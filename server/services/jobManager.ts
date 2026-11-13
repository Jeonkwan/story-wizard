import type {
  JobType,
  JobProgress,
  ActiveJobSummary,
  CatalogItem,
} from '../../shared/types.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { StorageNotFoundError } from '../storage/storageAdapter.js';
import { ConflictError } from '../lib/validators.js';
import { storyToCatalogItem } from './geminiStory.js';

export const MAX_PERSISTED_JOBS = 30;
export const JOB_HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const JOB_PRUNE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class JobManager {
  private jobs: Map<string, JobProgress> = new Map();
  private storage?: StorageAdapter;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(storage?: StorageAdapter) {
    this.storage = storage;
  }

  setStorage(storage: StorageAdapter): void {
    this.storage = storage;
  }

  /**
   * Serializes async write tasks so rapid job updates do not race on jobs.json.
   */
  private enqueuePersist(task: () => Promise<void>): Promise<void> {
    const run = async () => {
      try {
        await task();
      } catch (err) {
        // Let ConflictError bubble if thrown in dismiss checks
        if (err instanceof ConflictError) {
          throw err;
        }
        console.warn('[JobManager] Error during queued persistence:', err);
      }
    };
    this.persistQueue = this.persistQueue.then(run, run);
    return this.persistQueue;
  }

  /**
   * Persists a job record into jobs.json, pruning expired history and capping at MAX_PERSISTED_JOBS.
   */
  private async saveJobToHistory(job: JobProgress): Promise<void> {
    if (!this.storage) return;
    return this.enqueuePersist(async () => {
      await this.storage!.updateJsonAtomic<JobProgress[]>(
        'jobs.json',
        (current) => {
          const list = Array.isArray(current) ? [...current] : [];
          const idx = list.findIndex((j) => j.job_id === job.job_id);
          if (idx >= 0) {
            list[idx] = { ...list[idx], ...job };
          } else {
            list.unshift({ ...job });
          }

          const cutoff = Date.now() - JOB_HISTORY_TTL_MS;
          const filtered = list.filter((j) => {
            const t = new Date(j.started_at).getTime();
            return !isNaN(t) && t > cutoff;
          });
          return filtered.slice(0, MAX_PERSISTED_JOBS);
        },
        []
      );
    });
  }

  /**
   * Creates a new running job and registers it in-memory.
   * If a storage adapter is bound and storyId is not a placeholder,
   * asynchronously persists active_job in story and catalog metadata.
   */
  createJob(
    type: JobType,
    storyId: string,
    initialMessage?: string,
    autoPersist = true,
    meta?: { title?: string; stage?: string }
  ): JobProgress {
    const startedAt = new Date().toISOString();
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const defaultMessages: Record<JobType, string> = {
      draft: 'Drafting story with Gemini 3.8 Flash...',
      direct: 'Directing script and stage directions with Gemini 3.8 Flash...',
      synthesize: 'Synthesizing multi-speaker speech audio with Gemini 3.8 Flash TTS...',
    };

    const defaultStages: Record<JobType, string> = {
      draft: 'drafting',
      direct: 'directing',
      synthesize: 'synthesizing',
    };

    const job: JobProgress = {
      job_id: jobId,
      story_id: storyId,
      type,
      status: 'running',
      started_at: startedAt,
      elapsed_seconds: 0,
      message: initialMessage || defaultMessages[type],
      error: null,
      title: meta?.title,
      stage: meta?.stage || defaultStages[type],
    };

    this.jobs.set(jobId, job);

    if (autoPersist && this.storage) {
      this.saveJobToHistory(job).catch((err) => {
        console.warn(`[JobManager] Failed to persist job ${jobId} to jobs.json:`, err);
      });
      if (storyId && storyId !== 'new' && storyId !== 'draft') {
        this.persistJobStart(jobId).catch((err) => {
          console.warn(`[JobManager] Failed to persist active_job start for story ${storyId}:`, err);
        });
      }
    }

    return { ...job };
  }

  async persistJobStart(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !this.storage) return;

    // Always persist the running job to jobs.json
    await this.saveJobToHistory(job);

    if (!job.story_id || job.story_id === 'new' || job.story_id === 'draft') return;

    const summary: ActiveJobSummary = {
      job_id: job.job_id,
      type: job.type,
      started_at: job.started_at,
    };
    await this.persistStoryActiveJob(job.story_id, summary);
  }

  /**
   * Updates an existing job's progress.
   * If the job transitions to completed or failed, automatically records finished_at,
   * updates stage, persists to jobs.json, and clears active_job in storage.
   */
  updateJob(jobId: string, patch: Partial<JobProgress>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (patch.status && patch.status !== 'running') {
      const started = new Date(job.started_at).getTime();
      job.elapsed_seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    }

    if (patch.status === 'completed' || patch.status === 'failed') {
      if (!patch.finished_at && !job.finished_at) {
        patch.finished_at = new Date().toISOString();
      }
      patch.stage = patch.stage ?? patch.status;
    }

    Object.assign(job, patch);

    if (this.storage) {
      this.saveJobToHistory(job).catch((err) => {
        console.warn(`[JobManager] Failed to update job ${jobId} in jobs.json:`, err);
      });
    }

    if (job.status === 'completed' || job.status === 'failed') {
      if (this.storage) {
        if (job.story_id && job.story_id !== 'new' && job.story_id !== 'draft') {
          this.persistStoryActiveJob(job.story_id, null).catch((err) => {
            console.warn(`[JobManager] Failed to clear active_job for story ${job.story_id}:`, err);
          });
        }
        if (
          job.result_story_id &&
          job.result_story_id !== job.story_id &&
          job.result_story_id !== 'new' &&
          job.result_story_id !== 'draft'
        ) {
          this.persistStoryActiveJob(job.result_story_id, null).catch((err) => {
            console.warn(
              `[JobManager] Failed to clear active_job for result story ${job.result_story_id}:`,
              err
            );
          });
        }
      }
    }
  }

  /**
   * Asynchronous update that awaits storage persistence when updating jobs.json and clearing active_job.
   */
  async updateJobAsync(jobId: string, patch: Partial<JobProgress>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (patch.status && patch.status !== 'running') {
      const started = new Date(job.started_at).getTime();
      job.elapsed_seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    }

    if (patch.status === 'completed' || patch.status === 'failed') {
      if (!patch.finished_at && !job.finished_at) {
        patch.finished_at = new Date().toISOString();
      }
      patch.stage = patch.stage ?? patch.status;
    }

    Object.assign(job, patch);

    if (this.storage) {
      await this.saveJobToHistory(job);
    }

    if (job.status === 'completed' || job.status === 'failed') {
      if (this.storage) {
        if (job.story_id && job.story_id !== 'new' && job.story_id !== 'draft') {
          await this.persistStoryActiveJob(job.story_id, null);
        }
        if (
          job.result_story_id &&
          job.result_story_id !== job.story_id &&
          job.result_story_id !== 'new' &&
          job.result_story_id !== 'draft'
        ) {
          await this.persistStoryActiveJob(job.result_story_id, null);
        }
      }
    }
  }

  /**
   * Reconciles stale running jobs on startup or crash recovery:
   * 1. Any job in jobs.json with status === 'running' whose job_id is NOT actively running in this.jobs
   *    is marked failed with an interrupted message, and story.active_job is cleared.
   * 2. Any catalog item with active_job not running in this.jobs is cleared.
   */
  async reconcileStaleJobs(): Promise<number> {
    if (!this.storage) return 0;
    let reconciledCount = 0;
    const now = new Date().toISOString();

    // 1. Reconcile jobs.json
    try {
      await this.storage.updateJsonAtomic<JobProgress[]>(
        'jobs.json',
        (current) => {
          if (!Array.isArray(current)) return [];
          const list = [...current];
          for (let i = 0; i < list.length; i++) {
            const j = list[i];
            if (j.status === 'running') {
              const liveJob = this.jobs.get(j.job_id);
              if (!liveJob || liveJob.status !== 'running') {
                const started = new Date(j.started_at).getTime();
                const elapsed = isNaN(started)
                  ? j.elapsed_seconds || 0
                  : Math.max(0, Math.floor((Date.now() - started) / 1000));
                list[i] = {
                  ...j,
                  status: 'failed',
                  stage: 'failed',
                  finished_at: now,
                  elapsed_seconds: elapsed,
                  message: 'Interrupted by server restart',
                  error: 'Generation was interrupted by a server restart. Please try again.',
                };
                reconciledCount++;
              }
            }
          }
          return list;
        },
        []
      );
    } catch (err) {
      if (!(err instanceof StorageNotFoundError)) {
        console.warn('[JobManager] Error reconciling jobs.json:', err);
      }
    }

    // 2. Clear stale active_job references in catalog.json and story.json
    try {
      const staleStoryIds: string[] = [];
      await this.storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          if (!Array.isArray(current)) return [];
          const list = [...current];
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item && item.active_job) {
              const liveJob = this.jobs.get(item.active_job.job_id);
              if (!liveJob || liveJob.status !== 'running') {
                list[i] = { ...item, active_job: null };
                staleStoryIds.push(item.id);
              }
            }
          }
          return list;
        },
        []
      );

      for (const storyId of staleStoryIds) {
        try {
          const story = await this.storage.getStory(storyId);
          if (story.active_job) {
            story.active_job = null;
            await this.storage.saveStory(story);
          }
        } catch (err) {
          if (!(err instanceof StorageNotFoundError)) {
            console.warn(`[JobManager] Failed to clear story active_job for ${storyId}:`, err);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof StorageNotFoundError)) {
        console.warn('[JobManager] Error reconciling catalog.json active_job:', err);
      }
    }

    return reconciledCount;
  }

  /**
   * Gracefully marks running jobs as interrupted when server shuts down / restarts.
   */
  async markRunningJobsInterrupted(reason = 'Server shutting down'): Promise<number> {
    const now = new Date().toISOString();
    let interruptedCount = 0;
    const interruptedJobs: JobProgress[] = [];

    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        const started = new Date(job.started_at).getTime();
        job.elapsed_seconds = isNaN(started)
          ? job.elapsed_seconds
          : Math.max(0, Math.floor((Date.now() - started) / 1000));
        job.status = 'failed';
        job.stage = 'failed';
        job.finished_at = now;
        job.message = reason;
        job.error = reason;
        interruptedCount++;
        interruptedJobs.push({ ...job });

        if (this.storage && job.story_id && job.story_id !== 'new' && job.story_id !== 'draft') {
          this.persistStoryActiveJob(job.story_id, null).catch(() => {});
        }
        if (
          this.storage &&
          job.result_story_id &&
          job.result_story_id !== job.story_id &&
          job.result_story_id !== 'new' &&
          job.result_story_id !== 'draft'
        ) {
          this.persistStoryActiveJob(job.result_story_id, null).catch(() => {});
        }
      }
    }

    if (this.storage && interruptedJobs.length > 0) {
      await this.enqueuePersist(async () => {
        await this.storage!.updateJsonAtomic<JobProgress[]>(
          'jobs.json',
          (current) => {
            const list = Array.isArray(current) ? [...current] : [];
            for (const ij of interruptedJobs) {
              const idx = list.findIndex((j) => j.job_id === ij.job_id);
              if (idx >= 0) {
                list[idx] = { ...list[idx], ...ij };
              } else {
                list.unshift({ ...ij });
              }
            }
            return list.slice(0, MAX_PERSISTED_JOBS);
          },
          []
        );
      });
    }

    return interruptedCount;
  }

  /**
   * Helper to safely read persisted jobs from jobs.json via updateJsonAtomic.
   */
  private async readPersistedJobs(): Promise<JobProgress[]> {
    if (!this.storage) return [];
    try {
      return await this.storage.updateJsonAtomic<JobProgress[]>(
        'jobs.json',
        (current) => (Array.isArray(current) ? current : []),
        []
      );
    } catch (err) {
      if (!(err instanceof StorageNotFoundError)) {
        console.warn('[JobManager] Failed to read jobs.json:', err);
      }
      return [];
    }
  }

  /**
   * Retrieves a job by ID, dynamically recalculating elapsed seconds if currently running.
   */
  getJob(jobId: string): JobProgress | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (job.status === 'running') {
      const started = new Date(job.started_at).getTime();
      job.elapsed_seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    }

    return { ...job };
  }

  /**
   * Retrieves a job by checking in-memory jobs first, then falling back to jobs.json.
   */
  async getJobAsync(jobId: string): Promise<JobProgress | null> {
    const liveJob = this.getJob(jobId);
    if (liveJob) return liveJob;

    if (this.storage) {
      const persisted = await this.readPersistedJobs();
      const found = persisted.find((j) => j && j.job_id === jobId);
      if (found) {
        const jobCopy = { ...found };
        if (jobCopy.status === 'running') {
          const started = new Date(jobCopy.started_at).getTime();
          jobCopy.elapsed_seconds = isNaN(started)
            ? jobCopy.elapsed_seconds || 0
            : Math.max(0, Math.floor((Date.now() - started) / 1000));
        }
        return jobCopy;
      }
    }

    return null;
  }

  /**
   * Returns recent job history merging in-memory state with jobs.json,
   * sorted newest first and pruned beyond 24 hours.
   */
  async getRecentJobs(limit = 20): Promise<JobProgress[]> {
    const mergedMap = new Map<string, JobProgress>();
    const now = Date.now();
    const cutoff = now - JOB_HISTORY_TTL_MS;

    // Load persisted history from jobs.json
    if (this.storage) {
      const persisted = await this.readPersistedJobs();
      for (const j of persisted) {
        if (j && j.job_id) {
          const started = new Date(j.started_at).getTime();
          if (isNaN(started) || started > cutoff) {
            mergedMap.set(j.job_id, { ...j });
          }
        }
      }
    }

    // Overlay live in-memory jobs (more up-to-date)
    for (const job of this.jobs.values()) {
      const started = new Date(job.started_at).getTime();
      if (isNaN(started) || started > cutoff) {
        const copy = { ...job };
        if (copy.status === 'running') {
          copy.elapsed_seconds = isNaN(started)
            ? copy.elapsed_seconds
            : Math.max(0, Math.floor((now - started) / 1000));
        }
        mergedMap.set(copy.job_id, copy);
      }
    }

    const sorted = Array.from(mergedMap.values()).sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );

    return sorted.slice(0, limit);
  }

  /**
   * Dismisses a completed or failed job from both in-memory map and jobs.json.
   * Throws ConflictError (409) if the job is still running.
   */
  async dismissJob(jobId: string): Promise<boolean> {
    const live = this.jobs.get(jobId);
    if (live && live.status === 'running') {
      throw new ConflictError(`Cannot dismiss a running job: "${jobId}"`);
    }

    let found = false;
    if (live) {
      this.jobs.delete(jobId);
      found = true;
    }

    if (this.storage) {
      await this.enqueuePersist(async () => {
        await this.storage!.updateJsonAtomic<JobProgress[]>(
          'jobs.json',
          (current) => {
            if (!Array.isArray(current)) return [];
            const existing = current.find((j) => j.job_id === jobId);
            if (existing) {
              if (existing.status === 'running') {
                throw new ConflictError(`Cannot dismiss a running job: "${jobId}"`);
              }
              found = true;
              return current.filter((j) => j.job_id !== jobId);
            }
            return current;
          },
          []
        );
      });
    }

    return found;
  }

  /**
   * Finds the active running job for a given storyId, or null if none is running.
   */
  getActiveJobForStory(storyId: string): JobProgress | null {
    for (const job of this.jobs.values()) {
      if (
        job.status === 'running' &&
        (job.story_id === storyId || job.result_story_id === storyId)
      ) {
        const started = new Date(job.started_at).getTime();
        job.elapsed_seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
        return { ...job };
      }
    }
    return null;
  }

  /**
   * Returns all active running jobs, optionally filtered by storyId.
   */
  getActiveJobs(storyId?: string): JobProgress[] {
    const active: JobProgress[] = [];
    const now = Date.now();

    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        const started = new Date(job.started_at).getTime();
        job.elapsed_seconds = Math.max(0, Math.floor((now - started) / 1000));

        if (!storyId || job.story_id === storyId || job.result_story_id === storyId) {
          active.push({ ...job });
        }
      }
    }

    return active;
  }

  /**
   * Prunes completed or failed jobs older than 15 minutes.
   * Also cleans up stale running jobs older than 60 minutes.
   */
  cleanupOldJobs(): number {
    const now = Date.now();
    let prunedCount = 0;

    for (const [id, job] of this.jobs.entries()) {
      const started = new Date(job.started_at).getTime();
      const ageMs = now - started;

      if ((job.status === 'completed' || job.status === 'failed') && ageMs > JOB_PRUNE_TTL_MS) {
        this.jobs.delete(id);
        prunedCount++;
      } else if (job.status === 'running' && ageMs > 60 * 60 * 1000) {
        // Stale running job safety cleanup
        this.jobs.delete(id);
        prunedCount++;
      }
    }

    return prunedCount;
  }

  /**
   * Helper to persist or clear story.active_job in story.json and catalog.json.
   */
  async persistStoryActiveJob(storyId: string, summary: ActiveJobSummary | null): Promise<void> {
    if (!this.storage) return;

    try {
      const story = await this.storage.getStory(storyId);
      story.active_job = summary;
      await this.storage.saveStory(story);

      const catalogItem = storyToCatalogItem(story);
      await this.storage.updateJsonAtomic<CatalogItem[]>(
        'catalog.json',
        (current) => {
          const list = current ? [...current] : [];
          const idx = list.findIndex((c) => c.id === story.id);
          if (idx >= 0) {
            list[idx] = catalogItem;
          } else {
            list.unshift(catalogItem);
          }
          return list;
        },
        []
      );
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        // Story does not exist yet (e.g. fresh draft) — ignore gracefully
        return;
      }
      throw err;
    }
  }

  /**
   * Clear all jobs (useful for testing).
   */
  clear(): void {
    this.jobs.clear();
  }
}

export const defaultJobManager = new JobManager();
