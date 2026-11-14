import { loadConfig } from '../server/config.js';
import { createStorageAdapter, StorageNotFoundError, type StorageAdapter } from '../server/storage/index.js';
import { transcodeWavToM4a, type M4aTranscoder } from '../server/lib/m4a.js';
import { storyToCatalogItem } from '../server/services/geminiStory.js';
import type { CatalogItem } from '../shared/types.js';

export interface MigrateWavToM4aOptions {
  force?: boolean;
  dryRun?: boolean;
  transcoder?: M4aTranscoder;
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
  const config = loadConfig();
  const storage = createStorageAdapter(config);

  const mode = config.gcsBucketName ? `gcs:${config.gcsBucketName}` : `local:${config.dataDir}`;
  console.log(
    `[migrate:m4a] Starting migration (mode=${mode}, force=${force}, dryRun=${dryRun})`
  );

  migrateWavToM4a(storage, { force, dryRun })
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
