# Phase 1 Architectural & Security Review (`b6b91ad`)

> **Reviewed By:** Lead Architect  
> **Verdict:** **Conditional Pass — 4 Security & Reliability Fixes Required Before Tagging `phase-1-verified`**  
> Overall structure, `NodeNext` ESM cleanliness, test coverage (`43/43`), and seed data are strong. Line-by-line review caught 2 critical security/Express-v4 issues and 2 storage/streaming hardening items to resolve before locking `phase-1-verified`.

---

## Required Action Items for Builder Agent

- [ ] **1. [CRITICAL — Security] Fail Closed When `ADMIN_GOOGLE_EMAIL` or `GOOGLE_CLIENT_ID` Is Unset**
  - **Finding:**
    - In `server/routes/auth.ts` (lines 49–55), `if (config.adminGoogleEmail && payload.email.toLowerCase() !== ...)` skips email verification when `ADMIN_GOOGLE_EMAIL` is empty (`""`), allowing *any* Google user to log in if the env var is omitted!
    - In `server/middleware/auth.ts` (line 22), `audience: clientId || undefined` skips audience verification when `GOOGLE_CLIENT_ID` is empty, and `verifyAdminSession` (lines 79–83) skips email checking when `adminEmail` is empty.
  - **Fix:**
    1. In `POST /api/admin/login` (non-`devBypass` path): if `!config.adminGoogleEmail.trim()`, return `403` (`"Admin email is not configured"`). Always enforce `payload.email.toLowerCase() === config.adminGoogleEmail.trim().toLowerCase()`.
    2. In `createDefaultGoogleTokenVerifier(clientId)`: if `!clientId.trim()`, throw an error (`"GOOGLE_CLIENT_ID is not configured"`) before calling `verifyIdToken`, and always pass `audience: clientId`.
    3. In `verifyAdminSession(token, secret, config)`: determine `expectedEmail = config.adminGoogleEmail.trim() || (config.allowDevBypass ? 'admin@storyteller.local' : '')`. If `!expectedEmail` or `payload.email.toLowerCase() !== expectedEmail.toLowerCase()`, return `null`.
    4. Add a unit/supertest regression test in `tests/storageAndAuth.test.ts` verifying that when `ADMIN_GOOGLE_EMAIL=""` and `allowBypass=false`, `POST /api/admin/login` with a verified Google token (`attacker@gmail.com`) is **rejected with `403`**, never `200`!

- [ ] **2. [CRITICAL — Reliability] Wrap Express 4 `async` Route Handlers to Prevent Unhandled Rejection Crashes**
  - **Finding:** Express v4 (`4.21.2`) does not automatically forward rejected promises from `async` route handlers to `next(err)`. A storage/GCS I/O throw inside `GET /api/catalog`, `GET /api/stories/:id` (`throw err` at line 59), `GET /api/stories/:id/audios/:filename`, or `GET /api/admin/stories` triggers an `UnhandledPromiseRejection` that crashes Node instead of reaching `app.ts`'s error handler.
  - **Fix:**
    1. Create a tiny `asyncHandler` utility (e.g., in `server/lib/asyncHandler.ts`) wrapping `(req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)` and wrap all `async` route handlers in `server/routes/public.ts` and `server/routes/auth.ts`.
    2. In `server/app.ts`'s global error handler, add `if (res.headersSent) { next(err); return; }` at the top.
    3. Add a supertest test where a mocked `storage.getCatalog()` rejects with `new Error('GCS timeout')` and assert `GET /api/catalog` cleanly returns `500 { error: 'GCS timeout' }` without an unhandled rejection.

- [ ] **3. [HIGH — Streaming & Caching] Safe `pipeline()` Streaming, Draft `Cache-Control`, & Strict Digit Range Check**
  - **Finding (`server/routes/public.ts`):**
    - Line 118 sets `Cache-Control: public, max-age=31536000, immutable` even when an admin streams a `draft` story's audio (risking public CDN caching of draft audio).
    - Lines 126 & 204 use `.pipe(res)` without `stream.pipeline`, risking leaked file/GCS streams on client abort or uncaught stream `'error'` events.
    - Lines 154/165/175 use `parseInt(str, 10)` without checking `/^\d+$/.test(str)`, accepting malformed headers like `Range: bytes=0abc-10xyz`.
  - **Fix:**
    1. Set `Cache-Control` to `'public, max-age=31536000, immutable'` when `story.status === 'published'`, and `'private, no-store'` when `story.status === 'draft'`.
    2. Validate non-empty `startStr` / `endStr` with `/^\d+$/.test(...)` before `Number(...)` (`416` on non-digits).
    3. Pipe audio using `pipeline(audioDesc.createStream(...), res, () => {})` from `'node:stream'`.
    4. Add tests asserting `private, no-store` on draft audio and `416` on `Range: bytes=0abc-10xyz`.

- [ ] **4. [MEDIUM — Storage] Fix Sibling-Directory Prefix Bypass, GCS 64-bit Generation Precision, & `createStorageAdapter`**
  - **Finding A (`server/storage/localStorage.ts` line 22):** `!resolved.startsWith(this.dataDir)` allows sibling paths like `../<basename>-evil/file.json` because `"/tmp/dir-evil/file.json".startsWith("/tmp/dir")` is `true`!
    - **Fix:** Check `if (resolved !== this.dataDir && !resolved.startsWith(this.dataDir + path.sep))` and add a test with `../${path.basename(tmpDir)}-evil/leak.json` asserting `InvalidSlugError`.
  - **Finding B (`server/storage/gcsStorage.ts` lines 35–56):** GCS `metadata.generation` is a 64-bit integer string that can exceed `Number.MAX_SAFE_INTEGER`. Keep `generation` as `string | number` (`0` when `404`, otherwise `metadata.generation` directly without `Number(generation)`), and pass `generation !== 0 ? { generation } : undefined` to `file.download(...)` so `download` reads the exact generation snapshot locked by `ifGenerationMatch: generation`.
  - **Finding C (`server/storage/index.ts` & `server/app.ts`):** Export `createStorageAdapter(config)` from `server/storage/index.ts` (`config.gcsBucketName ? new GcsStorageAdapter(config.gcsBucketName) : new LocalStorageAdapter(config.dataDir)`) and use it in both `server/app.ts` and `server/index.ts`.
