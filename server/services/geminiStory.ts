import { GoogleGenAI, Type } from '@google/genai';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { validateSlug, SLUG_REGEX } from '../storage/storageAdapter.js';
import {
  validateWriterOutput,
  validateDirectorOutput,
  ValidationError,
  type WriterOutputInput,
  type DirectorOutputInput,
} from '../lib/validators.js';
import type {
  CatalogItem,
  CharacterProfile,
  ScriptTurn,
  SeriesContext,
  Story,
} from '../../shared/types.js';

export interface GenerateWriterDraftInput {
  mode: 'fresh' | 'sequel';
  prompt: string;
  referenceText?: string;
  seriesContext?: {
    seriesId: string;
    episodeNumber: number;
    priorTitle?: string;
    priorSummary?: string;
    characterBible?: CharacterProfile[];
  };
}

export interface DirectScriptInput {
  title: string;
  summary: string;
  characters: CharacterProfile[];
  script_turns: ScriptTurn[];
}

export interface TranscribeAudioRequest {
  audioBase64: string;
  mimeType: string;
  contextHint?: string;
}

export interface StoryLLMProvider {
  generateWriterDraft(input: GenerateWriterDraftInput): Promise<WriterOutputInput>;
  directScript(input: DirectScriptInput): Promise<DirectorOutputInput>;
  transcribeAudio?(req: TranscribeAudioRequest): Promise<string>;
}

/**
 * Builds a deterministic, collision-safe slug matching /^[a-z0-9][a-z0-9-_]{1,80}$/
 * using YYYY-MM-DD-<kebab-title>. Appends -2, -3 if collision with existing IDs.
 */
export function generateStorySlug(
  title: string,
  existingIds: Set<string>,
  dateStr = new Date().toISOString().slice(0, 10)
): string {
  const kebab = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'story';

  const base = `${dateStr}-${kebab}`.slice(0, 68);
  let candidate = base;
  let counter = 2;

  while (existingIds.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }

  if (!SLUG_REGEX.test(candidate)) {
    // Fallback if somehow invalid characters remained
    candidate = `story-${Date.now()}`;
  }

  return candidate;
}

/**
 * Helper to transform a full Story into a CatalogItem so catalog.json and story.json never drift.
 */
export function storyToCatalogItem(story: Story): CatalogItem {
  const defaultAudio =
    story.audio_versions.find((v) => v.is_default)?.audio_url ||
    story.audio_versions[0]?.audio_url ||
    null;

  return {
    id: story.id,
    status: story.status,
    title: story.title,
    summary: story.summary,
    tags: [...story.tags],
    series_id: story.series_context?.series_id ?? null,
    episode_number: story.series_context?.episode_number ?? null,
    created_at: story.created_at,
    updated_at: story.updated_at,
    default_audio_url: defaultAudio,
    audio_versions_count: story.audio_versions.length,
    active_job: story.active_job ?? null,
  };
}

/**
 * Safely parses LLM JSON responses, stripping optional markdown fences and throwing ValidationError.
 */
export function parseLLMJson<T>(rawText: string | undefined, stage: string): T {
  if (!rawText || !rawText.trim()) {
    throw new ValidationError(`Model returned empty output for ${stage}`);
  }
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to parse model JSON output for ${stage}: ${msg}`);
  }
}

/**
 * Production StoryLLMProvider backed by @google/genai and gemini-3.8-flash.
 */
export class GoogleGenAIStoryLLMProvider implements StoryLLMProvider {
  private ai: GoogleGenAI | null = null;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'gemini-3.8-flash') {
    this.apiKey = apiKey;
    this.model = model;
  }

  private getClient(): GoogleGenAI {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is required to use GoogleGenAIStoryLLMProvider');
    }
    if (!this.ai) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.ai;
  }

  async generateWriterDraft(input: GenerateWriterDraftInput): Promise<WriterOutputInput> {
    const ai = this.getClient();
    let systemInstruction =
      'You are a master storytelling author for Storyteller Studio. Write engaging, vivid, immersive narratives ' +
      'matching whatever genre, tone, mood, and pace the user requests (e.g. comedic, adventurous, sci-fi, dramatic, mystery, whimsical, or bedtime). ' +
      'Maintain natural, punchy dialogue where each character speaks with a distinct personality. ' +
      'Structure the narrative into title, a 1-2 sentence summary, 2 to 5 relevant genre/mood tags, character profiles (never named "Narrator"), and at least 2 script turns. ' +
      'Script turns alternate between "Narrator" and character speakers. Do not emit vocal sound-effect tags like <sigh> or <pause> at this stage; write pure narrative prose and dialogue.';

    let promptText = `Story Prompt: ${input.prompt}`;

    if (input.mode === 'sequel' && input.seriesContext) {
      const { seriesId, episodeNumber, priorTitle, priorSummary, characterBible } =
        input.seriesContext;
      systemInstruction +=
        `\nYou are writing Episode ${episodeNumber} in the ongoing series "${seriesId}". ` +
        `Prior Episode Title: "${priorTitle || 'Untitled'}". ` +
        `Prior Episode Summary: "${priorSummary || ''}". ` +
        'Advance the story organically, maintaining narrative energy, established character personalities, and vocal quirks from previous episodes without forcing a peaceful bedtime conclusion unless that series is explicitly bedtime.';

      if (characterBible && characterBible.length > 0) {
        promptText += `\nExisting Character Bible:\n${JSON.stringify(characterBible, null, 2)}`;
      }
    }

    if (input.referenceText && input.referenceText.trim()) {
      promptText += `\n\nReference Material:\n${input.referenceText.trim()}`;
    }

    const response = await ai.models.generateContent({
      model: this.model,
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['title', 'summary', 'tags', 'characters', 'script_turns'],
          properties: {
            title: { type: Type.STRING },
            summary: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            characters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['name', 'traits'],
                properties: {
                  name: { type: Type.STRING },
                  traits: { type: Type.STRING },
                },
              },
            },
            script_turns: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['turn_id', 'speaker', 'text'],
                properties: {
                  turn_id: { type: Type.INTEGER },
                  speaker: { type: Type.STRING },
                  text: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    });

    return parseLLMJson<WriterOutputInput>(response.text, 'Writer draft');
  }

  async directScript(input: DirectScriptInput): Promise<DirectorOutputInput> {
    const systemInstruction =
      'You are an expert audio drama voice director for Storyteller Studio. Your job is to direct pacing, emotion, and vocal expressions matching the specific scene context and emotional beat of the story for young listeners ages 3–8: ' +
      '1. KEEP SPOKEN WORDS VERBATIM. Do not alter story prose or drop dialogue. ' +
      '2. Insert natural inline vocal tags strictly from the approved list: <sigh>, <laugh>, <chuckle>, <gasp>, <yawn>, <breath>, <short pause>, <long pause>. ' +
      '3. For each turn, provide a sustained acting note in "style" (max 200 chars), reflecting character emotions in that moment, vocal acting (e.g. whispered, excited, cautious, booming), comedic drama, playful pitch, or dramatic mood. ' +
      'CRITICAL PACING & ANTI-RUSH RULE FOR CHILDREN: Separate high theatrical energy from speaking speed. Encourage vivid character mimicry, playful pitch, comedic drama, and dramatic pauses (<short pause> / <breath>), while NEVER emitting fast speaking-rate directives (such as "at high speed", "cartoonish speed", "fast-paced", "full speed", "rapid-fire", or "speaking rapidly") so every word stays clear, intelligible, and unhurried for children ages 3–8. ' +
      '4. Propose 1 to 3 distinct voice design candidates (label, description, suggested_for) suitable for audio synthesis matching the genre and character personalities.';

    const promptText = `Story Title: ${input.title}\nSummary: ${input.summary}\nCharacters:\n${JSON.stringify(
      input.characters,
      null,
      2
    )}\n\nScript Turns to Direct:\n${JSON.stringify(input.script_turns, null, 2)}`;

    const ai = this.getClient();
    const response = await ai.models.generateContent({
      model: this.model,
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['script_turns', 'voice_candidates'],
          properties: {
            script_turns: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['turn_id', 'speaker', 'style', 'text'],
                properties: {
                  turn_id: { type: Type.INTEGER },
                  speaker: { type: Type.STRING },
                  style: { type: Type.STRING },
                  text: { type: Type.STRING },
                },
              },
            },
            voice_candidates: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['label', 'description', 'suggested_for'],
                properties: {
                  label: { type: Type.STRING },
                  description: { type: Type.STRING },
                  suggested_for: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    });

    return parseLLMJson<DirectorOutputInput>(response.text, 'Director script');
  }

  async transcribeAudio(req: TranscribeAudioRequest): Promise<string> {
    const ai = this.getClient();
    let prompt =
      'Transcribe the spoken audio accurately with natural punctuation. Output ONLY the transcribed text without commentary or quotes.';
    if (req.contextHint) {
      prompt += ` Context hint: this audio is spoken for a children's storytelling application (${req.contextHint}).`;
    }

    const response = await ai.models.generateContent({
      model: this.model,
      contents: [
        {
          inlineData: {
            data: req.audioBase64,
            mimeType: req.mimeType,
          },
        },
        prompt,
      ],
    });

    return (response.text || '').trim();
  }
}

export interface GenerateStoryDraftRequest {
  mode: 'fresh' | 'sequel';
  prompt: string;
  referenceText?: string;
  seriesId?: string;
  previousStoryId?: string;
}

export class GeminiStoryService {
  public readonly config: AppConfig;
  private storage: StorageAdapter;
  private llmProvider: StoryLLMProvider;

  constructor(
    config: AppConfig,
    storage: StorageAdapter,
    llmProvider?: StoryLLMProvider
  ) {
    this.config = config;
    this.storage = storage;
    this.llmProvider =
      llmProvider ||
      new GoogleGenAIStoryLLMProvider(config.geminiApiKey, config.geminiTextModel);
  }

  async generateStoryDraft(input: GenerateStoryDraftRequest): Promise<Story> {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Request body must be an object');
    }

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) {
      throw new ValidationError('Story prompt is required');
    }

    if (input.mode !== 'fresh' && input.mode !== 'sequel') {
      throw new ValidationError('Mode must be either "fresh" or "sequel"');
    }

    let seriesContext: SeriesContext | null = null;
    let rawWriter: WriterOutputInput;

    if (input.mode === 'fresh') {
      if (input.seriesId && typeof input.seriesId === 'string' && input.seriesId.trim()) {
        const sanitizedSeriesId = input.seriesId
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, '-')
          .replace(/-{2,}/g, '-')
          .replace(/^[-_]+|[-_]+$/g, '');
        validateSlug(sanitizedSeriesId, 'seriesId');
        seriesContext = {
          series_id: sanitizedSeriesId,
          episode_number: 1,
        };
      }

      rawWriter = await this.llmProvider.generateWriterDraft({
        mode: 'fresh',
        prompt,
        referenceText: input.referenceText,
        seriesContext: seriesContext
          ? {
              seriesId: seriesContext.series_id,
              episodeNumber: 1,
            }
          : undefined,
      });
    } else {
      // mode === 'sequel'
      const prevId =
        typeof input.previousStoryId === 'string' ? input.previousStoryId.trim() : '';
      if (!prevId) {
        throw new ValidationError('previousStoryId is required for sequel mode');
      }
      validateSlug(prevId, 'previousStoryId');

      const previousStory = await this.storage.getStory(prevId);

      const seriesId = previousStory.series_context?.series_id || previousStory.id;
      const episodeNumber = (previousStory.series_context?.episode_number ?? 1) + 1;

      // Carry preferred voice ID from previous story series context or default solo audio
      let preferredVoiceId = previousStory.series_context?.preferred_voice_id;
      if (!preferredVoiceId && previousStory.audio_versions.length > 0) {
        const soloVer = previousStory.audio_versions.find((v) => v.casting.mode === 'solo');
        if (soloVer) {
          preferredVoiceId = soloVer.casting.narrator_voice_id;
        } else {
          preferredVoiceId = previousStory.audio_versions[0].casting.narrator_voice_id;
        }
      }

      seriesContext = {
        series_id: seriesId,
        episode_number: episodeNumber,
        previous_story_id: previousStory.id,
        preferred_voice_id: preferredVoiceId,
      };

      rawWriter = await this.llmProvider.generateWriterDraft({
        mode: 'sequel',
        prompt,
        referenceText: input.referenceText,
        seriesContext: {
          seriesId,
          episodeNumber,
          priorTitle: previousStory.title,
          priorSummary: previousStory.summary,
          characterBible: previousStory.characters,
        },
      });
    }

    const validated = validateWriterOutput(rawWriter);

    // Compute unique slug
    const catalog = await this.storage.getCatalog();
    const existingIds = new Set(catalog.map((item) => item.id));
    const storyId = generateStorySlug(validated.title, existingIds);

    const now = new Date().toISOString();
    const story: Story = {
      id: storyId,
      status: 'draft',
      title: validated.title,
      summary: validated.summary,
      tags: validated.tags,
      series_context: seriesContext,
      characters: validated.characters,
      script_turns: validated.script_turns,
      voice_candidates: [],
      audio_versions: [],
      created_at: now,
      updated_at: now,
    };

    // Save story.json
    await this.storage.saveStory(story);

    // Atomically upsert catalog.json
    const catalogItem = storyToCatalogItem(story);
    await this.storage.updateJsonAtomic<CatalogItem[]>(
      'catalog.json',
      (current) => {
        const list = current ? [...current] : [];
        const existingIdx = list.findIndex((c) => c.id === story.id);
        if (existingIdx >= 0) {
          list[existingIdx] = catalogItem;
        } else {
          list.unshift(catalogItem);
        }
        return list;
      },
      []
    );

    return story;
  }

  async directStoryScript(storyId: string): Promise<Story> {
    validateSlug(storyId, 'storyId');
    const story = await this.storage.getStory(storyId);

    const rawDirector = await this.llmProvider.directScript({
      title: story.title,
      summary: story.summary,
      characters: story.characters,
      script_turns: story.script_turns,
    });

    const validatedDirector = validateDirectorOutput(rawDirector, story.script_turns);

    story.script_turns = validatedDirector.script_turns;
    story.voice_candidates = validatedDirector.voice_candidates;
    story.updated_at = new Date().toISOString();

    // Save story.json
    await this.storage.saveStory(story);

    // Update catalog.json updated_at atomically
    await this.storage.updateJsonAtomic<CatalogItem[]>(
      'catalog.json',
      (current) => {
        const list = current ? [...current] : [];
        const existingIdx = list.findIndex((c) => c.id === story.id);
        if (existingIdx >= 0) {
          list[existingIdx] = storyToCatalogItem(story);
        }
        return list;
      },
      []
    );

    return story;
  }

  async transcribeAudio(req: TranscribeAudioRequest): Promise<string> {
    if (!this.llmProvider.transcribeAudio) {
      throw new Error('Audio transcription is not supported by the configured StoryLLMProvider');
    }
    return this.llmProvider.transcribeAudio(req);
  }
}
