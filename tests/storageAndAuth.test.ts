import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import {
  LocalStorageAdapter,
  GcsStorageAdapter,
  InvalidSlugError,
} from '../server/storage/index.js';
import {
  signAdminSession,
  ADMIN_COOKIE_NAME,
  type GoogleTokenVerifier,
} from '../server/middleware/auth.js';
import { wrapPcmAsWav } from '../server/lib/wav.js';
import type { CatalogItem, Story } from '../shared/types.js';

describe('Phase 1: Dual-Mode Storage, HTTP Range Streaming & Admin Auth', () => {
  let tmpDir: string;
  let storage: LocalStorageAdapter;
  const adminEmail = 'admin@storyteller.local';
  const sessionSecret = 'test-session-secret-at-least-32-chars-long!';

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storyteller-phase1-'));
    storage = new LocalStorageAdapter(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper to create test app
  function createTestApp(customVerifier?: GoogleTokenVerifier, allowBypass = true) {
    const config = loadConfig({
      DATA_DIR: tmpDir,
      ADMIN_GOOGLE_EMAIL: adminEmail,
      SESSION_SECRET: sessionSecret,
      NODE_ENV: 'test',
      DEV_ADMIN_BYPASS: allowBypass ? 'true' : 'false',
    });
    return createApp({
      config,
      storage,
      verifyGoogleIdToken: customVerifier,
    });
  }

  // Helper to seed a published story and a draft story with audio
  async function seedTestStories() {
    const pcm = Buffer.alloc(48000, 1); // 1 sec of audio = 48000 bytes PCM
    const { wav } = wrapPcmAsWav(pcm); // 44 + 48000 = 48044 bytes

    const publishedStory: Story = {
      id: 'published-story',
      status: 'published',
      title: 'Published Story Title',
      summary: 'Summary of published story.',
      tags: ['bedtime'],
      series_context: null,
      characters: [{ name: 'Bibi', traits: 'Gentle bell' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'Hello.' },
        { turn_id: 2, speaker: 'Bibi', style: '', text: 'Goodnight!' },
      ],
      voice_candidates: [{ label: 'V1', description: 'Desc', suggested_for: 'Narrator' }],
      audio_versions: [
        {
          version_id: 'v1-solo',
          label: 'Solo Version',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 1,
          audio_url: '/api/stories/published-story/audios/v1-solo.wav',
          created_at: '2026-11-05T00:00:00.000Z',
        },
      ],
      created_at: '2026-11-05T00:00:00.000Z',
      updated_at: '2026-11-05T00:00:00.000Z',
    };

    const draftStory: Story = {
      id: 'draft-story',
      status: 'draft',
      title: 'Draft Story Title',
      summary: 'Summary of draft story.',
      tags: ['draft'],
      series_context: null,
      characters: [{ name: 'SecretChar', traits: 'Quiet' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'Draft intro.' },
        { turn_id: 2, speaker: 'SecretChar', style: '', text: 'Draft whisper.' },
      ],
      voice_candidates: [{ label: 'V2', description: 'Desc', suggested_for: 'Narrator' }],
      audio_versions: [
        {
          version_id: 'v1-draft',
          label: 'Draft Version',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 1,
          audio_url: '/api/stories/draft-story/audios/v1-draft.wav',
          created_at: '2026-11-05T00:00:00.000Z',
        },
      ],
      created_at: '2026-11-06T00:00:00.000Z',
      updated_at: '2026-11-06T00:00:00.000Z',
    };

    await storage.saveStory(publishedStory);
    await storage.saveAudio('published-story', 'v1-solo', wav);

    await storage.saveStory(draftStory);
    await storage.saveAudio('draft-story', 'v1-draft', wav);

    const catalog: CatalogItem[] = [
      {
        id: publishedStory.id,
        status: publishedStory.status,
        title: publishedStory.title,
        summary: publishedStory.summary,
        tags: publishedStory.tags,
        series_id: null,
        episode_number: null,
        created_at: publishedStory.created_at,
        updated_at: publishedStory.updated_at,
        default_audio_url: publishedStory.audio_versions[0].audio_url,
        audio_versions_count: 1,
      },
      {
        id: draftStory.id,
        status: draftStory.status,
        title: draftStory.title,
        summary: draftStory.summary,
        tags: draftStory.tags,
        series_id: null,
        episode_number: null,
        created_at: draftStory.created_at,
        updated_at: draftStory.updated_at,
        default_audio_url: null,
        audio_versions_count: 1,
      },
    ];

    await storage.saveCatalog(catalog);
    return { publishedStory, draftStory, wavLength: wav.length };
  }

  /* -------------------------------------------------------------------------
   * 1. Catalog & Draft Privacy Tests
   * ----------------------------------------------------------------------- */
  describe('Catalog & Draft Privacy', () => {
    it('unauthenticated GET /api/catalog returns only published stories; GET /api/stories/:draft returns 404', async () => {
      await seedTestStories();
      const app = createTestApp();

      // Unauthenticated catalog returns only published
      const resCat = await request(app).get('/api/catalog');
      expect(resCat.status).toBe(200);
      expect(resCat.body.length).toBe(1);
      expect(resCat.body[0].id).toBe('published-story');

      // Unauthenticated story fetch for draft returns 404
      const resDraft = await request(app).get('/api/stories/draft-story');
      expect(resDraft.status).toBe(404);

      // Unauthenticated audio fetch for draft returns 404
      const resDraftAudio = await request(app).get('/api/stories/draft-story/audios/v1-draft.wav');
      expect(resDraftAudio.status).toBe(404);

      // Unauthenticated story fetch for published returns 200
      const resPub = await request(app).get('/api/stories/published-story');
      expect(resPub.status).toBe(200);
      expect(resPub.body.id).toBe('published-story');
    });

    it('authenticated admin receives draft stories in catalog (?includeDrafts=true) and GET /api/stories/:draft', async () => {
      await seedTestStories();
      const app = createTestApp();
      const adminCookie = signAdminSession(adminEmail, sessionSecret);

      // Admin with ?includeDrafts=true receives both
      const resCat = await request(app)
        .get('/api/catalog?includeDrafts=true')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${adminCookie}`]);
      expect(resCat.status).toBe(200);
      expect(resCat.body.length).toBe(2);

      // Admin can view the draft story directly
      const resDraft = await request(app)
        .get('/api/stories/draft-story')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${adminCookie}`]);
      expect(resDraft.status).toBe(200);
      expect(resDraft.body.id).toBe('draft-story');

      // Admin can fetch audio of draft story
      const resDraftAudio = await request(app)
        .get('/api/stories/draft-story/audios/v1-draft.wav')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${adminCookie}`]);
      expect(resDraftAudio.status).toBe(200);
    });
  });

  /* -------------------------------------------------------------------------
   * 2. HTTP Range Audio Streaming Tests
   * ----------------------------------------------------------------------- */
  describe('HTTP Range Streaming', () => {
    it('returns 200 OK with full file when no Range header is provided', async () => {
      const { wavLength } = await seedTestStories();
      const app = createTestApp();

      const res = await request(app).get('/api/stories/published-story/audios/v1-solo.wav');
      expect(res.status).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toBe('audio/wav');
      expect(res.headers['content-length']).toBe(String(wavLength));
      expect(res.headers['cache-control']).toContain('max-age=31536000');
      expect(res.body.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(res.body.length).toBe(wavLength);
    });

    it('returns 206 Partial Content for explicit range (bytes=0-43, first 44 bytes)', async () => {
      const { wavLength } = await seedTestStories();
      const app = createTestApp();

      const res = await request(app)
        .get('/api/stories/published-story/audios/v1-solo.wav')
        .set('Range', 'bytes=0-43');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-43/${wavLength}`);
      expect(res.headers['content-length']).toBe('44');
      expect(res.body.length).toBe(44);
      expect(res.body.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(res.body.subarray(8, 12).toString('ascii')).toBe('WAVE');
    });

    it('returns 206 Partial Content for open-ended range (bytes=100-)', async () => {
      const { wavLength } = await seedTestStories();
      const app = createTestApp();

      const res = await request(app)
        .get('/api/stories/published-story/audios/v1-solo.wav')
        .set('Range', 'bytes=100-');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 100-${wavLength - 1}/${wavLength}`);
      expect(res.headers['content-length']).toBe(String(wavLength - 100));
      expect(res.body.length).toBe(wavLength - 100);
    });

    it('returns 206 Partial Content for suffix range (bytes=-50)', async () => {
      const { wavLength } = await seedTestStories();
      const app = createTestApp();

      const res = await request(app)
        .get('/api/stories/published-story/audios/v1-solo.wav')
        .set('Range', 'bytes=-50');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes ${wavLength - 50}-${wavLength - 1}/${wavLength}`);
      expect(res.headers['content-length']).toBe('50');
      expect(res.body.length).toBe(50);
    });

    it('returns 416 Range Not Satisfiable when range start is beyond total bytes', async () => {
      const { wavLength } = await seedTestStories();
      const app = createTestApp();

      const res = await request(app)
        .get('/api/stories/published-story/audios/v1-solo.wav')
        .set('Range', 'bytes=9999999-10000000');

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${wavLength}`);
    });

    it('returns 416 for inverted range (bytes=50-20)', async () => {
      const { wavLength } = await seedTestStories();
      const app = createTestApp();

      const res = await request(app)
        .get('/api/stories/published-story/audios/v1-solo.wav')
        .set('Range', 'bytes=50-20');

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${wavLength}`);
    });
  });

  /* -------------------------------------------------------------------------
   * 3. Path Traversal Protection
   * ----------------------------------------------------------------------- */
  describe('Path Traversal Protection', () => {
    it('blocks path traversal attempts in URL params with 400', async () => {
      const app = createTestApp();

      // Traversal in story id
      const res1 = await request(app).get('/api/stories/..%2Fsecret/audios/v1.wav');
      expect(res1.status).toBe(400);

      // Traversal in audio filename
      const res2 = await request(app).get('/api/stories/published-story/audios/..%2Fsecret.wav');
      expect(res2.status).toBe(400);

      // Missing .wav extension
      const res3 = await request(app).get('/api/stories/published-story/audios/v1-solo');
      expect(res3.status).toBe(400);
    });

    it('storage layer throws InvalidSlugError for invalid slugs and path traversal in paths', async () => {
      await expect(storage.getStory('../secret')).rejects.toThrow(InvalidSlugError);
      await expect(storage.getAudioStream('valid-slug', '../malicious')).rejects.toThrow(
        InvalidSlugError
      );
      await expect(
        storage.updateJsonAtomic('../outside.json', () => ({ ok: true }))
      ).rejects.toThrow(InvalidSlugError);
    });
  });

  /* -------------------------------------------------------------------------
   * 4. GCS Atomic Retry Unit Test (Mocking 412 Precondition Failed)
   * ----------------------------------------------------------------------- */
  describe('GCS Optimistic Concurrency Control', () => {
    it('retries updateJsonAtomic on HTTP 412 generation conflict and succeeds on second save', async () => {
      let saveCount = 0;
      let downloadCount = 0;
      const fileData = { count: 1 };

      const mockFile = {
        getMetadata: async () => [{ generation: 100 }],
        download: async () => {
          downloadCount++;
          return [Buffer.from(JSON.stringify(fileData))];
        },
        save: async () => {
          saveCount++;
          if (saveCount === 1) {
            // First save attempt encounters race condition: throws 412
            const err = new Error('Precondition Failed') as Error & { code: number };
            err.code = 412;
            throw err;
          }
          // Second attempt succeeds
          return;
        },
      };

      const mockBucket = {
        file: () => mockFile,
      };

      const gcsStorage = new GcsStorageAdapter(mockBucket as any);

      const result = await gcsStorage.updateJsonAtomic<{ count: number }>(
        'catalog.json',
        (curr) => ({ count: (curr?.count || 0) + 1 })
      );

      expect(saveCount).toBe(2);
      expect(downloadCount).toBe(2);
      expect(result.count).toBe(2);
    });

    it('throws error when 412 persists across all retries', async () => {
      const mockFile = {
        getMetadata: async () => [{ generation: 100 }],
        download: async () => [Buffer.from(JSON.stringify({}))],
        save: async () => {
          const err = new Error('Precondition Failed') as Error & { code: number };
          err.code = 412;
          throw err;
        },
      };

      const mockBucket = { file: () => mockFile };
      const gcsStorage = new GcsStorageAdapter(mockBucket as any);

      await expect(
        gcsStorage.updateJsonAtomic('catalog.json', () => ({ test: true }))
      ).rejects.toThrow('Precondition Failed');
    });
  });

  /* -------------------------------------------------------------------------
   * 5. LocalStorage Concurrent Atomic Updates
   * ----------------------------------------------------------------------- */
  describe('LocalStorage Concurrent Atomic Updates', () => {
    it('serializes concurrent updateJsonAtomic calls to the same file without data loss', async () => {
      // 10 concurrent increments to a counter
      const updates = Array.from({ length: 10 }, () =>
        storage.updateJsonAtomic<{ count: number }>(
          'counter.json',
          (curr) => ({ count: (curr?.count || 0) + 1 }),
          { count: 0 }
        )
      );

      await Promise.all(updates);

      const final = await storage.updateJsonAtomic<{ count: number }>(
        'counter.json',
        (curr) => curr!,
        { count: 0 }
      );

      expect(final.count).toBe(10);
    });
  });

  /* -------------------------------------------------------------------------
   * 6. Admin Authentication & Route Protection
   * ----------------------------------------------------------------------- */
  describe('Admin Auth & Session Management', () => {
    it('rejects wrong Google email with 403 Forbidden', async () => {
      const verifier: GoogleTokenVerifier = async () => ({
        email: 'attacker@evil.com',
        email_verified: true,
      });

      const app = createTestApp(verifier);
      const res = await request(app).post('/api/admin/login').send({ idToken: 'valid-token' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied');
    });

    it('rejects unverified Google email with 403 Forbidden', async () => {
      const verifier: GoogleTokenVerifier = async () => ({
        email: adminEmail,
        email_verified: false,
      });

      const app = createTestApp(verifier);
      const res = await request(app).post('/api/admin/login').send({ idToken: 'unverified-token' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('not verified');
    });

    it('logs in authorized Google admin and issues HMAC-signed session cookie', async () => {
      const verifier: GoogleTokenVerifier = async () => ({
        email: adminEmail,
        email_verified: true,
      });

      const app = createTestApp(verifier);
      const res = await request(app).post('/api/admin/login').send({ idToken: 'valid-token' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.email).toBe(adminEmail);

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toContain(ADMIN_COOKIE_NAME);
      expect(cookies[0]).toContain('HttpOnly');
      expect(cookies[0]).toContain('SameSite=Strict');
    });

    it('allows dev bypass in non-production when configured', async () => {
      const app = createTestApp(undefined, true);
      const res = await request(app).post('/api/admin/login').send({ devBypass: true });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const cookies = res.headers['set-cookie'];
      expect(cookies[0]).toContain(ADMIN_COOKIE_NAME);
    });

    it('blocks dev bypass when DEV_ADMIN_BYPASS is false, NODE_ENV is production, or K_SERVICE is present', async () => {
      // 1. DEV_ADMIN_BYPASS is false
      const app1 = createTestApp(undefined, false);
      const res1 = await request(app1).post('/api/admin/login').send({ devBypass: true });
      expect(res1.status).toBe(401);

      // 2. K_SERVICE is set (Cloud Run simulation)
      const configKService = loadConfig({
        K_SERVICE: 'storyteller-run-service',
        SESSION_SECRET: sessionSecret,
        DEV_ADMIN_BYPASS: 'true',
      });
      expect(configKService.allowDevBypass).toBe(false);
      const app2 = createApp({ config: configKService, storage });
      const res2 = await request(app2).post('/api/admin/login').send({ devBypass: true });
      expect(res2.status).toBe(401);

      // 3. NODE_ENV is production
      const configProd = loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: sessionSecret,
        DEV_ADMIN_BYPASS: 'true',
      });
      expect(configProd.allowDevBypass).toBe(false);
      const app3 = createApp({ config: configProd, storage });
      const res3 = await request(app3).post('/api/admin/login').send({ devBypass: true });
      expect(res3.status).toBe(401);
    });

    it('requireAdmin middleware rejects unauthenticated probe request with 401', async () => {
      const app = createTestApp();
      const res = await request(app).get('/api/admin/stories');
      expect(res.status).toBe(401);
    });

    it('requireAdmin middleware rejects tampered cookie signature with 401', async () => {
      const app = createTestApp();
      const validCookie = signAdminSession(adminEmail, sessionSecret);
      const tamperedCookie = validCookie.slice(0, -4) + 'abcd';

      const res = await request(app)
        .get('/api/admin/stories')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${tamperedCookie}`]);

      expect(res.status).toBe(401);
    });

    it('requireAdmin middleware rejects expired session cookie with 401', async () => {
      const app = createTestApp();
      // Sign with negative maxAge to simulate expired token
      const expiredCookie = signAdminSession(adminEmail, sessionSecret, -1000);

      const res = await request(app)
        .get('/api/admin/stories')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${expiredCookie}`]);

      expect(res.status).toBe(401);
    });

    it('authenticated admin can access protected probe route /api/admin/stories and log out', async () => {
      await seedTestStories();
      const app = createTestApp();
      const validCookie = signAdminSession(adminEmail, sessionSecret);

      // Probe route returns stories
      const resProbe = await request(app)
        .get('/api/admin/stories')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${validCookie}`]);

      expect(resProbe.status).toBe(200);
      expect(resProbe.body.length).toBe(2);

      // GET /api/admin/me returns authenticated status
      const resMe = await request(app)
        .get('/api/admin/me')
        .set('Cookie', [`${ADMIN_COOKIE_NAME}=${validCookie}`]);
      expect(resMe.status).toBe(200);
      expect(resMe.body.authenticated).toBe(true);
      expect(resMe.body.email).toBe(adminEmail);

      // POST /api/admin/logout clears cookie
      const resLogout = await request(app).post('/api/admin/logout');
      expect(resLogout.status).toBe(200);
      expect(resLogout.headers['set-cookie'][0]).toContain('Max-Age=0');
    });
  });

  /* -------------------------------------------------------------------------
   * 7. Configuration Safety Checks
   * ----------------------------------------------------------------------- */
  describe('Config Startup Safety', () => {
    it('throws error at startup in production or Cloud Run if SESSION_SECRET is missing or < 32 chars', () => {
      expect(() => {
        loadConfig({
          NODE_ENV: 'production',
          SESSION_SECRET: 'short-secret',
        });
      }).toThrow('SESSION_SECRET must be at least 32 characters');

      expect(() => {
        loadConfig({
          K_SERVICE: 'storyteller',
          SESSION_SECRET: '',
        });
      }).toThrow('SESSION_SECRET must be at least 32 characters');
    });
  });
});
