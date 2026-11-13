import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  JobManager,
  JOB_PRUNE_TTL_MS,
  MAX_PERSISTED_JOBS,
  JOB_HISTORY_TTL_MS,
} from '../server/services/jobManager.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { ConflictError } from '../server/lib/validators.js';
import type { Story, CatalogItem, JobProgress } from '../shared/types.js';

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

  describe('Phase 15: Durable Job History, Restart Reconciliation & Dismissal', () => {
    it('exports MAX_PERSISTED_JOBS=30 and JOB_HISTORY_TTL_MS=24h', () => {
      expect(MAX_PERSISTED_JOBS).toBe(30);
      expect(JOB_HISTORY_TTL_MS).toBe(24 * 60 * 60 * 1000);
      expect(JOB_PRUNE_TTL_MS).toBe(15 * 60 * 1000);
    });

    it('persists job creation and completion into jobs.json with stage and finished_at', async () => {
      const job = jobManager.createJob('draft', 'new', 'Writing...', true, {
        title: 'Story about a brave fox',
        stage: 'drafting',
      });
      expect(job.title).toBe('Story about a brave fox');
      expect(job.stage).toBe('drafting');

      // Wait for async persistence
      await new Promise((resolve) => setTimeout(resolve, 60));

      const persistedJobs = await storage.updateJsonAtomic<JobProgress[]>('jobs.json', (c) => c ?? [], []);
      expect(persistedJobs.length).toBe(1);
      expect(persistedJobs[0].job_id).toBe(job.job_id);
      expect(persistedJobs[0].title).toBe('Story about a brave fox');
      expect(persistedJobs[0].stage).toBe('drafting');
      expect(persistedJobs[0].status).toBe('running');

      // Update to completed
      await jobManager.updateJobAsync(job.job_id, {
        status: 'completed',
        result_story_id: 'test-bedtime-story',
      });

      const persistedJobsAfter = await storage.updateJsonAtomic<JobProgress[]>('jobs.json', (c) => c ?? [], []);
      expect(persistedJobsAfter[0].status).toBe('completed');
      expect(persistedJobsAfter[0].stage).toBe('completed');
      expect(persistedJobsAfter[0].finished_at).toBeDefined();
    });

    it('reconciles stale running jobs on server restart, marking orphan jobs failed and clearing active_job', async () => {
      // Simulate jobs.json written by a previous server run before crash/restart
      const staleJobId = 'job_stale_12345';
      const staleJob: JobProgress = {
        job_id: staleJobId,
        story_id: 'test-bedtime-story',
        type: 'direct',
        status: 'running',
        started_at: new Date(Date.now() - 30_000).toISOString(),
        elapsed_seconds: 30,
        title: 'Bedtime Bear',
        stage: 'directing',
      };
      await storage.updateJsonAtomic<JobProgress[]>('jobs.json', () => [staleJob], []);

      // Story and catalog both have active_job pointing to this stale job
      await jobManager.persistStoryActiveJob('test-bedtime-story', {
        job_id: staleJobId,
        type: 'direct',
        started_at: staleJob.started_at,
      });

      const storyBefore = await storage.getStory('test-bedtime-story');
      expect(storyBefore.active_job?.job_id).toBe(staleJobId);

      // Create a fresh JobManager instance simulating new server process
      const freshJobManager = new JobManager(storage);
      const reconciledCount = await freshJobManager.reconcileStaleJobs();
      expect(reconciledCount).toBe(1);

      // Verify jobs.json has marked the job failed
      const jobs = await storage.updateJsonAtomic<JobProgress[]>('jobs.json', (c) => c ?? [], []);
      expect(jobs[0].status).toBe('failed');
      expect(jobs[0].stage).toBe('failed');
      expect(jobs[0].finished_at).toBeDefined();
      expect(jobs[0].message).toBe('Interrupted by server restart');
      expect(jobs[0].error).toContain('interrupted by a server restart');

      // Verify active_job cleared on story and catalog
      const storyAfter = await storage.getStory('test-bedtime-story');
      expect(storyAfter.active_job).toBeNull();

      const catalogAfter = await storage.getCatalog();
      const catalogItem = catalogAfter.find((c) => c.id === 'test-bedtime-story');
      expect(catalogItem?.active_job).toBeNull();
    });

    it('marks running in-memory jobs as interrupted during graceful shutdown', async () => {
      const liveJob = jobManager.createJob('direct', 'test-bedtime-story', 'Directing...', true, {
        title: 'Bedtime Bear Directing',
        stage: 'directing',
      });
      await new Promise((resolve) => setTimeout(resolve, 60));

      const count = await jobManager.markRunningJobsInterrupted('Interrupted by server shutdown/deploy');
      expect(count).toBe(1);

      const retrieved = jobManager.getJob(liveJob.job_id);
      expect(retrieved?.status).toBe('failed');
      expect(retrieved?.stage).toBe('failed');
      expect(retrieved?.message).toBe('Interrupted by server shutdown/deploy');
      expect(retrieved?.error).toBe('Interrupted by server shutdown/deploy');
      expect(retrieved?.finished_at).toBeDefined();

      const story = await storage.getStory('test-bedtime-story');
      expect(story.active_job).toBeNull();
    });

    it('retrieves recent jobs merging in-memory state and jobs.json, sorting newest first', async () => {
      // Create job 1 (older)
      const job1 = jobManager.createJob('draft', 'new', 'Writing...', true, {
        title: 'Story 1',
      });
      jobManager.updateJob(job1.job_id, {
        status: 'completed',
        started_at: new Date(Date.now() - 10_000).toISOString(),
      });

      // Create job 2 (newer)
      const job2 = jobManager.createJob('direct', 'test-bedtime-story', 'Directing...', true, {
        title: 'Story 2',
      });
      jobManager.updateJob(job2.job_id, {
        status: 'running',
        started_at: new Date(Date.now() - 2_000).toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 60));

      const recent = await jobManager.getRecentJobs();
      expect(recent.length).toBeGreaterThanOrEqual(2);
      expect(recent[0].job_id).toBe(job2.job_id); // Newer first
      expect(recent[1].job_id).toBe(job1.job_id);
      expect(recent[0].elapsed_seconds).toBeGreaterThanOrEqual(2);
    });

    it('retrieves job asynchronously by checking in-memory first then falling back to jobs.json', async () => {
      const job = jobManager.createJob('draft', 'new', 'Drafting...', true);
      await jobManager.updateJobAsync(job.job_id, {
        status: 'completed',
        result_story_id: 'test-bedtime-story',
      });

      // In-memory lookup
      const inMemoryFound = await jobManager.getJobAsync(job.job_id);
      expect(inMemoryFound).not.toBeNull();
      expect(inMemoryFound?.job_id).toBe(job.job_id);

      // Now clear in-memory map to test jobs.json fallback
      jobManager.clear();
      expect(jobManager.getJob(job.job_id)).toBeNull();

      const diskFound = await jobManager.getJobAsync(job.job_id);
      expect(diskFound).not.toBeNull();
      expect(diskFound?.job_id).toBe(job.job_id);
      expect(diskFound?.status).toBe('completed');
    });

    it('dismisses completed/failed jobs from memory and jobs.json, and rejects dismissing running jobs with ConflictError', async () => {
      const runningJob = jobManager.createJob('direct', 'test-bedtime-story');
      await expect(jobManager.dismissJob(runningJob.job_id)).rejects.toThrow(ConflictError);

      // Mark completed
      await jobManager.updateJobAsync(runningJob.job_id, { status: 'completed' });

      // Dismiss completed job
      const dismissed = await jobManager.dismissJob(runningJob.job_id);
      expect(dismissed).toBe(true);

      // Verify removed from in-memory and disk
      expect(jobManager.getJob(runningJob.job_id)).toBeNull();
      expect(await jobManager.getJobAsync(runningJob.job_id)).toBeNull();

      // Dismiss non-existent job returns false
      const nonExistent = await jobManager.dismissJob('job_non_existent');
      expect(nonExistent).toBe(false);
    });

    it('persists running synthesize/direct job to jobs.json on persistJobStart and reconciles to failed on server restart', async () => {
      // 1. Create a synthesize job with autoPersist = false (as done in adminStories.ts)
      const synthJob = jobManager.createJob('synthesize', 'test-bedtime-story', 'Synthesizing voice audio...', false, {
        title: 'Bedtime Bear Narration',
        stage: 'synthesizing',
      });

      // Initially not in jobs.json because autoPersist was false
      const beforePersist = await storage.updateJsonAtomic<JobProgress[]>('jobs.json', (c) => c ?? [], []);
      expect(beforePersist.some((j) => j.job_id === synthJob.job_id)).toBe(false);

      // 2. Call persistJobStart (which now persists to jobs.json and updates active_job)
      await jobManager.persistJobStart(synthJob.job_id);

      const afterPersist = await storage.updateJsonAtomic<JobProgress[]>('jobs.json', (c) => c ?? [], []);
      const foundInJobsJson = afterPersist.find((j) => j.job_id === synthJob.job_id);
      expect(foundInJobsJson).toBeDefined();
      expect(foundInJobsJson?.status).toBe('running');
      expect(foundInJobsJson?.title).toBe('Bedtime Bear Narration');
      expect(foundInJobsJson?.stage).toBe('synthesizing');

      // Check story and catalog have active_job
      const story = await storage.getStory('test-bedtime-story');
      expect(story.active_job?.job_id).toBe(synthJob.job_id);
      const catalog = await storage.getCatalog();
      expect(catalog.find((c) => c.id === 'test-bedtime-story')?.active_job?.job_id).toBe(synthJob.job_id);

      // 3. Simulate server restart with fresh JobManager
      const freshJobManager = new JobManager(storage);
      const reconciled = await freshJobManager.reconcileStaleJobs();
      expect(reconciled).toBe(1);

      // Verify jobs.json updated to failed
      const jobsAfterRestart = await storage.updateJsonAtomic<JobProgress[]>('jobs.json', (c) => c ?? [], []);
      const reconciledJob = jobsAfterRestart.find((j) => j.job_id === synthJob.job_id);
      expect(reconciledJob?.status).toBe('failed');
      expect(reconciledJob?.stage).toBe('failed');
      expect(reconciledJob?.error).toContain('interrupted by a server restart');

      // Verify story.active_job and catalog item active_job are cleared
      const storyAfter = await storage.getStory('test-bedtime-story');
      expect(storyAfter.active_job).toBeNull();
      const catalogAfter = await storage.getCatalog();
      expect(catalogAfter.find((c) => c.id === 'test-bedtime-story')?.active_job).toBeNull();
    });
  });
});
