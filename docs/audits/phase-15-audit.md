# Phase 15 Engineering Audit Report: Fire-and-Go Background Generation, Durable Job History, Activity Tray & Cloud Run `--no-cpu-throttling`

> **Target Audience:** Lead Architect / Senior Reviewing Agent  
> **Milestone:** Phase 15 (Fire-and-Go Background Generation, Durable Job History, Activity Tray & Cloud Run `--no-cpu-throttling`)  
> **Repository:** `/home/ubuntu/story-wizard` (`c:\Users\m93\projects\story-wizard`)  
> **Status:** All Phase 15 Objectives & Verification Criteria 100% Complete & Passing (268/268 Unit & Integration Tests Green across 14 Vitest Test Files, 14/14 Playwright E2E Tests Passing, NodeNext Native ESM Build Verified)

---

## 1. Executive Summary & Verification Matrix

Phase 15 transforms Storyteller Studio into a true **fire-and-go background creation environment**. Users can initiate fresh stories, chained multi-stage generations (drafting -> directing -> studio speech synthesis), or audio productions without being forced to keep their browser tab focused or stare at blocking modal progress cards.

All implementation work strictly adheres to project architectural guardrails:
- **Zero Unapproved Dependencies:** Zero new npm packages added. Relies strictly on native Web APIs (Web Notifications API, DOM Events, standard CSS) and existing atomic file storage adapters.
- **NodeNext Native ESM Architecture:** Strict explicit `.js` relative imports across all `server/**` and `shared/**` modules.
- **Atomic Concurrency & Job Durability:** All background jobs are serialized through a single-instance async write queue (`persistQueue`) updating `jobs.json` atomically via `storage.updateJsonAtomic<JobProgress[]>('jobs.json', ...)`.
- **Restart Reconciliation & Graceful Termination:** On server startup or unexpected restarts, orphan running jobs in `jobs.json` are automatically reconciled to `status: 'failed'` (`'Interrupted by server restart'`), clearing stale `active_job` pointers on stories and catalog. Graceful shutdown (`SIGTERM`, `SIGINT`) sets running jobs to `failed` before container exit.
- **Unlocked Navigation & Zero Blocking Dialogs:** All restrictive `beforeunload` interception dialogs have been permanently excised. All navigation buttons (`➕ New Story`, `← Public Library`, `Sequel →`, sidebar story cards) remain completely clickable while generation proceeds in the background.
- **Global Generation Activity Tray:** A compact, responsive Activity bar (`data-testid="generation-activity-tray"`) tracks running, completed, and failed jobs across stories with live second counters, `Open Story →` workbench loaders, and dismiss `✕` controls.
- **Cloud Run Always-On CPU Execution:** `--no-cpu-throttling` is added to `deploy.sh` so Google Cloud Run container instances allocate full CPU cycles to background timers, HTTP streaming, and audio synthesis even after the initial HTTP 202 response is returned.

### Verification Matrix

| Verification Target | Command | Result | Details |
|---|---|---|---|
| **TypeScript Typecheck (Client & Shared)** | `npm run typecheck` | **PASS (0 errors)** | Strict mode across all client components, hooks, and types |
| **Server ESM Compilation** | `npx tsc -p tsconfig.server.json` | **PASS (0 errors)** | NodeNext ESM compiled cleanly into `dist/server` |
| **Unit & Integration Suite** | `npm test` (`vitest run`) | **PASS (268/268)** | 14 test files passing, including `tests/jobManager.test.ts` (14/14), `tests/pipelineApi.test.ts` (23/23), and `tests/ui.test.tsx` (33/33) |
| **Native Node ESM Verification** | `tests/esm-build.test.ts` | **PASS (1/1)** | Dynamic native Node ESM import under plain `node` |
| **Playwright E2E Suite** | `npm run build && npx playwright test` | **PASS (14/14)** | All 14 E2E test specs green, including `storybook.spec.ts` (6/6) and `qa-phase15.spec.ts` (1/1) |
| **Cloud Run Deployment Flag** | `tests/deploymentConfig.test.ts` | **PASS (27/27)** | Verified `--no-cpu-throttling` present in `deploy.sh` deployment arguments |
| **Visual QA Screenshots** | Headless Browser Captures | **PASS (3/3 captured)** | `qa-screenshots/phase15-*.png` generated with correct viewport bounds, contrast, and layout |

---

## 2. Key Deliverables & Implementation Details

### 2.1 Backend Durable Job History & Restart Reconciliation (`server/services/jobManager.ts`)
- **Constants & History Windows:**
  - Exported `MAX_PERSISTED_JOBS = 30` (maximum jobs retained in `jobs.json`).
  - Exported `JOB_HISTORY_TTL_MS = 24 * 60 * 60 * 1000` (24-hour retention window for job history).
  - Maintained `JOB_PRUNE_TTL_MS = 15 * 60 * 1000` (15-minute in-memory cleanup for backward compatibility with existing unit tests).
- **Serialized Atomic Persistence Queue:**
  - Added `persistQueue: Promise<void>` promise chain to serialize concurrent updates to `jobs.json`, preventing race conditions during rapid multi-stage generation updates (`createJob`, `updateJob`, `dismissJob`).
  - Implemented `readPersistedJobs()` helper using `this.storage.updateJsonAtomic<JobProgress[]>('jobs.json', (current) => (Array.isArray(current) ? current : []), [])`.
- **Job Creation & State Transitions:**
  - Extended `createJob(type, storyId, initialMessage?, autoPersist?, meta?: { title?: string; stage?: string })` to accept optional metadata (`title`, `stage`).
  - In `updateJob` / `updateJobAsync`: Automatically sets `finished_at` (ISO timestamp) and updates `stage: patch.stage ?? patch.status` whenever a job transitions to `'completed'` or `'failed'`. If the job was tracking an active story, clears `story.active_job = null` in storage.
- **Server Restart Reconciliation (`reconcileStaleJobs()`):**
  - Scans `jobs.json` on startup.
  - Any job marked `status: 'running'` whose `job_id` is not actively executing in `this.jobs` is updated in `jobs.json` to:
    - `status: 'failed'`
    - `stage: 'failed'`
    - `finished_at: new Date().toISOString()`
    - `message: 'Interrupted by server restart'`
    - `error: 'Generation was interrupted by a server restart. Please try again.'`
    - Clears `active_job = null` on the associated `story.json` and in `catalog.json`.
  - Reconciles orphan `active_job` pointers across `catalog.json` items whose jobs are no longer running.
- **Graceful Shutdown Interruption (`markRunningJobsInterrupted()`):**
  - Iterates over all currently running in-memory jobs and transitions them to `status: 'failed'` (`stage: 'failed'`, `finished_at`, `error: reason`).
  - Persists updates to `jobs.json` and clears story `active_job` pointers before server exit.
- **Recent Jobs & Dismissal:**
  - `getRecentJobs(limit = 20)`: Merges live in-memory jobs with persisted `jobs.json` entries, recalculates live `elapsed_seconds` for active jobs, prunes expired (>24h) jobs, and sorts newest first (`started_at` descending).
  - `getJobAsync(jobId)`: Checks in-memory cache then falls back to `jobs.json`.
  - `dismissJob(jobId)`: Removes completed or failed jobs from both in-memory cache and `jobs.json`. Throws `ConflictError` (HTTP 409) if the job is currently `'running'`.

### 2.2 Server App Lifecycles & API Routes (`server/app.ts`, `server/index.ts`, `server/routes/adminStories.ts`)
- **Server Lifecycle Hooking (`server/app.ts`, `server/index.ts`):**
  - Connected `jobManager.setStorage(storage)` during app factory initialization.
  - Invoked `await defaultJobManager.reconcileStaleJobs()` during server startup in `server/index.ts`.
  - Registered graceful shutdown listeners on `SIGTERM` and `SIGINT` invoking `markRunningJobsInterrupted('Interrupted by server shutdown/deploy')` before closing the HTTP server.
- **Admin Job Endpoints (`server/routes/adminStories.ts`):**
  - `GET /api/admin/jobs`: Returns `{ jobs: JobProgress[] }` with up to 20 recent jobs.
  - `GET /api/admin/jobs/:jobId`: Asynchronously looks up job from memory or `jobs.json`; returns 404 if not found.
  - `DELETE /api/admin/jobs/:jobId`: Dismisses a completed or failed job; returns 409 Conflict if job is currently running.
- **Pipeline Stage Tracking in Story Routes:**
  - `POST /api/admin/stories/write`: Passes prompt preview as `title` and `stage: 'drafting'` to `createJob`. Immediately upon draft completion, updates job with `currentStory.title`, `story_id`, and `result_story_id`. Dynamically tracks `stage: 'directing'` and `stage: 'synthesizing'` while keeping `active_job` synced in `catalog.json`.
  - `POST /api/admin/stories/:id/direct`: Looks up story title and updates job with `stage: 'directing'`.
  - `POST /api/admin/stories/:id/synthesize`: Looks up story title and updates job with `stage: 'synthesizing'`.

### 2.3 Frontend Client API & Background Experience (`client/api/client.ts`, `client/components/DirectorStudio.tsx`, `client/components/VoiceStudioPanel.tsx`)
- **Client API (`client/api/client.ts`):**
  - Added `fetchRecentJobs(limit = 20): Promise<JobProgress[]>` (`GET /api/admin/jobs`).
  - Added `dismissJob(jobId: string): Promise<{ ok: boolean }>` (`DELETE /api/admin/jobs/:jobId`).
  - Re-exported `JobProgress` for TypeScript consumers.
- **Excised All `beforeunload` Interceptions:**
  - Completely removed `window.addEventListener('beforeunload', ...)` and `window.removeEventListener('beforeunload', ...)` from both `DirectorStudio.tsx` and `VoiceStudioPanel.tsx`. Users can refresh, switch stories, or close tabs at will without annoying browser blocker prompts.
- **Reassuring Background Progress Copy:**
  - Replaced all obsolete `"Please keep this tab open"` copy with explicit background reassurance:
    `"Running in the background — you can safely switch stories, queue another, or close this tab."`
- **Unlocked Navigation & Queue Another Action:**
  - Excised `disabled={isWriting || isDirecting}` locks from:
    - `➕ New Story` button
    - `← Public Library` button
    - All sidebar story cards and mobile archive drawer story cards
    - `Sequel →` action buttons
  - Directing controls only lock when the currently active story has an active directing job (`isCurrentStoryDirecting`).
  - Added **`➕ Queue Another Story`** button (`data-testid="queue-another-story-btn"`): Clears local form lock and resets prompt inputs so the curator can immediately author another story while the previous one runs in the background.
- **Global Generation Activity Tray (`data-testid="generation-activity-tray"`):**
  - Automatically loads recent jobs on mount and listens for `visibilitychange` events to refresh when the tab becomes active.
  - Polls `/api/admin/jobs` every 2 seconds whenever any job in the list has `status === 'running'`.
  - Collapsible header displaying total count, active running badge, and opt-in **`🔔 Notify me`** button (using Web Notifications API to alert user when jobs complete or fail while backgrounded).
  - Displays tactile status badge (`⏳ Running` / `✓ Ready` / `⚠️ Failed`), story title, stage description, and live elapsed seconds.
  - Completed jobs provide an **`Open Story →`** button that loads the story into the workbench preview and a dismiss **`✕`** button.
  - Failed jobs display the specific error message and a dismiss **`✕`** button.
- **Sidebar & Mobile Drawer Live Indicators:**
  - Displays live badges (`⏳ Drafting...`, `🎬 Directing...`, `🎧 Synthesizing...`) on any story card with an active job.
  - Renders a top synthetic card for in-flight fresh drafts (`story_id === 'new'`) with `⏳ GENERATING` and the draft's working title.
- **VoiceStudioPanel 404 Recovery:**
  - In `VoiceStudioPanel.tsx`, safe error handling detects HTTP 404 (`ApiError(404)`) during synthesis polling (such as after a server restart). Clears poll timers, dismisses the busy progress card, and presents a clear, actionable guidance banner:
    `"Previous synthesis job is no longer active (server may have restarted). You can safely start a new synthesis."`

### 2.4 Cloud Run `--no-cpu-throttling` Flag (`deploy.sh`, `tests/deploymentConfig.test.ts`)
- Added `--no-cpu-throttling` to `DEPLOY_ARGS` in `deploy.sh`.
- Added dry-run command echo to `deploy.sh`.
- Verified in `tests/deploymentConfig.test.ts` (all 27 tests passing) that `deploy.sh` contains `--no-cpu-throttling`.

---

## 3. Visual QA Verification & Screenshots

Three visual artifacts were generated via Playwright headless browser tests and verified in `qa-screenshots/`:

| Screenshot File | Viewport | Theme | Description |
|---|---|---|---|
| `qa-screenshots/phase15-activity-tray-running-dark.png` | 1440x900 | Dark (Espresso) | Studio view with Generation Activity tray tracking in-flight background draft, sidebar showing `⏳ GENERATING` synthetic card, unlocked navigation, and `➕ Queue Another Story` button |
| `qa-screenshots/phase15-activity-tray-completed-light.png` | 1440x900 | Light (Daylight Latte) | Studio workbench view in light mode showing completed job row with `✓ Ready` badge, `Open Story →` button, and dismiss `✕` button |
| `qa-screenshots/phase15-mobile-activity-tray-dark.png` | 375x812 | Dark (Espresso) | Mobile iPhone viewport showing compact responsive layout of the activity tray, running & completed jobs stacked, mobile topbar, and zero horizontal overflow |

---

## 4. Test Suite Execution Summary

### 4.1 Vitest Unit & Integration Suites (`npm test`)
```
 RUN  v3.2.7 /home/ubuntu/story-wizard

 ✓ tests/deploymentConfig.test.ts (27 tests)
 ✓ tests/jobManager.test.ts (14 tests)
 ✓ tests/pipelineApi.test.ts (23 tests)
 ✓ tests/storageAndAuth.test.ts (31 tests)
 ✓ tests/validators.test.ts (19 tests)
 ✓ tests/wav.test.ts (6 tests)
 ✓ tests/ttsSynthesis.test.ts (6 tests)
 ✓ tests/phase9VoiceLifecycle.test.ts (50 tests)
 ✓ tests/phase10MobileAndComposer.test.tsx (19 tests)
 ✓ tests/phase11VoiceStudio.test.tsx (17 tests)
 ✓ tests/phase13FiresideRedesign.test.tsx (8 tests)
 ✓ tests/phase14WorkflowAndSafeArea.test.tsx (14 tests)
 ✓ tests/ui.test.tsx (33 tests)
 ✓ tests/esm-build.test.ts (1 test)

 Test Files  14 passed (14)
      Tests  268 passed (268)
   Duration  7.65s
```

### 4.2 Playwright End-to-End Suite (`npx playwright test`)
```
Running 14 tests using 1 worker

  ✓   1 [chromium] › tests/e2e/qa-phase10.spec.ts:96:3 (5.7s)
  ✓   2 [chromium] › tests/e2e/qa-phase11.spec.ts:115:3 (2.6s)
  ✓   3 [chromium] › tests/e2e/qa-phase13.spec.ts:4:3 (2.7s)
  ✓   4 [chromium] › tests/e2e/qa-phase14.spec.ts:4:3 (2.1s)
  ✓   5 [chromium] › tests/e2e/qa-phase15.spec.ts:4:3 (2.6s)
  ✓   6 [chromium] › tests/e2e/qa-phase5.spec.ts:47:3 (1.4s)
  ✓   7 [chromium] › tests/e2e/qa-phase5.spec.ts:198:3 (1.6s)
  ✓   8 [chromium] › tests/e2e/qa-phase5.spec.ts:402:3 (5.8s)
  ✓   9 [chromium] › tests/e2e/storybook.spec.ts:30:3 (1.1s)
  ✓  10 [chromium] › tests/e2e/storybook.spec.ts:197:3 (3.3s)
  ✓  11 [chromium] › tests/e2e/storybook.spec.ts:317:3 (2.6s)
  ✓  12 [chromium] › tests/e2e/storybook.spec.ts:428:3 (2.4s)
  ✓  13 [chromium] › tests/e2e/storybook.spec.ts:568:3 (4.5s)
  ✓  14 [chromium] › tests/e2e/storybook.spec.ts:717:3 (2.7s)

  14 passed (43.2s)
```

---

## 5. Architectural Compliance & Tagging Notice

- **Architectural Guardrails Checked:**
  - Zero unapproved dependencies added.
  - All NodeNext ESM imports in `server/**` and `shared/**` use explicit `.js` relative specifiers.
  - Strict TypeScript compiler check (`npm run typecheck`, `npx tsc -p tsconfig.server.json`) completed with zero errors or warnings.
  - Zero `.env` secrets logged or committed.
- **Git Milestone Tagging Policy:**
  - As instructed in `AGENTS.md`, the `phase-15-verified` git tag is **NOT** created or moved by this engineering agent. It is left solely to the Lead Architect following independent architectural and visual review.
