import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';

export interface MigrateOptions {
  bucketName?: string;
  dryRun?: boolean;
  dataDir?: string;
  force?: boolean;
}

export interface MigrationFile {
  localPath: string;
  relativePath: string;
  contentType: string;
  sizeBytes: number;
}

export interface MigrationResult {
  totalFiles: number;
  totalBytes: number;
  uploadedCount: number;
  skippedCount: number;
  dryRun: boolean;
  files: MigrationFile[];
}

export function parseArgs(args: string[]): MigrateOptions {
  const options: MigrateOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg.startsWith('--bucket=')) {
      options.bucketName = arg.slice('--bucket='.length);
    } else if (arg === '--bucket' && i + 1 < args.length) {
      options.bucketName = args[++i];
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--data-dir' && i + 1 < args.length) {
      options.dataDir = args[++i];
    }
  }
  return options;
}

export function getContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  if (lower.endsWith('.wav')) {
    return 'audio/wav';
  }
  if (lower.endsWith('.m4a')) {
    return 'audio/mp4';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  return 'application/octet-stream';
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export async function discoverDataFiles(dataDir: string): Promise<MigrationFile[]> {
  const resolvedDir = path.resolve(dataDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Data directory not found: ${resolvedDir}`);
  }

  const results: MigrationFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // ignore hidden files
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          lower.endsWith('.json') ||
          lower.endsWith('.wav') ||
          lower.endsWith('.m4a') ||
          lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.png')
        ) {
          const stats = await fs.promises.stat(fullPath);
          const relativePath = path.relative(resolvedDir, fullPath).replace(/\\/g, '/');
          results.push({
            localPath: fullPath,
            relativePath,
            contentType: getContentType(entry.name),
            sizeBytes: stats.size,
          });
        }
      }
    }
  }

  await walk(resolvedDir);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export async function migrateToGcs(
  options: MigrateOptions = {},
  storageClient?: Storage
): Promise<MigrationResult> {
  const dataDir = options.dataDir || process.env.DATA_DIR || './data';
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const bucketName = options.bucketName || process.env.GCS_BUCKET_NAME || '';

  if (!dryRun && !bucketName) {
    throw new Error(
      'GCS bucket name is required. Specify via --bucket=<name> or GCS_BUCKET_NAME environment variable.'
    );
  }

  const displayBucket = bucketName || '[dry-run-bucket]';
  const files = await discoverDataFiles(dataDir);
  const totalFiles = files.length;
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);

  console.log(`[migrate:gcs] Target bucket: gs://${displayBucket}`);
  console.log(`[migrate:gcs] Source directory: ${path.resolve(dataDir)}`);
  console.log(`[migrate:gcs] Found ${totalFiles} data file(s) (${formatBytes(totalBytes)})`);

  if (dryRun) {
    console.log(`[migrate:gcs] [DRY RUN] Simulating upload to gs://${displayBucket}:`);
    for (const file of files) {
      console.log(
        `  -> would upload: ${file.relativePath} (${formatBytes(file.sizeBytes)}, ${file.contentType}) -> gs://${displayBucket}/${file.relativePath}`
      );
    }
    console.log(
      `[migrate:gcs] [DRY RUN] Complete: ${totalFiles} file(s) would be uploaded (${formatBytes(totalBytes)}). No changes made.`
    );
    return {
      totalFiles,
      totalBytes,
      uploadedCount: 0,
      skippedCount: 0,
      dryRun: true,
      files,
    };
  }

  const storage = storageClient || new Storage();
  const bucket = storage.bucket(bucketName);

  let uploadedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const gcsFile = bucket.file(file.relativePath);

    if (!force) {
      const [exists] = await gcsFile.exists();
      if (exists) {
        console.log(
          `[${i + 1}/${totalFiles}] SKIP gs://${bucketName}/${file.relativePath} (already exists, use --force to overwrite)`
        );
        skippedCount++;
        continue;
      }
    }

    const buffer = await fs.promises.readFile(file.localPath);
    await gcsFile.save(buffer, {
      contentType: file.contentType,
      resumable: false,
    });
    uploadedCount++;
    console.log(
      `[${i + 1}/${totalFiles}] UPLOADED ${file.relativePath} (${formatBytes(file.sizeBytes)}) -> gs://${bucketName}/${file.relativePath}`
    );
  }

  console.log(
    `[migrate:gcs] Migration complete: ${uploadedCount} uploaded, ${skippedCount} skipped out of ${totalFiles} total file(s) (${formatBytes(totalBytes)}).`
  );

  return {
    totalFiles,
    totalBytes,
    uploadedCount,
    skippedCount,
    dryRun: false,
    files,
  };
}

// Direct execution entry point
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('migrateToGcs.ts') ||
    process.argv[1].endsWith('migrateToGcs.js') ||
    process.argv[1].includes('migrateToGcs'));

if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  migrateToGcs(options).catch((err) => {
    console.error(`[migrate:gcs] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
