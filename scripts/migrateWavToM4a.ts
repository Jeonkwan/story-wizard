import { execFileSync } from 'node:child_process';
import { Storage, type StorageOptions } from '@google-cloud/storage';
import { OAuth2Client } from 'google-auth-library';
import { loadConfig, type AppConfig } from '../server/config.js';
import {
  createStorageAdapter,
  GcsStorageAdapter,
  StorageNotFoundError,
  type StorageAdapter,
} from '../server/storage/index.js';
import { transcodeWavToM4a, type M4aTranscoder } from '../server/lib/m4a.js';
import { storyToCatalogItem } from '../server/services/geminiStory.js';
import type { CatalogItem } from '../shared/types.js';

export interface MigrateWavToM4aOptions {
  force?: boolean;
  dryRun?: boolean;
  transcoder?: M4aTranscoder;
}

export interface CreateMigrationStorageOptions {
  /** Force authentication via `gcloud auth print-access-token` instead of ADC. */
  useGcloudAuth?: boolean;
  /** Injectable token provider for unit tests. */
  getGcloudAccessToken?: () => string;
  /** Injectable `@google-cloud/storage` factory for unit tests. */
  createGcsStorage?: (opts?: StorageOptions) => Storage;
  /** Injectable default storage factory for unit tests. */
  createDefaultStorage?: (config: AppConfig) => StorageAdapter;
}

/**
 * Obtains a short-lived OAuth2 access token from the active `gcloud` CLI session.
 */
function defaultGetGcloudAccessToken(): string {
  return execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf-8',
  }).trim();
}

/**
 * Returns true when an error indicates missing, unreadable, or expired Application
 * Default Credentials (e.g., `invalid_grant` on stale local ADC files).
 */
export function isAdcCredentialError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as {
    message?: unknown;
    code?: unknown;
    response?: { data?: { error?: unknown; error_description?: unknown } };
  };
  const combined = [
    typeof record.message === 'string' ? record.message : '',
    typeof record.code === 'string' ? record.code : '',
    typeof record.response?.data?.error === 'string' ? record.response.data.error : '',
    typeof record.response?.data?.error_description === 'string'
      ? record.response.data.error_description
      : '',
  ].join(' ');
  return /invalid_grant|Could not load the default credentials|Unable to detect a Project Id|ENOENT.*application_default_credentials|default credentials/i.test(
    combined
  );
}

/**
 * Creates a `StorageAdapter` for the `.wav -> .m4a` migration CLI.
 * When `config.gcsBucketName` is set, supports explicit `--gcloud-auth` or
 * automatic fallback to `gcloud auth print-access-token` if ADC fails with a
 * credential error (such as `invalid_grant`).
 */
export async function createMigrationStorage(
  config: AppConfig,
  options: CreateMigrationStorageOptions = {}
): Promise<StorageAdapter> {
  const makeDefaultStorage = options.createDefaultStorage || createStorageAdapter;
  if (!config.gcsBucketName) {
    return makeDefaultStorage(config);
  }

  const buildGcloudStorage = (): StorageAdapter => {
    const getToken = options.getGcloudAccessToken || defaultGetGcloudAccessToken;
    const accessToken = getToken().trim();
    if (!accessToken) {
      throw new Error('Empty access token returned by `gcloud auth print-access-token`.');
    }

    // Omit expiry_date so OAuth2Client uses the provided token directly without
    // attempting a refresh flow when no refresh_token is attached.
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: accessToken });

    const makeStorage = options.createGcsStorage || ((opts?: StorageOptions) => new Storage(opts));
    const gcsClient = makeStorage({
      authClient: authClient as StorageOptions['authClient'],
    });
    return new GcsStorageAdapter(gcsClient.bucket(config.gcsBucketName));
  };

  if (options.useGcloudAuth) {
    return buildGcloudStorage();
  }

  const defaultStorage = makeDefaultStorage(config);
  try {
    await defaultStorage.getCatalog();
    return defaultStorage;
  } catch (err) {
    if (!isAdcCredentialError(err)) {
      throw err;
    }
    console.warn(
      '[migrate:m4a] ADC credentials unavailable or expired; falling back to `gcloud auth print-access-token`.'
    );
    return buildGcloudStorage();
  }
}

export interface MigrateWavToM4aResult {
  storiesScanned: number;
  versionsScanned: number;
  migratedCount: number;
  skippedCount: number;
  errorCount: number;
}

/**
 * Collects all bytes from a NodeJS readable stream into a single Buffer.
 */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Iterates through all catalog stories and audio versions, transcoding legacy `.wav`
 * files into faststart `.m4a` files, saving them to storage, and updating `story.json`
 * (`audio_url`, `wav_url`, `m4a_size_bytes`) and `catalog.json` (`default_audio_url`).
 */
export async function migrateWavToM4a(
  storage: StorageAdapter,
  options: MigrateWavToM4aOptions = {}
): Promise<MigrateWavToM4aResult> {
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const transcoder = options.transcoder || transcodeWavToM4a;

  const catalog = await storage.getCatalog();
  let storiesScanned = 0;
  let versionsScanned = 0;
  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const item of catalog) {
    let story;
    try {
      story = await storage.getStory(item.id);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        console.warn(`[migrate:m4a] Skipping missing story "${item.id}"`);
        continue;
      }
      throw err;
    }

    storiesScanned++;
    if (!story.audio_versions || story.audio_versions.length === 0) {
      continue;
    }

    let storyModified = false;

    for (const ver of story.audio_versions) {
      versionsScanned++;
      const expectedM4aUrl = `/api/stories/${story.id}/audios/${ver.version_id}.m4a`;
      const expectedWavUrl = `/api/stories/${story.id}/audios/${ver.version_id}.wav`;

      let existingM4aSize: number | null = null;
      if (!force) {
        try {
          const m4aDesc = await storage.getAudioM4aStream(story.id, ver.version_id);
          if (m4aDesc.totalBytes > 0) {
            existingM4aSize = m4aDesc.totalBytes;
          }
        } catch (err) {
          if (!(err instanceof StorageNotFoundError)) {
            console.warn(
              `[migrate:m4a] Error checking .m4a for ${story.id}/${ver.version_id}:`,
              err
            );
          }
        }
      }

      if (existingM4aSize !== null) {
        // Ensure metadata fields are updated even if the .m4a blob was already generated
        const needsMetadataSync =
          ver.audio_url !== expectedM4aUrl ||
          ver.wav_url !== expectedWavUrl ||
          ver.m4a_size_bytes !== existingM4aSize;

        if (needsMetadataSync) {
          ver.wav_url = ver.wav_url || expectedWavUrl;
          ver.audio_url = expectedM4aUrl;
          ver.m4a_size_bytes = existingM4aSize;
          storyModified = true;
          migratedCount++;
          console.log(
            `[migrate:m4a] SYNCED metadata ${story.id}/${ver.version_id} (.m4a ${existingM4aSize} bytes)`
          );
        } else {
          skippedCount++;
        }
        continue;
      }

      try {
        const wavDesc = await storage.getAudioStream(story.id, ver.version_id);
        if (dryRun) {
          migratedCount++;
          console.log(
            `[migrate:m4a] [DRY RUN] Would transcode ${story.id}/${ver.version_id} (${wavDesc.totalBytes} bytes WAV)`
          );
          continue;
        }

        const wavBuffer = await streamToBuffer(wavDesc.createStream());
        const m4aBuffer = await transcoder(wavBuffer);
        await storage.saveAudioM4a(story.id, ver.version_id, m4aBuffer);

        ver.wav_url = ver.wav_url || expectedWavUrl;
        ver.audio_url = expectedM4aUrl;
        ver.m4a_size_bytes = m4aBuffer.length;
        storyModified = true;
        migratedCount++;
        console.log(
          `[migrate:m4a] MIGRATED ${story.id}/${ver.version_id}: ${wavBuffer.length}B WAV -> ${m4aBuffer.length}B M4A`
        );
      } catch (err) {
        errorCount++;
        console.error(
          `[migrate:m4a] Failed to migrate ${story.id}/${ver.version_id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    if (storyModified && !dryRun) {
      story.updated_at = new Date().toISOString();
      await storage.saveStory(story);
      const updatedCatalogItem = storyToCatalogItem(story);
      await storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          const idx = list.findIndex((c) => c.id === story.id);
          if (idx >= 0) {
            list[idx] = updatedCatalogItem;
          } else {
            list.unshift(updatedCatalogItem);
          }
          return list;
        },
        []
      );
    }
  }

  console.log(
    `[migrate:m4a] Complete: stories=${storiesScanned}, versions=${versionsScanned}, migrated=${migratedCount}, skipped=${skippedCount}, errors=${errorCount}`
  );

  return {
    storiesScanned,
    versionsScanned,
    migratedCount,
    skippedCount,
    errorCount,
  };
}

// Direct CLI execution entrypoint
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('migrateWavToM4a.ts') ||
    process.argv[1].endsWith('migrateWavToM4a.js') ||
    process.argv[1].includes('migrateWavToM4a'));

if (isDirectExecution) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const useGcloudAuth = args.includes('--gcloud-auth');
  const config = loadConfig();

  const mode = config.gcsBucketName ? `gcs:${config.gcsBucketName}` : `local:${config.dataDir}`;
  console.log(
    `[migrate:m4a] Starting migration (mode=${mode}, force=${force}, dryRun=${dryRun}, gcloudAuth=${useGcloudAuth})`
  );

  createMigrationStorage(config, { useGcloudAuth })
    .then((storage) => migrateWavToM4a(storage, { force, dryRun }))
    .then((result) => {
      if (result.errorCount > 0) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('[migrate:m4a] Fatal error:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
