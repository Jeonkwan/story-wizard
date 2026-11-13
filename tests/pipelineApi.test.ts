import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import {
  signAdminSession,
  ADMIN_COOKIE_NAME,
} from '../server/middleware/auth.js';
import { wrapPcmAsWav } from '../server/lib/wav.js';
import type {
  StoryLLMProvider,
  GenerateWriterDraftInput,
  DirectScriptInput,
} from '../server/services/geminiStory.js';
import {
  parseLLMJson,
  storyToCatalogItem,
  GoogleGenAIStoryLLMProvider,
} from '../server/services/geminiStory.js';
import type {
  WriterOutputInput,
  DirectorOutputInput,
} from '../server/lib/validators.js';
import { ValidationError } from '../server/lib/validators.js';
import { StorageNotFoundError } from '../server/storage/storageAdapter.js';
import {
  DEFAULT_AGE_RANGE,
  DEFAULT_VOCABULARY_LEVEL,
  VALID_AGE_RANGES,
  VALID_VOCABULARY_LEVELS,
  type Story,
  type CatalogItem,
} from '../shared/types.js';

describe('Phase 3: Admin Studio & Writer-Director Pipeline Integration Tests', () => {
  let tmpDir: string;
  let storage: LocalStorageAdapter;
  const adminEmail = 'curator@storyteller.studio';
  const sessionSecret = 'test-session-secret-at-least-32-chars-long!';

  // Injected mock LLM provider with spies
  let lastWriterDraftInput: GenerateWriterDraftInput | null = null;
  let lastDirectScriptInput: DirectScriptInput | null = null;

  const mockLLMProvider: StoryLLMProvider = {
    async generateWriterDraft(input: GenerateWriterDraftInput): Promise<WriterOutputInput> {
      lastWriterDraftInput = input;
      if (input.mode === 'sequel') {
        const characters = input.seriesContext?.characterBible?.length
          ? input.seriesContext.characterBible
          : [{ name: 'Bibi', traits: 'Gentle bell chime, sleepy' }];
        const charSpeaker = characters[0].name;

        return {
          title: 'The Sleepy Little Train: Star Mountain',
          summary: 'The little train chugs up Star Mountain under a starry sky.',
          tags: ['bedtime', 'train', 'stars'],
          characters,
          script_turns: [
            {
              turn_id: 1,
              speaker: 'Narrator',
              text: 'The sleepy blue train started climbing Star Mountain.',
            },
            {
              turn_id: 2,
              speaker: charSpeaker,
              text: 'Look at the glittering constellations above us!',
            },
          ],
        };
      }

      return {
        title: 'The Cozy Woodpecker',
        summary: 'A tired little woodpecker finds a warm hollow for the night.',
        tags: ['bedtime', 'forest', 'woodpecker'],
        characters: [{ name: 'Pip', traits: 'Tiny soft chirps, drowsy' }],
        script_turns: [
          {
            turn_id: 1,
            speaker: 'Narrator',
            text: 'Deep in the quiet forest, dusk was falling softly.',
          },
          {
            turn_id: 2,
            speaker: 'Pip',
            text: 'Time to tuck my feathers in for sleep.',
          },
        ],
      };
    },

    async directScript(input: DirectScriptInput): Promise<DirectorOutputInput> {
      lastDirectScriptInput = input;
      return {
        script_turns: input.script_turns.map((turn) => {
          if (turn.speaker === 'Narrator') {
            return {
              turn_id: turn.turn_id,
              speaker: turn.speaker,
              style: 'Warm, calm bedtime cadence',
              text: `${turn.text} <short pause>`,
            };
          }
          return {
            turn_id: turn.turn_id,
            speaker: turn.speaker,
            style: 'Speaking dialogue as character: sleepy murmur',
            text: `${turn.text} <yawn>`,
          };
        }),
        voice_candidates: [
          {
            label: 'Grandpa Owl',
            description: 'Deep, resonant, slow bedtime narration with rich baritone warmth',
            suggested_for: 'Narrator',
          },
          {
            label: 'Pip Woodpecker',
            description: 'Youthful, high-pitched soft chirping voice for a baby bird',
            suggested_for: 'Pip',
          },
        ],
      };
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storyteller-phase3-'));
    storage = new LocalStorageAdapter(tmpDir);
    lastWriterDraftInput = null;
    lastDirectScriptInput = null;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const config = loadConfig({
      DATA_DIR: tmpDir,
      ADMIN_GOOGLE_EMAIL: adminEmail,
      SESSION_SECRET: sessionSecret,
      NODE_ENV: 'test',
      DEV_ADMIN_BYPASS: 'true',
    });
    return createApp({
      config,
      storage,
      storyLLMProvider: mockLLMProvider,
    });
  }

  function getAdminCookie() {
    return `${ADMIN_COOKIE_NAME}=${signAdminSession(adminEmail, sessionSecret)}`;
  }

  /* -------------------------------------------------------------------------
   * Gate 1: Mode A & Draft Isolation
   * ----------------------------------------------------------------------- */
  it('Gate 1: Mode A generates draft, isolates from public catalog, and direct populates styles/tags/candidates', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    // 1. Generate Mode A story draft
    const resWrite = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'fresh',
        prompt: 'A story about a sleepy woodpecker',
        referenceText: 'Pip loves gentle pinecones.',
      });

    expect(resWrite.status).toBe(201);
    const story = resWrite.body;
    expect(story.id).toMatch(/^\d{4}-\d{2}-\d{2}-the-cozy-woodpecker/);
    expect(story.status).toBe('draft');
    expect(story.title).toBe('The Cozy Woodpecker');
    expect(story.characters).toHaveLength(1);
    expect(story.characters[0].name).toBe('Pip');
    expect(story.script_turns).toHaveLength(2);
    expect(story.voice_candidates).toEqual([]);
    expect(story.audio_versions).toEqual([]);

    // 2. Draft Isolation: public catalog must exclude it
    const resPublicCatalog = await request(app).get('/api/catalog');
    expect(resPublicCatalog.status).toBe(200);
    expect(resPublicCatalog.body).toHaveLength(0);

    // Public cannot view draft directly
    const resPublicStory = await request(app).get(`/api/stories/${story.id}`);
    expect(resPublicStory.status).toBe(404);

    // Admin can view draft directly
    const resAdminStory = await request(app)
      .get(`/api/stories/${story.id}`)
      .set('Cookie', [adminCookie]);
    expect(resAdminStory.status).toBe(200);
    expect(resAdminStory.body.id).toBe(story.id);

    // Admin catalog includes it
    const resAdminStories = await request(app)
      .get('/api/admin/stories')
      .set('Cookie', [adminCookie]);
    expect(resAdminStories.status).toBe(200);
    expect(resAdminStories.body).toHaveLength(1);
    expect(resAdminStories.body[0].status).toBe('draft');

    // 3. Auto-Direct script turns
    const resDirect = await request(app)
      .post(`/api/admin/stories/${story.id}/direct`)
      .set('Cookie', [adminCookie]);

    expect(resDirect.status).toBe(200);
    expect(lastDirectScriptInput).not.toBeNull();
    expect(lastDirectScriptInput?.title).toBe(story.title);
    const directedStory = resDirect.body;
    expect(directedStory.voice_candidates).toHaveLength(2);
    expect(directedStory.voice_candidates[0].label).toBe('Grandpa Owl');
    expect(directedStory.script_turns[0].style).toBe('Warm, calm bedtime cadence');
    expect(directedStory.script_turns[0].text).toContain('<short pause>');
    expect(directedStory.script_turns[1].style).toContain('sleepy murmur');
    expect(directedStory.script_turns[1].text).toContain('<yawn>');
  });

  /* -------------------------------------------------------------------------
   * Gate 2: Mode B Sequel Continuity
   * ----------------------------------------------------------------------- */
  it('Gate 2: Mode B sequel carries series context, increments episode, and passes prior character bible to Writer', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    // 1. Create episode 1 with seriesId
    const resEp1 = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'fresh',
        prompt: 'The sleepy train episode 1',
        seriesId: 'sleepy-train-adventures',
      });
    expect(resEp1.status).toBe(201);
    const ep1 = resEp1.body;
    expect(ep1.series_context).toEqual({
      series_id: 'sleepy-train-adventures',
      episode_number: 1,
    });

    // 2. Create episode 2 sequel referencing episode 1
    const resEp2 = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'sequel',
        previousStoryId: ep1.id,
        prompt: 'The train climbs Star Mountain',
      });

    expect(resEp2.status).toBe(201);
    const ep2 = resEp2.body;
    expect(ep2.series_context).toEqual({
      series_id: 'sleepy-train-adventures',
      episode_number: 2,
      previous_story_id: ep1.id,
    });

    // Verify mockLLMProvider received character bible and prior episode context
    expect(lastWriterDraftInput).not.toBeNull();
    expect(lastWriterDraftInput?.mode).toBe('sequel');
    expect(lastWriterDraftInput?.seriesContext?.seriesId).toBe('sleepy-train-adventures');
    expect(lastWriterDraftInput?.seriesContext?.episodeNumber).toBe(2);
    expect(lastWriterDraftInput?.seriesContext?.priorTitle).toBe(ep1.title);
    expect(lastWriterDraftInput?.seriesContext?.characterBible).toHaveLength(1);
    expect(lastWriterDraftInput?.seriesContext?.characterBible?.[0].name).toBe('Pip');
  });

  /* -------------------------------------------------------------------------
   * Gate 3: Publish Guardrail
   * ----------------------------------------------------------------------- */
  it('Gate 3: Rejects publishing with 0 audio versions; permits publishing once audio exists and allows reverting to draft', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    // Create draft
    const resWrite = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({ mode: 'fresh', prompt: 'Cozy night' });
    const storyId = resWrite.body.id;

    // Attempt to publish story with 0 audio versions -> 400
    const resBadPublish = await request(app)
      .patch(`/api/admin/stories/${storyId}/status`)
      .set('Cookie', [adminCookie])
      .send({ status: 'published' });

    expect(resBadPublish.status).toBe(400);
    expect(resBadPublish.body.error).toMatch(/Cannot publish story with 0 audio versions/i);

    // Seed audio directly into story
    const { wav } = wrapPcmAsWav(Buffer.alloc(48000, 0));
    await storage.saveAudio(storyId, 'v1-solo', wav);

    const updatedStory = await storage.getStory(storyId);
    updatedStory.audio_versions.push({
      version_id: 'v1-solo',
      label: 'Default Solo',
      casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
      is_default: true,
      duration_sec: 1,
      audio_url: `/api/stories/${storyId}/audios/v1-solo.wav`,
      created_at: new Date().toISOString(),
    });
    await storage.saveStory(updatedStory);

    // Now publish with >= 1 audio version -> 200
    const resGoodPublish = await request(app)
      .patch(`/api/admin/stories/${storyId}/status`)
      .set('Cookie', [adminCookie])
      .send({ status: 'published' });

    expect(resGoodPublish.status).toBe(200);
    expect(resGoodPublish.body.status).toBe('published');

    // Verify it appears in public catalog
    const resPublic = await request(app).get('/api/catalog');
    expect(resPublic.body).toHaveLength(1);
    expect(resPublic.body[0].id).toBe(storyId);

    // Revert to draft -> 200
    const resRevertDraft = await request(app)
      .patch(`/api/admin/stories/${storyId}/status`)
      .set('Cookie', [adminCookie])
      .send({ status: 'draft' });

    expect(resRevertDraft.status).toBe(200);
    expect(resRevertDraft.body.status).toBe('draft');

    // Disappears from public catalog
    const resPublicAfterRevert = await request(app).get('/api/catalog');
    expect(resPublicAfterRevert.body).toHaveLength(0);
  });

  /* -------------------------------------------------------------------------
   * Gate 4: Manual Edit Sanitization
   * ----------------------------------------------------------------------- */
  it('Gate 4: PUT /api/admin/stories/:id strips unauthorized tags while preserving approved vocal tags and prose parentheses', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    const resWrite = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({ mode: 'fresh', prompt: 'Cozy night' });
    const storyId = resWrite.body.id;

    // Send edit with unauthorized <cough_loudly>, uppercase <SHORT PAUSE>, and prose parentheses
    const resEdit = await request(app)
      .put(`/api/admin/stories/${storyId}`)
      .set('Cookie', [adminCookie])
      .send({
        title: 'Manually Polished Title',
        summary: 'Updated summary by human admin.',
        tags: ['POLISHED', 'bedtime', 'calm'],
        characters: [{ name: 'Pip', traits: 'Gentle chirping' }],
        script_turns: [
          {
            turn_id: 1,
            speaker: 'Narrator',
            style: 'Whispering warmly',
            text: 'The moon rose (bright yellow). <SHORT PAUSE> <cough_loudly> It lit the mossy path.',
          },
          {
            turn_id: 2,
            speaker: 'Pip',
            style: 'Sleepy flutter',
            text: 'Goodnight forest! <sigh>',
          },
        ],
      });

    expect(resEdit.status).toBe(200);
    const edited = resEdit.body;
    expect(edited.title).toBe('Manually Polished Title');
    expect(edited.summary).toBe('Updated summary by human admin.');
    expect(edited.tags).toEqual(['polished', 'bedtime', 'calm']);
    // <SHORT PAUSE> preserved and normalized to lowercase; <cough_loudly> stripped; (bright yellow) preserved
    expect(edited.script_turns[0].text).toBe(
      'The moon rose (bright yellow). <short pause> It lit the mossy path.'
    );
    expect(edited.script_turns[0].style).toBe('Whispering warmly');
    expect(edited.script_turns[1].text).toBe('Goodnight forest! <sigh>');

    // Verify catalog item was synced
    const catalog = await storage.getCatalog();
    const item = catalog.find((c) => c.id === storyId);
    expect(item?.title).toBe('Manually Polished Title');
    expect(item?.summary).toBe('Updated summary by human admin.');
  });

  /* -------------------------------------------------------------------------
   * Gate 5: Delete Story Cleanup
   * ----------------------------------------------------------------------- */
  it('Gate 5: DELETE /api/admin/stories/:id deletes story.json, audio files, and catalog entry', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    const resWrite = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({ mode: 'fresh', prompt: 'Story to delete' });
    const storyId = resWrite.body.id;

    // Attach audio version
    const { wav } = wrapPcmAsWav(Buffer.alloc(48000, 0));
    await storage.saveAudio(storyId, 'v1-test', wav);

    const story = await storage.getStory(storyId);
    story.audio_versions.push({
      version_id: 'v1-test',
      label: 'Test Audio',
      casting: { mode: 'solo', narrator_voice_id: 'kore', character_voices: {} },
      is_default: true,
      duration_sec: 1,
      audio_url: `/api/stories/${storyId}/audios/v1-test.wav`,
      created_at: new Date().toISOString(),
    });
    await storage.saveStory(story);

    // Delete story
    const resDelete = await request(app)
      .delete(`/api/admin/stories/${storyId}`)
      .set('Cookie', [adminCookie]);

    expect(resDelete.status).toBe(200);
    expect(resDelete.body).toEqual({ ok: true, deletedId: storyId });

    // Assert story.json does not exist
    await expect(storage.getStory(storyId)).rejects.toThrow(StorageNotFoundError);

    // Assert audio stream does not exist
    await expect(storage.getAudioStream(storyId, 'v1-test')).rejects.toThrow(StorageNotFoundError);

    // Assert catalog does not contain story
    const catalog = await storage.getCatalog();
    expect(catalog.some((c) => c.id === storyId)).toBe(false);
  });

  /* -------------------------------------------------------------------------
   * Gate 6: Unauthenticated 401 Enforcement
   * ----------------------------------------------------------------------- */
  it('Gate 6: Rejects unauthenticated requests with 401 across all admin story endpoints', async () => {
    const app = createTestApp();

    const resGet = await request(app).get('/api/admin/stories');
    expect(resGet.status).toBe(401);

    const resWrite = await request(app)
      .post('/api/admin/stories/write')
      .send({ mode: 'fresh', prompt: 'test' });
    expect(resWrite.status).toBe(401);

    const resDirect = await request(app).post('/api/admin/stories/some-story/direct');
    expect(resDirect.status).toBe(401);

    const resPut = await request(app)
      .put('/api/admin/stories/some-story')
      .send({ title: 'foo' });
    expect(resPut.status).toBe(401);

    const resPatch = await request(app)
      .patch('/api/admin/stories/some-story/status')
      .send({ status: 'published' });
    expect(resPatch.status).toBe(401);

    const resDelete = await request(app).delete('/api/admin/stories/some-story');
    expect(resDelete.status).toBe(401);
  });

  /* -------------------------------------------------------------------------
   * Review Findings: seriesId Hyphen Normalization & parseLLMJson
   * ----------------------------------------------------------------------- */
  it('normalizes seriesId by collapsing repeated hyphens and stripping punctuation/leading/trailing dashes', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    const res = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'fresh',
        prompt: 'A gentle bedtime journey',
        seriesId: '  --Sleepy Train!! Adventures--  ',
      });

    expect(res.status).toBe(201);
    expect(res.body.series_context?.series_id).toBe('sleepy-train-adventures');
    expect(res.body.series_context?.episode_number).toBe(1);
  });

  it('parseLLMJson strips optional markdown code fences and wraps parse errors in ValidationError', () => {
    // Strips ```json ... ```
    const fencedJson = '```json\n{"title": "Fenced Story", "tags": ["calm"]}\n```';
    const parsed = parseLLMJson<{ title: string; tags: string[] }>(fencedJson, 'test');
    expect(parsed.title).toBe('Fenced Story');
    expect(parsed.tags).toEqual(['calm']);

    // Throws ValidationError on empty output
    expect(() => parseLLMJson('', 'test')).toThrow(ValidationError);
    expect(() => parseLLMJson(undefined, 'test')).toThrow(ValidationError);

    // Throws ValidationError on malformed JSON
    expect(() => parseLLMJson('{"incomplete": true,', 'test')).toThrow(ValidationError);
  });

  /* -------------------------------------------------------------------------
   * Phase 6: Multi-Genre Freedom in Story Generation & Directing
   * ----------------------------------------------------------------------- */
  it('supports non-bedtime comedic, sci-fi, and adventure prompts without bedtime forcing', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    const genrePrompt = 'A witty, fast-paced comedic sci-fi adventure about two space mechanics fixing a robot';
    const res = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'fresh',
        prompt: genrePrompt,
        seriesId: 'space-mechanics',
      });

    expect(res.status).toBe(201);
    expect(lastWriterDraftInput).not.toBeNull();
    expect(lastWriterDraftInput?.prompt).toBe(genrePrompt);
    expect(res.body.series_context?.series_id).toBe('space-mechanics');

    // Directing preserves comedic/dynamic voice acting and pacing
    const directRes = await request(app)
      .post(`/api/admin/stories/${res.body.id}/direct`)
      .set('Cookie', [adminCookie]);

    expect(directRes.status).toBe(200);
    expect(lastDirectScriptInput).not.toBeNull();
    expect(lastDirectScriptInput?.title).toBe(res.body.title);
  });

  /* -------------------------------------------------------------------------
   * Phase 7: Zero-DB Asynchronous Job Manager & Pipeline Routes
   * ----------------------------------------------------------------------- */
  it('Phase 7: GET /api/admin/jobs/active lists running jobs and GET /api/admin/jobs/:id returns status', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    // Query active jobs initially -> empty list
    const resInitial = await request(app)
      .get('/api/admin/jobs/active')
      .set('Cookie', [adminCookie]);
    expect(resInitial.status).toBe(200);
    expect(resInitial.body.activeJobs).toEqual([]);

    // Query non-existent jobId -> 404
    const resNotFound = await request(app)
      .get('/api/admin/jobs/nonexistent-job-id')
      .set('Cookie', [adminCookie]);
    expect(resNotFound.status).toBe(404);
  });

  it('Phase 7: POST /api/admin/stories/write?async=true returns 202 Accepted and runs draft in background', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    const resAsync = await request(app)
      .post('/api/admin/stories/write?async=true')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'fresh',
        prompt: 'A gentle owl story in the night',
      });

    expect(resAsync.status).toBe(202);
    expect(resAsync.body.jobId).toMatch(/^job_\d+_[a-z0-9]+$/);
    expect(resAsync.body.status).toBe('running');

    const jobId = resAsync.body.jobId;

    // Check GET /jobs/:jobId
    const resStatus = await request(app)
      .get(`/api/admin/jobs/${jobId}`)
      .set('Cookie', [adminCookie]);
    expect(resStatus.status).toBe(200);
    expect(resStatus.body.job.job_id).toBe(jobId);

    // Wait microtask tick for background draft completion
    let attempts = 0;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 50));
      const poll = await request(app)
        .get(`/api/admin/jobs/${jobId}`)
        .set('Cookie', [adminCookie]);
      if (poll.body.job.status === 'completed') {
        expect(poll.body.job.result_story_id).toBeDefined();
        break;
      }
      attempts++;
    }
  });

  it('Phase 7: POST /api/admin/stories/:id/direct?async=true returns 202 Accepted and updates story', async () => {
    const app = createTestApp();
    const adminCookie = getAdminCookie();

    // First create a story synchronously
    const resCreate = await request(app)
      .post('/api/admin/stories/write')
      .set('Cookie', [adminCookie])
      .send({
        mode: 'fresh',
        prompt: 'A story to be directed',
      });
    expect(resCreate.status).toBe(201);
    const storyId = resCreate.body.id;

    // Trigger async direct
    const resDirectAsync = await request(app)
      .post(`/api/admin/stories/${storyId}/direct?async=true`)
      .set('Cookie', [adminCookie]);

    expect(resDirectAsync.status).toBe(202);
    expect(resDirectAsync.body.status).toBe('running');
    const directJobId = resDirectAsync.body.jobId;

    // Verify GET /api/admin/jobs/active?storyId=... lists the direct job
    const resActive = await request(app)
      .get(`/api/admin/jobs/active?storyId=${storyId}`)
      .set('Cookie', [adminCookie]);
    expect(resActive.status).toBe(200);

    // Wait for background completion
    let attempts = 0;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 50));
      const poll = await request(app)
        .get(`/api/admin/jobs/${directJobId}`)
        .set('Cookie', [adminCookie]);
      if (poll.body.job.status === 'completed') {
        expect(poll.body.job.status).toBe('completed');
        break;
      }
      attempts++;
    }
  });

  /* -------------------------------------------------------------------------
   * Phase 12: Backend Age-Vocab Prompt Engine & Prompt Metadata Persistence
   * ----------------------------------------------------------------------- */
  describe('Phase 12: Backend Age-Vocab Prompt Engine & Prompt Metadata Persistence', () => {
    it('exports VALID_AGE_RANGES and VALID_VOCABULARY_LEVELS constants matching spec', () => {
      expect(VALID_AGE_RANGES).toEqual(['toddler', 'early-reader', 'elementary', 'young-reader']);
      expect(VALID_VOCABULARY_LEVELS).toEqual(['simple', 'standard', 'enriched', 'advanced']);
      expect(DEFAULT_AGE_RANGE).toBe('early-reader');
      expect(DEFAULT_VOCABULARY_LEVEL).toBe('standard');
    });

    it('POST /api/admin/stories/write passes ageRange and vocabularyLevel to StoryLLMProvider and returns prompt_metadata', async () => {
      const app = createTestApp();
      const adminCookie = getAdminCookie();

      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A brave little otter exploring a river',
          referenceText: 'Otter loves shiny blue pebbles.',
          ageRange: 'toddler',
          vocabularyLevel: 'simple',
          genrePreset: 'whimsical',
        });

      expect(res.status).toBe(201);
      const story = res.body;

      // Verify mock LLM spy captured the parameters
      expect(lastWriterDraftInput).not.toBeNull();
      expect(lastWriterDraftInput?.ageRange).toBe('toddler');
      expect(lastWriterDraftInput?.vocabularyLevel).toBe('simple');
      expect(lastWriterDraftInput?.genrePreset).toBe('whimsical');
      expect(lastWriterDraftInput?.prompt).toBe('A brave little otter exploring a river');
      expect(lastWriterDraftInput?.referenceText).toBe('Otter loves shiny blue pebbles.');

      // Verify response story.prompt_metadata
      expect(story.prompt_metadata).toBeDefined();
      expect(story.prompt_metadata.original_prompt).toBe('A brave little otter exploring a river');
      expect(story.prompt_metadata.reference_text).toBe('Otter loves shiny blue pebbles.');
      expect(story.prompt_metadata.age_range).toBe('toddler');
      expect(story.prompt_metadata.vocabulary_level).toBe('simple');
      expect(story.prompt_metadata.genre_preset).toBe('whimsical');
      expect(story.prompt_metadata.created_at).toBe(story.created_at);

      // Verify stored story.json on disk includes identical prompt_metadata
      const storedStory = await storage.getStory(story.id);
      expect(storedStory.prompt_metadata).toEqual(story.prompt_metadata);
    });

    it('POST /api/admin/stories/write defaults ageRange to early-reader and vocabularyLevel to standard when omitted', async () => {
      const app = createTestApp();
      const adminCookie = getAdminCookie();

      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A gentle bear who loves counting stars',
        });

      expect(res.status).toBe(201);
      const story = res.body;

      // Verify LLM spy received default values
      expect(lastWriterDraftInput?.ageRange).toBe(DEFAULT_AGE_RANGE);
      expect(lastWriterDraftInput?.vocabularyLevel).toBe(DEFAULT_VOCABULARY_LEVEL);

      // Verify story prompt_metadata has defaults
      expect(story.prompt_metadata).toBeDefined();
      expect(story.prompt_metadata.age_range).toBe('early-reader');
      expect(story.prompt_metadata.vocabulary_level).toBe('standard');
      expect(story.prompt_metadata.original_prompt).toBe('A gentle bear who loves counting stars');
      expect(story.prompt_metadata.reference_text).toBeUndefined();
      expect(story.prompt_metadata.genre_preset).toBeUndefined();

      // Check on disk
      const storedStory = await storage.getStory(story.id);
      expect(storedStory.prompt_metadata).toEqual(story.prompt_metadata);
    });

    it('POST /api/admin/stories/write validates ageRange and vocabularyLevel values with 400 Bad Request', async () => {
      const app = createTestApp();
      const adminCookie = getAdminCookie();

      // Invalid ageRange
      const resInvalidAge = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'Story prompt',
          ageRange: 'adult',
        });
      expect(resInvalidAge.status).toBe(400);
      expect(resInvalidAge.body.error).toContain('Invalid ageRange');

      // Invalid vocabularyLevel
      const resInvalidVocab = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'Story prompt',
          vocabularyLevel: 'postgraduate',
        });
      expect(resInvalidVocab.status).toBe(400);
      expect(resInvalidVocab.body.error).toContain('Invalid vocabularyLevel');
    });

    it('Backward compatibility: legacy stories without prompt_metadata load cleanly via GET /api/stories/:id and GET /api/admin/stories', async () => {
      const app = createTestApp();
      const adminCookie = getAdminCookie();

      const legacyStoryId = '2026-01-01-legacy-fixture-story';
      const legacyStory: Story = {
        id: legacyStoryId,
        status: 'published',
        title: 'The Ancient Owl Story',
        summary: 'Created in an older version of Storyteller Studio without prompt_metadata.',
        tags: ['classic', 'owl'],
        series_context: null,
        characters: [{ name: 'Old Owl', traits: 'Wise and quiet' }],
        script_turns: [
          { turn_id: 1, speaker: 'Narrator', style: '', text: 'Long before prompt metadata was added.' },
          { turn_id: 2, speaker: 'Old Owl', style: '', text: 'Hoo hoo, I am timeless.' },
        ],
        voice_candidates: [],
        audio_versions: [],
        created_at: '2026-01-01T12:00:00.000Z',
        updated_at: '2026-01-01T12:00:00.000Z',
      };

      // Directly persist legacy story to disk without prompt_metadata
      await storage.saveStory(legacyStory);
      await storage.updateJsonAtomic<CatalogItem[]>('catalog.json', (current) => [
        storyToCatalogItem(legacyStory),
        ...(current || []),
      ]);

      // Public GET /api/stories/:id
      const resPublic = await request(app).get(`/api/stories/${legacyStoryId}`);
      expect(resPublic.status).toBe(200);
      expect(resPublic.body.id).toBe(legacyStoryId);
      expect(resPublic.body.title).toBe('The Ancient Owl Story');
      expect(resPublic.body.prompt_metadata).toBeUndefined();

      // Admin GET /api/stories/:id
      const resAdmin = await request(app)
        .get(`/api/stories/${legacyStoryId}`)
        .set('Cookie', [adminCookie]);
      expect(resAdmin.status).toBe(200);
      expect(resAdmin.body.prompt_metadata).toBeUndefined();

      // Admin GET /api/admin/stories
      const resAdminList = await request(app)
        .get('/api/admin/stories')
        .set('Cookie', [adminCookie]);
      expect(resAdminList.status).toBe(200);
      const foundInList = resAdminList.body.find((item: CatalogItem) => item.id === legacyStoryId);
      expect(foundInList).toBeDefined();
      expect(foundInList.title).toBe('The Ancient Owl Story');
    });

    it('Re-verifies DELETE /api/admin/stories/:id cleans up story with prompt_metadata and audio files', async () => {
      const app = createTestApp();
      const adminCookie = getAdminCookie();

      // Create story with prompt_metadata
      const resWrite = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A story to be deleted with prompt_metadata',
          ageRange: 'elementary',
          vocabularyLevel: 'enriched',
        });
      expect(resWrite.status).toBe(201);
      const storyId = resWrite.body.id;
      expect(resWrite.body.prompt_metadata.age_range).toBe('elementary');

      // Attach audio version
      const { wav } = wrapPcmAsWav(Buffer.alloc(48000, 0));
      await storage.saveAudio(storyId, 'v1-test-p12', wav);

      const story = await storage.getStory(storyId);
      story.audio_versions.push({
        version_id: 'v1-test-p12',
        label: 'Test P12 Audio',
        casting: { mode: 'solo', narrator_voice_id: 'kore', character_voices: {} },
        is_default: true,
        duration_sec: 1,
        audio_url: `/api/stories/${storyId}/audios/v1-test-p12.wav`,
        created_at: new Date().toISOString(),
      });
      await storage.saveStory(story);

      // DELETE /api/admin/stories/:id
      const resDelete = await request(app)
        .delete(`/api/admin/stories/${storyId}`)
        .set('Cookie', [adminCookie]);

      expect(resDelete.status).toBe(200);
      expect(resDelete.body).toEqual({ ok: true, deletedId: storyId });

      // Story JSON must not exist
      await expect(storage.getStory(storyId)).rejects.toThrow(StorageNotFoundError);

      // Audio stream must not exist
      await expect(storage.getAudioStream(storyId, 'v1-test-p12')).rejects.toThrow(StorageNotFoundError);

      // Catalog must not contain deleted story
      const catalog = await storage.getCatalog();
      expect(catalog.some((c) => c.id === storyId)).toBe(false);
    });

    it('GoogleGenAIStoryLLMProvider.generateWriterDraft calibrates systemInstruction for all age ranges and vocabulary levels', async () => {
      let capturedSystemInstruction = '';
      const mockAi = {
        models: {
          generateContent: async (args: any) => {
            capturedSystemInstruction = args.config.systemInstruction;
            return {
              text: JSON.stringify({
                title: 'Test Title',
                summary: 'Test summary.',
                tags: ['test'],
                characters: [{ name: 'Hero', traits: 'Bold' }],
                script_turns: [
                  { turn_id: 1, speaker: 'Narrator', text: 'Once.' },
                  { turn_id: 2, speaker: 'Hero', text: 'Hello.' },
                ],
              }),
            };
          },
        },
      };

      const provider = new GoogleGenAIStoryLLMProvider('test-key');
      (provider as any).ai = mockAi;

      // Test Toddler + Simple
      await provider.generateWriterDraft({
        mode: 'fresh',
        prompt: 'Little duck',
        ageRange: 'toddler',
        vocabularyLevel: 'simple',
        genrePreset: 'bedtime',
      });
      expect(capturedSystemInstruction).toContain('Target Audience: Toddlers (Ages 2–4)');
      expect(capturedSystemInstruction).toContain('very short sentences (4–8 words)');
      expect(capturedSystemInstruction).toContain('Vocabulary Level: Simple');
      expect(capturedSystemInstruction).toContain('Genre Preset: bedtime');

      // Test Early Reader + Standard
      await provider.generateWriterDraft({
        mode: 'fresh',
        prompt: 'Playful puppy',
        ageRange: 'early-reader',
        vocabularyLevel: 'standard',
      });
      expect(capturedSystemInstruction).toContain('Target Audience: Early Readers (Ages 5–7)');
      expect(capturedSystemInstruction).toContain('phonics-friendly');
      expect(capturedSystemInstruction).toContain('Vocabulary Level: Standard');

      // Test Elementary + Enriched
      await provider.generateWriterDraft({
        mode: 'fresh',
        prompt: 'Mystery cabin',
        ageRange: 'elementary',
        vocabularyLevel: 'enriched',
      });
      expect(capturedSystemInstruction).toContain('Target Audience: Elementary (Ages 8–10)');
      expect(capturedSystemInstruction).toContain('witty character banter');
      expect(capturedSystemInstruction).toContain('Vocabulary Level: Enriched');
      expect(capturedSystemInstruction).toContain('Introduce 3 to 5 colorful');

      // Test Young Reader + Advanced
      await provider.generateWriterDraft({
        mode: 'fresh',
        prompt: 'Space exploration',
        ageRange: 'young-reader',
        vocabularyLevel: 'advanced',
      });
      expect(capturedSystemInstruction).toContain('Target Audience: Young Readers (Ages 11+)');
      expect(capturedSystemInstruction).toContain('complex sentence structures');
      expect(capturedSystemInstruction).toContain('Vocabulary Level: Advanced');
      expect(capturedSystemInstruction).toContain('Sophisticated, literary expressions');
    });
  });

  describe('Phase 15: Durable Job History & Background Endpoints', () => {
    it('GET /api/admin/jobs returns recent jobs list', async () => {
      const app = createTestApp();
      const res = await request(app)
        .get('/api/admin/jobs')
        .set('Cookie', getAdminCookie());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it('GET /api/admin/jobs/:jobId returns persisted completed job', async () => {
      const app = createTestApp();

      // Trigger an async write job
      const writeRes = await request(app)
        .post('/api/admin/stories/write?async=true')
        .set('Cookie', getAdminCookie())
        .send({
          mode: 'fresh',
          prompt: 'A gentle bear under stars',
        });

      expect(writeRes.status).toBe(202);
      const jobId = writeRes.body.jobId;
      expect(jobId).toBeDefined();

      // Wait a moment for background draft to complete
      await new Promise((resolve) => setTimeout(resolve, 150));

      const jobRes = await request(app)
        .get(`/api/admin/jobs/${jobId}`)
        .set('Cookie', getAdminCookie());

      expect(jobRes.status).toBe(200);
      expect(jobRes.body.job.job_id).toBe(jobId);
      expect(jobRes.body.job.status).toBe('completed');
      expect(jobRes.body.job.title).toBe('The Cozy Woodpecker');
      expect(jobRes.body.job.stage).toBe('completed');
      expect(jobRes.body.job.finished_at).toBeDefined();
    });

    it('DELETE /api/admin/jobs/:jobId dismisses completed job with 200, rejects running with 409, returns 404 for missing', async () => {
      const app = createTestApp();

      // Missing job
      const missingRes = await request(app)
        .delete('/api/admin/jobs/job_missing_123')
        .set('Cookie', getAdminCookie());
      expect(missingRes.status).toBe(404);

      // Trigger async write
      const writeRes = await request(app)
        .post('/api/admin/stories/write?async=true')
        .set('Cookie', getAdminCookie())
        .send({
          mode: 'fresh',
          prompt: 'A quick little bird',
        });

      const jobId = writeRes.body.jobId;

      // Wait for it to complete
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Dismiss completed job
      const dismissRes = await request(app)
        .delete(`/api/admin/jobs/${jobId}`)
        .set('Cookie', getAdminCookie());
      expect(dismissRes.status).toBe(200);
      expect(dismissRes.body.ok).toBe(true);

      // Verify now 404
      const afterRes = await request(app)
        .get(`/api/admin/jobs/${jobId}`)
        .set('Cookie', getAdminCookie());
      expect(afterRes.status).toBe(404);
    });

    it('Chained write?async=true sets title, stage, and tracks active_job', async () => {
      const app = createTestApp();

      const writeRes = await request(app)
        .post('/api/admin/stories/write?async=true')
        .set('Cookie', getAdminCookie())
        .send({
          mode: 'fresh',
          prompt: 'A brave raccoon explores the meadow',
          autoDirect: true,
        });

      expect(writeRes.status).toBe(202);
      const jobId = writeRes.body.jobId;

      // Wait for full pipeline execution to finish
      await new Promise((resolve) => setTimeout(resolve, 200));

      const jobRes = await request(app)
        .get(`/api/admin/jobs/${jobId}`)
        .set('Cookie', getAdminCookie());

      expect(jobRes.status).toBe(200);
      expect(jobRes.body.job.status).toBe('completed');
      expect(jobRes.body.job.stage).toBe('completed');
      expect(jobRes.body.job.result_story_id).toBeDefined();

      // Story active_job should be cleared on completion
      const story = await storage.getStory(jobRes.body.job.result_story_id);
      expect(story.active_job).toBeNull();
    });
  });
});
