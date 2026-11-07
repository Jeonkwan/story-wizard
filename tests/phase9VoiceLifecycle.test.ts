import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { StorageNotFoundError, InvalidSlugError } from '../server/storage/storageAdapter.js';
import { wrapPcmAsWav } from '../server/lib/wav.js';
import {
  validateDirectorOutput,
  type DirectorOutputInput,
} from '../server/lib/validators.js';
import {
  MAX_TTS_BATCH_TURNS,
  MAX_TTS_BATCH_CHARS,
  PACE_VOICE_PROMPT_CLAUSE,
  PACE_SYNTHESIS_ANCHOR,
  sanitizeLiteralTempoPhrases,
  buildTurnStyle,
  GoogleGenAITtsProvider,
  type TtsProvider,
  type SynthesizeBatchRequest,
  type PromptedVoiceRequest,
  type PromptedVoiceResponse,
} from '../server/services/geminiTts.js';
import {
  GoogleGenAIStoryLLMProvider,
  type StoryLLMProvider,
  type GenerateWriterDraftInput,
  type DirectScriptInput,
  type TranscribeAudioRequest,
} from '../server/services/geminiStory.js';
import type { Story, VoiceEntry, ScriptTurn } from '../shared/types.js';
import {
  MAX_VOICE_PREVIEW_CHARS,
  VOICE_SAMPLE_PRESETS,
  DEFAULT_VOICE_SAMPLE,
} from '../shared/voiceSamples.js';

class MockPhase9TtsProvider implements TtsProvider {
  public synthesizeCalls: SynthesizeBatchRequest[] = [];
  public createVoiceCalls: PromptedVoiceRequest[] = [];
  public deleteVoiceCalls: string[] = [];
  public nextCreatedVoiceId = 'voice_staged_take_1';
  public sampleAudioWav?: Buffer;

  async synthesizeBatch(req: SynthesizeBatchRequest): Promise<Buffer> {
    this.synthesizeCalls.push(req);
    const mockPcm = Buffer.alloc(4800, 0x11);
    const { wav } = wrapPcmAsWav(mockPcm);
    return wav;
  }

  async createPromptedVoice(req: PromptedVoiceRequest): Promise<PromptedVoiceResponse> {
    this.createVoiceCalls.push(req);
    const mockSample = Buffer.alloc(2400, 0x22);
    const { wav } = wrapPcmAsWav(mockSample);
    return {
      geminiVoiceName: this.nextCreatedVoiceId,
      sampleAudioWav: this.sampleAudioWav || wav,
    };
  }

  async deleteCustomVoice(geminiVoiceName: string): Promise<void> {
    this.deleteVoiceCalls.push(geminiVoiceName);
  }
}

class MockPhase9StoryLLMProvider implements StoryLLMProvider {
  public writerCalls: GenerateWriterDraftInput[] = [];
  public directorCalls: DirectScriptInput[] = [];
  public transcribeCalls: TranscribeAudioRequest[] = [];

  async generateWriterDraft(input: GenerateWriterDraftInput) {
    this.writerCalls.push(input);
    return {
      title: 'Mock Title',
      summary: 'Mock Summary',
      tags: ['adventure'],
      characters: [{ name: 'Pip', traits: 'Tiny mouse' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', text: 'Once upon a time.' },
        { turn_id: 2, speaker: 'Pip', text: 'Squeak!' },
      ],
    };
  }

  async directScript(input: DirectScriptInput) {
    this.directorCalls.push(input);
    return {
      script_turns: input.script_turns.map((t) => ({
        turn_id: t.turn_id,
        speaker: t.speaker,
        style: 'Excited, cheerful dramatic energy',
        text: t.text,
      })),
      voice_candidates: [
        { label: 'Pip Voice', description: 'Tiny squeaky mouse', suggested_for: 'Pip' },
      ],
    };
  }

  async transcribeAudio(req: TranscribeAudioRequest): Promise<string> {
    this.transcribeCalls.push(req);
    return 'Once upon a time in a starry forest';
  }
}

describe('Phase 9: Staged Draft Voice Lifecycle, Pacing Guardrails & Multimodal Dictation STT', () => {
  let tmpDir: string;
  let mockTts: MockPhase9TtsProvider;
  let mockLlm: MockPhase9StoryLLMProvider;
  let storage: LocalStorageAdapter;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase9-test-'));

    const config = loadConfig({
      DATA_DIR: tmpDir,
      NODE_ENV: 'test',
      DEV_ADMIN_BYPASS: 'true',
      ADMIN_GOOGLE_EMAIL: 'architect@storyteller.studio',
      GEMINI_API_KEY: 'test-api-key',
    });

    storage = new LocalStorageAdapter(tmpDir);
    mockTts = new MockPhase9TtsProvider();
    mockLlm = new MockPhase9StoryLLMProvider();

    app = createApp({
      config,
      storage,
      ttsProvider: mockTts,
      storyLLMProvider: mockLlm,
    });

    // Seed test voices in voices.json
    const starterVoices: VoiceEntry[] = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Kore',
        description: 'Warm, clear, expressive storytelling voice',
        language_code: 'en-US',
        tags: ['warm', 'expressive'],
        default_pace: 'natural',
        created_at: new Date().toISOString(),
      },
      {
        id: 'designed-saved-hero',
        label: 'Captain Courage',
        source: 'designed',
        gemini_voice_name: 'voice_saved_hero_123',
        description: 'Bold, adventurous storytelling hero',
        language_code: 'en-US',
        tags: ['hero', 'adventure'],
        default_pace: 'lively',
        preview_audio_url: '/api/voices/designed-saved-hero/preview.wav',
        created_at: new Date().toISOString(),
      },
    ];
    await storage.saveVoices(starterVoices);

    // Seed preview WAV for saved hero voice
    const heroPcm = Buffer.alloc(4800, 0x33);
    const { wav: heroWav } = wrapPcmAsWav(heroPcm);
    await storage.saveVoicePreview('designed-saved-hero', heroWav);

    // Obtain admin session
    const loginRes = await request(app).post('/api/admin/login').send({ devBypass: true });
    expect(loginRes.status).toBe(200);
    const cookieHeader = loginRes.headers['set-cookie'];
    adminCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /* =========================================================================
   * Voice Sample Presets and Constants
   * ======================================================================= */
  describe('Voice Sample Presets and Constants', () => {
    it('defines MAX_VOICE_PREVIEW_CHARS, DEFAULT_VOICE_SAMPLE and 4 presets <= 320 chars', () => {
      expect(MAX_VOICE_PREVIEW_CHARS).toBe(320);
      expect(VOICE_SAMPLE_PRESETS).toHaveLength(4);
      expect(DEFAULT_VOICE_SAMPLE).toBe(VOICE_SAMPLE_PRESETS[0].text);
      for (const preset of VOICE_SAMPLE_PRESETS) {
        expect(preset.text.length).toBeLessThanOrEqual(MAX_VOICE_PREVIEW_CHARS);
        expect(preset.id).toBeTruthy();
        expect(preset.label).toBeTruthy();
      }
    });
  });

  /* =========================================================================
   * Gate 1: Staged Draft Voice Preview & Saved-Voice Protection
   * ======================================================================= */
  describe('Gate 1: Staged Draft Voice Preview & Lifecycle', () => {
    it('creates a real prompted voice take on preview of unsaved prompt (NEVER falls back to Kore) and returns X-Draft-Voice-Name header', async () => {
      mockTts.nextCreatedVoiceId = 'voice_draft_dragon_99';

      const res = await request(app)
        .post('/api/admin/voices/preview')
        .set('Cookie', adminCookie)
        .send({
          description: 'A cozy, rumbling baby dragon who chuckles gently',
          sampleText: VOICE_SAMPLE_PRESETS[0].text,
          pace: 'calm',
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('audio/wav');
      expect(res.headers['x-draft-voice-name']).toBe('voice_draft_dragon_99');
      expect(res.headers['access-control-expose-headers']).toContain('X-Draft-Voice-Name');

      // Assert createPromptedVoice was called (not Kore)
      expect(mockTts.createVoiceCalls).toHaveLength(1);
      expect(mockTts.createVoiceCalls[0].description).toContain(
        'A cozy, rumbling baby dragon who chuckles gently'
      );
      expect(mockTts.createVoiceCalls[0].description).toContain(PACE_VOICE_PROMPT_CLAUSE.calm);

      // Assert synthesis used the real draft voice ID (NOT Kore)
      expect(mockTts.synthesizeCalls).toHaveLength(1);
      expect(mockTts.synthesizeCalls[0].speechConfig.voiceConfig).toEqual({
        voice: 'voice_draft_dragon_99',
      });
      expect(mockTts.synthesizeCalls[0].parts[0].speechMetadata?.style).toContain(
        PACE_SYNTHESIS_ANCHOR.calm
      );
    });

    it('reuses draftGeminiVoiceName on auditioning other presets without calling createPromptedVoice again', async () => {
      const res = await request(app)
        .post('/api/admin/voices/preview')
        .set('Cookie', adminCookie)
        .send({
          description: 'A cozy, rumbling baby dragon',
          sampleText: VOICE_SAMPLE_PRESETS[1].text,
          pace: 'calm',
          draftGeminiVoiceName: 'voice_draft_dragon_99',
        });

      expect(res.status).toBe(200);
      expect(res.headers['x-draft-voice-name']).toBe('voice_draft_dragon_99');
      // Skipped creation
      expect(mockTts.createVoiceCalls).toHaveLength(0);
      // Synthesized with existing staged draft ID
      expect(mockTts.synthesizeCalls).toHaveLength(1);
      expect(mockTts.synthesizeCalls[0].speechConfig.voiceConfig).toEqual({
        voice: 'voice_draft_dragon_99',
      });
    });

    it('regenerateTake=true generates a fresh take and cleans up the previous unsaved draft ID', async () => {
      mockTts.nextCreatedVoiceId = 'voice_draft_dragon_take2';

      const res = await request(app)
        .post('/api/admin/voices/preview')
        .set('Cookie', adminCookie)
        .send({
          description: 'A cozy, rumbling baby dragon',
          pace: 'calm',
          draftGeminiVoiceName: 'voice_draft_dragon_99',
          previousDraftGeminiVoiceName: 'voices/voice_draft_dragon_99', // with voices/ prefix to test prefix stripping
          regenerateTake: true,
        });

      expect(res.status).toBe(200);
      expect(res.headers['x-draft-voice-name']).toBe('voice_draft_dragon_take2');

      // Created new voice
      expect(mockTts.createVoiceCalls).toHaveLength(1);
      // Cleaned up previous draft (bare ID without voices/ prefix)
      expect(mockTts.deleteVoiceCalls).toContain('voice_draft_dragon_99');
    });

    it('Saved-Voice Protection Invariant: silent no-op when preview cleanup references a saved voice ID', async () => {
      mockTts.nextCreatedVoiceId = 'voice_draft_dragon_take3';

      const res = await request(app)
        .post('/api/admin/voices/preview')
        .set('Cookie', adminCookie)
        .send({
          description: 'A bold hero variant',
          previousDraftGeminiVoiceName: 'voice_saved_hero_123', // ID belongs to saved Captain Courage!
          regenerateTake: true,
        });

      expect(res.status).toBe(200);
      // Must NOT delete voice_saved_hero_123!
      expect(mockTts.deleteVoiceCalls).not.toContain('voice_saved_hero_123');
    });

    it('DELETE /api/admin/voices/draft/:geminiVoiceName rejects deletion with 409 Conflict if ID belongs to a saved voice', async () => {
      const res = await request(app)
        .delete('/api/admin/voices/draft/voices/voice_saved_hero_123')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('currently saved in the voice library');
      expect(mockTts.deleteVoiceCalls).not.toContain('voice_saved_hero_123');
    });

    it('DELETE /api/admin/voices/draft/:geminiVoiceName deletes unsaved draft with bare ID and returns 200', async () => {
      const res = await request(app)
        .delete('/api/admin/voices/draft/voices/voice_temporary_unsaved_777')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockTts.deleteVoiceCalls).toContain('voice_temporary_unsaved_777');
    });

    it('DELETE /api/admin/voices/draft/:geminiVoiceName returns 400 on malformed voice ID', async () => {
      const res = await request(app)
        .delete('/api/admin/voices/draft/invalid@voice!id')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid draft voice ID format');
    });
  });

  /* =========================================================================
   * Gate 2: Promote Staged Draft on Save & Cached Preview Audio Stream
   * ======================================================================= */
  describe('Gate 2: Voice Promotion on Save & Range Streaming Preview', () => {
    it('promotes stagedGeminiVoiceName + previewAudioBase64 on POST /api/admin/voices without calling createPromptedVoice twice', async () => {
      const mockPreviewWav = Buffer.alloc(4800, 0x33);
      const { wav: validWav } = wrapPcmAsWav(mockPreviewWav);
      const previewAudioBase64 = `data:audio/wav;base64,${validWav.toString('base64')}`;

      const res = await request(app)
        .post('/api/admin/voices')
        .set('Cookie', adminCookie)
        .send({
          label: 'Giggling Bumble Frog',
          description: 'A bubbly, squeaky amphibious storyteller',
          defaultPace: 'lively',
          stagedGeminiVoiceName: 'voice_draft_frog_456',
          previewAudioBase64,
          tags: ['bubbly', 'comedy'],
        });

      expect(res.status).toBe(201);
      const createdVoice: VoiceEntry = res.body;
      expect(createdVoice.id).toBe('designed-giggling-bumble-frog');
      expect(createdVoice.gemini_voice_name).toBe('voice_draft_frog_456');
      expect(createdVoice.default_pace).toBe('lively');
      expect(createdVoice.preview_audio_url).toBe(
        '/api/voices/designed-giggling-bumble-frog/preview.wav'
      );

      // Critical: createPromptedVoice was NOT called again on save!
      expect(mockTts.createVoiceCalls).toHaveLength(0);

      // Verify cached preview.wav exists in storage
      const previewStream = await storage.getVoicePreviewStream('designed-giggling-bumble-frog');
      expect(previewStream.totalBytes).toBe(validWav.length);
    });

    it('rejects POST /api/admin/voices with 409 Conflict if stagedGeminiVoiceName already belongs to a saved voice', async () => {
      const res = await request(app)
        .post('/api/admin/voices')
        .set('Cookie', adminCookie)
        .send({
          label: 'Imposter Hero',
          description: 'Attempting to reuse already saved hero voice',
          stagedGeminiVoiceName: 'voice_saved_hero_123',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists as a saved voice');
    });

    it('rejects POST /api/admin/voices with 400 if previewAudioBase64 exceeds 2MB decoded', async () => {
      const largePcm = Buffer.alloc(2.1 * 1024 * 1024, 0x00);
      const { wav: largeWav } = wrapPcmAsWav(largePcm);
      const largeB64 = largeWav.toString('base64');

      const res = await request(app)
        .post('/api/admin/voices')
        .set('Cookie', adminCookie)
        .send({
          label: 'Too Large Preview Voice',
          description: 'Valid prompt with oversized audio',
          stagedGeminiVoiceName: 'voice_oversized_audio_99',
          previewAudioBase64: largeB64,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('exceeds maximum 2MB limit');
    });

    it('streams cached preview via GET /api/voices/:id/preview.wav with 200 OK and 206 Partial Content (HTTP Range)', async () => {
      // 1. Full 200 OK request
      const res200 = await request(app).get('/api/voices/designed-saved-hero/preview.wav');
      expect(res200.status).toBe(200);
      expect(res200.headers['content-type']).toBe('audio/wav');
      expect(res200.headers['accept-ranges']).toBe('bytes');
      expect(res200.headers['cache-control']).toBe('public, max-age=3600');
      const totalBytes = parseInt(res200.headers['content-length'], 10);
      expect(totalBytes).toBeGreaterThan(44);

      // 2. Valid Range request (bytes=0-43, first 44 bytes = WAV header)
      const res206 = await request(app)
        .get('/api/voices/designed-saved-hero/preview.wav')
        .set('Range', 'bytes=0-43');
      expect(res206.status).toBe(206);
      expect(res206.headers['content-range']).toBe(`bytes 0-43/${totalBytes}`);
      expect(res206.headers['content-length']).toBe('44');
      expect(res206.body.subarray(0, 4).toString('ascii')).toBe('RIFF');

      // 3. Out-of-bounds Range request (416 Range Not Satisfiable)
      const res416 = await request(app)
        .get('/api/voices/designed-saved-hero/preview.wav')
        .set('Range', `bytes=${totalBytes + 100}-${totalBytes + 200}`);
      expect(res416.status).toBe(416);
      expect(res416.headers['content-range']).toBe(`bytes */${totalBytes}`);

      // 4. Absent voice returns 404
      const res404 = await request(app).get('/api/voices/non-existent-voice/preview.wav');
      expect(res404.status).toBe(404);

      // 5. Invalid slug returns 400
      const res400 = await request(app).get('/api/voices/invalid..slug!!/preview.wav');
      expect(res400.status).toBe(400);
    });
  });

  /* =========================================================================
   * Gate 3: Voice Metadata Update (PATCH) & Custom Deletion (DELETE)
   * ======================================================================= */
  describe('Gate 3: Voice CRUD Operations', () => {
    it('PATCH /api/admin/voices/:id updates metadata and validates pace', async () => {
      // Invalid pace
      const badPaceRes = await request(app)
        .patch('/api/admin/voices/designed-saved-hero')
        .set('Cookie', adminCookie)
        .send({ defaultPace: 'supersonic' });
      expect(badPaceRes.status).toBe(400);

      // Valid update
      const res = await request(app)
        .patch('/api/admin/voices/designed-saved-hero')
        .set('Cookie', adminCookie)
        .send({
          label: 'Captain Courage (Remastered)',
          tags: ['hero', 'adventure', 'remastered'],
          defaultPace: 'slow',
        });

      expect(res.status).toBe(200);
      expect(res.body.label).toBe('Captain Courage (Remastered)');
      expect(res.body.tags).toContain('remastered');
      expect(res.body.default_pace).toBe('slow');
      expect(res.body.gemini_voice_name).toBe('voice_saved_hero_123'); // immutable!
    });

    it('DELETE /api/admin/voices/:id rejects deleting prebuilt system voices with 400', async () => {
      const res = await request(app)
        .delete('/api/admin/voices/prebuilt-kore')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Prebuilt system voices cannot be deleted');
    });

    it('DELETE /api/admin/voices/:id deletes designed voice from voices.json, deletes preview audio, and calls provider deleteCustomVoice', async () => {
      const res = await request(app)
        .delete('/api/admin/voices/designed-saved-hero')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, deletedId: 'designed-saved-hero' });

      // Verify removed from voices catalog
      const voices = await storage.getVoices();
      expect(voices.some((v) => v.id === 'designed-saved-hero')).toBe(false);

      // Verify preview audio deleted (idempotent, get throws 404)
      await expect(
        storage.getVoicePreviewStream('designed-saved-hero')
      ).rejects.toThrow(StorageNotFoundError);

      // Verify provider custom voice cleanup called
      expect(mockTts.deleteVoiceCalls).toContain('voice_saved_hero_123');
    });
  });

  /* =========================================================================
   * Gate 4: Single-Call Director Pacing Instructions & Emotion Preservation
   * ======================================================================= */
  describe('Gate 4: Single-Call Director Prompt & Emotion Preservation', () => {
    it('GoogleGenAIStoryLLMProvider.directScript contains anti-rush children comprehension directives and makes 1 LLM call', async () => {
      let capturedConfig: any = null;
      let generateCallCount = 0;

      const mockAi = {
        models: {
          generateContent: async (args: any) => {
            generateCallCount++;
            capturedConfig = args.config;
            return {
              text: JSON.stringify({
                script_turns: [
                  {
                    turn_id: 1,
                    speaker: 'Narrator',
                    style: 'Excited, eager dramatic storytelling',
                    text: 'The treasure chest creaked open.',
                  },
                ],
                voice_candidates: [
                  {
                    label: 'Old Sailor',
                    description: 'Weathered pirate with gravelly warmth',
                    suggested_for: 'Narrator',
                  },
                ],
              }),
            };
          },
        },
      };

      const provider = new GoogleGenAIStoryLLMProvider('test-key');
      (provider as any).ai = mockAi;

      const result = await provider.directScript({
        title: 'Pirate Cove',
        summary: 'A friendly pirate adventure.',
        characters: [],
        script_turns: [
          {
            turn_id: 1,
            speaker: 'Narrator',
            style: '',
            text: 'The treasure chest creaked open.',
          },
        ],
      });

      // Exactly 1 single LLM call
      expect(generateCallCount).toBe(1);
      expect(result.script_turns).toHaveLength(1);

      // Assert systemInstruction contains anti-rush kids comprehension rules
      const instruction = capturedConfig.systemInstruction;
      expect(instruction).toContain('Separate high theatrical energy from speaking speed');
      expect(instruction).toContain('NEVER emitting fast speaking-rate directives');
      expect(instruction).toContain('at high speed');
      expect(instruction).toContain('cartoonish speed');
      expect(instruction).toContain('fast-paced');
      expect(instruction).toContain('full speed');
      expect(instruction).toContain('rapid-fire');
      expect(instruction).toContain('speaking rapidly');
      expect(instruction).toContain('children ages 3–8');
    });

    it('validateDirectorOutput preserves all emotional adjectives and clamps length cleanly', () => {
      const writerTurns: ScriptTurn[] = [
        {
          turn_id: 1,
          speaker: 'Narrator',
          style: '',
          text: 'The clock struck midnight.',
        },
      ];

      const directedTurns: DirectorOutputInput = {
        script_turns: [
          {
            turn_id: 1,
            speaker: 'Narrator',
            style: 'Excited, frantic, breathless, chaotic, and urgently whispered dramatic beat',
            text: 'The clock struck midnight. <short pause>',
          },
        ],
        voice_candidates: [
          { label: 'Narrator Voice', description: 'Warm storyteller', suggested_for: 'Narrator' },
        ],
      };

      const validated = validateDirectorOutput(directedTurns, writerTurns);
      const style = validated.script_turns[0].style;

      // Emotional words MUST NOT be stripped!
      expect(style).toContain('Excited');
      expect(style).toContain('frantic');
      expect(style).toContain('breathless');
      expect(style).toContain('chaotic');
      expect(style).toContain('urgently whispered');
      expect(style.length).toBeLessThanOrEqual(200);
    });
  });

  /* =========================================================================
   * Gate 5: Tempo Phrase Sanitization, Pace Anchors & Reduced Batch Limits (<=6 / <=1500)
   * ======================================================================= */
  describe('Gate 5: Tempo Phrase Sanitization, Pace Anchors & Exact-2 Speaker Rule', () => {
    it('sanitizeLiteralTempoPhrases replaces literal rate commands while preserving emotional acting words', () => {
      const inputs = [
        {
          input: 'Chaotic rhythmic countdown, nonsensical monkey babble at high speed',
          expected: 'Chaotic rhythmic countdown, nonsensical monkey babble with high animated energy',
        },
        {
          input: 'Dynamic, action-packed rush conveying physical motion and cartoonish speed',
          expected: 'Dynamic, action-packed rush conveying physical motion and animated cartoon energy',
        },
        {
          input: 'frantic and urgent as he runs full speed toward the exit',
          expected: 'frantic and urgent as he with playful urgency toward the exit',
        },
        {
          input: 'Excited, running full speed through the meadow',
          expected: 'Excited, with playful urgency through the meadow',
        },
        {
          input: 'Energetic narration at full speed with breathless laughter',
          expected: 'Energetic narration at full enthusiasm with breathless laughter',
        },
        {
          input: 'A fast-paced comedic chase scene',
          expected: 'A lively, energetic comedic chase scene',
        },
        {
          input: 'fast paced banter between friends',
          expected: 'lively, energetic banter between friends',
        },
        {
          input: 'rapid-fire dialogue full of bubbly surprises',
          expected: 'bouncy, spirited dialogue full of bubbly surprises',
        },
        {
          input: 'rapid fire excitement',
          expected: 'bouncy, spirited excitement',
        },
        {
          input: 'speaking rapidly with chaotic panic',
          expected: 'speaking animatedly with chaotic panic',
        },
        {
          input: 'speaking very fast while gasping',
          expected: 'speaking animatedly while gasping',
        },
        {
          input: 'speaking quickly with breathless wonder',
          expected: 'speaking animatedly with breathless wonder',
        },
        {
          input: 'fast, excited and curious',
          expected: 'Energetic, excited and curious',
        },
      ];

      for (const { input, expected } of inputs) {
        const sanitized = sanitizeLiteralTempoPhrases(input);
        expect(sanitized).toBe(expected);
      }
    });

    it('sanitizeLiteralTempoPhrases clamps total style length to <= 280 characters', () => {
      const veryLong = 'Very expressive dramatic tone. '.repeat(20);
      const sanitized = sanitizeLiteralTempoPhrases(veryLong);
      expect(sanitized.length).toBeLessThanOrEqual(280);
    });

    it('buildTurnStyle appends structured PACE_SYNTHESIS_ANCHOR and stays <= 280 chars', () => {
      const paces = ['slow', 'calm', 'natural', 'lively'] as const;

      for (const pace of paces) {
        const anchor = PACE_SYNTHESIS_ANCHOR[pace];
        expect(anchor).toBeDefined();

        const style = buildTurnStyle('Chaotic monkey babble at high speed, frantic and excited', pace);
        expect(style).toContain('with high animated energy');
        expect(style).toContain('frantic and excited');
        expect(style).toContain(anchor);
        expect(style.length).toBeLessThanOrEqual(280);
      }
    });

    it('enforces MAX_TTS_BATCH_TURNS = 6 and MAX_TTS_BATCH_CHARS = 1500 in solo synthesis', async () => {
      // 14 turns: batches should be 6 + 6 + 2 = 3 calls
      const turns = Array.from({ length: 14 }, (_, i) => ({
        turn_id: i + 1,
        speaker: 'Narrator',
        style: 'Gentle narrative tone',
        text: `Short turn number ${i + 1}.`,
      }));

      const story: Story = {
        id: 'batch-cap-test-story',
        status: 'draft',
        title: 'Batch Cap Test',
        summary: 'Verifying batch turn limit.',
        tags: ['test'],
        series_context: null,
        characters: [],
        script_turns: turns,
        voice_candidates: [],
        audio_versions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveStory(story);

      const res = await request(app)
        .post('/api/admin/stories/batch-cap-test-story/synthesize')
        .set('Cookie', adminCookie)
        .send({
          casting: {
            mode: 'solo',
            narrator_voice_id: 'prebuilt-kore',
            character_voices: {},
            pace: 'calm',
          },
        });

      expect(res.status).toBe(201);
      expect(MAX_TTS_BATCH_TURNS).toBe(6);
      expect(MAX_TTS_BATCH_CHARS).toBe(1500);

      // 14 turns split at <= 6 turns: 6, 6, 2 -> 3 calls
      expect(mockTts.synthesizeCalls).toHaveLength(3);
      expect(mockTts.synthesizeCalls[0].parts).toHaveLength(6);
      expect(mockTts.synthesizeCalls[1].parts).toHaveLength(6);
      expect(mockTts.synthesizeCalls[2].parts).toHaveLength(2);

      // Verify threaded pace anchor in speechMetadata.style
      for (const call of mockTts.synthesizeCalls) {
        for (const part of call.parts) {
          expect(part.speechMetadata?.style).toContain(PACE_SYNTHESIS_ANCHOR.calm);
        }
      }
    });

    it('splits batches before 6 turns if character count exceeds MAX_TTS_BATCH_CHARS (1500)', async () => {
      // 3 turns, each with 800 chars -> turn 1 (800) + turn 2 (800) = 1600 > 1500 -> splits!
      const turns = [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'A'.repeat(800) },
        { turn_id: 2, speaker: 'Narrator', style: '', text: 'B'.repeat(800) },
        { turn_id: 3, speaker: 'Narrator', style: '', text: 'C'.repeat(400) },
      ];

      const story: Story = {
        id: 'char-cap-test-story',
        status: 'draft',
        title: 'Char Cap Test',
        summary: 'Verifying char limit splitting.',
        tags: ['test'],
        series_context: null,
        characters: [],
        script_turns: turns,
        voice_candidates: [],
        audio_versions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveStory(story);

      const res = await request(app)
        .post('/api/admin/stories/char-cap-test-story/synthesize')
        .set('Cookie', adminCookie)
        .send({
          casting: {
            mode: 'solo',
            narrator_voice_id: 'prebuilt-kore',
            character_voices: {},
          },
        });

      expect(res.status).toBe(201);
      // Turn 1 (800), Turn 2 (800 > 1500 -> split), Turn 3 (800 + 400 = 1200) -> 2 batches
      expect(mockTts.synthesizeCalls).toHaveLength(2);
      expect(mockTts.synthesizeCalls[0].parts).toHaveLength(1);
      expect(mockTts.synthesizeCalls[1].parts).toHaveLength(2);
    });
  });

  /* =========================================================================
   * Gate 6: Multimodal Audio Dictation STT API (POST /api/admin/transcribe)
   * ======================================================================= */
  describe('Gate 6: Multimodal Audio Dictation API (POST /api/admin/transcribe)', () => {
    it('enforces requireAdmin authentication gate (401 without cookie)', async () => {
      const res = await request(app)
        .post('/api/admin/transcribe')
        .send({
          audioBase64: Buffer.from('mock audio').toString('base64'),
          mimeType: 'audio/webm',
        });

      expect(res.status).toBe(401);
      expect(mockLlm.transcribeCalls).toHaveLength(0);
    });

    it('transcribes valid audio payload and strips codec parameters (audio/webm;codecs=opus -> audio/webm)', async () => {
      const rawAudio = Buffer.from('fake webm opus audio bytes');
      const audioBase64 = `data:audio/webm;codecs=opus;base64,${rawAudio.toString('base64')}`;

      const res = await request(app)
        .post('/api/admin/transcribe')
        .set('Cookie', adminCookie)
        .send({
          audioBase64,
          mimeType: 'audio/webm;codecs=opus',
          contextHint: 'story_prompt',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: 'Once upon a time in a starry forest' });

      expect(mockLlm.transcribeCalls).toHaveLength(1);
      const call = mockLlm.transcribeCalls[0];
      // Raw base64 with data URL prefix stripped
      expect(call.audioBase64).toBe(rawAudio.toString('base64'));
      // Codec suffix stripped to base IANA MIME type for Gemini inlineData
      expect(call.mimeType).toBe('audio/webm');
      expect(call.contextHint).toBe('story_prompt');
    });

    it('accepts audio payloads > 1MB (<= 8MB) through the high-limit 12MB route body parser', async () => {
      // 1.5MB raw audio buffer
      const largeAudio = Buffer.alloc(1.5 * 1024 * 1024, 0x55);
      const audioBase64 = largeAudio.toString('base64');

      const res = await request(app)
        .post('/api/admin/transcribe')
        .set('Cookie', adminCookie)
        .send({
          audioBase64,
          mimeType: 'audio/mp4',
        });

      expect(res.status).toBe(200);
      expect(res.body.text).toBe('Once upon a time in a starry forest');
      expect(mockLlm.transcribeCalls[0].mimeType).toBe('audio/mp4');
    });

    it('rejects audio payloads > 8MB with 413 Payload Too Large', async () => {
      // 8.5MB raw audio buffer
      const oversizedAudio = Buffer.alloc(8.5 * 1024 * 1024, 0x77);
      const audioBase64 = oversizedAudio.toString('base64');

      const res = await request(app)
        .post('/api/admin/transcribe')
        .set('Cookie', adminCookie)
        .send({
          audioBase64,
          mimeType: 'audio/wav',
        });

      expect(res.status).toBe(413);
      expect(res.body.error).toContain('exceeds maximum 8MB limit');
    });

    it('rejects unsupported MIME types with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/transcribe')
        .set('Cookie', adminCookie)
        .send({
          audioBase64: Buffer.from('test').toString('base64'),
          mimeType: 'video/mp4',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unsupported audio MIME type');
    });

    it('rejects empty audioBase64 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/transcribe')
        .set('Cookie', adminCookie)
        .send({
          audioBase64: '   ',
          mimeType: 'audio/webm',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('audioBase64 is required');
    });
  });

  /* =========================================================================
   * Gate 7: LocalStorageAdapter Voice Preview Methods
   * ======================================================================= */
  describe('Gate 7: LocalStorageAdapter Voice Preview Persistence', () => {
    it('saves, streams with range, and idempotently deletes preview audio', async () => {
      const sampleWav = Buffer.alloc(4800, 0x44);
      const { wav } = wrapPcmAsWav(sampleWav);

      // 1. Save
      await storage.saveVoicePreview('designed-storage-test', wav);

      // 2. Stream
      const desc = await storage.getVoicePreviewStream('designed-storage-test');
      expect(desc.totalBytes).toBe(wav.length);

      // 3. Delete
      await storage.deleteVoicePreview('designed-storage-test');

      // 4. Confirm deleted
      await expect(
        storage.getVoicePreviewStream('designed-storage-test')
      ).rejects.toThrow(StorageNotFoundError);

      // 5. Delete again is idempotent (no throw)
      await expect(
        storage.deleteVoicePreview('designed-storage-test')
      ).resolves.not.toThrow();
    });

    it('validates voiceId slug against path traversal', async () => {
      await expect(
        storage.saveVoicePreview('../escape-dir', Buffer.from('riff'))
      ).rejects.toThrow(InvalidSlugError);

      await expect(
        storage.deleteVoicePreview('bad/slug/name')
      ).rejects.toThrow(InvalidSlugError);

      await expect(
        storage.getVoicePreviewStream('')
      ).rejects.toThrow(InvalidSlugError);
    });
  });

  /* =========================================================================
   * Gate 8: GoogleGenAITtsProvider.deleteCustomVoice & Cast Batching Tests
   * ======================================================================= */
  describe('Gate 8: SDK DeleteCustomVoice Invariants & Cast Mode Batching', () => {
    it('GoogleGenAITtsProvider.deleteCustomVoice strips voices/ prefix and passes bare ID to ai.voices.delete', async () => {
      let deletedId: string | null = null;
      const mockAi = {
        voices: {
          delete: async (id: string) => {
            deletedId = id;
            return {};
          },
        },
      };

      const provider = new GoogleGenAITtsProvider('test-api-key');
      (provider as any).ai = mockAi;

      // Pass with voices/ prefix
      await provider.deleteCustomVoice('voices/voice_sample_abc_123');
      expect(deletedId).toBe('voice_sample_abc_123'); // stripped!

      // Pass without voices/ prefix
      await provider.deleteCustomVoice('voice_bare_id_456');
      expect(deletedId).toBe('voice_bare_id_456');
    });

    it('GoogleGenAITtsProvider.deleteCustomVoice swallows 404/NOT_FOUND and throws other errors', async () => {
      const notFoundError = new Error('Voice not found');
      (notFoundError as any).status = 404;

      const mockAi = {
        voices: {
          delete: async () => {
            throw notFoundError;
          },
        },
      };

      const provider = new GoogleGenAITtsProvider('test-api-key');
      (provider as any).ai = mockAi;

      // Should not throw on 404
      await expect(provider.deleteCustomVoice('voice_non_existent_999')).resolves.not.toThrow();

      // Should throw on 500
      const serverError = new Error('Internal Server Error');
      (serverError as any).status = 500;
      mockAi.voices.delete = async () => {
        throw serverError;
      };
      await expect(provider.deleteCustomVoice('voice_server_error_999')).rejects.toThrow('Internal Server Error');
    });

    it('GoogleGenAITtsProvider.deleteCustomVoice rejects malformed voice ID format', async () => {
      const provider = new GoogleGenAITtsProvider('test-api-key');
      await expect(provider.deleteCustomVoice('not_a_valid_voice_id')).rejects.toThrow(
        'Invalid Gemini custom voice ID format'
      );
    });

    it('enforces MAX_TTS_BATCH_TURNS = 6 and Exact-2 Speaker Rule in cast mode', async () => {
      // 10 turns alternating between Narrator and Captain Courage (2 speakers)
      const turns = Array.from({ length: 10 }, (_, i) => ({
        turn_id: i + 1,
        speaker: i % 2 === 0 ? 'Narrator' : 'Captain',
        style: 'Heroic dialogue',
        text: `Heroic adventure dialogue line ${i + 1}.`,
      }));

      const story: Story = {
        id: 'cast-batch-cap-story',
        status: 'draft',
        title: 'Cast Batch Cap Story',
        summary: 'Verifying cast mode batch limits and Exact-2 speaker rule.',
        tags: ['cast'],
        series_context: null,
        characters: [{ name: 'Captain', traits: 'Bold hero' }],
        script_turns: turns,
        voice_candidates: [],
        audio_versions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveStory(story);

      const res = await request(app)
        .post('/api/admin/stories/cast-batch-cap-story/synthesize')
        .set('Cookie', adminCookie)
        .send({
          casting: {
            mode: 'cast',
            narrator_voice_id: 'prebuilt-kore',
            character_voices: {
              Captain: 'designed-saved-hero',
            },
          },
        });

      expect(res.status).toBe(201);
      // 10 turns split at <= 6 turns: 6 turns + 4 turns -> 2 calls
      expect(mockTts.synthesizeCalls).toHaveLength(2);
      expect(mockTts.synthesizeCalls[0].parts).toHaveLength(6);
      expect(mockTts.synthesizeCalls[1].parts).toHaveLength(4);

      // Both sub-batches have 2 speakers -> both must use multiSpeakerVoiceConfig with EXACT 2 speakers
      for (const call of mockTts.synthesizeCalls) {
        expect(call.speechConfig.multiSpeakerVoiceConfig).toBeDefined();
        expect(call.speechConfig.multiSpeakerVoiceConfig?.speakerVoiceConfigs).toHaveLength(2);
      }
    });
  });
});
