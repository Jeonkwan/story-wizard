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

export interface StoryLengthTarget {
  minTurns: number;
  maxTurns: number;
  minWords: number;
  targetMinWords: number;
  targetMaxWords: number;
  turnTextGuidance: string;
}

/**
 * Empirically calibrated turn and word-count targets per StoryLength tier
 * (~115–136 WPM observed Gemini 3.8 TTS narration rate).
 */
export const STORY_LENGTH_TARGETS: Record<StoryLength, StoryLengthTarget> = {
  short: {
    minTurns: 6,
    maxTurns: 8,
    minWords: 150,
    targetMinWords: 190,
    targetMaxWords: 260,
    turnTextGuidance:
      '35–50 words for Narrator turns (2–3 sentences) and 25–35 words for character turns',
  },
  medium: {
    minTurns: 12,
    maxTurns: 14,
    minWords: 360,
    targetMinWords: 430,
    targetMaxWords: 560,
    turnTextGuidance:
      '50–70 words for Narrator turns (3–4 sentences) and 30–45 words for character turns',
  },
  long: {
    minTurns: 22,
    maxTurns: 26,
    minWords: 720,
    targetMinWords: 800,
    targetMaxWords: 980,
    turnTextGuidance:
      '55–75 words for Narrator turns (3–5 vivid sentences) and 35–50 words for character turns (2–4 sentences)',
  },
  epic: {
    minTurns: 30,
    maxTurns: 36,
    minWords: 1000,
    targetMinWords: 1150,
    targetMaxWords: 1400,
    turnTextGuidance:
      '60–80 words for Narrator turns (4–5 vivid sentences) and 35–55 words for character turns (3–4 sentences)',
  },
};

/**
 * Counts spoken words across all script turns in a raw WriterOutputInput.
 */
export function countWriterDraftWords(draft: WriterOutputInput): number {
  if (!Array.isArray(draft.script_turns)) return 0;
  let total = 0;
  for (const turn of draft.script_turns) {
    if (typeof turn?.text === 'string') {
      const cleaned = turn.text.replace(/<[^>]+>/g, ' ').trim();
      if (cleaned) {
        total += cleaned.split(/\s+/).length;
      }
    }
  }
  return total;
}

/**
 * Builds explicit turn-count, per-turn word budgets, and multi-scene pacing targets
 * for the Writer LLM so generated audio durations reliably match UI minute ranges
 * (~115–136 WPM observed Gemini 3.8 TTS narration rate).
 *
 * @param storyLength Desired length tier: 'short', 'medium', 'long', or 'epic'
 * @returns Instruction string with target script turns, per-turn budgets, and word count
 */
export function buildStoryLengthInstruction(storyLength?: StoryLength): string {
  const length = storyLength || DEFAULT_STORY_LENGTH;
  switch (length) {
    case 'short':
      return (
        'Target Length: Short (~1–2 minutes of spoken audio).\n' +
        '- Structure the story into 6 to 8 script turns totaling 190 to 260 words.\n' +
        '- Pacing & Turn Budget: Write 3 Narrator turns (35–50 words each, 2–3 sentences) and 3–5 character dialogue turns (25–35 words each). Keep scenes brisk, vivid, and complete.'
      );
    case 'medium':
      return (
        'Target Length: Medium (~3–4 minutes of spoken audio).\n' +
        '- Structure the story into 12 to 14 script turns totaling 430 to 560 words (MINIMUM 410 words).\n' +
        '- Pacing & Turn Budget: Write 5–6 descriptive Narrator turns (50–70 words each, 3–4 sentences) and 7–8 conversational character turns (30–45 words each, 2–3 sentences). Avoid terse 1-line or sound-only turns; weave playful sounds into full dialogue. Do not rush the ending.'
      );
    case 'long':
      return (
        'Target Length: Long (~5–7 minutes of spoken audio).\n' +
        '- Structure the story into 22 to 26 script turns totaling 800 to 980 words (STRICT MINIMUM 760 words — do NOT stop early, summarize, or rush the ending).\n' +
        '- Pacing & Turn Budget: Write 10–12 rich Narrator turns (55–75 words each, 3–5 vivid descriptive sentences per turn) and 12–14 expressive character dialogue turns (35–50 words each, 2–4 sentences per turn). Never write short 1-sentence filler turns or standalone sound-effect lines; always weave funny sounds into full playful dialogue.\n' +
        '- Story Structure: Develop 4 distinct, unhurried scenes (1. lively setup & surprising discovery, 2. playful exploration & comedic chaos, 3. hands-on craft/learning beat, 4. joyful climax & warm resolution).'
      );
    case 'epic':
      return (
        'Target Length: Epic (~8–10 minutes of spoken audio).\n' +
        '- Structure the story into 30 to 36 script turns totaling 1,150 to 1,400 words (STRICT MINIMUM 1,080 words — do NOT summarize or wrap up early).\n' +
        '- Pacing & Turn Budget: Write 13–15 rich Narrator turns (60–80 words each, 4–5 vivid sentences per turn) and 17–21 expressive character dialogue turns (35–55 words each, 3–4 sentences of rich back-and-forth conversation). Never write terse 1-line turns or sound-only turns.\n' +
        '- Story Structure: Build a full 5-act journey (1. vivid opening world, 2. big discovery, 3. escalating funny complication, 4. collaborative craft/problem-solving, 5. memorable finale & cozy closing).'
      );
    default:
      return (
        'Target Length: Medium (~3–4 minutes of spoken audio).\n' +
        '- Structure the story into 12 to 14 script turns totaling 430 to 560 words (MINIMUM 410 words).\n' +
        '- Pacing & Turn Budget: Write 5–6 descriptive Narrator turns (50–70 words each, 3–4 sentences) and 7–8 conversational character turns (30–45 words each, 2–3 sentences). Do not rush the ending.'
      );
  }
}

/**
 * Concise recency reminder appended to the user prompt so low-thinking LLM passes
 * reliably respect turn counts and per-turn depth.
 *
 * @param storyLength Desired length tier: 'short', 'medium', 'long', or 'epic'
 * @returns Short length enforcement reminder string
 */
export function buildStoryLengthReminder(storyLength?: StoryLength): string {
  const length = storyLength || DEFAULT_STORY_LENGTH;
  switch (length) {
    case 'short':
      return 'Length Requirement: 6–8 turns (~190–260 words total).';
    case 'medium':
      return 'Length Requirement: 12–14 turns (~430–560 words total, minimum 410 words).';
    case 'long':
      return 'Length Requirement: 22–26 turns (~800–980 words total, strict minimum 760 words; write 3–5 rich sentences per Narrator turn and 2–4 sentences per Character turn).';
    case 'epic':
      return 'Length Requirement: 30–36 turns (~1,150–1,400 words total, strict minimum 1,080 words; write 4–5 rich sentences per Narrator turn and 3–4 sentences per Character turn across 5 full scenes).';
    default:
      return 'Length Requirement: 12–14 turns (~430–560 words total, minimum 410 words).';
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
      'Give each character a distinct, expressive conversational voice, and strictly follow the Target Length word-count, turn-budget, and multi-scene pacing rules below (do not write terse one-line turns when Medium, Long, or Epic length is requested). ' +
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

    promptText += `\n\n${buildStoryLengthReminder(input.storyLength)}`;

    const lengthKey: StoryLength = input.storyLength || DEFAULT_STORY_LENGTH;
    const target = STORY_LENGTH_TARGETS[lengthKey] || STORY_LENGTH_TARGETS[DEFAULT_STORY_LENGTH];

    const writerResponseSchema = {
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
          minItems: String(target.minTurns),
          description: `Ordered array of ${target.minTurns} to ${target.maxTurns} alternating Narrator and character turns totaling ${target.targetMinWords}–${target.targetMaxWords} words.`,
          items: {
            type: Type.OBJECT,
            required: ['turn_id', 'speaker', 'text'],
            properties: {
              turn_id: { type: Type.INTEGER },
              speaker: { type: Type.STRING },
              text: {
                type: Type.STRING,
                description: `Pure spoken prose or dialogue (${target.turnTextGuidance}). Avoid brief 1-sentence filler turns.`,
              },
            },
          },
        },
      },
    };

    const response = await ai.models.generateContent({
      model: this.model,
      contents: promptText,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: this.thinkingLevel },
        responseMimeType: 'application/json',
        responseSchema: writerResponseSchema,
      },
    });

    const parsed = parseLLMJson<WriterOutputInput>(response.text, 'Writer draft');
    const draftWords = countWriterDraftWords(parsed);

    // Conditional 1-shot expansion only when a real draft (>= 50 words) undershoots
    // the length tier's minimum word floor (protects against occasional LOW-thinking early wrap-ups).
    if (draftWords >= 50 && draftWords < target.minWords) {
      const currentTurns = Array.isArray(parsed.script_turns) ? parsed.script_turns.length : 0;
      const missingWords = Math.max(150, target.targetMinWords - draftWords);
      const extraTurns = Math.max(4, target.minTurns - currentTurns);
      const expandPrompt =
        `EXPANSION REQUIRED: The draft below only has ${draftWords} words across ${currentTurns} turns, which is ~${missingWords} words too short for "${lengthKey}".\n` +
        `Do NOT merely copy or lightly paraphrase the draft. You MUST add at least ${missingWords} more words by:\n` +
        `1. Inserting at least ${extraTurns} brand-new middle-scene turns with playful banter, sensory world details, and craft/learning beats.\n` +
        `2. Expanding existing short turns so Narrator turns are 60–80 words (4–5 vivid sentences) and character turns are 35–55 words (2–4 expressive sentences).\n` +
        `Final requirement: ${target.minTurns} to ${target.maxTurns} script turns totaling ${target.targetMinWords} to ${target.targetMaxWords} words (STRICT MINIMUM ${target.minWords} words). Do NOT emit vocal tags like <sigh>.\n\n` +
        `Original User Request: ${input.prompt}\n\n` +
        `Draft to Expand:\n${JSON.stringify(parsed)}`;

      const expansionThinking =
        this.thinkingLevel === ThinkingLevel.HIGH ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM;

      try {
        const expandedResp = await ai.models.generateContent({
          model: this.model,
          contents: expandPrompt,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: expansionThinking },
            responseMimeType: 'application/json',
            responseSchema: writerResponseSchema,
          },
        });
        const expanded = parseLLMJson<WriterOutputInput>(expandedResp.text, 'Writer draft expansion');
        if (countWriterDraftWords(expanded) > draftWords) {
          return expanded;
        }
      } catch (expandErr) {
        console.warn('[Writer] Conditional expansion pass failed; returning initial draft:', expandErr);
      }
    }

    return parsed;
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
