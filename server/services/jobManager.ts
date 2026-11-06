import type {
  JobType,
  JobProgress,
  ActiveJobSummary,
  CatalogItem,
} from '../../shared/types.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { StorageNotFoundError } from '../storage/storageAdapter.js';
import { storyToCatalogItem } from './geminiStory.js';

export const JOB_PRUNE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class JobManager {
  private jobs: Map<string, JobProgress> = new Map();
  private storage?: StorageAdapter;

  constructor(storage?: StorageAdapter) {
    this.storage = storage;
  }

  setStorage(storage: StorageAdapter): void {
    this.storage = storage;
  }

  /**
   * Creates a new running job and registers it in-memory.
   * If a storage adapter is bound and storyId is not a placeholder,
   * asynchronously persists active_job in story and catalog metadata.
   */
  createJob(type: JobType, storyId: string, initialMessage?: string, autoPersist = true): JobProgress {
    const startedAt = new Date().toISOString();
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const defaultMessages: Record<JobType, string> = {
      draft: 'Drafting story with Gemini 3.8 Flash...',
      direct: 'Directing script and stage directions with Gemini 3.8 Flash...',
      synthesize: 'Synthesizing multi-speaker speech audio with Gemini 3.8 Flash TTS...',
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
    };

    this.jobs.set(jobId, job);

    if (autoPersist && this.storage && storyId && storyId !== 'new' && storyId !== 'draft') {
      this.persistJobStart(jobId).catch((err) => {
        console.warn(`[JobManager] Failed to persist active_job start for story ${storyId}:`, err);
      });
    }

    return { ...job };
  }

  async persistJobStart(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !this.storage) return;
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
   * If the job transitions to completed or failed, clears active_job in storage.
   */
  updateJob(jobId: string, patch: Partial<JobProgress>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (patch.status && patch.status !== 'running') {
      const started = new Date(job.started_at).getTime();
      job.elapsed_seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    }

    Object.assign(job, patch);

    if (job.status === 'completed' || job.status === 'failed') {
      if (this.storage && job.story_id && job.story_id !== 'new' && job.story_id !== 'draft') {
        this.persistStoryActiveJob(job.story_id, null).catch((err) => {
          console.warn(`[JobManager] Failed to clear active_job for story ${job.story_id}:`, err);
        });
      }
    }
  }

  /**
   * Asynchronous update that awaits storage persistence when completing/failing.
   */
  async updateJobAsync(jobId: string, patch: Partial<JobProgress>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (patch.status && patch.status !== 'running') {
      const started = new Date(job.started_at).getTime();
      job.elapsed_seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    }

    Object.assign(job, patch);

    if (job.status === 'completed' || job.status === 'failed') {
      if (this.storage && job.story_id && job.story_id !== 'new' && job.story_id !== 'draft') {
        await this.persistStoryActiveJob(job.story_id, null);
      }
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
   * Finds the active running job for a given storyId, or null if none is running.
   */
  getActiveJobForStory(storyId: string): JobProgress | null {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && (job.story_id === storyId || job.result_story_id === storyId)) {
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
