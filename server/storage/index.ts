export * from './storageAdapter.js';
export * from './localStorage.js';
export * from './gcsStorage.js';

import type { AppConfig } from '../config.js';
import type { StorageAdapter } from './storageAdapter.js';
import { LocalStorageAdapter } from './localStorage.js';
import { GcsStorageAdapter } from './gcsStorage.js';

export function createStorageAdapter(config: AppConfig): StorageAdapter {
  if (config.gcsBucketName) {
    return new GcsStorageAdapter(config.gcsBucketName);
  }
  return new LocalStorageAdapter(config.dataDir);
}
