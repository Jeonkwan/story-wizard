import type { CatalogItem, Story, VoiceEntry } from '../../shared/types.js';

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-_]{1,80}$/;

export class InvalidSlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSlugError';
  }
}

export class StorageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageNotFoundError';
  }
}

export function validateSlug(slug: string, fieldName = 'slug'): string {
  if (!slug || typeof slug !== 'string' || !SLUG_REGEX.test(slug)) {
    throw new InvalidSlugError(`Invalid ${fieldName}: "${slug}". Must match ${SLUG_REGEX}`);
  }
  return slug;
}

export interface AudioStreamDescriptor {
  totalBytes: number;
  createStream: (range?: { start: number; end: number }) => NodeJS.ReadableStream;
}

export interface StorageAdapter {
  getCatalog(): Promise<CatalogItem[]>;
  saveCatalog(items: CatalogItem[]): Promise<void>;

  getVoices(): Promise<VoiceEntry[]>;
  saveVoices(voices: VoiceEntry[]): Promise<void>;

  getStory(storyId: string): Promise<Story>;
  saveStory(story: Story): Promise<void>;
  deleteStory(storyId: string): Promise<void>;

  saveAudio(storyId: string, versionId: string, wavBuffer: Buffer): Promise<void>;
  deleteAudio(storyId: string, versionId: string): Promise<void>;
  getAudioStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor>;

  updateJsonAtomic<T>(
    relativePath: string,
    mutator: (current: T | null) => T | Promise<T>,
    defaultValue?: T
  ): Promise<T>;
}
