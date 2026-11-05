import { GoogleGenAI } from '@google/genai';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { validateSlug } from '../storage/storageAdapter.js';
import { ValidationError } from '../lib/validators.js';
import { extractPcmFromWavOrRaw, createSilencePcm, wrapPcmAsWav } from '../lib/wav.js';
import { storyToCatalogItem } from './geminiStory.js';
import type {
  AudioVersion,
  CatalogItem,
  Story,
  VoiceCasting,
  VoiceEntry,
} from '../../shared/types.js';

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
}

export function toGeminiVoiceConfig(voice: VoiceEntry): VoiceConfigPayload {
  if (voice.source === 'prebuilt') {
    return { prebuiltVoiceConfig: { voiceName: voice.gemini_voice_name } };
  }
  return { voice: voice.gemini_voice_name };
}

export interface PreviewVoiceInput {
  voiceId?: string;
  description?: string;
  sampleText?: string;
}

export interface CreateVoiceInput {
  label: string;
  description: string;
  languageCode?: string;
  tags?: string[];
}

export interface SynthesizeStoryInput {
  casting: VoiceCasting;
  label?: string;
  makeDefault?: boolean;
}

const DEFAULT_BEDTIME_SAMPLE =
  'The sleepy little moon smiled down on the quiet valley, whispering a gentle goodnight to all the dreaming trees.';

export const DEFAULT_PREBUILT_VOICES: VoiceEntry[] = [
  {
    id: 'prebuilt-kore',
    label: 'Kore (Warm Prebuilt)',
    source: 'prebuilt',
    gemini_voice_name: 'Kore',
    description: 'Warm, calm, soothing female bedtime voice',
    language_code: 'en-US',
    tags: ['warm', 'bedtime', 'female'],
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
   * clamped to <= 220 characters. Returns canonical 44-byte RIFF WAV Buffer.
   */
  async previewVoice(input: PreviewVoiceInput): Promise<Buffer> {
    const rawSample = input.sampleText && input.sampleText.trim()
      ? input.sampleText.trim()
      : DEFAULT_BEDTIME_SAMPLE;
    const clampedSample = rawSample.slice(0, 220);

    let speechConfig: SpeechConfigPayload;
    let parts: TtsTurnPart[];

    if (input.voiceId && input.voiceId.trim()) {
      const voices = await this.listVoices();
      const voice = voices.find((v) => v.id === input.voiceId!.trim());
      if (!voice) {
        throw new ValidationError(`Voice not found: "${input.voiceId}"`);
      }
      const style = (input.description || voice.description || 'Warm, calm bedtime storytelling cadence').slice(0, 200);
      speechConfig = {
        voiceConfig: toGeminiVoiceConfig(voice),
      };
      parts = [
        {
          text: clampedSample,
          speechMetadata: {
            speaker: 'Narrator',
            style,
          },
        },
      ];
    } else if (input.description && input.description.trim()) {
      // Preview candidate natural-language prompt using prebuilt Kore as base voice
      const style = input.description.trim().slice(0, 200);
      speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      };
      parts = [
        {
          text: clampedSample,
          speechMetadata: {
            speaker: 'Narrator',
            style,
          },
        },
      ];
    } else {
      throw new ValidationError('Either voiceId or description is required for voice preview');
    }

    const rawBuffer = await this.ttsProvider.synthesizeBatch({
      model: this.config.geminiTtsLiteModel,
      parts,
      speechConfig,
    });

    const pcm = extractPcmFromWavOrRaw(rawBuffer);
    const { wav } = wrapPcmAsWav(pcm);
    return wav;
  }

  /**
   * Creates a custom prompted voice via the Google Voices API, generates a unique slug ID,
   * and atomically appends it to voices.json.
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

    const created = await this.ttsProvider.createPromptedVoice({
      label,
      description,
      languageCode: input.languageCode,
    });

    const existingVoices = await this.listVoices();
    const existingIds = new Set(existingVoices.map((v) => v.id));

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

    const newVoice: VoiceEntry = {
      id: voiceId,
      label,
      source: 'designed',
      gemini_voice_name: created.geminiVoiceName,
      description,
      language_code: input.languageCode?.trim() || 'en-US',
      tags: Array.isArray(input.tags)
        ? input.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      created_at: new Date().toISOString(),
    };

    await this.storage.updateJsonAtomic<VoiceEntry[]>(
      'voices.json',
      (current) => {
        const list = current && current.length > 0 ? [...current] : [...DEFAULT_PREBUILT_VOICES];
        list.push(newVoice);
        return list;
      },
      []
    );

    return newVoice;
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
      // Solo mode: contiguous batches of <= 12 turns and <= 3,000 characters
      let currentTurns: typeof story.script_turns = [];
      let currentChars = 0;

      for (const turn of story.script_turns) {
        const turnLen = turn.text.length;
        if (
          currentTurns.length > 0 &&
          (currentTurns.length >= 12 || currentChars + turnLen > 3000)
        ) {
          // Commit current batch
          const parts: TtsTurnPart[] = currentTurns.map((t) => {
            const charTrait = characterMap.get(t.speaker);
            const effectiveStyle =
              t.speaker === 'Narrator'
                ? t.style || 'Warm, calm bedtime storytelling cadence'
                : `Speaking dialogue as ${t.speaker}${charTrait ? ` (${charTrait})` : ''}: ${t.style || 'expressive, gentle'}`;
            return {
              text: t.text,
              speechMetadata: {
                speaker: 'Narrator',
                style: effectiveStyle,
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
          const effectiveStyle =
            t.speaker === 'Narrator'
              ? t.style || 'Warm, calm bedtime storytelling cadence'
              : `Speaking dialogue as ${t.speaker}${charTrait ? ` (${charTrait})` : ''}: ${t.style || 'expressive, gentle'}`;
          return {
            text: t.text,
            speechMetadata: {
              speaker: 'Narrator',
              style: effectiveStyle,
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
      // Cast mode: contiguous turns sharing <= 2 distinct speakers, <= 12 turns, <= 3,000 chars
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
            currentTurns.length >= 12 ||
            currentChars + turnLen > 3000)
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

          const parts: TtsTurnPart[] = currentTurns.map((t) => ({
            text: t.text,
            speechMetadata: {
              speaker: t.speaker,
              style: t.style || 'Warm, calm bedtime storytelling cadence',
            },
          }));

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

        const parts: TtsTurnPart[] = currentTurns.map((t) => ({
          text: t.text,
          speechMetadata: {
            speaker: t.speaker,
            style: t.style || 'Warm, calm bedtime storytelling cadence',
          },
        }));

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
