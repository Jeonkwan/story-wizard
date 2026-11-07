import { GoogleGenAI } from '@google/genai';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { validateSlug } from '../storage/storageAdapter.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/validators.js';
import { extractPcmFromWavOrRaw, createSilencePcm, wrapPcmAsWav } from '../lib/wav.js';
import { storyToCatalogItem } from './geminiStory.js';
import type {
  AudioVersion,
  CatalogItem,
  Story,
  VoiceCasting,
  VoiceEntry,
  VoicePace,
} from '../../shared/types.js';
import {
  MAX_VOICE_PREVIEW_CHARS,
  DEFAULT_VOICE_SAMPLE,
} from '../../shared/voiceSamples.js';

export interface SpeechMetadata {
  speaker: string;
  style?: string;
}

export interface TtsTurnPart {
  text: string;
  speechMetadata?: SpeechMetadata;
}

export interface VoiceConfigPayload {
  prebuiltVoiceConfig?: { voiceName: string };
  voice?: string;
}

export interface SpeakerVoiceConfigPayload {
  speaker: string;
  voiceConfig: VoiceConfigPayload;
}

export interface MultiSpeakerVoiceConfigPayload {
  speakerVoiceConfigs: SpeakerVoiceConfigPayload[];
}

export interface SpeechConfigPayload {
  voiceConfig?: VoiceConfigPayload;
  multiSpeakerVoiceConfig?: MultiSpeakerVoiceConfigPayload;
}

export interface SynthesizeBatchRequest {
  model: string;
  parts: TtsTurnPart[];
  speechConfig: SpeechConfigPayload;
}

export interface PromptedVoiceRequest {
  label: string;
  description: string;
  languageCode?: string;
}

export interface PromptedVoiceResponse {
  geminiVoiceName: string;
  sampleAudioWav?: Buffer;
}

export interface TtsProvider {
  synthesizeBatch(req: SynthesizeBatchRequest): Promise<Buffer>;
  createPromptedVoice(req: PromptedVoiceRequest): Promise<PromptedVoiceResponse>;
  deleteCustomVoice?(geminiVoiceName: string): Promise<void>;
}

export class GoogleGenAITtsProvider implements TtsProvider {
  private ai: GoogleGenAI | null = null;

  constructor(private readonly apiKey: string) {}

  private getClient(): GoogleGenAI {
    if (!this.ai) {
      if (!this.apiKey) {
        throw new Error('GEMINI_API_KEY is required for Gemini TTS provider');
      }
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.ai;
  }

  async synthesizeBatch(req: SynthesizeBatchRequest): Promise<Buffer> {
    const ai = this.getClient();

    const contents = [
      {
        role: 'user',
        parts: req.parts.map((p) => ({
          text: p.text,
          speechMetadata: p.speechMetadata
            ? {
                speaker: p.speechMetadata.speaker,
                style: p.speechMetadata.style,
              }
            : undefined,
        })),
      },
    ];

    // Note: cast speechConfig to any to satisfy the SDK's structural types
    const response = await ai.models.generateContent({
      model: req.model,
      contents,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: req.speechConfig as any,
      },
    });

    const candidates = response.candidates;
    const parts = candidates?.[0]?.content?.parts;
    const audioPart = parts?.find((p) => p.inlineData?.data);

    if (!audioPart || !audioPart.inlineData?.data) {
      throw new Error('No audio data received from Gemini TTS model');
    }

    return Buffer.from(audioPart.inlineData.data, 'base64');
  }

  async createPromptedVoice(req: PromptedVoiceRequest): Promise<PromptedVoiceResponse> {
    const ai = this.getClient();

    const created = await ai.voices.create({
      store: true,
      voice: {
        type: 'prompted',
        display_name: req.label,
        description: req.description,
        language_code: req.languageCode || 'en-US',
        prompted: {
          input: req.description,
        },
      },
    });

    if (!created.id) {
      throw new Error('Google Voices API did not return a voice ID');
    }

    let sampleAudioWav: Buffer | undefined;
    if (created.sample_audio?.data) {
      sampleAudioWav = Buffer.from(created.sample_audio.data, 'base64');
    }

    return {
      geminiVoiceName: created.id,
      sampleAudioWav,
    };
  }

  async deleteCustomVoice(geminiVoiceName: string): Promise<void> {
    const bareId = (geminiVoiceName || '').trim().replace(/^voices\//, '');
    if (!/^voice_[a-zA-Z0-9_-]+$/.test(bareId)) {
      throw new ValidationError(`Invalid Gemini custom voice ID format: "${geminiVoiceName}"`);
    }
    const ai = this.getClient();
    try {
      await ai.voices.delete(bareId);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: number; message?: string };
      const isNotFound =
        error.status === 404 ||
        error.code === 404 ||
        (typeof error.message === 'string' && error.message.toLowerCase().includes('not found'));
      if (!isNotFound) {
        throw err;
      }
    }
  }
}

export function toGeminiVoiceConfig(voice: VoiceEntry): VoiceConfigPayload {
  if (voice.source === 'prebuilt') {
    return { prebuiltVoiceConfig: { voiceName: voice.gemini_voice_name } };
  }
  return { voice: voice.gemini_voice_name };
}

export const MAX_TTS_BATCH_TURNS = 6;
export const MAX_TTS_BATCH_CHARS = 1500;

export const PACE_VOICE_PROMPT_CLAUSE: Record<VoicePace, string> = {
  slow: 'Speaking pace should be slow, soothing, gentle, and unhurried with clear word articulation.',
  calm: 'Speaking pace should be calm, relaxed, balanced, and unhurried with clear storytelling articulation.',
  natural: 'Speaking pace should be natural, engaging, and balanced with clear articulation.',
  lively: 'Speaking pace should be lively, upbeat, animated, and bouncy while keeping every word clear and crisp.',
};

export const PACE_SYNTHESIS_ANCHOR: Record<VoicePace, string> = {
  slow: 'Pace: slow, soothing, unhurried cadence with gentle pauses and crystal-clear word-by-word articulation.',
  calm: 'Pace: calm, relaxed, measured storytelling cadence with clear, unhurried articulation.',
  natural: 'Pace: natural, balanced storytelling rhythm with clear, intelligible word articulation—never rushed.',
  lively: 'Pace: lively, upbeat, animated storytelling energy while keeping every word crisp, clear, and unhurried for young children.',
};

export function clampToBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastBoundary = Math.max(
    truncated.lastIndexOf(' '),
    truncated.lastIndexOf('\t'),
    truncated.lastIndexOf(','),
    truncated.lastIndexOf(';'),
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf(':')
  );
  const clamped = (lastBoundary > 0 ? truncated.slice(0, lastBoundary) : truncated)
    .replace(/[,;:\s]+$/, '')
    .trim();
  return clamped;
}

export function sanitizeLiteralTempoPhrases(style: string): string {
  if (!style) return '';
  let s = style
    .replace(/^fast,\s*/i, 'Energetic, ')
    .replace(/\b(runs|running)\s+full speed\b/gi, '$1 with playful urgency')
    .replace(/\bfull speed\b/gi, 'full enthusiasm')
    .replace(/\bat high speed\b/gi, 'with high animated energy')
    .replace(/\bcartoonish speed\b/gi, 'animated cartoon energy')
    .replace(/\bfast[- ]paced\b/gi, 'lively, energetic')
    .replace(/\brapid[- ]fire\b/gi, 'bouncy, spirited')
    .replace(/\bspeaking\s+(?:very\s+)?(?:fast|rapidly|quickly)\b/gi, 'speaking animatedly');

  s = s.replace(/\s{2,}/g, ' ').trim();
  if (s.length > 280) {
    s = clampToBoundary(s, 280);
  }
  return s;
}

export function buildTurnStyle(baseStyle: string, pace: VoicePace): string {
  const anchor = PACE_SYNTHESIS_ANCHOR[pace] || PACE_SYNTHESIS_ANCHOR.natural;
  const sanitized = sanitizeLiteralTempoPhrases(baseStyle);
  if (!sanitized) {
    return anchor;
  }
  const maxBase = 280 - anchor.length - 2;
  const trimmedBase = sanitized.length > maxBase ? clampToBoundary(sanitized, maxBase) : sanitized;
  return trimmedBase ? `${trimmedBase}. ${anchor}` : anchor;
}

export function buildPromptedVoiceDescription(description: string, pace?: VoicePace): string {
  const cleanDesc = description.trim();
  if (pace && PACE_VOICE_PROMPT_CLAUSE[pace]) {
    return `${cleanDesc}. ${PACE_VOICE_PROMPT_CLAUSE[pace]}`;
  }
  return cleanDesc;
}

export function buildPreviewStyle(description: string, pace: VoicePace): string {
  return buildTurnStyle(description || 'Warm, clear, expressive storytelling cadence', pace);
}

export interface PreviewVoiceInput {
  voiceId?: string;
  description?: string;
  sampleText?: string;
  pace?: VoicePace;
  draftGeminiVoiceName?: string;
  previousDraftGeminiVoiceName?: string;
  regenerateTake?: boolean;
}

export interface PreviewVoiceResult {
  wav: Buffer;
  draftGeminiVoiceName?: string;
}

export interface CreateVoiceInput {
  label: string;
  description: string;
  languageCode?: string;
  tags?: string[];
  defaultPace?: VoicePace;
  stagedGeminiVoiceName?: string;
  previewWavBuffer?: Buffer;
}

export interface SynthesizeStoryInput {
  casting: VoiceCasting;
  label?: string;
  makeDefault?: boolean;
}

export { DEFAULT_VOICE_SAMPLE };

export const DEFAULT_PREBUILT_VOICES: VoiceEntry[] = [
  {
    id: 'prebuilt-kore',
    label: 'Kore (Warm Prebuilt)',
    source: 'prebuilt',
    gemini_voice_name: 'Kore',
    description: 'Warm, clear, expressive storytelling voice',
    language_code: 'en-US',
    tags: ['warm', 'expressive', 'storytelling'],
    default_pace: 'natural',
    created_at: '2026-11-04T00:00:00.000Z',
  },
  {
    id: 'prebuilt-puck',
    label: 'Puck (Playful Prebuilt)',
    source: 'prebuilt',
    gemini_voice_name: 'Puck',
    description: 'Gentle, curious, melodic voice',
    language_code: 'en-US',
    tags: ['curious', 'gentle'],
    default_pace: 'natural',
    created_at: '2026-11-04T00:00:00.000Z',
  },
  {
    id: 'prebuilt-aoede',
    label: 'Aoede (Breezy Prebuilt)',
    source: 'prebuilt',
    gemini_voice_name: 'Aoede',
    description: 'Soft whispery bedtime timbre',
    language_code: 'en-US',
    tags: ['soft', 'whisper'],
    default_pace: 'calm',
    created_at: '2026-11-04T00:00:00.000Z',
  },
];

export class GeminiTtsService {
  private readonly ttsProvider: TtsProvider;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: StorageAdapter,
    ttsProvider?: TtsProvider
  ) {
    this.ttsProvider =
      ttsProvider || new GoogleGenAITtsProvider(this.config.geminiApiKey);
  }

  /**
   * Returns all available voices, merging DEFAULT_PREBUILT_VOICES with stored voices.json.
   * Stored voices take precedence on matching ID so user customizations are respected.
   */
  async listVoices(): Promise<VoiceEntry[]> {
    let storedVoices: VoiceEntry[] = [];
    try {
      storedVoices = await this.storage.getVoices();
    } catch {
      storedVoices = [];
    }

    const voiceMap = new Map<string, VoiceEntry>();
    for (const def of DEFAULT_PREBUILT_VOICES) {
      voiceMap.set(def.id, def);
    }
    for (const v of storedVoices) {
      voiceMap.set(v.id, v);
    }

    return Array.from(voiceMap.values());
  }

  /**
   * Preview a voice (either an existing saved voice or a candidate natural-language prompt)
   * clamped to <= MAX_VOICE_PREVIEW_CHARS (320).
   * For unsaved prompts, creates a staged voice take via ai.voices.create and returns draftGeminiVoiceName.
   */
  async previewVoice(input: PreviewVoiceInput): Promise<PreviewVoiceResult> {
    const rawSample = input.sampleText && input.sampleText.trim()
      ? input.sampleText.trim()
      : DEFAULT_VOICE_SAMPLE;
    const clampedSample = rawSample.slice(0, MAX_VOICE_PREVIEW_CHARS);

    if (input.voiceId && input.voiceId.trim()) {
      const voices = await this.listVoices();
      const voice = voices.find((v) => v.id === input.voiceId!.trim());
      if (!voice) {
        throw new NotFoundError(`Voice not found: "${input.voiceId}"`);
      }
      const effectivePace: VoicePace = input.pace || voice.default_pace || 'natural';
      const style = buildTurnStyle(
        input.description || voice.description || 'Warm, clear, expressive storytelling cadence',
        effectivePace
      );

      const rawBuffer = await this.ttsProvider.synthesizeBatch({
        model: this.config.geminiTtsLiteModel,
        parts: [
          {
            text: clampedSample,
            speechMetadata: {
              speaker: 'Narrator',
              style,
            },
          },
        ],
        speechConfig: {
          voiceConfig: toGeminiVoiceConfig(voice),
        },
      });

      const pcm = extractPcmFromWavOrRaw(rawBuffer);
      const { wav } = wrapPcmAsWav(pcm);
      return { wav };
    } else if (input.description && input.description.trim()) {
      const draftId = input.draftGeminiVoiceName
        ? input.draftGeminiVoiceName.trim().replace(/^voices\//, '')
        : undefined;
      const prevDraftId = input.previousDraftGeminiVoiceName
        ? input.previousDraftGeminiVoiceName.trim().replace(/^voices\//, '')
        : undefined;

      if (draftId && !/^voice_[a-zA-Z0-9_-]+$/.test(draftId)) {
        throw new ValidationError(`Invalid draft voice ID format: "${input.draftGeminiVoiceName}"`);
      }
      if (prevDraftId && !/^voice_[a-zA-Z0-9_-]+$/.test(prevDraftId)) {
        throw new ValidationError(`Invalid previous draft voice ID format: "${input.previousDraftGeminiVoiceName}"`);
      }

      // Saved-Voice Protection Invariant for draft cleanup:
      // If previousDraftGeminiVoiceName is provided and (regenerateTake or previousDraft !== draft),
      // verify it does NOT belong to a saved voice before deleting.
      if (prevDraftId && (input.regenerateTake || prevDraftId !== draftId)) {
        const savedVoices = await this.listVoices();
        const isSaved = savedVoices.some(
          (v) => (v.gemini_voice_name || '').replace(/^voices\//, '') === prevDraftId
        );
        if (!isSaved && this.ttsProvider.deleteCustomVoice) {
          try {
            await this.ttsProvider.deleteCustomVoice(prevDraftId);
          } catch {
            // Swallow error during background draft cleanup
          }
        }
      }

      const effectivePace: VoicePace = input.pace || 'natural';

      let activeDraftVoiceName: string;
      if (draftId && !input.regenerateTake) {
        activeDraftVoiceName = draftId;
      } else {
        const promptDescription = buildPromptedVoiceDescription(input.description, effectivePace);
        const created = await this.ttsProvider.createPromptedVoice({
          label: 'Draft Voice Preview',
          description: promptDescription,
        });
        activeDraftVoiceName = created.geminiVoiceName.trim().replace(/^voices\//, '');
      }

      const style = buildPreviewStyle(input.description, effectivePace);

      const rawBuffer = await this.ttsProvider.synthesizeBatch({
        model: this.config.geminiTtsLiteModel,
        parts: [
          {
            text: clampedSample,
            speechMetadata: {
              speaker: 'Narrator',
              style,
            },
          },
        ],
        speechConfig: {
          voiceConfig: { voice: activeDraftVoiceName },
        },
      });

      const pcm = extractPcmFromWavOrRaw(rawBuffer);
      const { wav } = wrapPcmAsWav(pcm);
      return { wav, draftGeminiVoiceName: activeDraftVoiceName };
    } else {
      throw new ValidationError('Either voiceId or description is required for voice preview');
    }
  }

  /**
   * Creates a custom prompted voice via the Google Voices API (or promotes an existing staged draft voice),
   * generates a unique slug ID, caches preview WAV audio, and atomically appends it to voices.json.
   */
  async createAndSaveVoice(input: CreateVoiceInput): Promise<VoiceEntry> {
    const label = input.label ? input.label.trim() : '';
    const description = input.description ? input.description.trim() : '';

    if (!label) {
      throw new ValidationError('Voice label is required');
    }
    if (!description) {
      throw new ValidationError('Voice description is required');
    }

    if (input.defaultPace && !['slow', 'calm', 'natural', 'lively'].includes(input.defaultPace)) {
      throw new ValidationError(`Invalid default pace: "${input.defaultPace}"`);
    }

    const defaultPace: VoicePace = input.defaultPace || 'natural';

    const existingVoices = await this.listVoices();
    const existingIds = new Set(existingVoices.map((v) => v.id));

    let geminiVoiceName: string;
    let fallbackSampleAudioWav: Buffer | undefined;
    const isFreshPromptedVoice = !input.stagedGeminiVoiceName || !input.stagedGeminiVoiceName.trim();

    if (input.stagedGeminiVoiceName && input.stagedGeminiVoiceName.trim()) {
      const bareStagedId = input.stagedGeminiVoiceName.trim().replace(/^voices\//, '');
      if (!/^voice_[a-zA-Z0-9_-]+$/.test(bareStagedId)) {
        throw new ValidationError(`Invalid staged voice ID format: "${input.stagedGeminiVoiceName}"`);
      }

      const isAlreadySaved = existingVoices.some(
        (v) => (v.gemini_voice_name || '').replace(/^voices\//, '') === bareStagedId
      );
      if (isAlreadySaved) {
        throw new ConflictError(`Staged voice ID already exists as a saved voice: "${bareStagedId}"`);
      }

      geminiVoiceName = bareStagedId;
    } else {
      const promptDesc = buildPromptedVoiceDescription(description, defaultPace);
      const created = await this.ttsProvider.createPromptedVoice({
        label,
        description: promptDesc,
        languageCode: input.languageCode,
      });
      geminiVoiceName = created.geminiVoiceName.trim().replace(/^voices\//, '');
      fallbackSampleAudioWav = created.sampleAudioWav;
    }

    const kebab = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'custom';

    const baseId = `designed-${kebab}`;
    let voiceId = baseId;
    let counter = 2;

    while (existingIds.has(voiceId)) {
      voiceId = `${baseId}-${counter}`;
      counter++;
    }

    validateSlug(voiceId, 'voiceId');

    // Best-effort preview WAV caching
    let previewAudioUrl: string | undefined;
    try {
      let previewWav: Buffer | undefined;
      if (input.previewWavBuffer && input.previewWavBuffer.length > 0) {
        const pcm = extractPcmFromWavOrRaw(input.previewWavBuffer);
        const { wav } = wrapPcmAsWav(pcm);
        previewWav = wav;
      } else if (fallbackSampleAudioWav && fallbackSampleAudioWav.length > 0) {
        const pcm = extractPcmFromWavOrRaw(fallbackSampleAudioWav);
        const { wav } = wrapPcmAsWav(pcm);
        previewWav = wav;
      } else {
        const previewRes = await this.previewVoice({
          description,
          sampleText: DEFAULT_VOICE_SAMPLE,
          pace: defaultPace,
          draftGeminiVoiceName: geminiVoiceName,
        });
        previewWav = previewRes.wav;
      }

      if (previewWav && previewWav.length > 0) {
        await this.storage.saveVoicePreview(voiceId, previewWav);
        previewAudioUrl = `/api/voices/${voiceId}/preview.wav`;
      }
    } catch (previewErr) {
      console.warn(`[TtsService] Best-effort preview caching failed for ${voiceId}:`, previewErr);
    }

    const newVoice: VoiceEntry = {
      id: voiceId,
      label,
      source: 'designed',
      gemini_voice_name: geminiVoiceName,
      description,
      language_code: input.languageCode?.trim() || 'en-US',
      tags: Array.isArray(input.tags)
        ? input.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      default_pace: defaultPace,
      ...(previewAudioUrl ? { preview_audio_url: previewAudioUrl } : {}),
      created_at: new Date().toISOString(),
    };

    try {
      await this.storage.updateJsonAtomic<VoiceEntry[]>(
        'voices.json',
        (current) => {
          const list = current && current.length > 0 ? [...current] : [...DEFAULT_PREBUILT_VOICES];
          list.push(newVoice);
          return list;
        },
        []
      );
    } catch (storageErr) {
      if (isFreshPromptedVoice && this.ttsProvider.deleteCustomVoice) {
        try {
          await this.ttsProvider.deleteCustomVoice(geminiVoiceName);
        } catch {
          // Best-effort cleanup of orphaned Gemini voice
        }
      }
      throw storageErr;
    }

    return newVoice;
  }

  /**
   * Updates an existing voice's metadata (label, description, tags, defaultPace).
   * For prebuilt voices, persists overrides while keeping id, source, and gemini_voice_name immutable.
   */
  async updateVoice(
    voiceId: string,
    patch: { label?: string; description?: string; tags?: string[]; defaultPace?: VoicePace }
  ): Promise<VoiceEntry> {
    validateSlug(voiceId, 'voiceId');

    if (patch.defaultPace && !['slow', 'calm', 'natural', 'lively'].includes(patch.defaultPace)) {
      throw new ValidationError(`Invalid default pace: "${patch.defaultPace}"`);
    }

    let updatedEntry: VoiceEntry | null = null;

    await this.storage.updateJsonAtomic<VoiceEntry[]>(
      'voices.json',
      (current) => {
        const list = current && current.length > 0 ? [...current] : [...DEFAULT_PREBUILT_VOICES];
        const idx = list.findIndex((v) => v.id === voiceId);
        let existing: VoiceEntry;

        if (idx >= 0) {
          existing = list[idx];
        } else {
          const prebuilt = DEFAULT_PREBUILT_VOICES.find((v) => v.id === voiceId);
          if (!prebuilt) {
            throw new NotFoundError(`Voice not found: "${voiceId}"`);
          }
          existing = { ...prebuilt };
          list.push(existing);
        }

        const targetIdx = list.findIndex((v) => v.id === voiceId);
        updatedEntry = {
          ...existing,
          label: typeof patch.label === 'string' && patch.label.trim() ? patch.label.trim() : existing.label,
          description:
            typeof patch.description === 'string' && patch.description.trim()
              ? patch.description.trim()
              : existing.description,
          tags: Array.isArray(patch.tags)
            ? patch.tags.map((t) => String(t).trim()).filter(Boolean)
            : existing.tags,
          default_pace: patch.defaultPace || existing.default_pace || 'natural',
        };

        // Source, id, and gemini_voice_name remain strictly immutable
        updatedEntry.id = existing.id;
        updatedEntry.source = existing.source;
        updatedEntry.gemini_voice_name = existing.gemini_voice_name;

        list[targetIdx] = updatedEntry;
        return list;
      },
      []
    );

    if (!updatedEntry) {
      throw new NotFoundError(`Voice not found: "${voiceId}"`);
    }

    return updatedEntry;
  }

  /**
   * Deletes a custom designed voice from voices.json and deletes its preview audio.
   * Prebuilt system voices cannot be deleted.
   */
  async deleteVoice(voiceId: string): Promise<{ deletedId: string }> {
    validateSlug(voiceId, 'voiceId');

    const voices = await this.listVoices();
    const voice = voices.find((v) => v.id === voiceId);
    if (!voice) {
      throw new NotFoundError(`Voice not found: "${voiceId}"`);
    }

    if (voice.source === 'prebuilt') {
      throw new ValidationError('Prebuilt system voices cannot be deleted');
    }

    await this.storage.updateJsonAtomic<VoiceEntry[]>(
      'voices.json',
      (current) => {
        return current ? current.filter((v) => v.id !== voiceId) : [];
      },
      []
    );

    await this.storage.deleteVoicePreview(voiceId);

    if (this.ttsProvider.deleteCustomVoice && voice.gemini_voice_name) {
      try {
        await this.ttsProvider.deleteCustomVoice(voice.gemini_voice_name);
      } catch {
        // Best-effort cleanup
      }
    }

    return { deletedId: voiceId };
  }

  /**
   * Discards an unsaved staged draft voice ID after verifying it does not belong to any saved voice.
   */
  async discardDraftVoice(geminiVoiceName: string): Promise<void> {
    const bareId = (geminiVoiceName || '').trim().replace(/^voices\//, '');
    if (!/^voice_[a-zA-Z0-9_-]+$/.test(bareId)) {
      throw new ValidationError(`Invalid draft voice ID format: "${geminiVoiceName}"`);
    }

    // Saved-Voice Protection Invariant
    const voices = await this.listVoices();
    const isSaved = voices.some(
      (v) => (v.gemini_voice_name || '').replace(/^voices\//, '') === bareId
    );
    if (isSaved) {
      throw new ConflictError(
        `Cannot delete voice "${bareId}": it is currently saved in the voice library`
      );
    }

    if (this.ttsProvider.deleteCustomVoice) {
      await this.ttsProvider.deleteCustomVoice(bareId);
    }
  }

  /**
   * Synthesizes all script turns of a story (in solo or cast mode), concatenates PCM with 150ms
   * silence between batches, wraps as a single canonical RIFF WAV, writes audio to storage,
   * adds an AudioVersion to the Story, marks story as published, and atomically syncs catalog.json.
   */
  async synthesizeFullStory(
    storyId: string,
    input: SynthesizeStoryInput
  ): Promise<Story> {
    validateSlug(storyId, 'storyId');

    const story = await this.storage.getStory(storyId);
    if (!story.script_turns || story.script_turns.length === 0) {
      throw new ValidationError('Story has no script turns to synthesize');
    }

    const voices = await this.listVoices();
    const voiceMap = new Map<string, VoiceEntry>(voices.map((v) => [v.id, v]));

    const { casting, label, makeDefault } = input;
    if (!casting || (casting.mode !== 'solo' && casting.mode !== 'cast')) {
      throw new ValidationError('Invalid casting mode: must be "solo" or "cast"');
    }

    if (!casting.narrator_voice_id || typeof casting.narrator_voice_id !== 'string') {
      throw new ValidationError('Narrator voice ID is required');
    }

    const narratorVoice = voiceMap.get(casting.narrator_voice_id);
    if (!narratorVoice) {
      throw new ValidationError(`Narrator voice not found: "${casting.narrator_voice_id}"`);
    }

    if (casting.mode === 'cast') {
      for (const turn of story.script_turns) {
        if (turn.speaker !== 'Narrator') {
          const charVoiceId = casting.character_voices?.[turn.speaker];
          if (!charVoiceId || !voiceMap.has(charVoiceId)) {
            throw new ValidationError(
              `Missing or invalid voice for character: "${turn.speaker}"`
            );
          }
        }
      }
    }

    // Build Batches
    interface SubBatch {
      parts: TtsTurnPart[];
      speechConfig: SpeechConfigPayload;
    }

    const batches: SubBatch[] = [];
    const characterMap = new Map(story.characters.map((c) => [c.name, c.traits]));

    if (casting.mode === 'solo') {
      const effectivePace: VoicePace = casting.pace || narratorVoice.default_pace || 'natural';
      // Solo mode: contiguous batches of <= 6 turns and <= 1,500 characters
      let currentTurns: typeof story.script_turns = [];
      let currentChars = 0;

      for (const turn of story.script_turns) {
        const turnLen = turn.text.length;
        if (
          currentTurns.length > 0 &&
          (currentTurns.length >= MAX_TTS_BATCH_TURNS || currentChars + turnLen > MAX_TTS_BATCH_CHARS)
        ) {
          // Commit current batch
          const parts: TtsTurnPart[] = currentTurns.map((t) => {
            const charTrait = characterMap.get(t.speaker);
            const baseStyle =
              t.speaker === 'Narrator'
                ? t.style || 'Warm, clear, expressive storytelling cadence'
                : `Speaking dialogue as ${t.speaker}${charTrait ? ` (${charTrait})` : ''}: ${t.style || 'expressive, dynamic'}`;
            return {
              text: t.text,
              speechMetadata: {
                speaker: 'Narrator',
                style: buildTurnStyle(baseStyle, effectivePace),
              },
            };
          });

          batches.push({
            parts,
            speechConfig: {
              voiceConfig: toGeminiVoiceConfig(narratorVoice),
            },
          });

          currentTurns = [];
          currentChars = 0;
        }

        currentTurns.push(turn);
        currentChars += turnLen;
      }

      if (currentTurns.length > 0) {
        const parts: TtsTurnPart[] = currentTurns.map((t) => {
          const charTrait = characterMap.get(t.speaker);
          const baseStyle =
            t.speaker === 'Narrator'
              ? t.style || 'Warm, clear, expressive storytelling cadence'
              : `Speaking dialogue as ${t.speaker}${charTrait ? ` (${charTrait})` : ''}: ${t.style || 'expressive, dynamic'}`;
          return {
            text: t.text,
            speechMetadata: {
              speaker: 'Narrator',
              style: buildTurnStyle(baseStyle, effectivePace),
            },
          };
        });

        batches.push({
          parts,
          speechConfig: {
            voiceConfig: toGeminiVoiceConfig(narratorVoice),
          },
        });
      }
    } else {
      // Cast mode: contiguous turns sharing <= 2 distinct speakers, <= 6 turns, <= 1,500 chars
      let currentTurns: typeof story.script_turns = [];
      let currentSpeakers = new Set<string>();
      let currentChars = 0;

      for (const turn of story.script_turns) {
        const turnLen = turn.text.length;
        const potentialSpeakers = new Set(currentSpeakers);
        potentialSpeakers.add(turn.speaker);

        if (
          currentTurns.length > 0 &&
          (potentialSpeakers.size > 2 ||
            currentTurns.length >= MAX_TTS_BATCH_TURNS ||
            currentChars + turnLen > MAX_TTS_BATCH_CHARS)
        ) {
          // Commit current sub-batch
          const distinctSpeakers = Array.from(currentSpeakers);
          let speechConfig: SpeechConfigPayload;

          if (distinctSpeakers.length === 1) {
            const spk = distinctSpeakers[0];
            const voice =
              spk === 'Narrator' ? narratorVoice : voiceMap.get(casting.character_voices[spk])!;
            speechConfig = {
              voiceConfig: toGeminiVoiceConfig(voice),
            };
          } else {
            // EXACT 2 speakers rule
            const speakerVoiceConfigs = distinctSpeakers.map((spk) => {
              const voice =
                spk === 'Narrator' ? narratorVoice : voiceMap.get(casting.character_voices[spk])!;
              return {
                speaker: spk,
                voiceConfig: toGeminiVoiceConfig(voice),
              };
            });
            speechConfig = {
              multiSpeakerVoiceConfig: {
                speakerVoiceConfigs,
              },
            };
          }

          const parts: TtsTurnPart[] = currentTurns.map((t) => {
            const turnVoice =
              t.speaker === 'Narrator'
                ? narratorVoice
                : voiceMap.get(casting.character_voices[t.speaker]);
            const turnPace: VoicePace =
              casting.pace || turnVoice?.default_pace || 'natural';
            const baseStyle = t.style || 'Warm, clear, expressive storytelling cadence';
            return {
              text: t.text,
              speechMetadata: {
                speaker: t.speaker,
                style: buildTurnStyle(baseStyle, turnPace),
              },
            };
          });

          batches.push({ parts, speechConfig });

          currentTurns = [];
          currentSpeakers = new Set();
          currentChars = 0;
        }

        currentTurns.push(turn);
        currentSpeakers.add(turn.speaker);
        currentChars += turnLen;
      }

      if (currentTurns.length > 0) {
        const distinctSpeakers = Array.from(currentSpeakers);
        let speechConfig: SpeechConfigPayload;

        if (distinctSpeakers.length === 1) {
          const spk = distinctSpeakers[0];
          const voice =
            spk === 'Narrator' ? narratorVoice : voiceMap.get(casting.character_voices[spk])!;
          speechConfig = {
            voiceConfig: toGeminiVoiceConfig(voice),
          };
        } else {
          const speakerVoiceConfigs = distinctSpeakers.map((spk) => {
            const voice =
              spk === 'Narrator' ? narratorVoice : voiceMap.get(casting.character_voices[spk])!;
            return {
              speaker: spk,
              voiceConfig: toGeminiVoiceConfig(voice),
            };
          });
          speechConfig = {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs,
            },
          };
        }

        const parts: TtsTurnPart[] = currentTurns.map((t) => {
          const turnVoice =
            t.speaker === 'Narrator'
              ? narratorVoice
              : voiceMap.get(casting.character_voices[t.speaker]);
          const turnPace: VoicePace =
            casting.pace || turnVoice?.default_pace || 'natural';
          const baseStyle = t.style || 'Warm, clear, expressive storytelling cadence';
          return {
            text: t.text,
            speechMetadata: {
              speaker: t.speaker,
              style: buildTurnStyle(baseStyle, turnPace),
            },
          };
        });

        batches.push({ parts, speechConfig });
      }
    }

    // Synthesize each batch and collect pure PCM
    const pcmBuffers: Buffer[] = [];
    for (const batch of batches) {
      const rawAudio = await this.ttsProvider.synthesizeBatch({
        model: this.config.geminiTtsModel,
        parts: batch.parts,
        speechConfig: batch.speechConfig,
      });
      const pcm = extractPcmFromWavOrRaw(rawAudio);
      pcmBuffers.push(pcm);
    }

    // Interleave with 150ms silence between batches (N batches -> N - 1 silences)
    const silence150 = createSilencePcm(150);
    const chainedPcm: Buffer[] = [];
    for (let i = 0; i < pcmBuffers.length; i++) {
      chainedPcm.push(pcmBuffers[i]);
      if (i < pcmBuffers.length - 1) {
        chainedPcm.push(silence150);
      }
    }

    const fullPcm = Buffer.concat(chainedPcm);
    const { wav, durationSec } = wrapPcmAsWav(fullPcm);

    // Generate version ID slug
    const baseLabel = (
      label ||
      (casting.mode === 'solo'
        ? `${narratorVoice.label.split(' ')[0]} (Solo)`
        : 'Cast Ensemble')
    ).trim();

    const kebabLabel =
      baseLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'audio';

    const versionNum = (story.audio_versions?.length || 0) + 1;
    const timestamp = Math.floor(Date.now() / 1000);
    const versionId = `v${versionNum}-${kebabLabel}-${timestamp}`;
    validateSlug(versionId, 'versionId');

    // Save audio WAV to storage
    await this.storage.saveAudio(story.id, versionId, wav);

    const shouldBeDefault =
      !story.audio_versions || story.audio_versions.length === 0
        ? true
        : (makeDefault ?? true);

    const existingVersions = story.audio_versions ? [...story.audio_versions] : [];
    if (shouldBeDefault) {
      for (const v of existingVersions) {
        v.is_default = false;
      }
    }

    const normalizedCasting: VoiceCasting = {
      mode: casting.mode,
      narrator_voice_id: casting.narrator_voice_id.trim(),
      character_voices:
        casting.mode === 'cast' ? { ...(casting.character_voices || {}) } : {},
      pace: casting.pace,
    };

    const newVersion: AudioVersion = {
      version_id: versionId,
      label: baseLabel,
      casting: normalizedCasting,
      is_default: shouldBeDefault,
      duration_sec: durationSec,
      audio_url: `/api/stories/${story.id}/audios/${versionId}.wav`,
      created_at: new Date().toISOString(),
    };

    existingVersions.push(newVersion);
    story.audio_versions = existingVersions;
    story.status = 'published';

    if (
      casting.mode === 'solo' &&
      story.series_context &&
      !story.series_context.preferred_voice_id
    ) {
      story.series_context.preferred_voice_id = casting.narrator_voice_id;
    }

    story.updated_at = new Date().toISOString();
    await this.storage.saveStory(story);

    // Atomically sync catalog.json
    const catalogItem = storyToCatalogItem(story);
    await this.storage.updateJsonAtomic<CatalogItem[]>(
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

    return story;
  }
}
