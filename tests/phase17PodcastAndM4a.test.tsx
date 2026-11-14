// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { wrapPcmAsWav, SAMPLE_RATE } from '../server/lib/wav.js';
import { transcodeWavToM4a } from '../server/lib/m4a.js';
import { migrateWavToM4a } from '../scripts/migrateWavToM4a.js';
import type {
  TtsProvider,
  SynthesizeBatchRequest,
  PromptedVoiceRequest,
  PromptedVoiceResponse,
} from '../server/services/geminiTts.js';
import type { CatalogItem, PodcastConfig, Story, VoiceEntry } from '../shared/types.js';
import { PodcastLibraryPage } from '../client/components/PodcastLibraryPage.js';
import { VoiceStudioPanel } from '../client/components/VoiceStudioPanel.js';
import { StoryReader } from '../client/components/StoryReader.js';

function createToneWav(durationSec = 1, freq = 440): Buffer {
  const numSamples = Math.floor(SAMPLE_RATE * durationSec);
  const pcm = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.2;
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return wrapPcmAsWav(pcm).wav;
}

class MockTtsProvider implements TtsProvider {
  async synthesizeBatch(_req: SynthesizeBatchRequest): Promise<Buffer> {
    return createToneWav(0.3, 523.25);
  }

  async createPromptedVoice(_req: PromptedVoiceRequest): Promise<PromptedVoiceResponse> {
    return {
      geminiVoiceName: `voice_mock_${Date.now()}`,
      sampleAudioWav: createToneWav(0.2, 440),
    };
  }
}

describe('Phase 17: FFmpeg M4A Streaming, Lossless WAV Download, Migration & Podcast RSS Engine', () => {
  let tmpDir: string;
  let storage: LocalStorageAdapter;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-phase17-'));
    const config = loadConfig({
      DATA_DIR: tmpDir,
      NODE_ENV: 'test',
      DEV_ADMIN_BYPASS: 'true',
      ADMIN_GOOGLE_EMAIL: 'curator@storyteller.studio',
      GEMINI_API_KEY: 'test-key',
    });

    storage = new LocalStorageAdapter(tmpDir);
    app = createApp({
      config,
      storage,
      ttsProvider: new MockTtsProvider(),
    });

    const starterVoices: VoiceEntry[] = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Kore',
        description: 'Warm bedtime narrator',
        language_code: 'en-US',
        tags: ['warm'],
        created_at: '2026-11-04T00:00:00.000Z',
      },
    ];
    await storage.saveVoices(starterVoices);

    const loginRes = await request(app).post('/api/admin/login').send({ devBypass: true });
    expect(loginRes.status).toBe(200);
    const cookieHeader = loginRes.headers['set-cookie'];
    adminCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /* -------------------------------------------------------------------------
   * 1. FFmpeg .m4a Transcoding & TTS Synthesis Integration
   * ----------------------------------------------------------------------- */
  it('transcodes WAV to faststart M4A with ftyp header and moov atom preceding mdat', async () => {
    const wav = createToneWav(1, 587.33);
    const m4a = await transcodeWavToM4a(wav);

    expect(m4a.length).toBeGreaterThan(100);
    expect(m4a.subarray(4, 8).toString('ascii')).toBe('ftyp');
    const moovOffset = m4a.indexOf('moov');
    const mdatOffset = m4a.indexOf('mdat');
    expect(moovOffset).toBeGreaterThan(0);
    expect(mdatOffset).toBeGreaterThan(moovOffset);
  });

  it('synthesizeFullStory writes both .m4a and .wav, defaults audio_url to .m4a, and streams 200/206 + lossless ?download=1', async () => {
    const story: Story = {
      id: 'p17-synth-story',
      status: 'draft',
      title: 'The Lantern Boat',
      summary: 'A sleepy boat drifts across the silver pond.',
      tags: ['bedtime'],
      series_context: { series_id: 'pond-tales', episode_number: 3 },
      characters: [],
      script_turns: [
        {
          turn_id: 1,
          speaker: 'Narrator',
          style: 'Warm and gentle',
          text: 'Across the quiet pond drifted a tiny paper lantern boat.',
        },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: '2026-11-10T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    };
    await storage.saveStory(story);

    const res = await request(app)
      .post('/api/admin/stories/p17-synth-story/synthesize')
      .set('Cookie', [adminCookie])
      .send({
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {},
        },
        label: 'Kore Bedtime',
        makeDefault: true,
      });

    expect(res.status).toBe(201);
    const updated: Story = res.body;
    expect(updated.audio_versions).toHaveLength(1);
    const ver = updated.audio_versions[0];

    expect(ver.audio_url).toBe(`/api/stories/p17-synth-story/audios/${ver.version_id}.m4a`);
    expect(ver.wav_url).toBe(`/api/stories/p17-synth-story/audios/${ver.version_id}.wav`);
    expect(ver.m4a_size_bytes).toBeGreaterThan(0);

    // Verify both files exist in storage
    const m4aStream = await storage.getAudioM4aStream('p17-synth-story', ver.version_id);
    const wavStream = await storage.getAudioStream('p17-synth-story', ver.version_id);
    expect(m4aStream.totalBytes).toBe(ver.m4a_size_bytes);
    expect(wavStream.totalBytes).toBeGreaterThan(44);

    // Stream .m4a (200 & 206)
    const m4a200 = await request(app).get(ver.audio_url);
    expect(m4a200.status).toBe(200);
    expect(m4a200.headers['content-type']).toBe('audio/mp4');
    expect(m4a200.headers['accept-ranges']).toBe('bytes');

    const m4a206 = await request(app).get(ver.audio_url).set('Range', 'bytes=0-31');
    expect(m4a206.status).toBe(206);
    expect(m4a206.headers['content-type']).toBe('audio/mp4');
    expect(m4a206.headers['content-range']).toBe(`bytes 0-31/${ver.m4a_size_bytes}`);

    // Lossless .wav download with ?download=1
    const wavDl = await request(app).get(`${ver.wav_url}?download=1`);
    expect(wavDl.status).toBe(200);
    expect(wavDl.headers['content-type']).toBe('audio/wav');
    expect(wavDl.headers['content-disposition']).toContain('attachment');
    expect(wavDl.headers['content-disposition']).toContain(`p17-synth-story-${ver.version_id}.wav`);
  });

  /* -------------------------------------------------------------------------
   * 2. Automated .wav -> .m4a Migration Script
   * ----------------------------------------------------------------------- */
  it('migrateWavToM4a converts legacy .wav-only stories to .m4a and updates story.json + catalog.json', async () => {
    const wav = createToneWav(0.8, 440);
    const legacyStory: Story = {
      id: 'legacy-wav-story',
      status: 'published',
      title: 'Legacy Moonlight Train',
      summary: 'A legacy story originally saved with .wav only.',
      tags: ['bedtime'],
      series_context: null,
      characters: [],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: 'Calm', text: 'Choo choo under the stars.' },
      ],
      voice_candidates: [],
      audio_versions: [
        {
          version_id: 'v1',
          label: 'Legacy Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 1,
          audio_url: '/api/stories/legacy-wav-story/audios/v1.wav',
          created_at: '2026-11-01T00:00:00.000Z',
        },
      ],
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
    };
    const legacyCatalog: CatalogItem[] = [
      {
        id: legacyStory.id,
        status: 'published',
        title: legacyStory.title,
        summary: legacyStory.summary,
        tags: legacyStory.tags,
        series_id: null,
        episode_number: null,
        created_at: legacyStory.created_at,
        updated_at: legacyStory.updated_at,
        default_audio_url: '/api/stories/legacy-wav-story/audios/v1.wav',
        audio_versions_count: 1,
      },
    ];
    await storage.saveStory(legacyStory);
    await storage.saveAudio(legacyStory.id, 'v1', wav);
    await storage.saveCatalog(legacyCatalog);

    const firstRun = await migrateWavToM4a(storage);
    expect(firstRun.migratedCount).toBe(1);
    expect(firstRun.errorCount).toBe(0);

    const m4aDesc = await storage.getAudioM4aStream('legacy-wav-story', 'v1');
    expect(m4aDesc.totalBytes).toBeGreaterThan(100);

    const migratedStory = await storage.getStory('legacy-wav-story');
    expect(migratedStory.audio_versions[0].audio_url).toBe('/api/stories/legacy-wav-story/audios/v1.m4a');
    expect(migratedStory.audio_versions[0].wav_url).toBe('/api/stories/legacy-wav-story/audios/v1.wav');
    expect(migratedStory.audio_versions[0].m4a_size_bytes).toBe(m4aDesc.totalBytes);

    const migratedCatalog = await storage.getCatalog();
    expect(migratedCatalog[0].default_audio_url).toBe('/api/stories/legacy-wav-story/audios/v1.m4a');

    // Second run is idempotent and skips already-migrated files
    const secondRun = await migrateWavToM4a(storage);
    expect(secondRun.migratedCount).toBe(0);
    expect(secondRun.skippedCount).toBe(1);
  });

  /* -------------------------------------------------------------------------
   * 3. Dynamic Bucket-Driven Podcast Discovery, Deduplication & RSS Feed XML
   * ----------------------------------------------------------------------- */
  it('dynamically discovers bucket-dropped podcast.json + cover art and supports CRUD', async () => {
    const droppedDir = path.join(tmpDir, 'podcasts', 'bucket-dropped');
    await fs.promises.mkdir(droppedDir, { recursive: true });
    const droppedConfig: PodcastConfig = {
      id: 'bucket-dropped',
      title: 'Bucket Dropped Tales',
      author: 'Studio Curator',
      description: 'Discovered straight from storage',
      language: 'en-us',
      token: 'secret-token-123',
      episodes: [],
      created_at: '2026-11-10T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    };
    await fs.promises.writeFile(
      path.join(droppedDir, 'podcast.json'),
      JSON.stringify(droppedConfig, null, 2)
    );
    await fs.promises.writeFile(path.join(droppedDir, 'cover.jpg'), Buffer.from('FAKEJPGDATA'));

    const listRes = await request(app).get('/api/admin/podcasts').set('Cookie', [adminCookie]);
    expect(listRes.status).toBe(200);
    expect(listRes.body.podcasts).toHaveLength(1);
    expect(listRes.body.podcasts[0].id).toBe('bucket-dropped');
    expect(listRes.body.podcasts[0].cover_image_url).toBe('/api/podcasts/bucket-dropped/cover.jpg');

    // Cover image streaming
    const coverRes = await request(app).get('/api/podcasts/bucket-dropped/cover.jpg');
    expect(coverRes.status).toBe(200);
    expect(coverRes.headers['content-type']).toBe('image/jpeg');

    // Create new podcast via POST
    const createRes = await request(app)
      .post('/api/admin/podcasts')
      .set('Cookie', [adminCookie])
      .send({
        title: "Leo's Bedtime Stories",
        author: 'Dad',
        description: 'Cozy nightly stories',
      });
    expect(createRes.status).toBe(201);
    const created: PodcastConfig = createRes.body;
    expect(created.id).toBe('leo-s-bedtime-stories');
    expect(created.token).toMatch(/^[a-f0-9]{24}$/);

    // PATCH metadata & rotate token
    const patchRes = await request(app)
      .patch(`/api/admin/podcasts/${created.id}`)
      .set('Cookie', [adminCookie])
      .send({ title: 'Leo Nightly Feed', regenerateToken: true });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.title).toBe('Leo Nightly Feed');
    expect(patchRes.body.token).not.toBe(created.token);

    // DELETE podcast
    const delRes = await request(app)
      .delete(`/api/admin/podcasts/${created.id}`)
      .set('Cookie', [adminCookie]);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deletedId).toBe(created.id);
  });

  it('enforces deduplication, private token guard, HTTPS proxy RSS XML, draft/deleted filtering & version cleanup', async () => {
    const wav = createToneWav(0.5, 440);
    const m4a = await transcodeWavToM4a(wav);

    const story: Story = {
      id: 'rss-story-1',
      status: 'draft', // Starts as draft with synthesized audio; releasing promotes to published
      title: 'The Moonlit Fox & Star',
      summary: 'A fox discovers a twinkling lantern <under> the pines.',
      tags: ['fox'],
      series_context: { series_id: 'woodland', episode_number: 2 },
      characters: [],
      script_turns: [{ turn_id: 1, speaker: 'Narrator', style: 'Soft', text: 'Once upon a night.' }],
      voice_candidates: [],
      audio_versions: [
        {
          version_id: 'v1',
          label: 'Kore Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 12,
          audio_url: '/api/stories/rss-story-1/audios/v1.m4a',
          wav_url: '/api/stories/rss-story-1/audios/v1.wav',
          m4a_size_bytes: m4a.length,
          created_at: '2026-11-10T00:00:00.000Z',
        },
        {
          version_id: 'v2',
          label: 'Aoede Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: false,
          duration_sec: 15,
          audio_url: '/api/stories/rss-story-1/audios/v2.m4a',
          wav_url: '/api/stories/rss-story-1/audios/v2.wav',
          m4a_size_bytes: m4a.length,
          created_at: '2026-11-10T01:00:00.000Z',
        },
      ],
      created_at: '2026-11-10T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    };
    await storage.saveStory(story);
    await storage.saveAudio(story.id, 'v1', wav);
    await storage.saveAudioM4a(story.id, 'v1', m4a);
    await storage.saveAudio(story.id, 'v2', wav);
    await storage.saveAudioM4a(story.id, 'v2', m4a);

    const createPod = await request(app)
      .post('/api/admin/podcasts')
      .set('Cookie', [adminCookie])
      .send({ id: 'family-feed', title: 'Family Feed', token: 'top-secret-tok' });
    expect(createPod.status).toBe(201);

    // Release v1 (auto-publishes story)
    const rel1 = await request(app)
      .post('/api/admin/podcasts/family-feed/episodes')
      .set('Cookie', [adminCookie])
      .send({ storyId: 'rss-story-1', versionId: 'v1' });
    expect(rel1.status).toBe(200);
    expect(rel1.body.episodes).toHaveLength(1);
    expect(rel1.body.episodes[0].version_id).toBe('v1');

    const promotedStory = await storage.getStory('rss-story-1');
    expect(promotedStory.status).toBe('published');

    // Releasing the SAME storyId with v2 updates in-place with ZERO duplicates
    const rel2 = await request(app)
      .post('/api/admin/podcasts/family-feed/episodes')
      .set('Cookie', [adminCookie])
      .send({ storyId: 'rss-story-1', versionId: 'v2' });
    expect(rel2.status).toBe(200);
    expect(rel2.body.episodes).toHaveLength(1);
    expect(rel2.body.episodes[0].version_id).toBe('v2');

    // Feed rejects missing or invalid token with 403
    const noTok = await request(app).get('/api/podcasts/family-feed/feed.xml');
    expect(noTok.status).toBe(403);
    const badTok = await request(app).get('/api/podcasts/family-feed/feed.xml?token=wrong');
    expect(badTok.status).toBe(403);

    // Valid token returns valid RSS 2.0 XML respecting x-forwarded-proto & x-forwarded-host
    const feedRes = await request(app)
      .get('/api/podcasts/family-feed/feed.xml?token=top-secret-tok')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'stories.example.com');
    expect(feedRes.status).toBe(200);
    expect(feedRes.headers['content-type']).toContain('application/rss+xml');
    expect(feedRes.text).toContain('<title>The Moonlit Fox &amp; Star</title>');
    expect(feedRes.text).toContain('&lt;under&gt;');
    expect(feedRes.text).toContain('<itunes:duration>15</itunes:duration>');
    expect(feedRes.text).toContain('<itunes:episode>2</itunes:episode>');
    expect(feedRes.text).toContain('<pubDate>');
    expect(feedRes.text).toContain(
      `<enclosure url="https://stories.example.com/api/stories/rss-story-1/audios/v2.m4a" length="${m4a.length}" type="audio/x-m4a" />`
    );

    // Deleting v2 updates podcast episode pointer to new default (v1)
    const delVerRes = await request(app)
      .delete('/api/admin/stories/rss-story-1/versions/v2')
      .set('Cookie', [adminCookie]);
    expect(delVerRes.status).toBe(200);

    const updatedPodcast = await storage.getPodcast('family-feed');
    expect(updatedPodcast.episodes).toHaveLength(1);
    expect(updatedPodcast.episodes[0].version_id).toBe('v1');

    // Reverting story to draft omits it from feed.xml
    await request(app)
      .patch('/api/admin/stories/rss-story-1/status')
      .set('Cookie', [adminCookie])
      .send({ status: 'draft' });
    const draftFeed = await request(app).get('/api/podcasts/family-feed/feed.xml?token=top-secret-tok');
    expect(draftFeed.status).toBe(200);
    expect(draftFeed.text).not.toContain('<item>');

    // Deleting story cleans up episode entry on podcast.json
    const delStory = await request(app)
      .delete('/api/admin/stories/rss-story-1')
      .set('Cookie', [adminCookie]);
    expect(delStory.status).toBe(200);
    const cleanedPodcast = await storage.getPodcast('family-feed');
    expect(cleanedPodcast.episodes).toHaveLength(0);
  });

  /* -------------------------------------------------------------------------
   * 4. Frontend UI Tests (PodcastLibraryPage, VoiceStudioPanel, StoryReader)
   * ----------------------------------------------------------------------- */
  it('VoiceStudioPanel hides Podcast Release when podcasts is empty and renders it when >= 1 podcast exists + renders WAV download link', async () => {
    const sampleStory: Story = {
      id: 'ui-story-1',
      status: 'published',
      title: 'Sleepy Harbor',
      summary: 'A quiet boat story.',
      tags: ['bedtime'],
      series_context: null,
      characters: [],
      script_turns: [{ turn_id: 1, speaker: 'Narrator', style: 'Calm', text: 'Goodnight harbor.' }],
      voice_candidates: [],
      audio_versions: [
        {
          version_id: 'v1-kore',
          label: 'Kore Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 45,
          audio_url: '/api/stories/ui-story-1/audios/v1-kore.m4a',
          wav_url: '/api/stories/ui-story-1/audios/v1-kore.wav',
          m4a_size_bytes: 12345,
          created_at: '2026-11-10T00:00:00.000Z',
        },
      ],
      created_at: '2026-11-10T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    };

    const voicesPayload: VoiceEntry[] = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Kore',
        description: 'Warm',
        language_code: 'en-US',
        tags: [],
        created_at: '2026-11-04T00:00:00.000Z',
      },
    ];

    // 1. Empty podcasts -> section hidden
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/admin/voices')) {
          return new Response(JSON.stringify(voicesPayload), { status: 200 });
        }
        if (url.includes('/api/admin/podcasts')) {
          return new Response(JSON.stringify({ podcasts: [] }), { status: 200 });
        }
        if (url.includes('/api/admin/jobs/active')) {
          return new Response(JSON.stringify({ activeJobs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const { unmount } = render(
      <VoiceStudioPanel story={sampleStory} onStoryUpdated={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('download-wav-v1-kore')).toHaveAttribute(
        'href',
        '/api/stories/ui-story-1/audios/v1-kore.wav?download=1'
      );
    });
    expect(screen.queryByTestId('story-podcast-release-panel')).not.toBeInTheDocument();
    unmount();

    // 2. >= 1 podcast -> section visible
    const mockPodcasts: PodcastConfig[] = [
      {
        id: 'leo-feed',
        title: "Leo's Bedtime",
        author: 'Studio',
        description: 'Nightly tales',
        language: 'en-us',
        token: 'tok123',
        episodes: [],
        created_at: '2026-11-10T00:00:00.000Z',
        updated_at: '2026-11-10T00:00:00.000Z',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/admin/voices')) {
          return new Response(JSON.stringify(voicesPayload), { status: 200 });
        }
        if (url.includes('/api/admin/podcasts')) {
          return new Response(JSON.stringify({ podcasts: mockPodcasts }), { status: 200 });
        }
        if (url.includes('/api/admin/jobs/active')) {
          return new Response(JSON.stringify({ activeJobs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    render(<VoiceStudioPanel story={sampleStory} onStoryUpdated={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId('story-podcast-release-panel')).toBeInTheDocument();
      expect(screen.getByTestId('podcast-release-btn-leo-feed')).toBeInTheDocument();
    });
  });

  it('PodcastLibraryPage renders podcasts, creates a new podcast, copies RSS link, switches version, and unreleases episode', async () => {
    const initialStory: Story = {
      id: 'story-a',
      status: 'published',
      title: 'Sleepy Train',
      summary: 'Choo choo.',
      tags: ['train'],
      series_context: null,
      characters: [],
      script_turns: [{ turn_id: 1, speaker: 'Narrator', style: '', text: 'Roll along.' }],
      voice_candidates: [],
      audio_versions: [
        {
          version_id: 'v1',
          label: 'Kore Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 30,
          audio_url: '/api/stories/story-a/audios/v1.m4a',
          created_at: '2026-11-10T00:00:00.000Z',
        },
        {
          version_id: 'v2',
          label: 'Aoede Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: false,
          duration_sec: 35,
          audio_url: '/api/stories/story-a/audios/v2.m4a',
          created_at: '2026-11-10T01:00:00.000Z',
        },
      ],
      created_at: '2026-11-10T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    };

    let currentPodcasts: PodcastConfig[] = [
      {
        id: 'bedtime-show',
        title: 'Bedtime Show',
        author: 'Studio',
        description: 'Cozy feed',
        language: 'en-us',
        token: 'abc123token',
        episodes: [{ story_id: 'story-a', version_id: 'v1', published_at: '2026-11-10T00:00:00.000Z' }],
        created_at: '2026-11-10T00:00:00.000Z',
        updated_at: '2026-11-10T00:00:00.000Z',
      },
    ];

    const writeTextMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();

        if (url === '/api/admin/podcasts' && method === 'GET') {
          return new Response(JSON.stringify({ podcasts: currentPodcasts }), { status: 200 });
        }
        if (url === '/api/admin/podcasts' && method === 'POST') {
          const body = JSON.parse(String(init?.body || '{}'));
          const newPod: PodcastConfig = {
            id: 'new-show',
            title: body.title,
            author: body.author || 'Storyteller Studio',
            description: body.description || body.title,
            language: 'en-us',
            token: 'newtok999',
            episodes: [],
            created_at: '2026-11-11T00:00:00.000Z',
            updated_at: '2026-11-11T00:00:00.000Z',
          };
          currentPodcasts = [newPod, ...currentPodcasts];
          return new Response(JSON.stringify(newPod), { status: 201 });
        }
        if (url === '/api/admin/podcasts/bedtime-show/episodes' && method === 'POST') {
          const body = JSON.parse(String(init?.body || '{}'));
          const updated: PodcastConfig = {
            ...currentPodcasts.find((p) => p.id === 'bedtime-show')!,
            episodes: [
              {
                story_id: body.storyId,
                version_id: body.versionId || 'v1',
                published_at: '2026-11-11T00:00:00.000Z',
              },
            ],
          };
          currentPodcasts = currentPodcasts.map((p) => (p.id === 'bedtime-show' ? updated : p));
          return new Response(JSON.stringify(updated), { status: 200 });
        }
        if (url === '/api/admin/podcasts/bedtime-show/episodes/story-a' && method === 'DELETE') {
          const updated: PodcastConfig = {
            ...currentPodcasts.find((p) => p.id === 'bedtime-show')!,
            episodes: [],
          };
          currentPodcasts = currentPodcasts.map((p) => (p.id === 'bedtime-show' ? updated : p));
          return new Response(JSON.stringify(updated), { status: 200 });
        }
        if (url.startsWith('/api/catalog')) {
          return new Response(
            JSON.stringify([
              {
                id: 'story-a',
                status: 'published',
                title: 'Sleepy Train',
                summary: 'Choo choo.',
                tags: ['train'],
                series_id: null,
                episode_number: null,
                created_at: '2026-11-10T00:00:00.000Z',
                updated_at: '2026-11-10T00:00:00.000Z',
                default_audio_url: '/api/stories/story-a/audios/v1.m4a',
                audio_versions_count: 2,
              },
            ]),
            { status: 200 }
          );
        }
        if (url === '/api/stories/story-a') {
          return new Response(JSON.stringify(initialStory), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      })
    );

    render(
      <PodcastLibraryPage
        session={{ authenticated: true, devBypassEnabled: true }}
        onLogout={() => {}}
        onNavigate={() => {}}
        onNavigateHome={() => {}}
      />
    );

    // Discovered podcast renders
    await waitFor(() => {
      expect(screen.getByTestId('podcast-card-bedtime-show')).toBeInTheDocument();
      expect(screen.getByTestId('podcast-episode-bedtime-show-story-a')).toBeInTheDocument();
    });

    // Copy RSS link
    fireEvent.click(screen.getByTestId('copy-rss-link-bedtime-show'));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/podcasts/bedtime-show/feed.xml?token=abc123token')
      );
    });

    // Switch episode version to v2
    fireEvent.change(screen.getByTestId('episode-version-select-bedtime-show-story-a'), {
      target: { value: 'v2' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('episode-version-select-bedtime-show-story-a')).toHaveValue('v2');
    });

    // Unrelease episode
    fireEvent.click(screen.getByTestId('unrelease-episode-bedtime-show-story-a'));
    await waitFor(() => {
      expect(screen.queryByTestId('podcast-episode-bedtime-show-story-a')).not.toBeInTheDocument();
    });

    // Create new podcast
    fireEvent.click(screen.getByTestId('new-podcast-btn'));
    fireEvent.change(screen.getByTestId('podcast-title-input'), {
      target: { value: 'New Family Show' },
    });
    fireEvent.click(screen.getByTestId('save-podcast-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('podcast-card-new-show')).toBeInTheDocument();
    });
  });

  it('StoryReader renders reader and admin lossless .wav download links pointing to .wav?download=1', () => {
    const story: Story = {
      id: 'reader-wav-story',
      status: 'published',
      title: 'The Silver Bell',
      summary: 'A silver bell rings softly.',
      tags: ['bedtime'],
      series_context: null,
      characters: [],
      script_turns: [{ turn_id: 1, speaker: 'Narrator', style: '', text: 'Ding dong.' }],
      voice_candidates: [],
      audio_versions: [
        {
          version_id: 'v1-bell',
          label: 'Kore Solo',
          casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {} },
          is_default: true,
          duration_sec: 20,
          audio_url: '/api/stories/reader-wav-story/audios/v1-bell.m4a',
          wav_url: '/api/stories/reader-wav-story/audios/v1-bell.wav',
          created_at: '2026-11-10T00:00:00.000Z',
        },
      ],
      created_at: '2026-11-10T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    };

    render(
      <StoryReader
        story={story}
        isAdmin={true}
        activeAudioVersion={story.audio_versions[0]}
        onBack={() => {}}
      />
    );

    expect(screen.getByTestId('reader-download-wav-btn')).toHaveAttribute(
      'href',
      '/api/stories/reader-wav-story/audios/v1-bell.wav?download=1'
    );
    expect(screen.getByTestId('admin-download-wav-v1-bell')).toHaveAttribute(
      'href',
      '/api/stories/reader-wav-story/audios/v1-bell.wav?download=1'
    );
  });
});
