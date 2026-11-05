import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { validateSlug } from '../storage/storageAdapter.js';
import { createRequireAdminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validateManualStoryEdit } from '../lib/validators.js';
import {
  GeminiStoryService,
  storyToCatalogItem,
} from '../services/geminiStory.js';
import type { CatalogItem, VoiceDesignCandidate } from '../../shared/types.js';

export function createAdminStoriesRouter(
  config: AppConfig,
  storage: StorageAdapter,
  storyService: GeminiStoryService
): Router {
  const router = Router();
  const requireAdmin = createRequireAdminMiddleware(config);

  // All admin story routes require admin authentication
  router.use(requireAdmin);

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
      const { mode, prompt, referenceText, seriesId, previousStoryId } = req.body || {};

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        res.status(400).json({ error: 'Story prompt is required' });
        return;
      }

      if (mode !== 'fresh' && mode !== 'sequel') {
        res.status(400).json({ error: 'Mode must be either "fresh" or "sequel"' });
        return;
      }

      const story = await storyService.generateStoryDraft({
        mode,
        prompt: prompt.trim(),
        referenceText: typeof referenceText === 'string' ? referenceText : undefined,
        seriesId: typeof seriesId === 'string' && seriesId.trim() ? seriesId.trim() : undefined,
        previousStoryId:
          typeof previousStoryId === 'string' && previousStoryId.trim()
            ? previousStoryId.trim()
            : undefined,
      });

      res.status(201).json(story);
    })
  );

  // POST /api/admin/stories/:id/direct
  router.post(
    '/stories/:id/direct',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const story = await storyService.directStoryScript(id);
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

  return router;
}
