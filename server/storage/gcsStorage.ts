import { Storage, type Bucket } from '@google-cloud/storage';
import type { CatalogItem, Story, VoiceEntry } from '../../shared/types.js';
import {
  type StorageAdapter,
  type AudioStreamDescriptor,
  validateSlug,
  StorageNotFoundError,
} from './storageAdapter.js';

export class GcsStorageAdapter implements StorageAdapter {
  private bucket: Bucket;

  constructor(bucketOrName: Bucket | string) {
    if (typeof bucketOrName === 'string') {
      const storage = new Storage();
      this.bucket = storage.bucket(bucketOrName);
    } else {
      this.bucket = bucketOrName;
    }
  }

  async updateJsonAtomic<T>(
    relativePath: string,
    mutator: (current: T | null) => T | Promise<T>,
    defaultValue: T | null = null
  ): Promise<T> {
    const file = this.bucket.file(relativePath);
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let generation: number | string = 0;
      let current: T | null = defaultValue;

      try {
        const [metadata] = await file.getMetadata();
        generation = metadata.generation ?? 0;
        const [contents] = await file.download();
        current = JSON.parse(contents.toString('utf-8')) as T;
      } catch (err: unknown) {
        const error = err as { code?: number; status?: number };
        if (error.code !== 404 && error.status !== 404) {
          throw err;
        }
        generation = 0;
        current = defaultValue;
      }

      const updated = await mutator(current);
      try {
        await file.save(JSON.stringify(updated, null, 2), {
          contentType: 'application/json',
          resumable: false,
          preconditionOpts: {
            ifGenerationMatch: typeof generation === 'string' ? Number(generation) : generation,
          },
        });
        return updated;
      } catch (err: unknown) {
        const error = err as { code?: number; status?: number };
        const is412 = error.code === 412 || error.status === 412;
        if (is412 && attempt < maxRetries - 1) {
          continue; // Retry optimistic concurrency conflict
        }
        throw err;
      }
    }

    throw new Error(`Failed to update ${relativePath} after ${maxRetries} attempts`);
  }

  async getCatalog(): Promise<CatalogItem[]> {
    const file = this.bucket.file('catalog.json');
    try {
      const [contents] = await file.download();
      return JSON.parse(contents.toString('utf-8')) as CatalogItem[];
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) return [];
      throw err;
    }
  }

  async saveCatalog(items: CatalogItem[]): Promise<void> {
    await this.updateJsonAtomic('catalog.json', () => items, []);
  }

  async getVoices(): Promise<VoiceEntry[]> {
    const file = this.bucket.file('voices.json');
    try {
      const [contents] = await file.download();
      return JSON.parse(contents.toString('utf-8')) as VoiceEntry[];
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) return [];
      throw err;
    }
  }

  async saveVoices(voices: VoiceEntry[]): Promise<void> {
    await this.updateJsonAtomic('voices.json', () => voices, []);
  }

  async getStory(storyId: string): Promise<Story> {
    validateSlug(storyId, 'storyId');
    const file = this.bucket.file(`stories/${storyId}/story.json`);
    try {
      const [contents] = await file.download();
      return JSON.parse(contents.toString('utf-8')) as Story;
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) {
        throw new StorageNotFoundError(`Story not found: "${storyId}"`);
      }
      throw err;
    }
  }

  async saveStory(story: Story): Promise<void> {
    validateSlug(story.id, 'story.id');
    await this.updateJsonAtomic(`stories/${story.id}/story.json`, () => story);
  }

  async deleteStory(storyId: string): Promise<void> {
    validateSlug(storyId, 'storyId');
    await this.bucket.deleteFiles({ prefix: `stories/${storyId}/` });
  }

  async saveAudio(storyId: string, versionId: string, wavBuffer: Buffer): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const file = this.bucket.file(`stories/${storyId}/audios/${versionId}.wav`);
    await file.save(wavBuffer, {
      contentType: 'audio/wav',
      resumable: false,
    });
  }

  async deleteAudio(storyId: string, versionId: string): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const file = this.bucket.file(`stories/${storyId}/audios/${versionId}.wav`);
    try {
      await file.delete({ ignoreNotFound: true });
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code !== 404 && error.status !== 404) throw err;
    }
  }

  async getAudioStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const file = this.bucket.file(`stories/${storyId}/audios/${versionId}.wav`);
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) {
        throw new StorageNotFoundError(`Audio not found: "${storyId}/${versionId}"`);
      }
      throw err;
    }

    const totalBytes = Number(metadata.size);
    return {
      totalBytes,
      createStream: (range?: { start: number; end: number }) => {
        if (range) {
          return file.createReadStream({ start: range.start, end: range.end });
        }
        return file.createReadStream();
      },
    };
  }
}
