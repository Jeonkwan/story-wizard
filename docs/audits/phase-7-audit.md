# Phase 7 Engineering Audit Report: Zero-DB Asynchronous Job Manager & Refresh-Resilient Generation State

> **Target Audience:** Lead Architect / Senior Reviewing Agent  
> **Milestone:** Phase 7 (Zero-DB Asynchronous Job Manager & Refresh-Resilient Generation State)  
> **Repository:** `/home/ubuntu/story-wizard`  
> **Status:** All Phase 7 Objectives & Verification Criteria 100% Complete & Passing (104/104 Unit & Integration Tests Green across 8 Test Files, 8/8 Headless Chromium Playwright E2E Tests Green, 2/2 High-Resolution Visual Checkpoint Screenshots Captured, Zero Unhandled Exceptions, Zero Stale Jobs, NodeNext Native ESM Build Verified)

---

## 1. Executive Summary & Verification Matrix

Phase 7 resolves a critical usability and network vulnerability in long-running AI operations (Story Drafting ~10s, Vocal Directing ~8s, and TTS Audio Synthesis 20–60s). Previously, these ran over synchronous HTTP sockets. If a user refreshed the page, switched apps on an iPhone, or encountered a brief connection drop, the browser aborted the fetch socket. The UI state reset to idle, misleading the user into believing generation had failed or prompting them to click submit again.

Phase 7 establishes a lightweight, zero-database in-memory job management architecture paired with persistent catalog/story metadata and client-side lifecycle recovery:

1. **Shared Types (`shared/types.ts`):** Defined `JobType`, `JobStatus`, `JobProgress`, and `ActiveJobSummary`. Extended `Story` and `CatalogItem` with `active_job?: ActiveJobSummary | null` so active generation status survives server restarts and is visible across all sessions.
2. **Backend Job Manager (`server/services/jobManager.ts`):** Lightweight in-memory singleton maintaining active generation tasks in a Node.js `Map<string, JobProgress>`. Computes dynamic `elapsed_seconds` on lookup, prunes completed/failed tasks older than 15 minutes (`JOB_PRUNE_TTL_MS = 900_000`), and synchronizes `story.active_job` in storage when jobs start, complete, or fail.
3. **Admin Story Routes (`server/routes/adminStories.ts`):**
   - Added `GET /api/admin/jobs/active` (with optional `?storyId=...` filter) returning `{ activeJobs: JobProgress[] }`.
   - Added `GET /api/admin/jobs/:jobId` returning `{ job: JobProgress }` with status and elapsed timing.
   - Added `?async=true` query parameter support on `POST /stories/write`, `POST /stories/:id/direct`, and `POST /stories/:id/synthesize`, returning `202 Accepted { jobId, status: 'running' }` immediately while executing Gemini generation in the background.
   - Maintained synchronous backward compatibility when `?async=true` is omitted while still registering running jobs in `JobManager`.
4. **Client API & UI Resilience (`client/api/client.ts`, `DirectorStudio.tsx`, `VoiceStudioPanel.tsx`):**
   - Added `fetchActiveJobs()`, `fetchJobStatus()`, and `pollJobUntilComplete()`.
   - On component mount or story selection, `DirectorStudio` and `VoiceStudioPanel` automatically detect running generation tasks from memory or storage.
   - Immediately restores the `.tactile-progress-card` with accurate elapsed seconds from the server.
   - Disables submit buttons, prompt textareas, mode toggles, and character controls to prevent double-submission.
   - Automatically polls `/api/admin/jobs/:jobId` every 1.5s until completion, seamlessly opening the resulting story in the workbench or updating audio versions.

| Component / Feature | Verification Criteria | Status | Evidence / Test |
| :--- | :--- | :--- | :--- |
| **Shared Job Types** | `JobType`, `JobStatus`, `JobProgress`, `ActiveJobSummary`, `active_job` in `Story` & `CatalogItem` | **PASS** | `shared/types.ts`, `typecheck` |
| **In-Memory Job Manager** | Zero-DB singleton, dynamic elapsed timing, 15-min TTL pruning, storage synchronization | **PASS** | `tests/jobManager.test.ts` (7/7 tests) |
| **Active & Status Endpoints** | `GET /api/admin/jobs/active`, `GET /api/admin/jobs/:id` with 404 handling | **PASS** | `tests/pipelineApi.test.ts` |
| **Async Drafting & Directing** | `POST /stories/write?async=true` and `POST /stories/:id/direct?async=true` return `202 Accepted` | **PASS** | `tests/pipelineApi.test.ts` |
| **Async Synthesis** | `POST /stories/:id/synthesize?async=true` returns `202 Accepted` and updates audio versions | **PASS** | `tests/pipelineApi.test.ts` |
| **UI Active Job Recovery** | Mount-time detection restores `.tactile-progress-card`, live timer, and disables controls | **PASS** | `tests/ui.test.tsx` (23/23 tests) |
| **Page Reload Resilience E2E** | Reloading page mid-generation restores progress card with live timer and completes without 2nd click | **PASS** | `tests/e2e/storybook.spec.ts` (8/8 tests) |
| **ESM Production Check** | Native NodeNext compilation (`dist/server/**/*.js`), clean dynamic imports in plain Node 22 | **PASS** | `tests/esm-build.test.ts` |
| **Visual Checkpoint Screenshots** | 2 high-res Phase 7 screenshots captured to `qa-screenshots/` | **PASS** | `phase7-active-job-recovery.png`, `phase7-workbench-completed.png` |

---

## 2. Technical Blueprint & Architecture

### 2.1 Shared Types (`shared/types.ts`)
```ts
export type JobType = 'draft' | 'direct' | 'synthesize';
export type JobStatus = 'running' | 'completed' | 'failed';

export interface JobProgress {
  job_id: string;
  story_id: string;
  type: JobType;
  status: JobStatus;
  started_at: string;
  elapsed_seconds: number;
  message?: string;
  result_story_id?: string;
  error?: string | null;
}

export interface ActiveJobSummary {
  job_id: string;
  type: JobType;
  started_at: string;
}

export interface Story {
  // ...
  active_job?: ActiveJobSummary | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogItem {
  // ...
  active_job?: ActiveJobSummary | null;
}
```

### 2.2 Backend Job Manager (`server/services/jobManager.ts`)
The `JobManager` operates entirely in memory using a native Node.js `Map<string, JobProgress>`. No database tables, background message brokers, or external dependencies are introduced:
- `createJob(type, storyId, initialMessage, autoPersist)`: Generates `job_${Date.now()}_${rand}` slug, stores in `Map`, and synchronizes storage.
- `updateJob(jobId, patch)` & `updateJobAsync(jobId, patch)`: Mutates job status, freezes elapsed time upon completion/failure, and clears storage `story.active_job`.
- `getJob(jobId)`: Computes `elapsed_seconds` dynamically via `Math.floor((Date.now() - new Date(started_at).getTime()) / 1000)`.
- `getActiveJobs(storyId?)`: Filters running tasks, supporting query filtering by story slug.
- `cleanupOldJobs()`: Prunes completed or failed jobs older than 15 minutes (`ageMs > 900_000`).

### 2.3 Storage Synchronization
When an asynchronous generation task starts on an existing story (directing or synthesis), `story.active_job` is updated with `{ job_id, type, started_at }` and saved to `story.json` and `catalog.json`. When the task completes or fails, `story.active_job` is cleared to `null`. If the server process restarts, the persistent metadata confirms an active job was running and prevents state desynchronization.

### 2.4 Client API & Polling Loop (`client/api/client.ts`)
```ts
export async function pollJobUntilComplete(
  jobId: string,
  onProgress?: (job: JobProgress) => void,
  pollIntervalMs = 1500
): Promise<JobProgress> {
  while (true) {
    const job = await fetchJobStatus(jobId);
    if (onProgress) {
      onProgress(job);
    }
    if (job.status === 'completed') {
      return job;
    }
    if (job.status === 'failed') {
      throw new Error(job.error || job.message || `Job ${jobId} failed`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
```

### 2.5 UI Restoration Flow (`DirectorStudio.tsx` & `VoiceStudioPanel.tsx`)
```mermaid
sequenceDiagram
    autonumber
    actor User as User / iPhone Safari
    participant Client as DirectorStudio UI
    participant API as Express API (/api/admin)
    participant JM as JobManager (Memory + Storage)

    User->>Client: Clicks "1. Write Story Draft"
    Client->>API: POST /api/admin/stories/write?async=true
    API->>JM: createJob('draft', 'new')
    API-->>Client: 202 Accepted { jobId: "job_123", status: "running" }
    Note over Client: Displays .tactile-progress-card (0s)<br/>Disables inputs & buttons

    User->>Client: Refreshes Page (Cmd+R or App Switch)
    Note over Client: Page Reloads (Cold State)
    Client->>API: GET /api/admin/jobs/active
    API->>JM: getActiveJobs()
    API-->>Client: { activeJobs: [{ job_id: "job_123", status: "running", elapsed_seconds: 6 }] }

    Note over Client: RESTORES .tactile-progress-card (6s)<br/>Disables inputs & buttons immediately!
    loop Every 1.5s
        Client->>API: GET /api/admin/jobs/job_123
        API-->>Client: { job: { status: "running", elapsed_seconds: 8 } }
    end

    Note over API: Gemini drafting finishes
    API->>JM: updateJob("job_123", { status: "completed", result_story_id: "2026-11-04-sleepy-little-train" })

    Client->>API: GET /api/admin/jobs/job_123
    API-->>Client: { job: { status: "completed", result_story_id: "2026-11-04-sleepy-little-train" } }
    Client->>API: GET /api/stories/2026-11-04-sleepy-little-train
    API-->>Client: Returns drafted Story
    Note over Client: Loads workbench automatically!<br/>Zero double-clicks required.
```

---

## 3. Automated Verification Results

### 3.1 Unit & Integration Test Suite (`npm test`)
```
 RUN  v3.2.7 /home/ubuntu/story-wizard

 ✓ tests/wav.test.ts (6 tests) 12ms
 ✓ tests/validators.test.ts (19 tests) 28ms
 ✓ tests/jobManager.test.ts (7 tests) 155ms
 ✓ tests/ttsSynthesis.test.ts (6 tests) 383ms
 ✓ tests/storageAndAuth.test.ts (30 tests) 444ms
 ✓ tests/pipelineApi.test.ts (12 tests) 522ms
 ✓ tests/ui.test.tsx (23 tests) 1514ms
 ✓ tests/esm-build.test.ts (1 test) 4192ms
   ✓ Native Node ESM Build Verification > compiles with tsconfig.server.json and dynamically imports server modules in plain node (4190ms)

 Test Files  8 passed (8)
      Tests  104 passed (104)
   Duration  4.88s
```

### 3.2 Native Production ESM Build Verification
- Verified TypeScript compilation under `"module": "NodeNext", "moduleResolution": "NodeNext"` with `npx tsc -p tsconfig.server.json`.
- Verified native Node.js dynamic import of compiled ESM modules in `dist/server/**/*.js` (`tests/esm-build.test.ts` passed).

### 3.3 Playwright E2E Test Suite (`npm run test:e2e`)
```
Running 8 tests using 1 worker

  ✓ 1 [chromium] › tests/e2e/qa-phase5.spec.ts:47:3 › verifies desktop/mobile viewports, light/dark themes, typography tokens, filtering, and captures library screenshots (1.6s)
  ✓ 2 [chromium] › tests/e2e/qa-phase5.spec.ts:198:3 › verifies reader drop-cap, dialogue badges, vocal tag stripping, docked player track info, speed toggle, 206 scrubbing, and captures screenshots (1.4s)
  ✓ 3 [chromium] › tests/e2e/qa-phase5.spec.ts:396:3 › verifies dev bypass login, turn editing, tag insertion, character add/delete, voice preview, casting toggle, version controls, and captures admin screenshots (7.5s)
  ✓ 4 [chromium] › tests/e2e/storybook.spec.ts:30:3 › renders catalog, filters stories, opens formatted reader, scrubs audio, and captures screenshots (2.3s)
  ✓ 5 [chromium] › tests/e2e/storybook.spec.ts:189:3 › logs into admin studio, edits story turn with quick tag, saves script, checks dark mode & mobile layout, and captures screenshot (6.0s)
  ✓ 6 [chromium] › tests/e2e/storybook.spec.ts:304:3 › verifies VoiceStudioPanel in admin workbench (Solo vs Cast toggle, Bibi character voice selector, existing version controls, Dark Mode, mobile layout) and captures screenshot (3.5s)
  ✓ 7 [chromium] › tests/e2e/storybook.spec.ts:412:3 › verifies compact mobile audio player (<70px height, 85px padding), genre freedom presets, and generation UX (4.6s)
  ✓ 8 [chromium] › tests/e2e/storybook.spec.ts:549:3 › Phase 7 Zero-DB Asynchronous Job Manager & Refresh Resilience: page reload mid-generation restores progress card and completes automatically (4.0s)

  8 passed (34.3s)
```

---

## 4. Visual Verification Checkpoints

The Playwright test suite captured two new high-resolution screenshots into `qa-screenshots/`:

1. **`qa-screenshots/phase7-active-job-recovery.png` (123 KB):**
   Demonstrates that immediately upon refreshing the page mid-generation, `DirectorStudio` restores the active generation status card with the running timer (`Drafting story with Gemini 3.8 Flash... 6s`), disables all prompt inputs, genre preset pills, series slug fields, and submit buttons (`Writing Draft... (6s)`), and locks down the interface against duplicate submissions.
2. **`qa-screenshots/phase7-workbench-completed.png` (143 KB):**
   Demonstrates that once the background polling loop receives `status: 'completed'`, the studio automatically dismisses the progress card, refreshes the stories sidebar, and transitions to the story workbench (`Story Metadata`, `Turn-by-Turn Script`, and `Voice Studio Panel`) with zero secondary clicks or lost state.

---

## 5. Technical Guardrail Audit

- **Zero Over-Engineering:** No database (Postgres/SQLite/Redis), no BullMQ/RabbitMQ queues, no foreign services. In-memory `Map` with automatic 15-minute pruning fulfills all requirements.
- **ESM Relative Imports:** All imports in `server/**` and `shared/**` use explicit `.js` extensions (`import { JobManager } from '../services/jobManager.js'`).
- **Gemini 3.8 Multi-Speaker Exact-2 Rule:** Multi-speaker casting and single-speaker fallback rules strictly preserved.
- **Git Discipline:** `.env`, `node_modules/`, `dist/`, `data/`, and `qa-screenshots/` excluded from git commits.
- **Single Audit Path:** Audit report strictly located at `docs/audits/phase-7-audit.md`.

---

## 6. Conclusion & Handoff Recommendation

Phase 7 is **100% complete, verified, and production-ready**. All unit tests, integration tests, E2E tests, ESM compilation checks, and visual audits pass without error. Ready for Lead Architect review.
