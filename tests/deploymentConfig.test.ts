import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Storage } from '@google-cloud/storage';
import { loadConfig } from '../server/config.js';
import {
  createStorageAdapter,
  GcsStorageAdapter,
  LocalStorageAdapter,
} from '../server/storage/index.js';
import {
  parseArgs,
  getContentType,
  formatBytes,
  discoverDataFiles,
  migrateToGcs,
} from '../scripts/migrateToGcs.js';

describe('Phase 8: Production Deployment Configuration & Fail-Closed Assertions', () => {
  describe('loadConfig Fail-Closed Safety', () => {
    it('throws when NODE_ENV=production and SESSION_SECRET is missing', () => {
      expect(() => {
        loadConfig({
          NODE_ENV: 'production',
          SESSION_SECRET: '',
        });
      }).toThrow(/SESSION_SECRET must be at least 32 characters/);
    });

    it('throws when NODE_ENV=production and SESSION_SECRET is shorter than 32 characters', () => {
      expect(() => {
        loadConfig({
          NODE_ENV: 'production',
          SESSION_SECRET: 'short-secret-1234',
        });
      }).toThrow(/SESSION_SECRET must be at least 32 characters/);
    });

    it('throws when K_SERVICE is set (Cloud Run) and SESSION_SECRET is missing', () => {
      expect(() => {
        loadConfig({
          K_SERVICE: 'storyteller-production',
          SESSION_SECRET: '',
        });
      }).toThrow(/SESSION_SECRET must be at least 32 characters/);
    });

    it('throws when K_SERVICE is set (Cloud Run) and SESSION_SECRET is shorter than 32 characters', () => {
      expect(() => {
        loadConfig({
          K_SERVICE: 'storyteller-production',
          SESSION_SECRET: 'only-twenty-five-chars!',
        });
      }).toThrow(/SESSION_SECRET must be at least 32 characters/);
    });

    it('succeeds in production when SESSION_SECRET is 32 or more characters', () => {
      const validSecret = 'production-secret-must-be-at-least-32-characters-long!';
      const config = loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: validSecret,
        GCS_BUCKET_NAME: 'prod-bucket',
        DEV_ADMIN_BYPASS: 'true', // Should be strictly ignored in production
      });

      expect(config.sessionSecret).toBe(validSecret);
      expect(config.nodeEnv).toBe('production');
      expect(config.allowDevBypass).toBe(false);
      expect(config.gcsBucketName).toBe('prod-bucket');
    });

    it('succeeds in Cloud Run (K_SERVICE) when valid SESSION_SECRET is provided and enforces allowDevBypass=false', () => {
      const validSecret = 'cloud-run-service-secret-32-chars-long!';
      const config = loadConfig({
        K_SERVICE: 'storyteller-cloudrun',
        SESSION_SECRET: validSecret,
        DEV_ADMIN_BYPASS: 'true',
      });

      expect(config.sessionSecret).toBe(validSecret);
      expect(config.allowDevBypass).toBe(false);
    });

    it('defaults to dev secret in development mode when SESSION_SECRET is omitted', () => {
      const config = loadConfig({
        NODE_ENV: 'development',
        DEV_ADMIN_BYPASS: 'true',
      });

      expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
      expect(config.allowDevBypass).toBe(true);
    });
  });

  describe('createStorageAdapter Factory Routing', () => {
    it('returns GcsStorageAdapter when GCS_BUCKET_NAME is configured', () => {
      const config = loadConfig({
        GCS_BUCKET_NAME: 'storyteller-test-bucket',
      });

      const adapter = createStorageAdapter(config);
      expect(adapter).toBeInstanceOf(GcsStorageAdapter);
    });

    it('returns LocalStorageAdapter when GCS_BUCKET_NAME is unset', () => {
      const config = loadConfig({
        GCS_BUCKET_NAME: '',
        DATA_DIR: './custom-data',
      });

      const adapter = createStorageAdapter(config);
      expect(adapter).toBeInstanceOf(LocalStorageAdapter);
    });
  });
});

describe('Phase 8: GCS Data Migration Tooling (scripts/migrateToGcs.ts)', () => {
  let tmpDataDir: string;

  beforeEach(async () => {
    tmpDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcs-migration-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('parses inline equals flags correctly', () => {
      const options = parseArgs([
        '--bucket=storyteller-bucket',
        '--data-dir=/tmp/custom-data',
        '--dry-run',
        '--force',
      ]);

      expect(options.bucketName).toBe('storyteller-bucket');
      expect(options.dataDir).toBe('/tmp/custom-data');
      expect(options.dryRun).toBe(true);
      expect(options.force).toBe(true);
    });

    it('parses space-separated flags correctly', () => {
      const options = parseArgs([
        '--bucket',
        'space-bucket',
        '--data-dir',
        './data-path',
        '--dry-run',
      ]);

      expect(options.bucketName).toBe('space-bucket');
      expect(options.dataDir).toBe('./data-path');
      expect(options.dryRun).toBe(true);
      expect(options.force).toBeUndefined();
    });

    it('returns empty object when no flags are given', () => {
      const options = parseArgs([]);
      expect(options).toEqual({});
    });
  });

  describe('getContentType', () => {
    it('identifies JSON files as application/json', () => {
      expect(getContentType('catalog.json')).toBe('application/json');
      expect(getContentType('voices.json')).toBe('application/json');
      expect(getContentType('stories/123/story.json')).toBe('application/json');
      expect(getContentType('DATA.JSON')).toBe('application/json');
    });

    it('identifies WAV audio files as audio/wav', () => {
      expect(getContentType('v1-narration.wav')).toBe('audio/wav');
      expect(getContentType('stories/123/audios/v2.wav')).toBe('audio/wav');
      expect(getContentType('AUDIO.WAV')).toBe('audio/wav');
    });

    it('defaults unknown file extensions to application/octet-stream', () => {
      expect(getContentType('file.txt')).toBe('application/octet-stream');
      expect(getContentType('unknown')).toBe('application/octet-stream');
    });
  });

  describe('formatBytes', () => {
    it('formats 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats exact KB and MB values', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('formats fractional byte amounts', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(2621440)).toBe('2.5 MB');
    });
  });

  describe('discoverDataFiles', () => {
    it('throws an error if dataDir does not exist', async () => {
      const nonExistentDir = path.join(tmpDataDir, 'does-not-exist');
      await expect(discoverDataFiles(nonExistentDir)).rejects.toThrow(
        /Data directory not found/
      );
    });

    it('recursively discovers JSON and WAV files while ignoring hidden and non-target files', async () => {
      // Seed test directory structure
      await fs.promises.writeFile(
        path.join(tmpDataDir, 'catalog.json'),
        JSON.stringify({ catalog: [] })
      );
      await fs.promises.writeFile(
        path.join(tmpDataDir, 'voices.json'),
        JSON.stringify({ voices: [] })
      );

      const storyDir = path.join(tmpDataDir, 'stories', 'story-01');
      const audioDir = path.join(storyDir, 'audios');
      await fs.promises.mkdir(audioDir, { recursive: true });

      await fs.promises.writeFile(
        path.join(storyDir, 'story.json'),
        JSON.stringify({ title: 'Test Story' })
      );
      await fs.promises.writeFile(
        path.join(audioDir, 'v1.wav'),
        Buffer.from('RIFF mock wav data')
      );

      // Add ignored files
      await fs.promises.writeFile(path.join(tmpDataDir, '.DS_Store'), 'junk');
      await fs.promises.writeFile(path.join(storyDir, '.gitkeep'), '');
      await fs.promises.writeFile(path.join(tmpDataDir, 'notes.txt'), 'ignore me');

      const files = await discoverDataFiles(tmpDataDir);

      expect(files).toHaveLength(4);
      expect(files.map((f) => f.relativePath)).toEqual([
        'catalog.json',
        'stories/story-01/audios/v1.wav',
        'stories/story-01/story.json',
        'voices.json',
      ]);

      expect(files[0].contentType).toBe('application/json');
      expect(files[1].contentType).toBe('audio/wav');
      expect(files[2].contentType).toBe('application/json');
      expect(files[3].contentType).toBe('application/json');

      expect(files[0].sizeBytes).toBeGreaterThan(0);
      expect(files[1].sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('migrateToGcs Execution', () => {
    it('fails closed when not dry-run and bucketName is missing', async () => {
      await expect(
        migrateToGcs({
          dataDir: tmpDataDir,
          dryRun: false,
          bucketName: '',
        })
      ).rejects.toThrow(/GCS bucket name is required/);
    });

    it('executes dry-run without writing to GCS or requiring bucketName', async () => {
      await fs.promises.writeFile(
        path.join(tmpDataDir, 'catalog.json'),
        JSON.stringify({ version: 1 })
      );

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await migrateToGcs({
        dataDir: tmpDataDir,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.totalFiles).toBe(1);
      expect(result.uploadedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.files[0].relativePath).toBe('catalog.json');

      const logs = logSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[DRY RUN]'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('gs://[dry-run-bucket]/catalog.json'))).toBe(true);
    });

    it('uploads files to mock storage and respects skip vs --force overwrites', async () => {
      // Create test files
      await fs.promises.writeFile(
        path.join(tmpDataDir, 'catalog.json'),
        JSON.stringify({ version: 1 })
      );
      await fs.promises.writeFile(
        path.join(tmpDataDir, 'voices.json'),
        JSON.stringify({ voices: [] })
      );

      const savedObjects = new Map<string, { buffer: Buffer; contentType: string }>();
      const existingInBucket = new Set<string>();

      const mockStorage = {
        bucket: (_bucketName: string) => ({
          file: (relPath: string) => ({
            exists: async () => [existingInBucket.has(relPath)],
            save: async (buffer: Buffer, opts: { contentType: string }) => {
              savedObjects.set(relPath, { buffer, contentType: opts.contentType });
              existingInBucket.add(relPath);
            },
          }),
        }),
      } as unknown as Storage;

      vi.spyOn(console, 'log').mockImplementation(() => {});

      // 1. Initial migration: all files uploaded
      const run1 = await migrateToGcs(
        {
          dataDir: tmpDataDir,
          bucketName: 'mock-test-bucket',
          force: false,
        },
        mockStorage
      );

      expect(run1.totalFiles).toBe(2);
      expect(run1.uploadedCount).toBe(2);
      expect(run1.skippedCount).toBe(0);
      expect(savedObjects.has('catalog.json')).toBe(true);
      expect(savedObjects.has('voices.json')).toBe(true);
      expect(savedObjects.get('catalog.json')?.contentType).toBe('application/json');

      // 2. Second migration without force: existing files should be skipped
      const run2 = await migrateToGcs(
        {
          dataDir: tmpDataDir,
          bucketName: 'mock-test-bucket',
          force: false,
        },
        mockStorage
      );

      expect(run2.totalFiles).toBe(2);
      expect(run2.uploadedCount).toBe(0);
      expect(run2.skippedCount).toBe(2);

      // 3. Third migration with --force: files should be uploaded/overwritten
      const run3 = await migrateToGcs(
        {
          dataDir: tmpDataDir,
          bucketName: 'mock-test-bucket',
          force: true,
        },
        mockStorage
      );

      expect(run3.totalFiles).toBe(2);
      expect(run3.uploadedCount).toBe(2);
      expect(run3.skippedCount).toBe(0);
    });
  });
});

describe('Phase 8: Cloud Run & DevOps Hygiene Specifications', () => {
  const rootDir = path.resolve(__dirname, '..');

  describe('gcs-lifecycle.json Specification', () => {
    it('defines 14-day deletion rule for noncurrent object versions', async () => {
      const lifecyclePath = path.join(rootDir, 'gcs-lifecycle.json');
      expect(fs.existsSync(lifecyclePath)).toBe(true);

      const raw = await fs.promises.readFile(lifecyclePath, 'utf-8');
      const config = JSON.parse(raw);

      expect(config.rule).toBeDefined();
      expect(Array.isArray(config.rule)).toBe(true);
      expect(config.rule).toHaveLength(1);

      const rule = config.rule[0];
      expect(rule.action).toEqual({ type: 'Delete' });
      expect(rule.condition).toEqual({ daysSinceNoncurrentTime: 14 });
    });
  });

  describe('.dockerignore Hygiene', () => {
    it('strictly excludes tests, docs, artifacts, credentials, and local build directories', async () => {
      const dockerignorePath = path.join(rootDir, '.dockerignore');
      expect(fs.existsSync(dockerignorePath)).toBe(true);

      const content = await fs.promises.readFile(dockerignorePath, 'utf-8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));

      const requiredPatterns = [
        'node_modules',
        'dist',
        'data',
        '.git',
        '.env*',
        'qa-screenshots',
        'playwright-report',
        'test-results',
        'coverage',
        '*.log',
        'docs',
        'tests',
      ];

      for (const pattern of requiredPatterns) {
        expect(lines).toContain(pattern);
      }
    });
  });

  describe('deploy.sh Script Configuration', () => {
    it('contains all required production Cloud Run scaling flags and defaults', async () => {
      const deployPath = path.join(rootDir, 'deploy.sh');
      expect(fs.existsSync(deployPath)).toBe(true);

      const content = await fs.promises.readFile(deployPath, 'utf-8');

      // Default architectural parameters
      expect(content).toContain('REGION="${REGION:-asia-southeast1}"');
      expect(content).toContain('SERVICE_NAME="${SERVICE_NAME:-storyteller-studio}"');
      expect(content).toContain('GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-storyteller-studio-mokamaker}"');
      expect(content).toContain('ADMIN_GOOGLE_EMAIL="${ADMIN_GOOGLE_EMAIL:-jeonkwan@gmail.com}"');

      // Scaling strategy parameters
      expect(content).toContain('--min-instances=0');
      expect(content).toContain('--max-instances=1');
      expect(content).toContain('--no-cpu-throttling');
      expect(content).toContain('--concurrency=80');
      expect(content).toContain('--timeout=300');
      expect(content).toContain('--memory=512Mi');
      expect(content).toContain('--cpu=1');
      expect(content).toContain('--allow-unauthenticated');

      // Dry run and fail-closed security handling
      expect(content).toContain('--dry-run');
      expect(content).toContain('SESSION_SECRET is required');
      expect(content).toContain('GEMINI_API_KEY is required');
    });
  });

  describe('.github/workflows/deploy.yml CI/CD Pipeline', () => {
    it('configures push/PR triggers, test-and-verify job, and automated Cloud Run deployment', async () => {
      const workflowPath = path.join(rootDir, '.github', 'workflows', 'deploy.yml');
      expect(fs.existsSync(workflowPath)).toBe(true);

      const content = await fs.promises.readFile(workflowPath, 'utf-8');

      // Triggers
      expect(content).toContain('branches:\n      - main');
      expect(content).toContain('pull_request:');

      // Test job verification commands
      expect(content).toContain('npm ci');
      expect(content).toContain('npm run typecheck');
      expect(content).toContain('npx tsc -p tsconfig.server.json');
      expect(content).toContain('npm test');

      // Deploy job verification
      expect(content).toContain('deploy-cloud-run:');
      expect(content).toContain('needs: test-and-verify');
      expect(content).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
      expect(content).toContain('google-github-actions/auth@v2');
      expect(content).toContain('google-github-actions/setup-gcloud@v2');
      expect(content).toContain('./deploy.sh');
    });
  });
});

