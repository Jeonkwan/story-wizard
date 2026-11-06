import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobManager, JOB_PRUNE_TTL_MS } from '../server/services/jobManager.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import type { Story, CatalogItem } from '../shared/types.js';

describe('Phase 7: Zero-DB Asynchronous JobManager Unit Tests', () => {
  let tmpDir: string;
  let storage: LocalStorageAdapter;
  let jobManager: JobManager;

  const mockStory: Story = {
    id: 'test-bedtime-story',
    status: 'draft',
    title: 'The Moonbeam Bear',
    summary: 'A fluffy bear follows a gentle moonbeam through the quiet woods.',
    tags: ['bedtime', 'bear'],
    series_context: null,
    characters: [{ name: 'Barnaby', traits: 'Sleepy brown bear, soft purrs' }],
    script_turns: [
      { turn_id: 1, speaker: 'Narrator', style: '', text: 'The forest was wrapped in silvery moonlight.' },
      { turn_id: 2, speaker: 'Barnaby', style: '', text: 'Time for a warm winter sleep.' },
    ],
    voice_candidates: [],
    audio_versions: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-job-manager-test-'));
    storage = new LocalStorageAdapter(tmpDir);
    await storage.saveStory(mockStory);
    const catalogItem: CatalogItem = {
      id: mockStory.id,
      status: mockStory.status,
      title: mockStory.title,
      summary: mockStory.summary,
      tags: [...mockStory.tags],
      series_id: null,
      episode_number: null,
      created_at: mockStory.created_at,
      updated_at: mockStory.updated_at,
      default_audio_url: null,
      audio_versions_count: 0,
      active_job: null,
    };
    await storage.saveCatalog([catalogItem]);

    jobManager = new JobManager(storage);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks();
  });

  it('creates an in-memory job with running status and zero elapsed seconds', () => {
    const job = jobManager.createJob('draft', 'new', 'Writing new story...');
    expect(job.job_id).toMatch(/^job_\d+_[a-z0-9]+$/);
    expect(job.type).toBe('draft');
    expect(job.story_id).toBe('new');
    expect(job.status).toBe('running');
    expect(job.elapsed_seconds).toBe(0);
    expect(job.message).toBe('Writing new story...');
    expect(job.started_at).toBeDefined();

    const retrieved = jobManager.getJob(job.job_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.job_id).toBe(job.job_id);
  });

  it('dynamically computes elapsed seconds for running jobs', () => {
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const job = jobManager.createJob('direct', 'test-bedtime-story');

    // Simulate time passage by rewinding started_at
    jobManager.updateJob(job.job_id, { started_at: fiveSecondsAgo });

    const retrieved = jobManager.getJob(job.job_id);
    expect(retrieved?.elapsed_seconds).toBeGreaterThanOrEqual(5);
  });

  it('updates job fields and freezes elapsed_seconds upon completion', () => {
    const job = jobManager.createJob('draft', 'new');
    jobManager.updateJob(job.job_id, {
      status: 'completed',
      result_story_id: 'test-bedtime-story',
      message: 'Draft completed successfully!',
    });

    const retrieved = jobManager.getJob(job.job_id);
    expect(retrieved?.status).toBe('completed');
    expect(retrieved?.result_story_id).toBe('test-bedtime-story');
    expect(retrieved?.message).toBe('Draft completed successfully!');
  });

  it('finds active job by storyId matching story_id or result_story_id', () => {
    const job1 = jobManager.createJob('direct', 'test-bedtime-story');
    expect(jobManager.getActiveJobForStory('test-bedtime-story')?.job_id).toBe(job1.job_id);
    expect(jobManager.getActiveJobForStory('nonexistent-story')).toBeNull();

    const job2 = jobManager.createJob('draft', 'new');
    expect(jobManager.getActiveJobForStory('new')?.job_id).toBe(job2.job_id);

    // Update result_story_id while running
    jobManager.updateJob(job2.job_id, { result_story_id: 'newly-created-slug' });
    expect(jobManager.getActiveJobForStory('newly-created-slug')?.job_id).toBe(job2.job_id);
  });

  it('filters active jobs list by storyId', () => {
    const job1 = jobManager.createJob('direct', 'test-bedtime-story');
    const job2 = jobManager.createJob('synthesize', 'other-story');

    const allActive = jobManager.getActiveJobs();
    expect(allActive.length).toBe(2);

    const storyActive = jobManager.getActiveJobs('test-bedtime-story');
    expect(storyActive.length).toBe(1);
    expect(storyActive[0].job_id).toBe(job1.job_id);

    jobManager.updateJob(job2.job_id, { status: 'completed' });
    expect(jobManager.getActiveJobs().length).toBe(1);
  });

  it('prunes completed/failed jobs older than 15 minutes but keeps recent jobs', () => {
    const freshCompleted = jobManager.createJob('draft', 'new');
    jobManager.updateJob(freshCompleted.job_id, { status: 'completed' });

    const oldCompleted = jobManager.createJob('direct', 'test-bedtime-story');
    jobManager.updateJob(oldCompleted.job_id, {
      status: 'completed',
      started_at: new Date(Date.now() - (JOB_PRUNE_TTL_MS + 60_000)).toISOString(),
    });

    const oldFailed = jobManager.createJob('synthesize', 'test-bedtime-story');
    jobManager.updateJob(oldFailed.job_id, {
      status: 'failed',
      started_at: new Date(Date.now() - (JOB_PRUNE_TTL_MS + 120_000)).toISOString(),
    });

    const stillRunning = jobManager.createJob('direct', 'test-bedtime-story');

    const prunedCount = jobManager.cleanupOldJobs();
    expect(prunedCount).toBe(2);

    expect(jobManager.getJob(freshCompleted.job_id)).not.toBeNull();
    expect(jobManager.getJob(stillRunning.job_id)).not.toBeNull();
    expect(jobManager.getJob(oldCompleted.job_id)).toBeNull();
    expect(jobManager.getJob(oldFailed.job_id)).toBeNull();
  });

  it('persists story.active_job in storage on job start and clears it on completion', async () => {
    const job = jobManager.createJob('direct', 'test-bedtime-story');

    // Wait microtask tick for async storage persistence
    await new Promise((resolve) => setTimeout(resolve, 50));

    const storyDuring = await storage.getStory('test-bedtime-story');
    expect(storyDuring.active_job).toBeDefined();
    expect(storyDuring.active_job?.job_id).toBe(job.job_id);
    expect(storyDuring.active_job?.type).toBe('direct');

    const catalogDuring = await storage.getCatalog();
    const itemDuring = catalogDuring.find((c) => c.id === 'test-bedtime-story');
    expect(itemDuring?.active_job?.job_id).toBe(job.job_id);

    // Now update job to completed
    jobManager.updateJob(job.job_id, { status: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const storyAfter = await storage.getStory('test-bedtime-story');
    expect(storyAfter.active_job).toBeNull();

    const catalogAfter = await storage.getCatalog();
    const itemAfter = catalogAfter.find((c) => c.id === 'test-bedtime-story');
    expect(itemAfter?.active_job).toBeNull();
  });
});
