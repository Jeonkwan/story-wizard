import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { validateSlug, StorageNotFoundError } from '../storage/storageAdapter.js';
import { createRequireAdminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validateManualStoryEdit } from '../lib/validators.js';
import {
  GeminiStoryService,
  storyToCatalogItem,
} from '../services/geminiStory.js';
import { GeminiTtsService } from '../services/geminiTts.js';
import { JobManager, defaultJobManager } from '../services/jobManager.js';
import {
  type CatalogItem,
  type VoiceDesignCandidate,
  type StoryAgeRange,
  type StoryVocabularyLevel,
  type StoryLength,
  VALID_AGE_RANGES,
  VALID_VOCABULARY_LEVELS,
  VALID_STORY_LENGTHS,
} from '../../shared/types.js';

export function createAdminStoriesRouter(
  config: AppConfig,
  storage: StorageAdapter,
  storyService: GeminiStoryService,
  ttsService?: GeminiTtsService,
  jobManager: JobManager = defaultJobManager
): Router {
  const router = Router();
  const requireAdmin = createRequireAdminMiddleware(config);
  const tts = ttsService || new GeminiTtsService(config, storage);

  jobManager.setStorage(storage);

  // All admin story routes require admin authentication
  router.use(requireAdmin);

  // GET /api/admin/jobs/active
  router.get(
    '/jobs/active',
    asyncHandler(async (req: Request, res: Response) => {
      const storyId = typeof req.query.storyId === 'string' ? req.query.storyId : undefined;
      jobManager.cleanupOldJobs();
      const activeJobs = jobManager.getActiveJobs(storyId);
      res.json({ activeJobs });
    })
  );

  // GET /api/admin/jobs/:jobId
  router.get(
    '/jobs/:jobId',
    asyncHandler(async (req: Request, res: Response) => {
      const { jobId } = req.params;
      const job = jobManager.getJob(jobId);
      if (!job) {
        res.status(404).json({ error: `Job not found: "${jobId}"` });
        return;
      }
      res.json({ job });
    })
  );

  // GET /api/admin/stories
  router.get(
    '/stories',
    asyncHandler(async (_req: Request, res: Response) => {
      const catalog = await storage.getCatalog();
      catalog.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      res.json(catalog);
    })
  );

  // POST /api/admin/stories/write
  router.post(
    '/stories/write',
    asyncHandler(async (req: Request, res: Response) => {
      const {
        mode,
        prompt,
        referenceText,
        seriesId,
        previousStoryId,
        ageRange,
        storyLength,
        vocabularyLevel,
        genrePreset,
        autoDirect,
        autoSynthesize,
        narratorVoiceId,
        avoidCharacterNames: customAvoidNames,
      } = req.body || {};

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        res.status(400).json({ error: 'Story prompt is required' });
        return;
      }

      if (mode !== 'fresh' && mode !== 'sequel') {
        res.status(400).json({ error: 'Mode must be either "fresh" or "sequel"' });
        return;
      }

      if (ageRange !== undefined && !VALID_AGE_RANGES.includes(ageRange as StoryAgeRange)) {
        res.status(400).json({
          error: `Invalid ageRange: "${ageRange}". Allowed values: ${VALID_AGE_RANGES.join(', ')}`,
        });
        return;
      }

      if (
        storyLength !== undefined &&
        !VALID_STORY_LENGTHS.includes(storyLength as StoryLength)
      ) {
        res.status(400).json({
          error: `Invalid storyLength: "${storyLength}". Allowed values: ${VALID_STORY_LENGTHS.join(', ')}`,
        });
        return;
      }

      if (
        vocabularyLevel !== undefined &&
        !VALID_VOCABULARY_LEVELS.includes(vocabularyLevel as StoryVocabularyLevel)
      ) {
        res.status(400).json({
          error: `Invalid vocabularyLevel: "${vocabularyLevel}". Allowed values: ${VALID_VOCABULARY_LEVELS.join(', ')}`,
        });
        return;
      }

      const validatedGenrePreset =
        typeof genrePreset === 'string' && genrePreset.trim()
          ? genrePreset.trim()
          : undefined;

      // Collect existing character names to avoid repetitive naming clichés
      let avoidCharacterNames: string[] = [];
      try {
        const catalog = await storage.getCatalog();
        const recentItems = catalog.slice(0, 10);
        const namesSet = new Set<string>();
        for (const item of recentItems) {
          try {
            const fullStory = await storage.getStory(item.id);
            if (Array.isArray(fullStory.characters)) {
              for (const char of fullStory.characters) {
                if (
                  char.name &&
                  typeof char.name === 'string' &&
                  char.name.trim() &&
                  char.name.trim().toLowerCase() !== 'narrator'
                ) {
                  namesSet.add(char.name.trim());
                }
              }
            }
          } catch {
            // ignore individual story read errors
          }
        }
        if (Array.isArray(customAvoidNames)) {
          for (const name of customAvoidNames) {
            if (typeof name === 'string' && name.trim()) {
              namesSet.add(name.trim());
            }
          }
        }
        avoidCharacterNames = Array.from(namesSet);
      } catch (err) {
        console.warn('[AdminStories] Failed to collect existing character names:', err);
      }

      const isAsync = req.query.async === 'true';
      const storyTarget = mode === 'sequel' && previousStoryId ? String(previousStoryId).trim() : 'new';
      const job = jobManager.createJob('draft', storyTarget, 'Drafting story with Gemini 3.8 Flash...');

      const runDraft = async () => {
        try {
          // Step 1: Draft story
          const story = await storyService.generateStoryDraft({
            mode,
            prompt: prompt.trim(),
            referenceText: typeof referenceText === 'string' ? referenceText : undefined,
            seriesId: typeof seriesId === 'string' && seriesId.trim() ? seriesId.trim() : undefined,
            previousStoryId:
              typeof previousStoryId === 'string' && previousStoryId.trim()
                ? previousStoryId.trim()
                : undefined,
            ageRange: ageRange as StoryAgeRange | undefined,
            storyLength: storyLength as StoryLength | undefined,
            vocabularyLevel: vocabularyLevel as StoryVocabularyLevel | undefined,
            genrePreset: validatedGenrePreset,
            avoidCharacterNames,
          });

          let currentStory = story;

          // Step 2: Auto-Direct if requested
          if (autoDirect === true) {
            await jobManager.updateJobAsync(job.job_id, {
              status: 'running',
              story_id: currentStory.id,
              result_story_id: currentStory.id,
              message: 'Stage 2/3: Auto-directing vocal delivery cues...',
            });
            try {
              currentStory = await storyService.directStoryScript(currentStory.id);
            } catch (directErr) {
              console.warn(
                `[adminStories] Auto-directing failed for story ${currentStory.id}, proceeding with draft:`,
                directErr
              );
            }
          }

          // Step 3: Auto-Synthesize if requested with a valid narrator voice
          if (
            autoSynthesize === true &&
            typeof narratorVoiceId === 'string' &&
            narratorVoiceId.trim()
          ) {
            await jobManager.updateJobAsync(job.job_id, {
              status: 'running',
              story_id: currentStory.id,
              result_story_id: currentStory.id,
              message: 'Stage 3/3: Synthesizing full story narration...',
            });
            try {
              currentStory = await tts.synthesizeFullStory(currentStory.id, {
                casting: {
                  mode: 'solo',
                  narrator_voice_id: narratorVoiceId.trim(),
                  character_voices: {},
                },
                label: 'Default Solo Narration',
                makeDefault: true,
              });
            } catch (synthErr) {
              console.warn(
                `[adminStories] Auto-synthesizing failed for story ${currentStory.id}:`,
                synthErr
              );
              throw synthErr;
            }
          }

          currentStory.active_job = null;
          await jobManager.updateJobAsync(job.job_id, {
            status: 'completed',
            result_story_id: currentStory.id,
            story_id: currentStory.id,
            message:
              autoSynthesize && narratorVoiceId
                ? 'Story creation and narration complete!'
                : autoDirect
                ? 'Story draft and direction complete!'
                : 'Story draft complete!',
          });
          return currentStory;
        } catch (err) {
          await jobManager.updateJobAsync(job.job_id, {
            status: 'failed',
            error: err instanceof Error ? err.message : 'Draft generation failed',
            message: 'Draft generation failed',
          });
          throw err;
        }
      };

      if (isAsync) {
        runDraft().catch((err) => {
          console.warn(`[JobManager] Background draft job ${job.job_id} failed:`, err);
        });
        res.status(202).json({ jobId: job.job_id, status: 'running' });
        return;
      }

      const story = await runDraft();
      res.status(201).json(story);
    })
  );

  // POST /api/admin/stories/:id/direct
  router.post(
    '/stories/:id/direct',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const isAsync = req.query.async === 'true';
      const job = jobManager.createJob(
        'direct',
        id,
        'Directing vocal expressions and pacing with Gemini 3.8 Flash...',
        false
      );
      await jobManager.persistJobStart(job.job_id);

      const runDirect = async () => {
        try {
          const story = await storyService.directStoryScript(id);
          story.active_job = null;
          await jobManager.updateJobAsync(job.job_id, {
            status: 'completed',
            result_story_id: story.id,
            message: 'Directing complete!',
          });
          return story;
        } catch (err) {
          await jobManager.updateJobAsync(job.job_id, {
            status: 'failed',
            error: err instanceof Error ? err.message : 'Directing failed',
            message: 'Directing failed',
          });
          throw err;
        }
      };

      if (isAsync) {
        runDirect().catch((err) => {
          console.warn(`[JobManager] Background direct job ${job.job_id} failed:`, err);
        });
        res.status(202).json({ jobId: job.job_id, status: 'running' });
        return;
      }

      const story = await runDirect();
      res.json(story);
    })
  );

  // PUT /api/admin/stories/:id
  router.put(
    '/stories/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const story = await storage.getStory(id);

      // Validate manual edits
      const validated = validateManualStoryEdit({
        title: req.body?.title,
        summary: req.body?.summary,
        tags: req.body?.tags,
        characters: req.body?.characters,
        script_turns: req.body?.script_turns,
      });

      // Optional voice_candidates validation if provided
      let voiceCandidates = story.voice_candidates;
      if (Array.isArray(req.body?.voice_candidates)) {
        const candidates: VoiceDesignCandidate[] = [];
        for (const c of req.body.voice_candidates) {
          if (!c || typeof c !== 'object') {
            res.status(400).json({ error: 'Each voice_candidate must be an object' });
            return;
          }
          const label = typeof c.label === 'string' ? c.label.trim() : '';
          const description = typeof c.description === 'string' ? c.description.trim() : '';
          const suggested_for = typeof c.suggested_for === 'string' ? c.suggested_for.trim() : '';
          if (!label || !description || !suggested_for) {
            res.status(400).json({
              error: 'voice_candidate label, description, and suggested_for must be non-empty strings',
            });
            return;
          }
          candidates.push({ label, description, suggested_for });
        }
        voiceCandidates = candidates;
      }

      story.title = validated.title;
      story.summary = validated.summary;
      story.tags = validated.tags;
      story.characters = validated.characters;
      story.script_turns = validated.script_turns;
      story.voice_candidates = voiceCandidates;
      story.updated_at = new Date().toISOString();

      await storage.saveStory(story);

      // Atomically sync catalog.json
      const catalogItem = storyToCatalogItem(story);
      await storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          const idx = list.findIndex((c) => c.id === story.id);
          if (idx >= 0) {
            list[idx] = catalogItem;
          } else {
            list.unshift(catalogItem);
          }
          return list;
        },
        []
      );

      res.json(story);
    })
  );

  // PATCH /api/admin/stories/:id/status
  router.patch(
    '/stories/:id/status',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const { status } = req.body || {};
      if (status !== 'draft' && status !== 'published') {
        res.status(400).json({ error: 'Status must be either "draft" or "published"' });
        return;
      }

      const story = await storage.getStory(id);

      // Guardrail: Reject publishing if audio_versions is empty
      if (status === 'published' && (!story.audio_versions || story.audio_versions.length === 0)) {
        res.status(400).json({ error: 'Cannot publish story with 0 audio versions' });
        return;
      }

      story.status = status;
      story.updated_at = new Date().toISOString();

      await storage.saveStory(story);

      // Atomically sync catalog.json
      const catalogItem = storyToCatalogItem(story);
      await storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          const idx = list.findIndex((c) => c.id === story.id);
          if (idx >= 0) {
            list[idx] = catalogItem;
          } else {
            list.unshift(catalogItem);
          }
          return list;
        },
        []
      );

      res.json(story);
    })
  );

  // DELETE /api/admin/stories/:id
  router.delete(
    '/stories/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const story = await storage.getStory(id);

      // Delete every audio version file gracefully
      if (Array.isArray(story.audio_versions)) {
        for (const ver of story.audio_versions) {
          try {
            await storage.deleteAudio(story.id, ver.version_id);
          } catch {
            // Ignore missing audio files
          }
        }
      }

      // Delete story directory
      await storage.deleteStory(story.id);

      // Atomically remove from catalog.json
      await storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          return list.filter((c) => c.id !== story.id);
        },
        []
      );

      res.json({ ok: true, deletedId: story.id });
    })
  );

  // POST /api/admin/stories/:id/synthesize — TTS Synthesis & Publishing
  router.post(
    '/stories/:id/synthesize',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const { casting, label, makeDefault } = req.body || {};
      if (!casting || typeof casting !== 'object') {
        res.status(400).json({ error: 'Casting configuration is required' });
        return;
      }

      const isAsync = req.query.async === 'true';
      const job = jobManager.createJob(
        'synthesize',
        id,
        'Synthesizing multi-speaker speech audio with Gemini 3.8 Flash TTS...',
        false
      );
      await jobManager.persistJobStart(job.job_id);

      const runSynthesize = async () => {
        try {
          const updatedStory = await tts.synthesizeFullStory(id, {
            casting,
            label: typeof label === 'string' ? label : undefined,
            makeDefault: typeof makeDefault === 'boolean' ? makeDefault : undefined,
          });
          updatedStory.active_job = null;
          await jobManager.updateJobAsync(job.job_id, {
            status: 'completed',
            result_story_id: updatedStory.id,
            message: 'Audio synthesis complete!',
          });
          return updatedStory;
        } catch (err) {
          await jobManager.updateJobAsync(job.job_id, {
            status: 'failed',
            error: err instanceof Error ? err.message : 'Audio synthesis failed',
            message: 'Audio synthesis failed',
          });
          throw err;
        }
      };

      if (isAsync) {
        runSynthesize().catch((err) => {
          console.warn(`[JobManager] Background synthesis job ${job.job_id} failed:`, err);
        });
        res.status(202).json({ jobId: job.job_id, status: 'running' });
        return;
      }

      const updatedStory = await runSynthesize();
      res.status(201).json(updatedStory);
    })
  );

  // PATCH /api/admin/stories/:id/versions/:versionId/default — Set default audio version
  router.patch(
    '/stories/:id/versions/:versionId/default',
    asyncHandler(async (req: Request, res: Response) => {
      const { id, versionId } = req.params;
      validateSlug(id, 'id');
      validateSlug(versionId, 'versionId');

      const story = await storage.getStory(id);
      const targetVer = story.audio_versions?.find((v) => v.version_id === versionId);
      if (!targetVer) {
        res.status(404).json({ error: `Audio version not found: "${versionId}"` });
        return;
      }

      for (const v of story.audio_versions) {
        v.is_default = v.version_id === versionId;
      }

      story.updated_at = new Date().toISOString();
      await storage.saveStory(story);

      // Atomically sync catalog.json
      const catalogItem = storyToCatalogItem(story);
      await storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          const idx = list.findIndex((c) => c.id === story.id);
          if (idx >= 0) {
            list[idx] = catalogItem;
          } else {
            list.unshift(catalogItem);
          }
          return list;
        },
        []
      );

      res.json(story);
    })
  );

  // DELETE /api/admin/stories/:id/versions/:versionId — Delete audio version
  router.delete(
    '/stories/:id/versions/:versionId',
    asyncHandler(async (req: Request, res: Response) => {
      const { id, versionId } = req.params;
      validateSlug(id, 'id');
      validateSlug(versionId, 'versionId');

      const story = await storage.getStory(id);
      const idx = (story.audio_versions || []).findIndex((v) => v.version_id === versionId);
      if (idx < 0) {
        res.status(404).json({ error: `Audio version not found: "${versionId}"` });
        return;
      }

      try {
        await storage.deleteAudio(story.id, versionId);
      } catch (err) {
        if (!(err instanceof StorageNotFoundError)) {
          // Ignore if audio file is already missing
        }
      }

      const wasDefault = story.audio_versions[idx].is_default;
      story.audio_versions.splice(idx, 1);

      if (story.audio_versions.length > 0) {
        const hasDefault = story.audio_versions.some((v) => v.is_default);
        if (wasDefault || !hasDefault) {
          const sorted = [...story.audio_versions].sort((a, b) => {
            const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            if (diff !== 0) return diff;
            return story.audio_versions.indexOf(b) - story.audio_versions.indexOf(a);
          });
          const newest = sorted[0];
          for (const v of story.audio_versions) {
            v.is_default = v.version_id === newest.version_id;
          }
        }
      } else {
        story.status = 'draft';
      }

      story.updated_at = new Date().toISOString();
      await storage.saveStory(story);

      // Atomically sync catalog.json
      const catalogItem = storyToCatalogItem(story);
      await storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          const cIdx = list.findIndex((c) => c.id === story.id);
          if (cIdx >= 0) {
            list[cIdx] = catalogItem;
          } else {
            list.unshift(catalogItem);
          }
          return list;
        },
        []
      );

      res.json(story);
    })
  );

  return router;
}
