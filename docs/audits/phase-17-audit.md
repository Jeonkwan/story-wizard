# Phase 17 Audit Report

## Scope
FFmpeg `.m4a` (AAC-LC `+faststart`) default streaming, lossless `.wav` download (`?download=1`), automated `.wav -> .m4a` migration, and dynamic bucket-driven private Podcast RSS engine (`podcasts/{id}/podcast.json`).

## Summary of Changes

### 1. Docker & Environment
- **`Dockerfile`**: Added `RUN apk add --no-cache ffmpeg` in both `builder` and `runner` stages (before `USER node` in `runner`).
- **`package.json`**: Added `"migrate:m4a": "tsx --env-file-if-exists=.env scripts/migrateWavToM4a.ts"`.

### 2. Shared Types & FFmpeg Transcoder
- **`shared/types.ts`**: Extended `AudioVersion` additively (`wav_url?: string`, `m4a_size_bytes?: number`), added `PodcastEpisodeEntry` and `PodcastConfig`, and exported `getLosslessWavUrl(version)`.
- **`server/lib/m4a.ts`** (new): Implemented `M4aTranscoder` type and `transcodeWavToM4a(wavBuffer)` using `os.tmpdir()` temp `.wav`/`.m4a` files (`ffmpeg -y -f wav -i <tmpIn.wav> -c:a aac -b:a 128k -movflags +faststart <tmpOut.m4a>`), validating non-empty output with `ftyp` at bytes `4..8` and cleaning up temp files in `finally`.

### 3. Storage Adapters & TTS Synthesis
- **`server/storage/storageAdapter.ts`**, **`server/storage/localStorage.ts`**, **`server/storage/gcsStorage.ts`**:
  - Preserved `saveAudio` and `getAudioStream` signatures for `.wav` compatibility.
  - Added `saveAudioM4a`, `getAudioM4aStream`, `listPodcasts`, `getPodcast`, `savePodcast`, `deletePodcast`, and `getPodcastCoverStream`.
  - Updated `deleteAudio` in both adapters to remove both `.wav` and `.m4a` files while ignoring not-found errors on either.
  - Implemented dynamic directory/bucket scanning in `listPodcasts()` with `cover.jpg`/`cover.png` discovery and slug validation in `getPodcastCoverStream()`.
- **`server/services/geminiTts.ts`** & **`server/app.ts`**:
  - Added optional `m4aTranscoder?: M4aTranscoder` to `GeminiTtsService` and `CreateAppOptions`.
  - Updated `synthesizeFullStory` to transcode `.wav` -> `.m4a`, save both `.wav` and `.m4a`, and set `audio_url` to `.m4a`, `wav_url` to `.wav`, and `m4a_size_bytes`. (Voice previews remain `.wav`.)
  - Mounted `createAdminPodcastsRouter` at `/api/admin` in `server/app.ts`.

### 4. Public Streaming, Lossless Download & Podcast RSS
- **`server/routes/public.ts`**:
  - Updated `streamAudioWithRange` to accept `contentType`.
  - Updated `GET /api/stories/:id/audios/:filename` to serve `.m4a` (`audio/mp4`) and `.wav` (`audio/wav`, adding `Content-Disposition: attachment` when `?download=1` or `?download=true`), returning `400` for unsupported extensions (e.g., `.mp3`).
  - Added `GET /api/podcasts/:podcastId/feed.xml` with `?token=` guard (`403` when `podcast.token` is non-empty and missing/mismatched), reverse-proxy base URL resolution (`x-forwarded-proto`, `x-forwarded-host`, `PUBLIC_BASE_URL`), XML escaping, conditional `<itunes:image>` only when cover exists, automatic skipping of missing/draft/audio-less stories, fallback to story default `version_id`, and `<enclosure ... type="audio/x-m4a" />`.
  - Added `GET /api/podcasts/:podcastId/cover.:ext` (`jpg` | `png`).

### 5. Admin Podcast CRUD & Cleanup Hooks
- **`server/routes/adminPodcasts.ts`** (new): Implemented `GET /api/admin/podcasts`, `POST /api/admin/podcasts`, `PATCH /api/admin/podcasts/:id`, `DELETE /api/admin/podcasts/:id`, `POST /api/admin/podcasts/:id/episodes` (auto-publishing draft stories that have audio and enforcing `story_id` deduplication), and `DELETE /api/admin/podcasts/:id/episodes/:storyId`.
- **`server/routes/adminStories.ts`**: Added best-effort podcast episode cleanup hooks on story deletion and audio version deletion.

### 6. Migration & Seed Scripts
- **`scripts/migrateWavToM4a.ts`** (new): Implemented `migrateWavToM4a(storage, options?)` and CLI runner supporting `--dry-run` and `--force`, skipping versions with existing valid `.m4a` files, transcoding `.wav` -> `.m4a`, and updating `story.json` and `catalog.json`.
- **`scripts/seedLocalData.ts`**: Updated to generate and persist both `.wav` and `.m4a` for seeded stories with `.m4a` as default `audio_url`/`default_audio_url`, `wav_url`, and `m4a_size_bytes`.
- **`scripts/migrateToGcs.ts`**: Updated `getContentType` and `discoverDataFiles` to include `.m4a` (`audio/mp4`), `.jpg`/`.jpeg` (`image/jpeg`), and `.png` (`image/png`).

### 7. Frontend UI
- **`client/api/client.ts`**: Added typed Podcast API client functions (`fetchAdminPodcasts`, `createPodcast`, `updatePodcast`, `deletePodcast`, `releaseStoryToPodcast`, `unreleaseStoryFromPodcast`).
- **`client/components/AdminLoginGate.tsx`**: Added 3rd tab `📻 Podcasts` (`data-testid="admin-tab-podcasts"`, `/admin/podcasts`) rendering `<PodcastLibraryPage />`.
- **`client/components/PodcastLibraryPage.tsx`** (new): Built full podcast management UI matching Fireside Espresso dark-first design tokens (create/edit/delete podcast, private RSS URL display/copy + token rotation, episode list with version switcher & unrelease button, quick-release picker).
- **`client/components/VoiceStudioPanel.tsx`**: Added dynamic `📻 PODCAST RELEASE` panel (`data-testid="story-podcast-release-panel"`) shown when `podcasts.length > 0 && story.audio_versions.length > 0`, plus `⬇ WAV` (`data-testid="download-wav-<version_id>"`) button on each audio version card.
- **`client/components/StoryReader.tsx`**: Added `⬇ WAV (Lossless)` (`data-testid="reader-download-wav-btn"`) in the reader header/meta area and `⬇ WAV` link on each row of the Admin Audio Versions panel.

### 8. Tests
- Updated existing tests: `tests/phase14WorkflowAndSafeArea.test.tsx`, `tests/e2e/qa-phase5.spec.ts`, `tests/storageAndAuth.test.ts`, `tests/deploymentConfig.test.ts`, and `tests/esm-build.test.ts`.
- Added unit/integration suite `tests/phase17PodcastAndM4a.test.tsx` and Playwright E2E suite `tests/e2e/qa-phase17.spec.ts`.

## Verification Results
- `npm run typecheck`: Passed (exit 0).
- `npx tsc -p tsconfig.server.json`: Passed (exit 0).
- `npm test`: Passed (`15` test files, `285` tests passed).
- `npm run build`: Passed (`vite build` + `tsc -p tsconfig.server.json`).
- `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy npm run test:e2e`: Passed (`15` passed across all Playwright specs, including `qa-phase5.spec.ts` and `qa-phase17.spec.ts`).
- `GCS_BUCKET_NAME= npm run seed`: Passed (`Successfully seeded local data in ./data`).
- `GCS_BUCKET_NAME= npx tsx scripts/migrateWavToM4a.ts`: Passed (`stories=3, versions=4, migrated=0, skipped=4, errors=0` after seeding `.m4a` + `.wav`).
- `npm run migrate:m4a -- --dry-run`: Targeted configured GCS bucket and exited `1` with `invalid_grant` due to expired/unavailable GCS ADC credentials in the sandbox environment.
- `docker build --progress=plain -t storyteller-studio:phase17-check .` + `docker run --rm storyteller-studio:phase17-check ffmpeg -version | head -n 2`: Passed (`ffmpeg version 8.1.3`; temporary image removed afterward).
- Visual inspection of Playwright screenshots (`qa-screenshots/phase17-desktop-podcasts-tab-dark.png`, `qa-screenshots/phase17-mobile-podcasts-tab-dark.png`, `qa-screenshots/phase17-desktop-workbench-podcast-release-dark.png`, `qa-screenshots/phase17-mobile-reader-wav-download-dark.png`): Verified Fireside Espresso dark theme, clean typography, and zero horizontal overflow on desktop (`1440x900`) and mobile (`375x812`).
