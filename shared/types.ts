export type StoryStatus = 'draft' | 'published';

export type StoryAgeRange = 'toddler' | 'early-reader' | 'elementary' | 'young-reader';
export type StoryVocabularyLevel = 'simple' | 'standard' | 'enriched' | 'advanced';
export type StoryLength = 'short' | 'medium' | 'long' | 'epic';

export const VALID_AGE_RANGES: readonly StoryAgeRange[] = [
  'toddler',
  'early-reader',
  'elementary',
  'young-reader',
] as const;

export const VALID_VOCABULARY_LEVELS: readonly StoryVocabularyLevel[] = [
  'simple',
  'standard',
  'enriched',
  'advanced',
] as const;

export const VALID_STORY_LENGTHS: readonly StoryLength[] = [
  'short',
  'medium',
  'long',
  'epic',
] as const;

export const DEFAULT_AGE_RANGE: StoryAgeRange = 'early-reader';
export const DEFAULT_VOCABULARY_LEVEL: StoryVocabularyLevel = 'standard';
export const DEFAULT_STORY_LENGTH: StoryLength = 'medium';

export interface StoryPromptMetadata {
  original_prompt: string;
  reference_text?: string;
  age_range?: StoryAgeRange;
  vocabulary_level?: StoryVocabularyLevel;
  genre_preset?: string;
  story_length?: StoryLength;
  created_at: string;
}

export type VoicePace = 'slow' | 'calm' | 'natural' | 'lively';

export interface VoiceSamplePreset {
  id: string;
  label: string;
  styleHint: string;
  text: string;
}

export type JobType = 'draft' | 'direct' | 'synthesize';
export type JobStatus = 'running' | 'completed' | 'failed';

export interface JobProgress {
  job_id: string;
  story_id: string;
  type: JobType;
  status: JobStatus;
  started_at: string;
  elapsed_seconds: number;
  message?: string;
  result_story_id?: string;
  error?: string | null;
  title?: string;
  stage?: string;
  finished_at?: string;
}

export interface ActiveJobSummary {
  job_id: string;
  type: JobType;
  started_at: string;
}

export interface CatalogItem {
  id: string;                      // e.g. "2026-11-04-sleepy-little-train"
  status: StoryStatus;             // Public GET /api/catalog returns ONLY "published"
  title: string;
  summary: string;
  tags: string[];
  series_id: string | null;
  episode_number: number | null;
  created_at: string;              // ISO 8601
  updated_at: string;              // ISO 8601
  default_audio_url: string | null;// "/api/stories/{id}/audios/{version_id}.wav" or null if draft
  audio_versions_count: number;
  active_job?: ActiveJobSummary | null;
}

export interface CharacterProfile {
  name: string;                    // e.g. "Bibi" (never "Narrator" — Narrator is implicit)
  traits: string;                  // Personality + vocal timbre hint, e.g. "Gentle bell chime, curious"
}

export interface ScriptTurn {
  turn_id: number;                 // 1-indexed contiguous integer (1, 2, 3...)
  speaker: string;                 // "Narrator" or exact match to a CharacterProfile.name
  style: string;                   // Sustained acting note for speechMetadata.style (empty string "" right after Writer, populated by Director)
  text: string;                    // Verbatim spoken text; after Director may include approved <...> vocal tags
}

export interface VoiceDesignCandidate {
  label: string;                   // e.g. "Cozy Grandpa Owl"
  description: string;             // Natural-language prompt for ai.voices.create
  suggested_for: string;           // "Narrator (Solo)" or character name
}

export interface VoiceCasting {
  mode: 'solo' | 'cast';
  narrator_voice_id: string;       // References VoiceEntry.id in voices.json
  character_voices: Record<string, string>; // Used in 'cast' mode: { [characterName]: voiceEntryId }
  pace?: VoicePace;
}

export interface AudioVersion {
  version_id: string;              // Immutable slug, e.g. "v1-owl-solo-1762350000"
  label: string;                   // e.g. "Grandpa Owl (Bedtime Solo)"
  casting: VoiceCasting;
  is_default: boolean;
  duration_sec: number;
  audio_url: string;               // Default streaming URL: "/api/stories/{story_id}/audios/{version_id}.m4a" (or legacy .wav)
  wav_url?: string;                // Lossless download URL: "/api/stories/{story_id}/audios/{version_id}.wav"
  m4a_size_bytes?: number;         // Exact byte length of .m4a file for RSS <enclosure length="...">
  created_at: string;
}

/**
 * Resolves the lossless .wav download URL for an AudioVersion, preserving
 * explicit `wav_url` if set or deriving it from an `.m4a` `audio_url`.
 */
export function getLosslessWavUrl(version: { audio_url: string; wav_url?: string }): string {
  return version.wav_url || version.audio_url.replace(/\.m4a$/i, '.wav');
}

export interface PodcastEpisodeEntry {
  story_id: string;                // References Story.id (unique per podcast — no duplicates)
  version_id: string;              // References AudioVersion.version_id on that story
  published_at: string;            // ISO 8601 timestamp when released to this podcast
}

export interface PodcastConfig {
  id: string;                      // Slug matching SLUG_REGEX, e.g. "leo-bedtime"
  title: string;                   // e.g. "Leo's Bedtime Stories"
  author: string;                  // Default "Storyteller Studio"
  description: string;             // Short summary for <description> and <itunes:summary>
  language: string;                // Default "en-us"
  token: string;                   // Secret token required on GET /api/podcasts/:id/feed.xml?token=...
  cover_image_url?: string | null; // Optional "/api/podcasts/{id}/cover.jpg" if present in bucket
  episodes: PodcastEpisodeEntry[]; // Ordered list of opted-in story episodes (deduplicated by story_id)
  created_at: string;              // ISO 8601
  updated_at: string;              // ISO 8601
}

export interface SeriesContext {
  series_id: string;
  episode_number: number;
  previous_story_id?: string;
  preferred_voice_id?: string;
}

export interface Story {
  id: string;
  status: StoryStatus;
  title: string;
  summary: string;
  tags: string[];
  series_context: SeriesContext | null;
  characters: CharacterProfile[];
  script_turns: ScriptTurn[];
  voice_candidates: VoiceDesignCandidate[]; // Populated by Director LLM
  audio_versions: AudioVersion[];
  prompt_metadata?: StoryPromptMetadata;
  active_job?: ActiveJobSummary | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceEntry {
  id: string;                      // Slug ID in voices.json, e.g. "prebuilt-kore" or "cozy-grandpa-owl"
  label: string;                   // Human title, e.g. "Kore (Warm Prebuilt)" or "Grandpa Owl"
  source: 'prebuilt' | 'designed';
  gemini_voice_name: string;       // Prebuilt name ("Kore", "Puck", "Aoede", "Charon", "Fenrir") OR custom "voice_..." ID from ai.voices.create
  description: string;
  language_code: string;           // Default "en-US"
  tags: string[];
  default_pace?: VoicePace;
  preview_audio_url?: string;      // Optional cached "/api/voices/{id}/preview.wav"
  created_at: string;
}
