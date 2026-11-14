# Phase 17 Deployment, GCS `.m4a` Backfill & CI/CD Hardening Audit Report

## Scope
Fix GitHub Actions CI (`ffmpeg` installation), add `--gcloud-auth` + automatic `gcloud auth print-access-token` fallback on ADC credential errors to `scripts/migrateWavToM4a.ts`, backfill existing GCS stories to `.m4a`, deploy Phase 17 to Google Cloud Run via `./deploy.sh`, and verify live production endpoints.

## Summary of Changes

### 1. GitHub Actions CI Fix (`.github/workflows/deploy.yml`)
- Added an `Install FFmpeg` step (`sudo apt-get update && sudo apt-get install -y ffmpeg`) inside `test-and-verify` before `Unit & Integration Tests` so `npm test` (specifically `transcodeWavToM4a` and `migrateWavToM4a` tests) passes on `ubuntu-latest`.
- Added assertion coverage in `tests/deploymentConfig.test.ts` verifying `sudo apt-get install -y ffmpeg` is present in `.github/workflows/deploy.yml`.

### 2. GCS Migration `gcloud` Access-Token Fallback (`scripts/migrateWavToM4a.ts`)
- Exported `isAdcCredentialError(err)` and `createMigrationStorage(config, options?)` from `scripts/migrateWavToM4a.ts`.
- Added `--gcloud-auth` CLI flag support and automatic fallback to `gcloud auth print-access-token` via `OAuth2Client` (`google-auth-library`) + `new Storage({ authClient }).bucket(config.gcsBucketName)` -> `new GcsStorageAdapter(bucket)` whenever `config.gcsBucketName` is configured and `storage.getCatalog()` fails with an ADC/credential error (`invalid_grant`, `Could not load the default credentials`, etc.).
- Added unit tests in `tests/phase17PodcastAndM4a.test.tsx` covering explicit `--gcloud-auth`, automatic `invalid_grant` fallback, non-credential error rethrow, and `isAdcCredentialError`.

### 3. GCS `.m4a` Backfill (`gs://storyteller-studio-mokamaker`)
- Executed `npm run migrate:m4a -- --dry-run`: discovered 5 stories (`3` published versions needing `.m4a` transcode, `2` audio-less drafts), `errors=0`.
- Executed `npm run migrate:m4a`:
  - `2026-11-13-bobby-jaiden-and-the-pillow-rocket-blastoff/v1-default-solo-narration-1794559855`: `21463724B` WAV -> `6055435B` M4A
  - `2026-11-13-bobby-jaiden-and-the-great-sneaker-safari/v1-default-solo-narration-1794558814`: `18232844B` WAV -> `5113467B` M4A
  - `2026-11-13-rocco-the-capybara-and-the-great-gelato-adventure/v1-default-solo-narration-1794550097`: `21740204B` WAV -> `6345518B` M4A
  - Result: `stories=5, versions=3, migrated=3, skipped=0, errors=0`.
- Verified `gs://storyteller-studio-mokamaker/catalog.json` via `gcloud storage cat`: all 3 published stories now point to `.m4a` in `default_audio_url` (and the 2 draft stories retain `null`).

### 4. Cloud Run Deployment (`./deploy.sh`)
- Verified dry-run configuration via `./deploy.sh --dry-run` with `GOOGLE_CLIENT_ID` sourced from `.env` and `SESSION_SECRET` / `GEMINI_API_KEY` bound from Google Secret Manager (`storyteller-session-secret:latest`, `storyteller-gemini-api-key:latest`).
- Deployed to Cloud Run (`mokamaker-gcp`, `asia-southeast1`, service `storyteller-studio`):
  - Active revision: `storyteller-studio-00010-899` (100% traffic)
  - Service URL: `https://storyteller-studio-wrtjpohpgq-as.a.run.app` (alias `https://storyteller-studio-1038663876987.asia-southeast1.run.app`)

### 5. Live Production Read-Only Verification
- `gcloud run services describe storyteller-studio --region asia-southeast1 --project mokamaker-gcp --format="value(status.url,status.latestReadyRevisionName)"`: returned `https://storyteller-studio-wrtjpohpgq-as.a.run.app` and `storyteller-studio-00010-899`.
- `GET /api/catalog`: returned all 3 published stories with `.m4a` `default_audio_url` paths.
- `GET /api/stories/2026-11-13-bobby-jaiden-and-the-pillow-rocket-blastoff/audios/v1-default-solo-narration-1794559855.m4a` with `Range: bytes=0-63`: returned `HTTP/2 206`, `content-type: audio/mp4`, `content-range: bytes 0-63/6055435`, `content-length: 64`.
- `GET /api/stories/2026-11-13-bobby-jaiden-and-the-pillow-rocket-blastoff/audios/v1-default-solo-narration-1794559855.wav?download=1`: returned `HTTP/2 200`, `content-type: audio/wav`, `content-disposition: attachment; filename="2026-11-13-bobby-jaiden-and-the-pillow-rocket-blastoff-v1-default-solo-narration-1794559855.wav"`, `content-length: 21463724`.
- `GET /api/admin/me`: returned `{"authenticated":false,"devBypassEnabled":false,"googleClientId":"1038663876987-4rv82705qknl3r8mps3l9k0ehbsns6bf.apps.googleusercontent.com"}`.
- `GET /api/podcasts/nonexistent/feed.xml`: returned `404` JSON `{"error":"Podcast not found: \"nonexistent\""}`.

## Validation Gates
- `npm run typecheck`: Passed (exit `0`).
- `npx tsc -p tsconfig.server.json`: Passed (exit `0`).
- `npm test`: Passed (`15` test files, `286` tests passed).
- `npm run build`: Passed (`tsc -p tsconfig.server.json` + `vite build`).
