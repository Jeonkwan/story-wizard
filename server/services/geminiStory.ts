import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
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
  StoryAgeRange,
  StoryLength,
  StoryVocabularyLevel,
} from '../../shared/types.js';
import {
  DEFAULT_AGE_RANGE,
  DEFAULT_STORY_LENGTH,
  DEFAULT_VOCABULARY_LEVEL,
  VALID_AGE_RANGES,
  VALID_STORY_LENGTHS,
  VALID_VOCABULARY_LEVELS,
} from '../../shared/types.js';

export interface GenerateWriterDraftInput {
  mode: 'fresh' | 'sequel';
  prompt: string;
  referenceText?: string;
  ageRange?: StoryAgeRange;
  storyLength?: StoryLength;
  vocabularyLevel?: StoryVocabularyLevel;
  customVocabularyInstructions?: string;
  genrePreset?: string;
  avoidCharacterNames?: string[];
  seriesContext?: {
    seriesId: string;
    episodeNumber: number;
    priorTitle?: string;
    priorSummary?: string;
    characterBible?: CharacterProfile[];
  };
}

export type WriterInput = GenerateWriterDraftInput;

/**
 * Overused default AI names to ban unless explicitly requested by the user prompt.
 */
export const BANNED_AI_CHARACTER_NAMES: readonly string[] = [
  'Barnaby',
  'Bramble',
  'Pip',
  'Squeak',
  'Oliver',
  'Milo',
  'Toby',
  'Whiskers',
  'Luna',
  'Nutkin',
  'Thimble',
] as const;

/**
 * Builds explicit turn-count and word-count targets for Gemini 3.8 Writer LLM.
 *
 * @param storyLength Desired length tier: 'short', 'medium', 'long', or 'epic'
 * @returns Instruction string with target script turns and word count
 */
export function buildStoryLengthInstruction(storyLength?: StoryLength): string {
  const length = storyLength || DEFAULT_STORY_LENGTH;
  switch (length) {
    case 'short':
      return 'Target Length: Short. Structure the story into 6 to 8 script turns (~200–300 words total). Keep scenes brisk, punchy, and contained.';
    case 'medium':
      return 'Target Length: Medium. Structure the story into 10 to 14 script turns (~450–650 words total). Provide a balanced narrative arc with rich character interaction.';
    case 'long':
      return 'Target Length: Long. Structure the story into 16 to 22 script turns (~800–1,100 words total). Develop scenes thoroughly with multiple narrative beats and playful dialogue.';
    case 'epic':
      return 'Target Length: Epic. Structure the story into 24 to 30 script turns (~1,200–1,600 words total). Create an immersive, multi-scene adventure with deep dialogue and rich world-building.';
    default:
      return 'Target Length: Medium. Structure the story into 10 to 14 script turns (~450–650 words total).';
  }
}

/**
 * Automatically maps an age group to its natural default vocabulary level.
 *
 * @param age Target audience age range
 * @returns Natural corresponding vocabulary level
 */
export function defaultVocabularyForAge(age?: StoryAgeRange): StoryVocabularyLevel {
  switch (age) {
    case 'toddler':
      return 'simple';
    case 'early-reader':
      return 'standard';
    case 'elementary':
      return 'enriched';
    case 'young-reader':
      return 'advanced';
    default:
      return DEFAULT_VOCABULARY_LEVEL;
  }
}

/**
 * Builds unified pedagogical and vocabulary instructions for the Writer LLM.
 * If vocabularyLevel is not explicitly provided, it auto-maps from ageGroup.
 *
 * @param ageGroup Target audience age range
 * @param vocabularyLevel Optional explicit vocabulary level
 * @param customVocabularyInstructions Optional custom vocabulary instructions
 * @returns Consolidated pedagogical instructions
 */
export function buildPedagogicalInstruction(
  ageGroup?: StoryAgeRange,
  vocabularyLevel?: StoryVocabularyLevel,
  customVocabularyInstructions?: string
): string {
  const age = ageGroup || DEFAULT_AGE_RANGE;
  const vocab = vocabularyLevel || defaultVocabularyForAge(age);
  const instructions: string[] = [];

  switch (age) {
    case 'toddler':
      instructions.push(
        'Target Audience: Toddlers (Ages 2–4). Use very short sentences (4–8 words), rhythmic repetition, sound effects, concrete sensory concepts (animals, toys, food, bedtime).'
      );
      break;
    case 'early-reader':
      instructions.push(
        'Target Audience: Early Readers (Ages 5–7). Use phonics-friendly prose, playful narrative momentum, clear cause-and-effect, and engaging character dialogue.'
      );
      break;
    case 'elementary':
      instructions.push(
        'Target Audience: Elementary (Ages 8–10). Use dynamic plot, witty character banter, figurative language, problem-solving, and descriptive world details.'
      );
      break;
    case 'young-reader':
      instructions.push(
        'Target Audience: Young Readers (Ages 11+). Use complex sentence structures, subtle humor, literary expressions, multi-layered themes, and nuanced character motivations.'
      );
      break;
  }

  switch (vocab) {
    case 'simple':
      instructions.push(
        'Vocabulary Level: Simple. High-frequency, easy-to-read vocabulary with soothing repetition.'
      );
      break;
    case 'standard':
      instructions.push(
        'Vocabulary Level: Standard. Natural, expressive, age-appropriate storytelling vocabulary.'
      );
      break;
    case 'enriched':
      instructions.push(
        'Vocabulary Level: Enriched. Introduce 3 to 5 colorful, descriptive vocabulary words whose meanings are clear from context.'
      );
      break;
    case 'advanced':
      instructions.push(
        'Vocabulary Level: Advanced. Sophisticated, literary expressions with clever wordplay and descriptive flair.'
      );
      break;
  }

  if (customVocabularyInstructions && customVocabularyInstructions.trim()) {
    instructions.push(`Custom Vocabulary Focus: ${customVocabularyInstructions.trim()}`);
  }

  return instructions.join('\n');
}

/**
 * Builds anti-cliché and character name diversity instructions.
 * Forbids overused AI storybook names unless explicitly requested, and forbids recently used names.
 *
 * @param prompt User story prompt
 * @param avoidCharacterNames Optional list of character names to avoid reusing
 * @returns Anti-cliché diversity instruction string
 */
export function buildCharacterDiversityInstruction(
  prompt: string,
  avoidCharacterNames?: string[]
): string {
  const promptLower = (prompt || '').toLowerCase();
  const activeBanned = BANNED_AI_CHARACTER_NAMES.filter(
    (name) => !promptLower.includes(name.toLowerCase())
  );

  let instruction =
    'ANTI-CLICHÉ & CHARACTER NAME DIVERSITY RULE: ' +
    `DO NOT use overused default AI storybook character names (${activeBanned.join(', ')}) unless explicitly requested in the prompt. ` +
    'Invent fresh, distinctive, phonetically and culturally varied character names drawn from nature, astronomy, music, mythology, or unique linguistic sounds.';

  if (avoidCharacterNames && avoidCharacterNames.length > 0) {
    const cleanAvoid = Array.from(
      new Set(
        avoidCharacterNames
          .filter((n) => typeof n === 'string' && n.trim())
          .map((n) => n.trim())
      )
    );
    if (cleanAvoid.length > 0) {
      instruction += `\nDO NOT reuse any of these recently used character names: ${cleanAvoid.join(', ')}.`;
    }
  }

  return instruction;
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

const THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
  THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
};

/**
 * Normalizes a string or ThinkingLevel enum into a @google/genai ThinkingLevel,
 * defaulting to ThinkingLevel.LOW for cost and latency control.
 */
export function resolveThinkingLevel(level?: string): ThinkingLevel {
  const normalized = (level || 'LOW').trim().toUpperCase();
  return THINKING_LEVEL_MAP[normalized] ?? ThinkingLevel.LOW;
}

/**
 * Production StoryLLMProvider backed by @google/genai and gemini-4-hydrogen.
 */
export class GoogleGenAIStoryLLMProvider implements StoryLLMProvider {
  private ai: GoogleGenAI | null = null;
  private apiKey: string;
  private model: string;
  private thinkingLevel: ThinkingLevel;

  constructor(
    apiKey: string,
    model = 'gemini-4-hydrogen',
    thinkingLevel: string | ThinkingLevel = ThinkingLevel.LOW
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.thinkingLevel = resolveThinkingLevel(thinkingLevel);
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
    const age = input.ageRange || DEFAULT_AGE_RANGE;
    const vocab = input.vocabularyLevel;

    const pedagogical = buildPedagogicalInstruction(
      age,
      vocab,
      input.customVocabularyInstructions
    );
    const lengthInstruction = buildStoryLengthInstruction(input.storyLength);
    const diversityInstruction = buildCharacterDiversityInstruction(
      input.prompt,
      input.avoidCharacterNames
    );

    let systemInstruction =
      'You are a master storytelling author for Storyteller Studio. Write engaging, vivid, immersive narratives ' +
      'matching whatever genre, tone, mood, and pace the user requests (e.g. comedic, adventurous, sci-fi, dramatic, mystery, whimsical, or bedtime). ' +
      'Maintain natural, punchy dialogue where each character speaks with a distinct personality. ' +
      'Structure the narrative into title, a 1-2 sentence summary, 2 to 5 relevant genre/mood tags, character profiles (never named "Narrator"), and script turns. ' +
      'Script turns alternate between "Narrator" and character speakers. Do not emit vocal sound-effect tags like <sigh> or <pause> at this stage; write pure narrative prose and dialogue.\n' +
      `${lengthInstruction}\n` +
      `${pedagogical}\n` +
      `${diversityInstruction}`;

    if (input.genrePreset && input.genrePreset.trim()) {
      systemInstruction += `\nGenre Preset: ${input.genrePreset.trim()}.`;
    }

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
        thinkingConfig: { thinkingLevel: this.thinkingLevel },
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
        thinkingConfig: { thinkingLevel: this.thinkingLevel },
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
      config: {
        thinkingConfig: { thinkingLevel: this.thinkingLevel },
      },
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
  ageRange?: StoryAgeRange;
  storyLength?: StoryLength;
  vocabularyLevel?: StoryVocabularyLevel;
  customVocabularyInstructions?: string;
  genrePreset?: string;
  avoidCharacterNames?: string[];
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
      new GoogleGenAIStoryLLMProvider(
        config.geminiApiKey,
        config.geminiTextModel,
        config.geminiThinkingLevel
      );
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

    const ageRange: StoryAgeRange = input.ageRange ?? DEFAULT_AGE_RANGE;
    const storyLength: StoryLength = input.storyLength ?? DEFAULT_STORY_LENGTH;
    const vocabularyLevel: StoryVocabularyLevel =
      input.vocabularyLevel ?? defaultVocabularyForAge(ageRange);

    if (input.ageRange && !VALID_AGE_RANGES.includes(input.ageRange)) {
      throw new ValidationError(`Invalid ageRange: "${input.ageRange}"`);
    }
    if (input.storyLength && !VALID_STORY_LENGTHS.includes(input.storyLength)) {
      throw new ValidationError(`Invalid storyLength: "${input.storyLength}"`);
    }
    if (input.vocabularyLevel && !VALID_VOCABULARY_LEVELS.includes(input.vocabularyLevel)) {
      throw new ValidationError(`Invalid vocabularyLevel: "${input.vocabularyLevel}"`);
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
        ageRange,
        storyLength,
        vocabularyLevel: vocabularyLevel,
        customVocabularyInstructions: input.customVocabularyInstructions,
        genrePreset: input.genrePreset,
        avoidCharacterNames: input.avoidCharacterNames,
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
        ageRange,
        storyLength,
        vocabularyLevel: vocabularyLevel,
        customVocabularyInstructions: input.customVocabularyInstructions,
        genrePreset: input.genrePreset,
        avoidCharacterNames: input.avoidCharacterNames,
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
      prompt_metadata: {
        original_prompt: prompt,
        reference_text: input.referenceText,
        age_range: ageRange,
        vocabulary_level: vocabularyLevel,
        genre_preset: input.genrePreset,
        story_length: input.storyLength || DEFAULT_STORY_LENGTH,
        created_at: now,
      },
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
