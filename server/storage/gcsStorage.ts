import { Storage, type Bucket } from '@google-cloud/storage';
import type { CatalogItem, PodcastConfig, Story, VoiceEntry } from '../../shared/types.js';
import {
  type StorageAdapter,
  type AudioStreamDescriptor,
  SLUG_REGEX,
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
        const [contents] = await (file.download as (opts?: { generation?: string | number }) => Promise<[Buffer]>)(
          generation !== 0 ? { generation } : undefined
        );
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
            ifGenerationMatch: generation,
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

  /**
   * Saves a transcoded AAC-LC `.m4a` audio file to GCS alongside the lossless `.wav`.
   */
  async saveAudioM4a(storyId: string, versionId: string, m4aBuffer: Buffer): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const file = this.bucket.file(`stories/${storyId}/audios/${versionId}.m4a`);
    await file.save(m4aBuffer, {
      contentType: 'audio/mp4',
      resumable: false,
    });
  }

  /**
   * Deletes both `.wav` and `.m4a` audio objects from GCS, ignoring 404/not-found.
   */
  async deleteAudio(storyId: string, versionId: string): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    for (const ext of ['wav', 'm4a'] as const) {
      const file = this.bucket.file(`stories/${storyId}/audios/${versionId}.${ext}`);
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (err: unknown) {
        const error = err as { code?: number; status?: number };
        if (error.code !== 404 && error.status !== 404) throw err;
      }
    }
  }

  private async getGcsFileStream(
    objectPath: string,
    notFoundMessage: string
  ): Promise<AudioStreamDescriptor> {
    const file = this.bucket.file(objectPath);
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) {
        throw new StorageNotFoundError(notFoundMessage);
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

  async getAudioStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    return this.getGcsFileStream(
      `stories/${storyId}/audios/${versionId}.wav`,
      `Audio not found: "${storyId}/${versionId}"`
    );
  }

  /**
   * Streams the transcoded `.m4a` audio object from GCS with Range support.
   */
  async getAudioM4aStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    return this.getGcsFileStream(
      `stories/${storyId}/audios/${versionId}.m4a`,
      `Audio M4A not found: "${storyId}/${versionId}"`
    );
  }

  async saveVoicePreview(voiceId: string, wavBuffer: Buffer): Promise<void> {
    validateSlug(voiceId, 'voiceId');
    const file = this.bucket.file(`voices/${voiceId}/preview.wav`);
    await file.save(wavBuffer, {
      contentType: 'audio/wav',
      resumable: false,
    });
  }

  async deleteVoicePreview(voiceId: string): Promise<void> {
    validateSlug(voiceId, 'voiceId');
    const file = this.bucket.file(`voices/${voiceId}/preview.wav`);
    try {
      await file.delete({ ignoreNotFound: true });
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code !== 404 && error.status !== 404) throw err;
    }
  }

  async getVoicePreviewStream(voiceId: string): Promise<AudioStreamDescriptor> {
    validateSlug(voiceId, 'voiceId');
    const file = this.bucket.file(`voices/${voiceId}/preview.wav`);
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) {
        throw new StorageNotFoundError(`Voice preview not found: "${voiceId}"`);
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

  /**
   * Dynamically scans `podcasts/<id>/podcast.json` objects in the GCS bucket and
   * populates optional `cover_image_url` when `cover.jpg` or `cover.png` exists.
   */
  async listPodcasts(): Promise<PodcastConfig[]> {
    const [files] = await this.bucket.getFiles({ prefix: 'podcasts/' });
    const fileNames = new Set(files.map((f) => f.name));
    const configRegex = /^podcasts\/([a-z0-9][a-z0-9-_]{1,80})\/podcast\.json$/;

    const podcasts: PodcastConfig[] = [];
    for (const file of files) {
      const match = file.name.match(configRegex);
      if (!match) continue;
      const podcastId = match[1];
      if (!SLUG_REGEX.test(podcastId)) continue;

      try {
        const [contents] = await file.download();
        const parsed = JSON.parse(contents.toString('utf-8')) as PodcastConfig;
        if (!parsed.cover_image_url) {
          if (fileNames.has(`podcasts/${podcastId}/cover.jpg`)) {
            parsed.cover_image_url = `/api/podcasts/${podcastId}/cover.jpg`;
          } else if (fileNames.has(`podcasts/${podcastId}/cover.png`)) {
            parsed.cover_image_url = `/api/podcasts/${podcastId}/cover.png`;
          }
        }
        podcasts.push(parsed);
      } catch (err) {
        console.warn(`[GcsStorage] Failed to load podcast config ${file.name}:`, err);
      }
    }

    podcasts.sort((a, b) => {
      const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return diff !== 0 ? diff : a.title.localeCompare(b.title);
    });
    return podcasts;
  }

  /**
   * Reads a single podcast configuration object from GCS.
   */
  async getPodcast(podcastId: string): Promise<PodcastConfig> {
    validateSlug(podcastId, 'podcastId');
    const file = this.bucket.file(`podcasts/${podcastId}/podcast.json`);
    try {
      const [contents] = await file.download();
      const parsed = JSON.parse(contents.toString('utf-8')) as PodcastConfig;
      if (!parsed.cover_image_url) {
        for (const ext of ['jpg', 'png'] as const) {
          try {
            const [exists] = await this.bucket.file(`podcasts/${podcastId}/cover.${ext}`).exists();
            if (exists) {
              parsed.cover_image_url = `/api/podcasts/${podcastId}/cover.${ext}`;
              break;
            }
          } catch {
            // Ignore optional cover check errors
          }
        }
      }
      return parsed;
    } catch (err: unknown) {
      const error = err as { code?: number; status?: number };
      if (error.code === 404 || error.status === 404) {
        throw new StorageNotFoundError(`Podcast not found: "${podcastId}"`);
      }
      throw err;
    }
  }

  /**
   * Atomically persists `podcasts/<id>/podcast.json` via GCS generation precondition.
   */
  async savePodcast(podcast: PodcastConfig): Promise<void> {
    validateSlug(podcast.id, 'podcast.id');
    await this.updateJsonAtomic(`podcasts/${podcast.id}/podcast.json`, () => podcast);
  }

  /**
   * Deletes all objects under `podcasts/<id>/` in GCS.
   */
  async deletePodcast(podcastId: string): Promise<void> {
    validateSlug(podcastId, 'podcastId');
    await this.bucket.deleteFiles({ prefix: `podcasts/${podcastId}/` });
  }

  /**
   * Streams optional podcast cover art (`cover.jpg` or `cover.png`) from GCS.
   */
  async getPodcastCoverStream(
    podcastId: string
  ): Promise<{ streamDesc: AudioStreamDescriptor; contentType: string }> {
    validateSlug(podcastId, 'podcastId');
    const candidates: Array<{ filename: string; contentType: string }> = [
      { filename: 'cover.jpg', contentType: 'image/jpeg' },
      { filename: 'cover.png', contentType: 'image/png' },
    ];
    for (const candidate of candidates) {
      try {
        const streamDesc = await this.getGcsFileStream(
          `podcasts/${podcastId}/${candidate.filename}`,
          `Podcast cover not found: "${podcastId}"`
        );
        return { streamDesc, contentType: candidate.contentType };
      } catch (err) {
        if (!(err instanceof StorageNotFoundError)) {
          throw err;
        }
      }
    }
    throw new StorageNotFoundError(`Podcast cover not found: "${podcastId}"`);
  }
}
