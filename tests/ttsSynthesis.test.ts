import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { wrapPcmAsWav } from '../server/lib/wav.js';
import type {
  TtsProvider,
  SynthesizeBatchRequest,
  PromptedVoiceRequest,
  PromptedVoiceResponse,
} from '../server/services/geminiTts.js';
import type { Story, VoiceEntry } from '../shared/types.js';
import { DEFAULT_VOICE_SAMPLE } from '../shared/voiceSamples.js';

class MockTtsProvider implements TtsProvider {
  public synthesizeCalls: SynthesizeBatchRequest[] = [];
  public createVoiceCalls: PromptedVoiceRequest[] = [];
  public batchPcmLength = 9600; // 0.2s of 24kHz 16-bit mono PCM

  async synthesizeBatch(req: SynthesizeBatchRequest): Promise<Buffer> {
    this.synthesizeCalls.push(req);
    const mockPcm = Buffer.alloc(this.batchPcmLength, 0x11);
    const { wav } = wrapPcmAsWav(mockPcm);
    return wav;
  }

  async createPromptedVoice(req: PromptedVoiceRequest): Promise<PromptedVoiceResponse> {
    this.createVoiceCalls.push(req);
    const mockSample = Buffer.alloc(2400, 0x22);
    const { wav } = wrapPcmAsWav(mockSample);
    return {
      geminiVoiceName: `voice_mock_${Date.now()}`,
      sampleAudioWav: wav,
    };
  }
}

describe('Phase 4: Gemini 3.8 TTS Engine, Voice Studio & Version Management', () => {
  let tmpDir: string;
  let mockTts: MockTtsProvider;
  let storage: LocalStorageAdapter;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-tts-test-'));

    const config = loadConfig({
      DATA_DIR: tmpDir,
      NODE_ENV: 'test',
      DEV_ADMIN_BYPASS: 'true',
      ADMIN_GOOGLE_EMAIL: 'curator@storyteller.studio',
      GEMINI_API_KEY: 'test-key',
    });

    storage = new LocalStorageAdapter(tmpDir);
    mockTts = new MockTtsProvider();

    app = createApp({
      config,
      storage,
      ttsProvider: mockTts,
    });

    // Seed starter voices in temp voices.json
    const starterVoices: VoiceEntry[] = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Kore',
        description: 'Warm, clear, expressive storytelling voice',
        language_code: 'en-US',
        tags: ['warm', 'expressive', 'storytelling'],
        created_at: new Date().toISOString(),
      },
      {
        id: 'prebuilt-puck',
        label: 'Puck (Playful Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Puck',
        description: 'Gentle, curious, melodic voice',
        language_code: 'en-US',
        tags: ['curious', 'gentle'],
        created_at: new Date().toISOString(),
      },
      {
        id: 'prebuilt-aoede',
        label: 'Aoede (Breezy Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Aoede',
        description: 'Soft whispery bedtime timbre',
        language_code: 'en-US',
        tags: ['soft', 'whisper'],
        created_at: new Date().toISOString(),
      },
    ];
    await storage.saveVoices(starterVoices);

    // Obtain admin session cookie
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send({ devBypass: true });
    expect(loginRes.status).toBe(200);
    const cookieHeader = loginRes.headers['set-cookie'];
    adminCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // ==========================================
  // Gate 1: Long-Story Batching & RIFF De-duplication Test
  // ==========================================
  it('Gate 1: synthesizes a 28-turn story in solo mode across 3 batches with RIFF de-duplication and 150ms silence padding', async () => {
    // 28-turn story: 12 + 12 + 4 turns
    const turns = Array.from({ length: 28 }, (_, i) => ({
      turn_id: i + 1,
      speaker: i % 3 === 0 ? 'Bibi' : 'Narrator',
      style: `Calm delivery turn ${i + 1}`,
      text: `This is bedtime sentence number ${i + 1} with peaceful thoughts of star-lit meadows.`,
    }));

    const story: Story = {
      id: 'gate1-long-story',
      status: 'draft',
      title: 'The Great Star Journey',
      summary: 'A 28-turn bedtime odyssey across twilight hills.',
      tags: ['stars', 'journey'],
      series_context: {
        series_id: 'star-voyager',
        episode_number: 1,
      },
      characters: [
        {
          name: 'Bibi',
          traits: 'Gentle bell chime whistle, sleepy locomotive',
        },
      ],
      script_turns: turns,
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await storage.saveStory(story);

    const res = await request(app)
      .post('/api/admin/stories/gate1-long-story/synthesize')
      .set('Cookie', adminCookie)
      .send({
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {},
        },
        label: 'Full Bedtime Reading',
        makeDefault: true,
      });

    expect(res.status).toBe(201);
    const synthesizedStory: Story = res.body;

    // 1. Assert provider calls: 28 turns divided into batches of <= 6 -> 5 calls (6 + 6 + 6 + 6 + 4)
    expect(mockTts.synthesizeCalls).toHaveLength(5);
    expect(mockTts.synthesizeCalls[0].parts).toHaveLength(6);
    expect(mockTts.synthesizeCalls[1].parts).toHaveLength(6);
    expect(mockTts.synthesizeCalls[2].parts).toHaveLength(6);
    expect(mockTts.synthesizeCalls[3].parts).toHaveLength(6);
    expect(mockTts.synthesizeCalls[4].parts).toHaveLength(4);

    // In solo mode, every turn part's speaker MUST be "Narrator"
    for (const call of mockTts.synthesizeCalls) {
      for (const part of call.parts) {
        expect(part.speechMetadata?.speaker).toBe('Narrator');
      }
      // Single-speaker voice config
      expect(call.speechConfig.voiceConfig).toEqual({
        prebuiltVoiceConfig: { voiceName: 'Kore' },
      });
      expect(call.speechConfig.multiSpeakerVoiceConfig).toBeUndefined();
    }

    // Check that Bibi's turn has character traits folded into speechMetadata.style
    const turn1Part = mockTts.synthesizeCalls[0].parts[0]; // Turn 1 (i=0) speaker was Bibi
    expect(turn1Part.speechMetadata?.style).toContain('Speaking dialogue as Bibi (Gentle bell chime whistle, sleepy locomotive):');

    // 2. Verify saved audio WAV on disk
    expect(synthesizedStory.audio_versions).toHaveLength(1);
    const version = synthesizedStory.audio_versions[0];
    expect(version.is_default).toBe(true);

    const wavPath = path.join(tmpDir, 'stories', 'gate1-long-story', 'audios', `${version.version_id}.wav`);
    const savedWav = await fs.promises.readFile(wavPath);

    // Exactly one RIFF header at offset 0
    expect(savedWav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(savedWav.indexOf('RIFF', 4)).toBe(-1); // Zero mid-stream embedded RIFF headers!

    // Exact byte size: 44 header + 5 * batchPcm (9600) + 4 * silence150ms (7200)
    const expectedByteSize = 44 + 5 * 9600 + 4 * 7200;
    expect(savedWav.length).toBe(expectedByteSize);
    expect(version.duration_sec).toBeGreaterThan(0);
    expect(synthesizedStory.status).toBe('published');
    expect(synthesizedStory.series_context?.preferred_voice_id).toBe('prebuilt-kore');
  });

  // ==========================================
  // Gate 2: 3-Speaker Cast Mode Sub-Batching Test (Exact-2 Rule)
  // ==========================================
  it('Gate 2: synthesizes a 3-character story in cast mode without exceeding 2 speakers per call, using single voiceConfig for 1-speaker batches', async () => {
    // Turns intentionally designed to produce:
    // Sub-batch 1: Narrator, Bibi (2 speakers -> multiSpeakerVoiceConfig with length 2)
    // Sub-batch 2: Owl, Owl (1 speaker -> single-speaker voiceConfig!)
    // Sub-batch 3: Bibi, Owl (2 speakers -> multiSpeakerVoiceConfig with length 2)
    const turns = [
      { turn_id: 1, speaker: 'Narrator', style: '', text: 'The woods were dark and still.' },
      { turn_id: 2, speaker: 'Bibi', style: '', text: 'Puff-puff, where are the stars?' },
      { turn_id: 3, speaker: 'Narrator', style: '', text: 'High in the ancient oak sat an owl.' },
      { turn_id: 4, speaker: 'Owl', style: '', text: 'Hoo hoo! Look higher, little train.' }, // introduces 3rd speaker -> triggers sub-batch split!
      { turn_id: 5, speaker: 'Owl', style: '', text: 'Close your eyes and listen to the wind.' },
      { turn_id: 6, speaker: 'Bibi', style: '', text: 'I hear it whispering goodnight.' }, // Owl + Bibi (2 speakers)
    ];

    const story: Story = {
      id: 'gate2-cast-story',
      status: 'draft',
      title: 'The Owl and the Engine',
      summary: 'A trio dialogue bedtime story.',
      tags: ['owl', 'bedtime'],
      series_context: null,
      characters: [
        { name: 'Bibi', traits: 'Gentle bell' },
        { name: 'Owl', traits: 'Deep wise hoot' },
      ],
      script_turns: turns,
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await storage.saveStory(story);

    const res = await request(app)
      .post('/api/admin/stories/gate2-cast-story/synthesize')
      .set('Cookie', adminCookie)
      .send({
        casting: {
          mode: 'cast',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {
            Bibi: 'prebuilt-puck',
            Owl: 'prebuilt-aoede',
          },
        },
        label: 'Trio Performance',
      });

    expect(res.status).toBe(201);
    expect(mockTts.synthesizeCalls.length).toBeGreaterThanOrEqual(2);

    for (const call of mockTts.synthesizeCalls) {
      if (call.speechConfig.multiSpeakerVoiceConfig) {
        // Multi-speaker MUST have EXACT 2 speakers (Gemini 3.8 TTS rule)
        expect(call.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toHaveLength(2);
        const configuredSpeakers = call.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.map(
          (c) => c.speaker
        );
        for (const part of call.parts) {
          expect(configuredSpeakers).toContain(part.speechMetadata?.speaker);
        }
      } else if (call.speechConfig.voiceConfig) {
        // Single speaker batch
        expect(call.speechConfig.multiSpeakerVoiceConfig).toBeUndefined();
        const speakers = new Set(call.parts.map((p) => p.speechMetadata?.speaker));
        expect(speakers.size).toBe(1);
      } else {
        throw new Error('Call has neither voiceConfig nor multiSpeakerVoiceConfig');
      }
    }
  });

  // ==========================================
  // Gate 3: Version Promotion & Last-Version Deletion Test
  // ==========================================
  it('Gate 3: handles version creation, default promotion, deletion, and draft reversion on last version delete', async () => {
    const story: Story = {
      id: 'gate3-lifecycle-story',
      status: 'draft',
      title: 'Lifecycle Journey',
      summary: 'Testing audio version lifecycle.',
      tags: ['test'],
      series_context: null,
      characters: [],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'A short sentence for testing versions.' },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await storage.saveStory(story);

    // 1. Synthesize v1 -> becomes default, story becomes published
    const synth1 = await request(app)
      .post('/api/admin/stories/gate3-lifecycle-story/synthesize')
      .set('Cookie', adminCookie)
      .send({
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {},
        },
        label: 'Version One',
      });

    expect(synth1.status).toBe(201);
    const storyAfterV1: Story = synth1.body;
    expect(storyAfterV1.status).toBe('published');
    expect(storyAfterV1.audio_versions).toHaveLength(1);
    const v1 = storyAfterV1.audio_versions[0];
    expect(v1.is_default).toBe(true);

    // Verify catalog reflects v1 default_audio_url
    let catalog = await storage.getCatalog();
    let catItem = catalog.find((c) => c.id === 'gate3-lifecycle-story');
    expect(catItem?.status).toBe('published');
    expect(catItem?.default_audio_url).toBe(v1.audio_url);

    // 2. Synthesize v2 with makeDefault: false -> v1 stays default
    const synth2 = await request(app)
      .post('/api/admin/stories/gate3-lifecycle-story/synthesize')
      .set('Cookie', adminCookie)
      .send({
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-puck',
          character_voices: {},
        },
        label: 'Version Two',
        makeDefault: false,
      });

    expect(synth2.status).toBe(201);
    const storyAfterV2: Story = synth2.body;
    expect(storyAfterV2.audio_versions).toHaveLength(2);
    const v2 = storyAfterV2.audio_versions.find((v) => v.version_id !== v1.version_id)!;
    expect(v2.is_default).toBe(false);

    // 3. PATCH .../v2/default -> sets v2 as default
    const patchRes = await request(app)
      .patch(`/api/admin/stories/gate3-lifecycle-story/versions/${v2.version_id}/default`)
      .set('Cookie', adminCookie);

    expect(patchRes.status).toBe(200);
    const storyAfterDefaultPatch: Story = patchRes.body;
    const patchedV2 = storyAfterDefaultPatch.audio_versions.find((v) => v.version_id === v2.version_id);
    const patchedV1 = storyAfterDefaultPatch.audio_versions.find((v) => v.version_id === v1.version_id);
    expect(patchedV2?.is_default).toBe(true);
    expect(patchedV1?.is_default).toBe(false);

    catalog = await storage.getCatalog();
    catItem = catalog.find((c) => c.id === 'gate3-lifecycle-story');
    expect(catItem?.default_audio_url).toBe(v2.audio_url);

    // 4. DELETE v2 -> v1 automatically promoted to is_default: true
    const delV2Res = await request(app)
      .delete(`/api/admin/stories/gate3-lifecycle-story/versions/${v2.version_id}`)
      .set('Cookie', adminCookie);

    expect(delV2Res.status).toBe(200);
    const storyAfterDelV2: Story = delV2Res.body;
    expect(storyAfterDelV2.audio_versions).toHaveLength(1);
    expect(storyAfterDelV2.audio_versions[0].version_id).toBe(v1.version_id);
    expect(storyAfterDelV2.audio_versions[0].is_default).toBe(true);

    catalog = await storage.getCatalog();
    catItem = catalog.find((c) => c.id === 'gate3-lifecycle-story');
    expect(catItem?.default_audio_url).toBe(v1.audio_url);

    // 5. DELETE v1 -> 0 versions left -> story reverts to "draft", default_audio_url is null
    const delV1Res = await request(app)
      .delete(`/api/admin/stories/gate3-lifecycle-story/versions/${v1.version_id}`)
      .set('Cookie', adminCookie);

    expect(delV1Res.status).toBe(200);
    const storyAfterDelV1: Story = delV1Res.body;
    expect(storyAfterDelV1.audio_versions).toHaveLength(0);
    expect(storyAfterDelV1.status).toBe('draft');

    catalog = await storage.getCatalog();
    catItem = catalog.find((c) => c.id === 'gate3-lifecycle-story');
    expect(catItem?.status).toBe('draft');
    expect(catItem?.default_audio_url).toBeNull();
    expect(catItem?.audio_versions_count).toBe(0);

    // Public GET /api/catalog must now EXCLUDE the draft story
    const publicCatalogRes = await request(app).get('/api/catalog');
    expect(publicCatalogRes.status).toBe(200);
    const publicItems = publicCatalogRes.body;
    expect(publicItems.find((c: any) => c.id === 'gate3-lifecycle-story')).toBeUndefined();
  });

  // ==========================================
  // Gate 4: Voice Studio API & Custom Voice Creation Test
  // ==========================================
  it('Gate 4: lists voices, previews voice by ID or prompt, creates a custom voice, and enforces 401 unauthenticated on all admin endpoints', async () => {
    // 1. GET /api/admin/voices
    const listRes = await request(app)
      .get('/api/admin/voices')
      .set('Cookie', adminCookie);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThanOrEqual(3);

    // 2. POST /api/admin/voices/preview with voiceId
    const prevVoiceRes = await request(app)
      .post('/api/admin/voices/preview')
      .set('Cookie', adminCookie)
      .send({
        voiceId: 'prebuilt-kore',
        sampleText: 'Goodnight little owl sleeping high in the tree.',
      });

    expect(prevVoiceRes.status).toBe(200);
    expect(prevVoiceRes.headers['content-type']).toBe('audio/wav');
    expect(prevVoiceRes.body.subarray(0, 4).toString('ascii')).toBe('RIFF');

    // 3. POST /api/admin/voices/preview with natural-language prompt description
    const prevPromptRes = await request(app)
      .post('/api/admin/voices/preview')
      .set('Cookie', adminCookie)
      .send({
        description: 'A soothing grandfather clock ticking softly in the warm library.',
      });

    expect(prevPromptRes.status).toBe(200);
    expect(prevPromptRes.headers['content-type']).toBe('audio/wav');
    expect(prevPromptRes.body.subarray(0, 4).toString('ascii')).toBe('RIFF');

    // 4. POST /api/admin/voices to create custom voice
    const createVoiceRes = await request(app)
      .post('/api/admin/voices')
      .set('Cookie', adminCookie)
      .send({
        label: 'Grandpa Barnaby',
        description: 'Deep, sleepy grandfather voice with warm chuckle timbre',
        languageCode: 'en-US',
        tags: ['grandfather', 'sleepy'],
      });

    expect(createVoiceRes.status).toBe(201);
    const newVoice: VoiceEntry = createVoiceRes.body;
    expect(newVoice.id).toMatch(/^designed-grandpa-barnaby/);
    expect(newVoice.source).toBe('designed');
    expect(newVoice.gemini_voice_name).toMatch(/^voice_mock_/);

    // Verify it was appended to voices.json
    const updatedVoices = await storage.getVoices();
    expect(updatedVoices.find((v) => v.id === newVoice.id)).toBeDefined();

    // 5. Use the designed voice in synthesis -> verify it translates to { voice: 'voice_...' }
    const story: Story = {
      id: 'custom-voice-story',
      status: 'draft',
      title: 'Grandpa Barnaby Tells a Tale',
      summary: 'Story with custom voice.',
      tags: ['custom'],
      series_context: null,
      characters: [],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: 'Warm', text: 'Rest now, little star.' },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await storage.saveStory(story);

    const synthRes = await request(app)
      .post('/api/admin/stories/custom-voice-story/synthesize')
      .set('Cookie', adminCookie)
      .send({
        casting: {
          mode: 'solo',
          narrator_voice_id: newVoice.id,
          character_voices: {},
        },
      });

    expect(synthRes.status).toBe(201);
    const lastCall = mockTts.synthesizeCalls[mockTts.synthesizeCalls.length - 1];
    expect(lastCall.speechConfig.voiceConfig).toEqual({
      voice: newVoice.gemini_voice_name,
    });

    // 6. Security: 401 unauthenticated check on all new endpoints
    const unauthGetVoices = await request(app).get('/api/admin/voices');
    expect(unauthGetVoices.status).toBe(401);

    const unauthPreview = await request(app).post('/api/admin/voices/preview').send({});
    expect(unauthPreview.status).toBe(401);

    const unauthCreateVoice = await request(app).post('/api/admin/voices').send({});
    expect(unauthCreateVoice.status).toBe(401);

    const unauthSynth = await request(app).post('/api/admin/stories/custom-voice-story/synthesize').send({});
    expect(unauthSynth.status).toBe(401);

    const unauthPatchDefault = await request(app).patch('/api/admin/stories/custom-voice-story/versions/v1/default');
    expect(unauthPatchDefault.status).toBe(401);

    const unauthDeleteVersion = await request(app).delete('/api/admin/stories/custom-voice-story/versions/v1');
    expect(unauthDeleteVersion.status).toBe(401);
  });

  it('guarantees built-in prebuilt voices exist on empty DATA_DIR without calling saveVoices', async () => {
    const emptyTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-empty-data-'));
    try {
      const emptyConfig = loadConfig({
        DATA_DIR: emptyTmpDir,
        NODE_ENV: 'test',
        DEV_ADMIN_BYPASS: 'true',
        ADMIN_GOOGLE_EMAIL: 'curator@storyteller.studio',
        GEMINI_API_KEY: 'test-key',
      });
      const emptyStorage = new LocalStorageAdapter(emptyTmpDir);
      const emptyMockTts = new MockTtsProvider();
      const emptyApp = createApp({
        config: emptyConfig,
        storage: emptyStorage,
        ttsProvider: emptyMockTts,
      });

      // Log in as admin
      const loginRes = await request(emptyApp)
        .post('/api/admin/login')
        .send({ devBypass: true });
      const cookie = loginRes.headers['set-cookie']?.[0] || '';

      // GET /api/admin/voices on fresh empty data dir returns 3 built-in voices
      const voicesRes = await request(emptyApp)
        .get('/api/admin/voices')
        .set('Cookie', cookie);
      expect(voicesRes.status).toBe(200);
      expect(voicesRes.body).toHaveLength(3);
      const voiceIds = voicesRes.body.map((v: VoiceEntry) => v.id);
      expect(voiceIds).toContain('prebuilt-kore');
      expect(voiceIds).toContain('prebuilt-puck');
      expect(voiceIds).toContain('prebuilt-aoede');

      // Create a draft story
      const story: Story = {
        id: 'fresh-data-story',
        status: 'draft',
        title: 'Fresh Story',
        summary: 'Testing empty data dir synthesis.',
        tags: ['test'],
        series_context: null,
        characters: [],
        script_turns: [
          { turn_id: 1, speaker: 'Narrator', style: 'Warm', text: 'Goodnight little cloud.' },
        ],
        voice_candidates: [],
        audio_versions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await emptyStorage.saveStory(story);

      // Synthesize using prebuilt-kore without voices.json ever seeded
      const synthRes = await request(emptyApp)
        .post('/api/admin/stories/fresh-data-story/synthesize')
        .set('Cookie', cookie)
        .send({
          casting: {
            mode: 'solo',
            narrator_voice_id: 'prebuilt-kore',
          },
          label: 'Bedtime Solo',
        });

      expect(synthRes.status).toBe(201);
      const updatedStory: Story = synthRes.body;
      expect(updatedStory.audio_versions).toHaveLength(1);
      expect(updatedStory.audio_versions[0].casting.narrator_voice_id).toBe('prebuilt-kore');
      expect(updatedStory.audio_versions[0].casting.character_voices).toEqual({});
    } finally {
      await fs.promises.rm(emptyTmpDir, { recursive: true, force: true });
    }
  });

  /* -------------------------------------------------------------------------
   * Phase 6: Voice Sample & Fallback Storytelling Cadence Tests
   * ----------------------------------------------------------------------- */
  it('Phase 6: uses DEFAULT_VOICE_SAMPLE and Warm, clear, expressive storytelling cadence as fallback', async () => {
    // 1. Preview with omitted sampleText -> verify DEFAULT_VOICE_SAMPLE is synthesized
    const previewRes = await request(app)
      .post('/api/admin/voices/preview')
      .set('Cookie', adminCookie)
      .send({
        voiceId: 'prebuilt-kore',
      });

    expect(previewRes.status).toBe(200);
    const lastPreviewCall = mockTts.synthesizeCalls[mockTts.synthesizeCalls.length - 1];
    expect(lastPreviewCall.parts[0].text).toBe(DEFAULT_VOICE_SAMPLE);
    expect(lastPreviewCall.parts[0].speechMetadata?.style).toContain('expressive');

    // 2. Synthesize story turn with undefined style -> fallback to expressive storytelling cadence
    const genreStory: Story = {
      id: 'phase6-genre-story',
      status: 'draft',
      title: 'Galactic Hitchhikers',
      summary: 'A fast-paced sci-fi buddy comedy.',
      tags: ['comedy', 'sci-fi'],
      series_context: null,
      characters: [{ name: 'Spork', traits: 'Clumsy alien chef' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'The galaxy had never seen a cook quite like Spork.' },
        { turn_id: 2, speaker: 'Spork', style: '', text: 'Pass me the quantum spatula!' },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await storage.saveStory(genreStory);

    const synthRes = await request(app)
      .post('/api/admin/stories/phase6-genre-story/synthesize')
      .set('Cookie', adminCookie)
      .send({
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
        },
        label: 'Solo Narration',
      });

    expect(synthRes.status).toBe(201);
    const soloSynthCall = mockTts.synthesizeCalls[mockTts.synthesizeCalls.length - 1];
    expect(soloSynthCall.parts[0].speechMetadata?.style).toContain('Warm, clear, expressive storytelling cadence');
    expect(soloSynthCall.parts[0].speechMetadata?.style).toContain('Pace: natural');
    expect(soloSynthCall.parts[1].speechMetadata?.style).toContain('expressive, dynamic');
  });
});
