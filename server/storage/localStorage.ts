import fs from 'node:fs';
import path from 'node:path';
import type { CatalogItem, PodcastConfig, Story, VoiceEntry } from '../../shared/types.js';
import {
  type StorageAdapter,
  type AudioStreamDescriptor,
  SLUG_REGEX,
  validateSlug,
  StorageNotFoundError,
  InvalidSlugError,
} from './storageAdapter.js';

export class LocalStorageAdapter implements StorageAdapter {
  private dataDir: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(dataDir = './data') {
    this.dataDir = path.resolve(dataDir);
  }

  private resolveSafePath(relativePath: string): string {
    const resolved = path.resolve(this.dataDir, relativePath);
    if (resolved !== this.dataDir && !resolved.startsWith(this.dataDir + path.sep)) {
      throw new InvalidSlugError(`Path traversal detected: "${relativePath}"`);
    }
    return resolved;
  }

  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    let resolveLock!: () => void;
    const current = new Promise<void>((r) => {
      resolveLock = r;
    });
    const chain = prev.then(
      () => current,
      () => current
    );
    this.locks.set(key, chain);

    try {
      await prev;
      return await fn();
    } finally {
      resolveLock();
      if (this.locks.get(key) === chain) {
        this.locks.delete(key);
      }
    }
  }

  private async writeAtomic(filePath: string, data: string | Buffer): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpFile = path.join(
      dir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.promises.writeFile(tmpFile, data);
    await fs.promises.rename(tmpFile, filePath);
  }

  async updateJsonAtomic<T>(
    relativePath: string,
    mutator: (current: T | null) => T | Promise<T>,
    defaultValue: T | null = null
  ): Promise<T> {
    const filePath = this.resolveSafePath(relativePath);
    return this.lock(filePath, async () => {
      let current: T | null = null;
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        current = JSON.parse(raw) as T;
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'ENOENT') {
          throw err;
        }
        current = defaultValue;
      }

      const updated = await mutator(current);
      await this.writeAtomic(filePath, JSON.stringify(updated, null, 2));
      return updated;
    });
  }

  async getCatalog(): Promise<CatalogItem[]> {
    const filePath = this.resolveSafePath('catalog.json');
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as CatalogItem[];
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return [];
      throw err;
    }
  }

  async saveCatalog(items: CatalogItem[]): Promise<void> {
    await this.updateJsonAtomic('catalog.json', () => items, []);
  }

  async getVoices(): Promise<VoiceEntry[]> {
    const filePath = this.resolveSafePath('voices.json');
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as VoiceEntry[];
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return [];
      throw err;
    }
  }

  async saveVoices(voices: VoiceEntry[]): Promise<void> {
    await this.updateJsonAtomic('voices.json', () => voices, []);
  }

  async getStory(storyId: string): Promise<Story> {
    validateSlug(storyId, 'storyId');
    const filePath = this.resolveSafePath(path.join('stories', storyId, 'story.json'));
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Story;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new StorageNotFoundError(`Story not found: "${storyId}"`);
      }
      throw err;
    }
  }

  async saveStory(story: Story): Promise<void> {
    validateSlug(story.id, 'story.id');
    const relPath = path.join('stories', story.id, 'story.json');
    await this.updateJsonAtomic(relPath, () => story);
  }

  async deleteStory(storyId: string): Promise<void> {
    validateSlug(storyId, 'storyId');
    const dir = this.resolveSafePath(path.join('stories', storyId));
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  async saveAudio(storyId: string, versionId: string, wavBuffer: Buffer): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const filePath = this.resolveSafePath(
      path.join('stories', storyId, 'audios', `${versionId}.wav`)
    );
    await this.writeAtomic(filePath, wavBuffer);
  }

  /**
   * Saves a transcoded AAC-LC `.m4a` audio file alongside the lossless `.wav`.
   */
  async saveAudioM4a(storyId: string, versionId: string, m4aBuffer: Buffer): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const filePath = this.resolveSafePath(
      path.join('stories', storyId, 'audios', `${versionId}.m4a`)
    );
    await this.writeAtomic(filePath, m4aBuffer);
  }

  /**
   * Deletes both `.wav` and `.m4a` audio files for a story version, ignoring missing files.
   */
  async deleteAudio(storyId: string, versionId: string): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    for (const ext of ['wav', 'm4a'] as const) {
      const filePath = this.resolveSafePath(
        path.join('stories', storyId, 'audios', `${versionId}.${ext}`)
      );
      try {
        await fs.promises.unlink(filePath);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'ENOENT') throw err;
      }
    }
  }

  private async getLocalFileStream(
    filePath: string,
    notFoundMessage: string
  ): Promise<AudioStreamDescriptor> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new StorageNotFoundError(notFoundMessage);
      }
      throw err;
    }

    return {
      totalBytes: stat.size,
      createStream: (range?: { start: number; end: number }) => {
        if (range) {
          return fs.createReadStream(filePath, { start: range.start, end: range.end });
        }
        return fs.createReadStream(filePath);
      },
    };
  }

  async getAudioStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const filePath = this.resolveSafePath(
      path.join('stories', storyId, 'audios', `${versionId}.wav`)
    );
    return this.getLocalFileStream(filePath, `Audio not found: "${storyId}/${versionId}"`);
  }

  /**
   * Streams the transcoded `.m4a` audio file with HTTP Range byte-slice support.
   */
  async getAudioM4aStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const filePath = this.resolveSafePath(
      path.join('stories', storyId, 'audios', `${versionId}.m4a`)
    );
    return this.getLocalFileStream(filePath, `Audio M4A not found: "${storyId}/${versionId}"`);
  }

  async saveVoicePreview(voiceId: string, wavBuffer: Buffer): Promise<void> {
    validateSlug(voiceId, 'voiceId');
    const filePath = this.resolveSafePath(path.join('voices', voiceId, 'preview.wav'));
    await this.writeAtomic(filePath, wavBuffer);
  }

  async deleteVoicePreview(voiceId: string): Promise<void> {
    validateSlug(voiceId, 'voiceId');
    const filePath = this.resolveSafePath(path.join('voices', voiceId, 'preview.wav'));
    try {
      await fs.promises.unlink(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
    }
  }

  async getVoicePreviewStream(voiceId: string): Promise<AudioStreamDescriptor> {
    validateSlug(voiceId, 'voiceId');
    const filePath = this.resolveSafePath(path.join('voices', voiceId, 'preview.wav'));
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new StorageNotFoundError(`Voice preview not found: "${voiceId}"`);
      }
      throw err;
    }

    return {
      totalBytes: stat.size,
      createStream: (range?: { start: number; end: number }) => {
        if (range) {
          return fs.createReadStream(filePath, { start: range.start, end: range.end });
        }
        return fs.createReadStream(filePath);
      },
    };
  }

  private async detectLocalPodcastCoverUrl(podcastId: string): Promise<string | null> {
    for (const ext of ['jpg', 'png'] as const) {
      const coverPath = this.resolveSafePath(path.join('podcasts', podcastId, `cover.${ext}`));
      try {
        await fs.promises.access(coverPath, fs.constants.R_OK);
        return `/api/podcasts/${podcastId}/cover.${ext}`;
      } catch {
        // Cover variant not present
      }
    }
    return null;
  }

  /**
   * Dynamically scans `data/podcasts/<id>/podcast.json` and detects optional cover art.
   */
  async listPodcasts(): Promise<PodcastConfig[]> {
    const podcastsDir = this.resolveSafePath('podcasts');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(podcastsDir, { withFileTypes: true });
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return [];
      throw err;
    }

    const podcasts: PodcastConfig[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG_REGEX.test(entry.name)) {
        continue;
      }
      const configPath = this.resolveSafePath(path.join('podcasts', entry.name, 'podcast.json'));
      try {
        const raw = await fs.promises.readFile(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as PodcastConfig;
        if (!parsed.cover_image_url) {
          const detectedCover = await this.detectLocalPodcastCoverUrl(entry.name);
          if (detectedCover) {
            parsed.cover_image_url = detectedCover;
          }
        }
        podcasts.push(parsed);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'ENOENT') {
          console.warn(`[LocalStorage] Failed to parse podcast config ${entry.name}:`, err);
        }
      }
    }

    podcasts.sort((a, b) => {
      const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return diff !== 0 ? diff : a.title.localeCompare(b.title);
    });
    return podcasts;
  }

  /**
   * Reads a single podcast configuration by slug ID.
   */
  async getPodcast(podcastId: string): Promise<PodcastConfig> {
    validateSlug(podcastId, 'podcastId');
    const configPath = this.resolveSafePath(path.join('podcasts', podcastId, 'podcast.json'));
    try {
      const raw = await fs.promises.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as PodcastConfig;
      if (!parsed.cover_image_url) {
        const detectedCover = await this.detectLocalPodcastCoverUrl(podcastId);
        if (detectedCover) {
          parsed.cover_image_url = detectedCover;
        }
      }
      return parsed;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new StorageNotFoundError(`Podcast not found: "${podcastId}"`);
      }
      throw err;
    }
  }

  /**
   * Atomically persists `podcasts/<id>/podcast.json`.
   */
  async savePodcast(podcast: PodcastConfig): Promise<void> {
    validateSlug(podcast.id, 'podcast.id');
    const relPath = path.join('podcasts', podcast.id, 'podcast.json');
    await this.updateJsonAtomic(relPath, () => podcast);
  }

  /**
   * Removes the podcast directory and all files inside `podcasts/<id>/`.
   */
  async deletePodcast(podcastId: string): Promise<void> {
    validateSlug(podcastId, 'podcastId');
    const dir = this.resolveSafePath(path.join('podcasts', podcastId));
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  /**
   * Streams optional podcast cover art (`cover.jpg` or `cover.png`), throwing
   * `StorageNotFoundError` if neither exists.
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
      const coverPath = this.resolveSafePath(path.join('podcasts', podcastId, candidate.filename));
      try {
        const streamDesc = await this.getLocalFileStream(
          coverPath,
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
