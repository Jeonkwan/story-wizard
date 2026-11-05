import fs from 'node:fs';
import path from 'node:path';
import type { CatalogItem, Story, VoiceEntry } from '../../shared/types.js';
import {
  type StorageAdapter,
  type AudioStreamDescriptor,
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

  async deleteAudio(storyId: string, versionId: string): Promise<void> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const filePath = this.resolveSafePath(
      path.join('stories', storyId, 'audios', `${versionId}.wav`)
    );
    try {
      await fs.promises.unlink(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
    }
  }

  async getAudioStream(storyId: string, versionId: string): Promise<AudioStreamDescriptor> {
    validateSlug(storyId, 'storyId');
    validateSlug(versionId, 'versionId');
    const filePath = this.resolveSafePath(
      path.join('stories', storyId, 'audios', `${versionId}.wav`)
    );
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new StorageNotFoundError(`Audio not found: "${storyId}/${versionId}"`);
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
}
