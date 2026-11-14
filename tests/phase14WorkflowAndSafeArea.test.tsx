// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { signAdminSession, ADMIN_COOKIE_NAME } from '../server/middleware/auth.js';
import { wrapPcmAsWav } from '../server/lib/wav.js';
import type {
  StoryLLMProvider,
  GenerateWriterDraftInput,
  DirectScriptInput,
} from '../server/services/geminiStory.js';
import {
  buildStoryLengthInstruction,
  buildStoryLengthReminder,
  buildPedagogicalInstruction,
  buildCharacterDiversityInstruction,
  defaultVocabularyForAge,
  BANNED_AI_CHARACTER_NAMES,
  GoogleGenAIStoryLLMProvider,
  STORY_LENGTH_TARGETS,
} from '../server/services/geminiStory.js';
import type {
  TtsProvider,
  SynthesizeBatchRequest,
  PromptedVoiceRequest,
  PromptedVoiceResponse,
} from '../server/services/geminiTts.js';
import type {
  WriterOutputInput,
  DirectorOutputInput,
} from '../server/lib/validators.js';
import {
  type Story,
  type VoiceEntry,
  DEFAULT_STORY_LENGTH,
} from '../shared/types.js';
import { VOICE_SAMPLE_PRESETS } from '../shared/voiceSamples.js';
import { DirectorStudio } from '../client/components/DirectorStudio';
import * as clientApi from '../client/api/client';

class MockTtsProvider implements TtsProvider {
  public synthesizeCalls: SynthesizeBatchRequest[] = [];
  public createVoiceCalls: PromptedVoiceRequest[] = [];

  async synthesizeBatch(req: SynthesizeBatchRequest): Promise<Buffer> {
    this.synthesizeCalls.push(req);
    // 0.2s of 24kHz 16-bit mono PCM = 9600 bytes
    const mockPcm = Buffer.alloc(9600, 0x11);
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

describe('Phase 14: One-Tap Chained Pipeline, Story Length & Name Diversity Tests', () => {
  let tmpDir: string;
  let storage: LocalStorageAdapter;
  let app: ReturnType<typeof createApp>;
  let mockTts: MockTtsProvider;
  let adminCookie: string;
  const adminEmail = 'curator@storyteller.studio';
  const sessionSecret = 'test-session-secret-at-least-32-chars-long!';

  let lastWriterDraftInput: GenerateWriterDraftInput | null = null;
  let lastDirectScriptInput: DirectScriptInput | null = null;

  const mockLLMProvider: StoryLLMProvider = {
    async generateWriterDraft(input: GenerateWriterDraftInput): Promise<WriterOutputInput> {
      lastWriterDraftInput = input;
      return {
        title: 'The Starlight Navigator',
        summary: 'Astrid steers her solar glider across the comet tail to guide lost starfinches home.',
        tags: ['sci-fi', 'adventure', 'stars'],
        characters: [{ name: 'Astrid', traits: 'Quick-thinking, joyful pilot' }],
        script_turns: [
          {
            turn_id: 1,
            speaker: 'Narrator',
            text: 'Across the glowing diamond ribbon of the Milky Way, Astrid adjusted her solar sails.',
          },
          {
            turn_id: 2,
            speaker: 'Astrid',
            text: 'Hang tight, starfinches! The nebula harbor is just past that singing nebula.',
          },
        ],
      };
    },

    async directScript(input: DirectScriptInput): Promise<DirectorOutputInput> {
      lastDirectScriptInput = input;
      return {
        script_turns: [
          {
            turn_id: 1,
            speaker: 'Narrator',
            style: 'Awestruck, expansive cadence with gentle warmth',
            text: 'Across the glowing diamond ribbon of the Milky Way, <short pause> Astrid adjusted her solar sails.',
          },
          {
            turn_id: 2,
            speaker: 'Astrid',
            style: 'Eager and cheerful, playful confidence',
            text: 'Hang tight, starfinches! <laugh> The nebula harbor is just past that singing nebula.',
          },
        ],
        voice_candidates: [
          {
            label: 'Astrid Voice',
            description: 'Youthful, spirited, clear resonant timbre with infectious curiosity',
            suggested_for: 'Astrid',
          },
        ],
      };
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-p14-test-'));
    const config = loadConfig({
      DATA_DIR: tmpDir,
      NODE_ENV: 'test',
      SESSION_SECRET: sessionSecret,
      ADMIN_GOOGLE_EMAIL: adminEmail,
      DEV_ADMIN_BYPASS: 'true',
      GEMINI_API_KEY: 'test-key',
    });

    storage = new LocalStorageAdapter(tmpDir);
    mockTts = new MockTtsProvider();

    // Seed initial Kore voice in storage
    const initialVoices: VoiceEntry[] = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Kore',
        description: 'Warm soothing narrator',
        language_code: 'en-US',
        tags: ['warm', 'soothing'],
        created_at: new Date().toISOString(),
      },
    ];
    await storage.saveVoices(initialVoices);

    app = createApp({
      config,
      storage,
      storyLLMProvider: mockLLMProvider,
      ttsProvider: mockTts,
    });

    adminCookie = `${ADMIN_COOKIE_NAME}=${signAdminSession(adminEmail, sessionSecret)}`;

    lastWriterDraftInput = null;
    lastDirectScriptInput = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('1. Backend Chained Pipeline Integration (POST /api/admin/stories/write)', () => {
    it('chains Writer -> Director -> Solo TTS in 1-tap when autoDirect and autoSynthesize are true', async () => {
      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A brave starfinch guide navigates the solar currents',
          ageRange: 'elementary',
          storyLength: 'short',
          autoDirect: true,
          autoSynthesize: true,
          narratorVoiceId: 'prebuilt-kore',
        });

      expect(res.status).toBe(201);
      const story: Story = res.body;

      // Stage 1 (Writer) check
      expect(story.id).toBeDefined();
      expect(story.title).toBe('The Starlight Navigator');
      expect(story.prompt_metadata?.story_length).toBe('short');
      expect(lastWriterDraftInput?.storyLength).toBe('short');

      // Stage 2 (Director) check
      expect(lastDirectScriptInput).not.toBeNull();
      expect(story.script_turns[0].style).toContain('Awestruck');
      expect(story.script_turns[0].text).toContain('<short pause>');
      expect(story.voice_candidates.length).toBeGreaterThan(0);

      // Stage 3 (TTS Synthesis) check
      expect(mockTts.synthesizeCalls.length).toBeGreaterThan(0);
      expect(story.status).toBe('published');
      expect(story.audio_versions.length).toBe(1);
      expect(story.audio_versions[0].casting.mode).toBe('solo');
      expect(story.audio_versions[0].casting.narrator_voice_id).toBe('prebuilt-kore');
      expect(story.audio_versions[0].is_default).toBe(true);
      expect(story.audio_versions[0].audio_url).toContain('.m4a');
      expect(story.audio_versions[0].wav_url).toContain('.wav');
    });

    it('chains Writer -> Director without TTS when autoSynthesize is false', async () => {
      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A starlight journey with autoDirect only',
          storyLength: 'long',
          autoDirect: true,
          autoSynthesize: false,
        });

      expect(res.status).toBe(201);
      const story: Story = res.body;

      expect(story.title).toBe('The Starlight Navigator');
      expect(story.status).toBe('draft');
      expect(story.prompt_metadata?.story_length).toBe('long');
      expect(lastDirectScriptInput).not.toBeNull();
      expect(story.script_turns[0].style).toContain('Awestruck');
      expect(mockTts.synthesizeCalls.length).toBe(0);
      expect(story.audio_versions.length).toBe(0);
    });

    it('preserves backwards compatibility when autoDirect is omitted', async () => {
      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A standalone unchained draft',
        });

      expect(res.status).toBe(201);
      const story: Story = res.body;

      expect(story.status).toBe('draft');
      expect(lastDirectScriptInput).toBeNull();
      expect(mockTts.synthesizeCalls.length).toBe(0);
      expect(story.script_turns[0].style).toBe('');
      expect(story.prompt_metadata?.story_length).toBe(DEFAULT_STORY_LENGTH);
    });

    it('validates storyLength against VALID_STORY_LENGTHS', async () => {
      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'Testing invalid length',
          storyLength: 'super-infinite',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid storyLength');
    });

    it('gathers recently used character names from catalog and passes avoidCharacterNames', async () => {
      // Seed an existing story with a unique character name
      const existingStory: Story = {
        id: '2026-11-12-existing-tale',
        status: 'published',
        title: 'Existing Tale',
        summary: 'A previous story with unique characters',
        tags: ['bedtime'],
        series_context: null,
        characters: [{ name: 'Zephyr', traits: 'Gentle breeze spirit' }],
        script_turns: [{ turn_id: 1, speaker: 'Narrator', style: '', text: 'Hello.' }],
        voice_candidates: [],
        audio_versions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await storage.saveStory(existingStory);
      await storage.saveCatalog([
        {
          id: existingStory.id,
          status: 'published',
          title: existingStory.title,
          summary: existingStory.summary,
          tags: existingStory.tags,
          series_id: null,
          episode_number: null,
          created_at: existingStory.created_at,
          updated_at: existingStory.updated_at,
          default_audio_url: null,
          audio_versions_count: 0,
        },
      ]);

      const res = await request(app)
        .post('/api/admin/stories/write')
        .set('Cookie', [adminCookie])
        .send({
          mode: 'fresh',
          prompt: 'A brand new tale of sky wanderers',
        });

      expect(res.status).toBe(201);
      expect(lastWriterDraftInput?.avoidCharacterNames).toContain('Zephyr');
    });
  });

  describe('2. Character Name Diversity & Pedagogical Prompt Rules', () => {
    it('banned AI character names include Barnaby, Bramble, Pip, Milo, Luna, etc.', () => {
      expect(BANNED_AI_CHARACTER_NAMES).toContain('Barnaby');
      expect(BANNED_AI_CHARACTER_NAMES).toContain('Bramble');
      expect(BANNED_AI_CHARACTER_NAMES).toContain('Pip');
      expect(BANNED_AI_CHARACTER_NAMES).toContain('Milo');
      expect(BANNED_AI_CHARACTER_NAMES).toContain('Oliver');
      expect(BANNED_AI_CHARACTER_NAMES).toContain('Luna');
    });

    it('buildCharacterDiversityInstruction generates diversity rules and appends avoidCharacterNames', () => {
      const prompt = 'A story about a courageous young astronaut';
      const instruction = buildCharacterDiversityInstruction(prompt, ['Zephyr', 'Orion']);

      expect(instruction).toContain('ANTI-CLICHÉ & CHARACTER NAME DIVERSITY RULE');
      expect(instruction).toContain('Barnaby');
      expect(instruction).toContain('DO NOT reuse any of these recently used character names: Zephyr, Orion');
    });

    it('buildCharacterDiversityInstruction allows banned name if explicitly requested in user prompt', () => {
      const prompt = 'A story about Oliver the clever owl who built a clock';
      const instruction = buildCharacterDiversityInstruction(prompt);

      // Oliver should not be forbidden because user explicitly requested Oliver
      expect(instruction).not.toContain('(Oliver');
      // Other names remain banned
      expect(instruction).toContain('Barnaby');
    });

    it('buildStoryLengthInstruction generates exact turn-count and word targets for all tiers', () => {
      const shortInst = buildStoryLengthInstruction('short');
      expect(shortInst).toContain('6 to 8 script turns');
      expect(shortInst).toContain('190 to 260 words');

      const mediumInst = buildStoryLengthInstruction('medium');
      expect(mediumInst).toContain('12 to 14 script turns');
      expect(mediumInst).toContain('430 to 560 words');
      expect(mediumInst).toContain('MINIMUM 410 words');

      const longInst = buildStoryLengthInstruction('long');
      expect(longInst).toContain('22 to 26 script turns');
      expect(longInst).toContain('800 to 980 words');
      expect(longInst).toContain('MINIMUM 760 words');

      const epicInst = buildStoryLengthInstruction('epic');
      expect(epicInst).toContain('30 to 36 script turns');
      expect(epicInst).toContain('1,150 to 1,400 words');
      expect(epicInst).toContain('MINIMUM 1,080 words');

      expect(buildStoryLengthReminder('long')).toContain('22–26 turns');
      expect(STORY_LENGTH_TARGETS.long.minWords).toBe(720);
      expect(STORY_LENGTH_TARGETS.epic.minWords).toBe(1000);
    });

    it('GoogleGenAIStoryLLMProvider runs conditional expansion only when real draft undershoots length floor', async () => {
      const longTurnText = Array.from({ length: 40 }, () => 'gelato').join(' ');
      const shortRealDraft = {
        title: 'Short Gelato Draft',
        summary: 'Too short initially.',
        tags: ['comedy'],
        characters: [{ name: 'Bongo', traits: 'Chill capybara' }],
        script_turns: Array.from({ length: 14 }, (_, idx) => ({
          turn_id: idx + 1,
          speaker: idx % 2 === 0 ? 'Narrator' : 'Bongo',
          text: longTurnText, // 14 * 40 = 560 words (< 720 minWords for 'long')
        })),
      };
      const expandedDraft = {
        ...shortRealDraft,
        script_turns: Array.from({ length: 22 }, (_, idx) => ({
          turn_id: idx + 1,
          speaker: idx % 2 === 0 ? 'Narrator' : 'Bongo',
          text: longTurnText, // 22 * 40 = 880 words (>= 720)
        })),
      };

      const calls: any[] = [];
      const provider = new GoogleGenAIStoryLLMProvider('test-key', 'gemini-4-hydrogen', 'LOW');
      (provider as any).ai = {
        models: {
          generateContent: async (args: any) => {
            calls.push(args);
            return {
              text: JSON.stringify(calls.length === 1 ? shortRealDraft : expandedDraft),
            };
          },
        },
      };

      const result = await provider.generateWriterDraft({
        mode: 'fresh',
        prompt: 'A capybara inside a gelato tub',
        storyLength: 'long',
      });

      expect(calls).toHaveLength(2);
      expect(calls[0].config.responseSchema.properties.script_turns.minItems).toBe('22');
      expect(calls[1].contents).toContain('EXPANSION REQUIRED');
      expect(result.script_turns).toHaveLength(22);

      // Now verify when first call already meets minWords (>= 720), only 1 call is made
      calls.length = 0;
      (provider as any).ai = {
        models: {
          generateContent: async (args: any) => {
            calls.push(args);
            return { text: JSON.stringify(expandedDraft) };
          },
        },
      };
      const singleCallResult = await provider.generateWriterDraft({
        mode: 'fresh',
        prompt: 'A capybara inside a gelato tub',
        storyLength: 'long',
      });
      expect(calls).toHaveLength(1);
      expect(singleCallResult.script_turns).toHaveLength(22);
    });

    it('defaultVocabularyForAge correctly maps age ranges to vocabulary tiers', () => {
      expect(defaultVocabularyForAge('toddler')).toBe('simple');
      expect(defaultVocabularyForAge('early-reader')).toBe('standard');
      expect(defaultVocabularyForAge('elementary')).toBe('enriched');
      expect(defaultVocabularyForAge('young-reader')).toBe('advanced');
    });

    it('buildPedagogicalInstruction auto-maps vocabulary when vocabularyLevel is omitted', () => {
      const toddlerInst = buildPedagogicalInstruction('toddler');
      expect(toddlerInst).toContain('Target Audience: Toddlers (Ages 2–4)');
      expect(toddlerInst).toContain('Vocabulary Level: Simple');

      const elementaryInst = buildPedagogicalInstruction('elementary');
      expect(elementaryInst).toContain('Target Audience: Elementary (Ages 8–10)');
      expect(elementaryInst).toContain('Vocabulary Level: Enriched');

      const explicitOverride = buildPedagogicalInstruction('toddler', 'advanced', 'Focus on space terms');
      expect(explicitOverride).toContain('Target Audience: Toddlers (Ages 2–4)');
      expect(explicitOverride).toContain('Vocabulary Level: Advanced');
      expect(explicitOverride).toContain('Custom Vocabulary Focus: Focus on space terms');
    });

    it('shared/voiceSamples.ts has eliminated "Barnaby" in favor of "Sir Cedric"', () => {
      const adventurePreset = VOICE_SAMPLE_PRESETS.find((p) => p.id === 'action-adventure');
      expect(adventurePreset).toBeDefined();
      expect(adventurePreset?.text).toContain('Sir Cedric');
      expect(adventurePreset?.text).not.toContain('Barnaby');

      // Verify no sample preset mentions Barnaby anywhere
      const anyBarnaby = VOICE_SAMPLE_PRESETS.some((p) => p.text.includes('Barnaby'));
      expect(anyBarnaby).toBe(false);
    });
  });

  describe('3. DirectorStudio Step 1 One-Tap UI Controls', () => {
    const adminSessionFixture: clientApi.AdminSession = {
      authenticated: true,
      email: 'curator@storyteller.studio',
      devBypassEnabled: true,
    };

    it('renders Story Length pills and switches between Quick, Standard, Extended, and Epic', async () => {
      vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchActiveJobs').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchRecentJobs').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue([
        {
          id: 'prebuilt-kore',
          label: 'Kore (Warm Prebuilt)',
          source: 'prebuilt',
          gemini_voice_name: 'Kore',
          description: 'Warm soothing narrator',
          language_code: 'en-US',
          tags: ['warm'],
          created_at: new Date().toISOString(),
        },
      ]);

      render(
        <DirectorStudio
          session={adminSessionFixture}
          onLogout={() => {}}
          onNavigateHome={() => {}}
        />
      );

      const lengthSelector = screen.getByTestId('story-length-selector');
      expect(lengthSelector).toBeInTheDocument();

      const standardPill = screen.getByRole('button', { name: /📖 Standard \(~3–4 min\)/i });
      const quickPill = screen.getByRole('button', { name: /⚡ Quick \(~1–2 min\)/i });
      const extendedPill = screen.getByRole('button', { name: /🌙 Extended \(~5–7 min\)/i });
      const epicPill = screen.getByRole('button', { name: /🏔️ Deep Dive \(~8–10 min\)/i });

      expect(standardPill).toHaveClass('active');
      expect(quickPill).not.toHaveClass('active');

      act(() => {
        fireEvent.click(quickPill);
      });
      expect(quickPill).toHaveClass('active');
      expect(standardPill).not.toHaveClass('active');

      act(() => {
        fireEvent.click(extendedPill);
      });
      expect(extendedPill).toHaveClass('active');
      expect(quickPill).not.toHaveClass('active');

      act(() => {
        fireEvent.click(epicPill);
      });
      expect(epicPill).toHaveClass('active');
      expect(extendedPill).not.toHaveClass('active');
    });

    it('renders Narrator Voice selector and auto-synthesize toggle, updating CTA button text', async () => {
      vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchActiveJobs').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchRecentJobs').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue([
        {
          id: 'prebuilt-kore',
          label: 'Kore (Warm Prebuilt)',
          source: 'prebuilt',
          gemini_voice_name: 'Kore',
          description: 'Warm soothing narrator',
          language_code: 'en-US',
          tags: ['warm'],
          created_at: new Date().toISOString(),
        },
        {
          id: 'prebuilt-puck',
          label: 'Puck (Playful Prebuilt)',
          source: 'prebuilt',
          gemini_voice_name: 'Puck',
          description: 'Playful narrator',
          language_code: 'en-US',
          tags: ['playful'],
          created_at: new Date().toISOString(),
        },
      ]);

      render(
        <DirectorStudio
          session={adminSessionFixture}
          onLogout={() => {}}
          onNavigateHome={() => {}}
        />
      );

      // Verify Narrator Voice select exists and loads voices
      const voiceSelect = await screen.findByRole('combobox', { name: /Narrator Voice/i });
      expect(voiceSelect).toBeInTheDocument();

      // Verify auto-synthesize toggle exists and is on by default
      const autoSynthToggle = screen.getByTestId('auto-synthesize-toggle');
      expect(autoSynthToggle).toBeChecked();

      // CTA button text with auto-synthesize ON
      const ctaBtn = screen.getByRole('button', { name: /✨ Create Story & Generate Audio/i });
      expect(ctaBtn).toBeInTheDocument();

      // Uncheck auto-synthesize
      act(() => {
        fireEvent.click(autoSynthToggle);
      });
      expect(autoSynthToggle).not.toBeChecked();

      // CTA button text should now read "Write & Direct Story Draft"
      expect(screen.getByRole('button', { name: /✍️ Write & Direct Story Draft/i })).toBeInTheDocument();
    });
  });
});
