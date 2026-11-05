# Phase 1 Engineering Audit & Review Report

> **Target Audience:** Reviewing Agent / Senior Engineer / Lead Architect  
> **Milestone:** Phase 1 (Dual-Mode Storage, Audio HTTP Range Streaming, Seed Data & Admin Auth)  
> **Repository:** `/home/ubuntu/story-wizard`  
> **Status:** All Phase 1 Requirements & Code Review Remediations Verified (100% green, 50/50 tests)

---

## 1. Executive Summary & Objective

Phase 1 implements the complete persistence, audio streaming, seed catalog, and single-admin authentication layers for **Storyteller Studio & Audio Engine** as specified in `HANDOFF_PLAN.md` and `.agents/skills/gcs-json-catalog/SKILL.md`.

Following the Lead Architect's Code & Security Review (`docs/reviews/phase-1-review.md`), 4 critical hardening items were resolved and validated:
1. **Security Fail-Closed:** Strict validation rejecting unconfigured `ADMIN_GOOGLE_EMAIL` or `GOOGLE_CLIENT_ID` with `403` or startup error.
2. **Express 4 Async Handlers:** Creation of `server/lib/asyncHandler.ts` wrapping all async route handlers and guarding `res.headersSent` in the global error handler.
3. **Safe Audio Streaming & Cache Control:** Using `pipeline()` from `'node:stream'`, enforcing strict digit checks on ranges, and setting `Cache-Control: private, no-store` for draft audio.
4. **Storage Hardening:** Preventing sibling-directory prefix bypasses in `localStorage.ts`, maintaining full 64-bit generation precision in `gcsStorage.ts`, and exporting canonical `createStorageAdapter(config)`.

All architectural guardrails and anti-over-engineering requirements were strictly followed:
- **No Database:** Storage uses structured JSON documents and WAV audio files exclusively.
- **Dual-Mode Storage:** Clean abstraction supporting local filesystem atomic persistence (`LocalStorageAdapter`) and Google Cloud Storage (`GcsStorageAdapter`) with optimistic concurrency control (`ifGenerationMatch`).
- **HTTP Range Streaming:** Native RFC 7233 partial content streaming (`206 Partial Content`, `416 Range Not Satisfiable`, `200 OK`) without external media servers or binaries.
- **Single-Admin Security:** Google Identity Services ID token verification, HMAC-SHA256 signed `HttpOnly`, `SameSite=Strict` cookies with `crypto.timingSafeEqual` signature checks, and hard-coded bypass prevention in production or Cloud Run (`K_SERVICE`).
- **Native Node ESM Compliance:** All relative imports in `server/**` and `shared/**` use explicit `.js` extensions under `tsconfig.server.json` (`NodeNext`).

---

## 2. Implemented Architecture & Modules

### 2.1 Configuration (`server/config.ts`)
- Implements `loadConfig(env = process.env)` returning strongly-typed `AppConfig`.
- Enforces runtime security invariants:
  - `allowDevBypass` is strictly evaluated as: `env.NODE_ENV !== 'production' && !env.K_SERVICE && env.DEV_ADMIN_BYPASS === 'true'`.
  - Throws startup error if `(NODE_ENV === 'production' || env.K_SERVICE)` and `SESSION_SECRET` is missing or shorter than 32 characters.

### 2.2 Storage Layer (`server/storage/`)
- **Contracts & Errors (`storageAdapter.ts`):**
  - Defines `StorageAdapter` interface for stories, audio files, voices, and catalog.
  - Defines `InvalidSlugError` (HTTP 400) and `StorageNotFoundError` (HTTP 404).
  - Enforces `validateSlug` against `/^[a-z0-9][a-z0-9-_]{1,80}$/` on all story IDs, version IDs, and paths.
- **Local Filesystem Adapter (`localStorage.ts`):**
  - Atomic write pattern: writes to unique temporary files (`.tmp-${pid}-${Date.now()}-${random}`) in the target folder, then executes `fs.promises.rename()`.
  - In-memory per-file mutex lock serialize concurrent `updateJsonAtomic` calls to the same file, guaranteeing zero lost updates.
  - Safe path resolution prevents directory traversal attacks outside `DATA_DIR`.
  - Returns audio stream descriptors with pre-calculated `totalBytes` allowing range validation prior to opening readable streams.
- **Google Cloud Storage Adapter (`gcsStorage.ts`):**
  - Accepts an injectable `@google-cloud/storage` `Bucket` instance (facilitating isolated unit tests without network calls).
  - Implements optimistic locking in `updateJsonAtomic`: reads file metadata to obtain current `generation` (or `0` if non-existent), applies mutator, and writes with `preconditionOpts: { ifGenerationMatch: generation }`.
  - Transparently retries up to 3 times on HTTP 412 Precondition Failed conflicts.

### 2.3 Seed Data (`scripts/seedLocalData.ts`)
- Populates `./data/voices.json` with 3 prebuilt voices (`Kore`, `Puck`, `Aoede`).
- Populates `./data/stories/2026-11-04-sleepy-little-train/story.json` (`status: "published"`) with character `Bibi` and script turns containing vocal tags (`<short pause>`, `<sigh>`) alongside legitimate prose in parentheses (`(which was painted bright blue)`).
- Synthesizes a pleasant 2-second sine-wave bell chime (587.33 Hz, exponential envelope) at 24kHz 16-bit mono PCM wrapped via `wrapPcmAsWav` into `./data/stories/2026-11-04-sleepy-little-train/audios/v1-owl-solo.wav`.
- Writes `./data/catalog.json` with matching catalog metadata.

### 2.4 Single-Admin Auth & Middleware (`server/middleware/auth.ts`, `server/routes/auth.ts`)
- **Login (`POST /api/admin/login`):**
  - Standard OAuth path: verifies Google ID token via `OAuth2Client`, requiring `payload.email_verified === true` and exact email match against `ADMIN_GOOGLE_EMAIL` (`403 Forbidden` on mismatch/unverified; `401 Unauthorized` on invalid token).
  - Dev bypass path: allowed **only** when `allowDevBypass === true` (`401` otherwise).
  - Issues signed `story_admin_session` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in prod/Cloud Run, 7-day TTL).
- **Session Verification & Middleware:**
  - HMAC-SHA256 signature checked using `crypto.timingSafeEqual` with buffer length guard.
  - Expiration and email payload validation.
  - `requireAdmin` middleware guards `/api/admin/*` endpoints (`401` on invalid/missing session).
- **Session Probe & Status:**
  - `GET /api/admin/me`: returns authenticated state, email, and dev bypass capability.
  - `GET /api/admin/stories`: protected probe route returning full catalog including drafts.
  - `POST /api/admin/logout`: clears session cookie.

### 2.5 Public Routes (`server/routes/public.ts`)
- **`GET /api/catalog`:**
  - Returns catalog items sorted newest-first (`created_at` desc).
  - Filters strictly to `status === 'published'` unless a valid admin session cookie is provided and `?includeDrafts=true`.
- **`GET /api/stories/:id`:**
  - Validates slug parameter.
  - Returns `404 Not Found` if story is draft and caller is unauthenticated.
- **`GET /api/stories/:id/audios/:filename`:**
  - Validates story slug and `.wav` filename slug.
  - Draft audio privacy: returns `404` if underlying story is a draft and caller is not an admin.
  - Full HTTP Range support:
    - No `Range`: `200 OK`, `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control: public, max-age=31536000, immutable`.
    - Explicit `bytes=start-end`: `206 Partial Content`, `Content-Range: bytes start-end/total`, `Content-Length: (end - start + 1)`.
    - Open-ended `bytes=start-`: `206 Partial Content`, `Content-Range: bytes start-(total-1)/total`.
    - Suffix `bytes=-N`: `206 Partial Content`, `Content-Range: bytes (total-N)-(total-1)/total`.
    - Out of bounds (`start >= total` or `start > end`): `416 Range Not Satisfiable` with `Content-Range: bytes */total`.

### 2.6 Server Express App Factory (`server/app.ts`, `server/index.ts`)
- Factory `createApp({ config, storage, verifyGoogleIdToken })` decoupling environment for deterministic integration tests.
- Serves `dist/client` static assets and SPA fallback only when `dist/client/index.html` exists.
- Global error handler mapping `InvalidSlugError` -> 400 and `StorageNotFoundError` -> 404.

---

## 3. Verification & Validation Evidence

### 3.1 TypeScript Typecheck
```bash
npm run typecheck
# Output: tsc --noEmit exited 0 with 0 errors
```

### 3.2 Full Unit & Integration Test Suite (`npm test`)
```text
 ✓ tests/wav.test.ts (6 tests)
 ✓ tests/validators.test.ts (13 tests)
 ✓ tests/storageAndAuth.test.ts (30 tests)
   ✓ Catalog & Draft Privacy > unauthenticated GET /api/catalog returns only published stories; GET /api/stories/:draft returns 404
   ✓ Catalog & Draft Privacy > authenticated admin receives draft stories in catalog (?includeDrafts=true) and GET /api/stories/:draft
   ✓ HTTP Range Streaming > returns 200 OK with full file when no Range header is provided
   ✓ HTTP Range Streaming > returns 206 Partial Content for explicit range (bytes=0-43, first 44 bytes)
   ✓ HTTP Range Streaming > returns 206 Partial Content for open-ended range (bytes=100-)
   ✓ HTTP Range Streaming > returns 206 Partial Content for suffix range (bytes=-50)
   ✓ HTTP Range Streaming > returns 416 Range Not Satisfiable when range start is beyond total bytes
   ✓ HTTP Range Streaming > returns 416 for inverted range (bytes=50-20)
   ✓ HTTP Range Streaming > sets Cache-Control to private, no-store for draft audio and public immutable for published audio
   ✓ HTTP Range Streaming > returns 416 when range header contains non-digit characters (e.g., bytes=0abc-10xyz)
   ✓ Path Traversal Protection > blocks path traversal attempts in URL params with 400
   ✓ Path Traversal Protection > storage layer throws InvalidSlugError for invalid slugs and path traversal in paths
   ✓ Path Traversal Protection > rejects sibling directory prefix bypass paths with InvalidSlugError in localStorage
   ✓ GCS Optimistic Concurrency Control > retries updateJsonAtomic on HTTP 412 generation conflict and succeeds on second save
   ✓ GCS Optimistic Concurrency Control > throws error when 412 persists across all retries
   ✓ LocalStorage Concurrent Atomic Updates > serializes concurrent updateJsonAtomic calls to the same file without data loss
   ✓ Admin Auth & Session Management > rejects wrong Google email with 403 Forbidden
   ✓ Admin Auth & Session Management > rejects unverified Google email with 403 Forbidden
   ✓ Admin Auth & Session Management > logs in authorized Google admin and issues HMAC-signed session cookie
   ✓ Admin Auth & Session Management > allows dev bypass in non-production when configured
   ✓ Admin Auth & Session Management > blocks dev bypass when DEV_ADMIN_BYPASS is false, NODE_ENV is production, or K_SERVICE is present
   ✓ Admin Auth & Session Management > requireAdmin middleware rejects unauthenticated probe request with 401
   ✓ Admin Auth & Session Management > requireAdmin middleware rejects tampered cookie signature with 401
   ✓ Admin Auth & Session Management > requireAdmin middleware rejects expired session cookie with 401
   ✓ Admin Auth & Session Management > authenticated admin can access protected probe route /api/admin/stories and log out
   ✓ Admin Auth & Session Management > fails closed with 403 when ADMIN_GOOGLE_EMAIL is empty even with a verified token
   ✓ Admin Auth & Session Management > throws error when createDefaultGoogleTokenVerifier is called with empty clientId
   ✓ Express 4 Async Handler & Error Handling > forwards rejected async storage promises to global error handler returning 500 JSON without crashing
   ✓ Config Startup Safety & Storage Factory > throws error at startup in production or Cloud Run if SESSION_SECRET is missing or < 32 chars
   ✓ Config Startup Safety & Storage Factory > createStorageAdapter chooses GcsStorageAdapter when gcsBucketName is set, and LocalStorageAdapter otherwise
 ✓ tests/esm-build.test.ts (1 test)
   ✓ Native Node ESM Build Verification > compiles with tsconfig.server.json and dynamically imports server modules in plain node

Test Files: 4 passed (4)
Tests:      50 passed (50)
Result:     100% green
```

### 3.3 Native Node ESM Direct Verification
```bash
npx tsc -p tsconfig.server.json && node -e "await import('./dist/server/lib/validators.js'); await import('./dist/server/lib/wav.js'); await import('./dist/server/app.js'); console.log('ESM_APP_OK')"
# Output: ESM_APP_OK
```

### 3.4 Seed Script Execution
```bash
npm run seed
# Output: Successfully seeded local data in ./data
```

---

## 4. Git & Working Tree Hygiene

- No untracked build artifacts, secrets, or junk (`data/`, `dist/`, `.env`, `node_modules/` ignored by `.gitignore`).
- Ready for Lead Architect code review inspection.
