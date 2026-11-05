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
import { parseLLMJson } from '../server/services/geminiStory.js';
import type {
  WriterOutputInput,
  DirectorOutputInput,
} from '../server/lib/validators.js';
import { ValidationError } from '../server/lib/validators.js';
import { StorageNotFoundError } from '../server/storage/storageAdapter.js';

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
});
