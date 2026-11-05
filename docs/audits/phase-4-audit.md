# Phase 4 Engineering Audit Report: Voice Studio, TTS Engine & Cloud Run Packaging

> **Target Audience:** Lead Architect / Senior Reviewing Agent  
> **Milestone:** Phase 4 (Voice Audition Studio, Chunked Gemini 3.8 TTS, Version Manager & Cloud Run Packaging)  
> **Repository:** `/home/ubuntu/story-wizard`  
> **Status:** All Phase 4 Requirements Implemented & Verified (100% Green, 85/85 Vitest Unit/Integration Tests + Live Gemini 3.8 Flash & Flash-Lite TTS Wire Smoke + Playwright Headless Chromium E2E + Docker Container Smoke Verification with Prebuilt Voices Out-of-the-Box)

---

## 1. Executive Summary & Objective

Phase 4 implements the complete voice audition, text-to-speech synthesis, and audio lifecycle pipeline for **Storyteller Studio**, enabling creators to:
1. **Audition and Design Voices:** Audition existing prebuilt system voices or candidate natural-language voice designs via 5-second previews synthesized by `gemini-3.8-flash-lite-tts`, and save custom prompted voices into `voices.json` using Google Voices API (`ai.voices.create`).
2. **Synthesize Full Bedtime Stories:** Synthesize multi-turn bedtime stories using `gemini-3.8-flash-tts` in both **Solo Storyteller** and **Multi-Speaker Cast** modes, strictly adhering to the **Gemini 3.8 TTS Multi-Speaker Exact-2 Rule** (calls with 1 distinct speaker use single-speaker `speechConfig.voiceConfig`; sub-batches with 2 speakers use `speechConfig.multiSpeakerVoiceConfig` with `speakerVoiceConfigs.length === 2`).
3. **RIFF-Safe PCM Audio Stitching:** Extract pure 24kHz 16-bit mono PCM from returned chunks using `extractPcmFromWavOrRaw`, insert `createSilencePcm(150)` (150ms = 7,200 zero bytes) between contiguous batches, and wrap the concatenated PCM once with `wrapPcmAsWav` so that saved `.wav` audio files have `"RIFF"` only at byte 0 with zero mid-stream header pops.
4. **Manage Audio Versions:** Automatically publish stories upon initial synthesis, promote default audio versions, promote the newest remaining version upon deleting the default, and gracefully revert stories to `'draft'` when 0 versions remain.
5. **Interactive UI Studio & Reader Admin Controls:** Provide creators with the tabbed **Step 3: Voice Audition, Synthesis & Audio Versions** panel (`VoiceStudioPanel.tsx`) in `/admin` (with live elapsed timer and dirty workbench auto-save), and provide admins with inline version controls inside the public reader (`StoryReader.tsx`).
6. **Cloud Run Ready:** Multi-stage production `Dockerfile` (`node:22-alpine`, non-root `USER node`, `/app/data` local storage fallback), `.dockerignore`, and deployment helper script (`deploy.sh`).

---

## 2. Architecture & File Layout

```text
/home/ubuntu/story-wizard/
├── server/
│   ├── app.ts                         # Injected TtsProvider / GeminiTtsService, mounted adminVoicesRouter
│   ├── routes/
│   │   ├── adminVoices.ts             # Voice endpoints (/voices, /voices/preview, POST /voices)
│   │   └── adminStories.ts            # Extended with /:id/synthesize, /:id/versions/:verId/default, DELETE /:id/versions/:verId
│   ├── services/
│   │   └── geminiTts.ts               # GeminiTtsService, TtsProvider, GoogleGenAITtsProvider, toGeminiVoiceConfig, batching logic
│   └── lib/
│       └── wav.ts                     # extractPcmFromWavOrRaw, createSilencePcm(150), wrapPcmAsWav
├── client/
│   ├── api/
│   │   └── client.ts                  # Typed client helpers (fetchVoices, previewVoiceAudio, createCustomVoice, synthesizeStoryAudio, etc.)
│   ├── App.tsx                        # Admin session check, passes isAdmin, activeAudioVersion, and onStoryUpdated to StoryReader
│   └── components/
│       ├── VoiceStudioPanel.tsx       # Step 3 workbench panel: auditioning, custom voice designer, casting, synthesis, versions list
│       ├── DirectorStudio.tsx         # Integrated VoiceStudioPanel with workbench auto-save before synthesis
│       └── StoryReader.tsx            # Integrated inline Admin Audio Versions panel with default toggle and delete
├── scripts/
│   ├── smokePhase4Live.ts             # Conditional live smoke script testing real gemini-3.8-flash-lite-tts audition
│   └── smokePhase3Live.ts             # Gemini 3.8 Flash writer & director live smoke
├── tests/
│   ├── ttsSynthesis.test.ts           # 4 integration tests (Gate 1: 28-turn solo batching, Gate 2: 3-speaker cast exact-2 rule, Gate 3: version lifecycle, Gate 4: voice endpoints & security)
│   ├── ui.test.tsx                    # 14 component tests (including VoiceStudioPanel & StoryReader admin panel)
│   ├── esm-build.test.ts              # Verified plain node dynamic imports of geminiTts.js & adminVoices.js
│   └── e2e/
│       └── storybook.spec.ts          # Playwright Chromium E2E: Voice studio workbench, casting toggle, dark mode, mobile 375x812
├── Dockerfile                         # Multi-stage production container build (builder -> runner with USER node)
├── .dockerignore                      # Build exclusions (node_modules, dist, data, .git, .env, etc.)
├── deploy.sh                          # gcloud run deploy helper (--timeout=300 --memory=512Mi --cpu=1)
└── qa-screenshots/
    └── phase4-voice-studio.png        # 1440x900 Dark Mode screenshot of Voice Studio panel in Director workbench
```

---

## 3. Detailed Implementations

### 3.1 `GeminiTtsService` & `TtsProvider` (`server/services/geminiTts.ts`)
- **Injectable `TtsProvider` Interface:**
  - `synthesizeBatch(req: SynthesizeBatchRequest): Promise<Buffer>`
  - `createPromptedVoice(req: PromptedVoiceRequest): Promise<PromptedVoiceResponse>`
- **`GoogleGenAITtsProvider`:**
  - Lazy initialization of `new GoogleGenAI({ apiKey })` so server and tests boot cleanly without `GEMINI_API_KEY`.
  - In `synthesizeBatch`: calls `ai.models.generateContent` with `responseModalities: ['AUDIO']` and `speechConfig`. Extracts audio from `response.candidates[0].content.parts` where `inlineData.data` is present.
  - In `createPromptedVoice`: calls `ai.voices.create({ store: true, voice: { type: 'prompted', display_name, description, language_code, prompted: { input: description } } })` using the verified snake_case fields of `@google/genai@2.24.0`.
- **`toGeminiVoiceConfig(voice: VoiceEntry)`:**
  - Prebuilt voice (`source === 'prebuilt'`): `{ prebuiltVoiceConfig: { voiceName: voice.gemini_voice_name } }`
  - Designed voice (`source === 'designed'`): `{ voice: voice.gemini_voice_name }`
- **`previewVoice({ voiceId?, description?, sampleText? })`:**
  - Clamps `sampleText` to `<= 220` characters (using a soothing default bedtime line if omitted).
  - Supports previewing an existing voice by `voiceId`, or previewing a candidate prompt description using prebuilt Kore as the base voice.
  - Extracts PCM via `extractPcmFromWavOrRaw` and wraps via `wrapPcmAsWav` so the response is always a canonical 44-byte RIFF WAV.
- **`createAndSaveVoice({ label, description, languageCode?, tags? })`:**
  - Validates non-empty `label` and `description` (`ValidationError`).
  - Calls `ttsProvider.createPromptedVoice`, generates collision-safe slug `designed-<kebab-label>`, and appends atomically to `voices.json`.
- **`synthesizeFullStory(storyId, { casting, label?, makeDefault? })`:**
  - Validates casting mode (`'solo' | 'cast'`) and speaker voices.
  - **Solo Mode Batching:** Batches contiguous turns `<= 12` turns and `<= 3,000` chars. Normalizes `speechMetadata.speaker` to `'Narrator'` and prepends character vocal traits into `style` (`Speaking dialogue as Bibi (traits): style`). Uses single-speaker `speechConfig.voiceConfig`.
  - **Cast Mode Batching & Exact-2 Rule:** Groups contiguous turns while `distinctSpeakers.size <= 2`, `turns.length <= 12`, and `chars <= 3,000`. If a sub-batch has **1 speaker**, calls with single-speaker `voiceConfig`; if **2 speakers**, calls with `multiSpeakerVoiceConfig.speakerVoiceConfigs` of **exact length 2**.
  - **PCM Stitching:** Strips RIFF headers using `extractPcmFromWavOrRaw`, inserts `createSilencePcm(150)` (7,200 zero bytes) between batches ($N - 1$ pads for $N$ batches), and wraps concatenated PCM once with `wrapPcmAsWav`.
  - **Publishing:** Writes audio file, appends `AudioVersion`, sets `story.status = 'published'`, and atomically syncs `catalog.json`.

### 3.2 Voice & Audio Version REST API (`server/routes/adminVoices.ts`, `server/routes/adminStories.ts`)
- All endpoints protected by `requireAdmin` + `asyncHandler`:
  - `GET /api/admin/voices`: returns `VoiceEntry[]`.
  - `POST /api/admin/voices/preview`: returns `200` binary `audio/wav` with `Cache-Control: private, no-store`.
  - `POST /api/admin/voices`: creates custom voice and appends to `voices.json`, returning `201` `VoiceEntry`.
  - `POST /api/admin/stories/:id/synthesize`: executes `synthesizeFullStory`, returning `201` `Story`.
  - `PATCH /api/admin/stories/:id/versions/:versionId/default`: marks `versionId` as default, clears others, saves `story.json`, and updates `catalog.json.default_audio_url`.
  - `DELETE /api/admin/stories/:id/versions/:versionId`: deletes `.wav` file, promotes the newest remaining version if default was deleted, reverts to `'draft'` (`default_audio_url: null`) if 0 versions remain, and syncs `catalog.json`.

### 3.3 Frontend Voice Studio & Reader Admin Controls (`client/**`)
- **`VoiceStudioPanel.tsx`:**
  - Displays proposed voice candidates with **"🔊 5s Preview"** (plays returned WAV Blob cleanly, revoking object URLs on cleanup) and **"💾 Save to Voice Library"**.
  - Expandable **"Design Custom Voice"** form.
  - Casting Controls: Toggle between **"🎙️ Solo Storyteller"** and **"🎭 Multi-Speaker Cast"**. Solo renders Narrator `<select>` + preview button; Cast renders individual `<select>` + preview for Narrator and every character in `story.characters`.
  - Synthesis Button: Prominent **"🎧 3. Synthesize & Publish Audio"** with live elapsed timer (`"Synthesizing... (4s)"`), and dirty-workbench auto-save hook before synthesis.
  - Versions Manager: Lists all versions with `DEFAULT` pill, `SOLO`/`CAST` badge, duration, `<audio controls>`, **"★ Set Default"**, and two-step **"🗑 Delete"** -> `"Confirm"` / `"Cancel"`.
- **`StoryReader.tsx`:**
  - Displays an inline **Admin Audio Versions** panel when `isAdmin` is true, keeping player, versions, and public catalog in sync.

### 3.4 Cloud Run Packaging (`Dockerfile`, `.dockerignore`, `deploy.sh`)
- `.dockerignore`: Excludes `node_modules`, `dist`, `data`, `.git`, `.env`, `.env.*`, `qa-screenshots`, `playwright-report`, `test-results`, `coverage`, `*.log`.
- `Dockerfile`: Multi-stage `node:22-alpine` (`npm ci` -> `npm run build` -> `npm prune --omit=dev` -> clean production stage with `/app/data` writable by `USER node`, `EXPOSE 8080`, `CMD ["node", "dist/server/index.js"]`).
- `deploy.sh`: Cloud Run deployment script with gcloud validation and required options (`--timeout=300 --memory=512Mi --cpu=1`).

---

## 4. Verification & Test Evidence

### 4.1 Vitest Unit & Integration Suites (`npm test`)
```text
 ✓ tests/wav.test.ts (6 tests) 15ms
 ✓ tests/validators.test.ts (19 tests) 32ms
 ✓ tests/pipelineApi.test.ts (8 tests) 311ms
 ✓ tests/ttsSynthesis.test.ts (5 tests) 338ms
 ✓ tests/storageAndAuth.test.ts (30 tests) 433ms
 ✓ tests/ui.test.tsx (16 tests) 1639ms
 ✓ tests/esm-build.test.ts (1 test) 4209ms

 Test Files  7 passed (7)
      Tests  85 passed (85)
   Duration  4.94s
```

All validation gates in `tests/ttsSynthesis.test.ts` passed:
1. **Gate 1 (Long-Story Batching & RIFF De-duplication):** 28-turn story in solo mode divides into 3 batches (`12 + 12 + 4` turns) with `speechMetadata.speaker === "Narrator"`, character traits folded into `style`. Saved `.wav` file has `"RIFF"` ONLY at byte 0 (`indexOf('RIFF', 4) === -1`) and exact byte size $44 + 3 \times 9600 + 2 \times 7200 = 43244$.
2. **Gate 2 (3-Speaker Cast Mode Sub-Batching & Exact-2 Rule):** 3-character story (`"Narrator"`, `"Bibi"`, `"Owl"`) in cast mode groups turns without exceeding 2 speakers per call; asserts `multiSpeakerVoiceConfig` has `speakerVoiceConfigs.length === 2` for 2-speaker calls, and single `voiceConfig` for 1-speaker calls. Every turn's speaker matches configured speakers.
3. **Gate 3 (Version Promotion & Last-Version Deletion):** Synthesize v1 (default, published); synthesize v2 (`makeDefault: false`); `PATCH .../v2/default` updates `catalog.default_audio_url` to v2; `DELETE .../v2` promotes v1 to default; `DELETE .../v1` leaves 0 versions, reverts story to `'draft'`, `default_audio_url: null`, and public `GET /api/catalog` excludes it.
4. **Gate 4 (Voice Studio Endpoints & Security):** `GET /api/admin/voices`, `POST /api/admin/voices/preview` (by ID and by description prompt), `POST /api/admin/voices` (creates custom voice and synthesizes with `{ voice: 'voice_...' }`), and 401 unauthenticated enforcement on all new admin routes.
5. **Fresh DATA_DIR Prebuilt Voices Guarantee:** Asserts that on an empty data directory without `saveVoices` ever called, `GET /api/admin/voices` returns 3 prebuilt voices (`Kore`, `Puck`, `Aoede`) and `POST /api/admin/stories/:id/synthesize` succeeds with `prebuilt-kore` and normalized casting.

### 4.2 Native Node ESM Verification (`tests/esm-build.test.ts`)
- Server compiles under `tsconfig.server.json` (`"module": "NodeNext"`).
- Dynamic import of `./dist/server/services/geminiTts.js` and `./dist/server/routes/adminVoices.js` succeeds cleanly in native `node`.

### 4.3 Live Wire Smoke Tests (`npm run test:live`)
Executed live tests against both Gemini 3.8 Flash (Writer + Director) and Gemini 3.8 Flash-Lite TTS (Audition Preview):
```text
[smoke:live] GEMINI_API_KEY detected. Starting conditional live smoke test with gemini-3.8-flash...
[smoke:live] Calling Gemini 3.8 Flash (generateStoryDraft)...
[smoke:live] Draft generated successfully! Title: "Bibi's Starry Moss Nest", turns: 5
[smoke:live] Calling Gemini 3.8 Flash (directStoryScript)...
[smoke:live] Directing complete! Voice candidates: Velvet Storyteller, Little Petal
[smoke:live] ALL LIVE GEMINI 3.8 FLASH CHECKS PASSED!

[smoke:live:tts] GEMINI_API_KEY detected. Starting conditional live smoke test with gemini-3.8-flash-lite-tts...
[smoke:live:tts] Calling Gemini 3.8 Flash-Lite TTS (previewVoice)...
[smoke:live:tts] Live audition succeeded! Synthesized valid RIFF WAV (389804 bytes, 24000 Hz)
[smoke:live:tts] ALL LIVE GEMINI 3.8 FLASH-LITE TTS CHECKS PASSED!
```

### 4.4 Playwright Headless Chromium E2E (`npm run test:e2e`)
```text
Running 3 tests using 1 worker
  ✓ Phase 2 Public Storybook E2E (1.9s)
  ✓ Phase 3 Admin Director Studio E2E (2.4s)
  ✓ Phase 4 Voice Audition Studio & Versions E2E (2.0s)
  3 passed (8.8s)
```
- Logs into `/admin` via Dev Sandbox Login.
- Loads seeded story into workbench.
- Verifies `VoiceStudioPanel` renders with existing `v1-owl-solo` version controls and `★ DEFAULT` badge.
- Tests Solo vs Cast toggle (renders Bibi's voice selector in Cast mode; hides in Solo mode).
- Tests Design Custom Voice expandable form.
- Asserts Dark Mode contrast (`.voice-studio-panel` evaluates to `#161F2C` background).
- Asserts mobile `375x812` zero horizontal overflow (`scrollWidth <= innerWidth`).
- Verified zero `pageerror` and zero `console.error` events.
- Captured `qa-screenshots/phase4-voice-studio.png` at `1440x900`.

### 4.5 Docker Container Build & Runtime Smoke Verification
```text
[+] Building 189.0s (16/16) FINISHED
 => naming to docker.io/library/storyteller-studio:latest
```
Booted container on port 18080:
```text
docker run -d --rm --name storyteller-phase4-smoke -p 18080:8080 -e SESSION_SECRET=smoke-test-secret-at-least-32-characters-long storyteller-studio
curl -i http://localhost:18080/          -> HTTP/1.1 200 OK (HTML SPA)
curl -i http://localhost:18080/api/catalog -> HTTP/1.1 200 OK (JSON [])
docker stop storyteller-phase4-smoke     -> stopped cleanly
```

### 4.6 Architectural Code Review Remediations (Commit `fix(phase-4)`)
All 6 open checklist findings from `docs/reviews/phase-4-review.md` were addressed, verified, and checked off:
1. **TypeScript Strictness (TS7006):** Typed `draft: Story | null = null` and `directed: Story | null = null` in `scripts/smokePhase3Live.ts` with explicit null guards, achieving clean `npm run typecheck` (`tsc --noEmit` exit 0).
2. **Director Workbench Save Persistence:** Extracted `persistWorkbenchEdits(): Promise<Story>` in `DirectorStudio.tsx` that rethrows save errors, wired `onBeforeSynthesize={async () => { await persistWorkbenchEdits(); }}`, passed live `editedCharacters` to `VoiceStudioPanel`, and added regression test in `tests/ui.test.tsx` verifying synthesis aborts on save rejection.
3. **Out-of-the-Box Built-In Prebuilt Voices:** Exported `DEFAULT_PREBUILT_VOICES` in `server/services/geminiTts.ts` and implemented `listVoices(): Promise<VoiceEntry[]>`. Routed `GET /api/admin/voices`, `previewVoice`, and `synthesizeFullStory` through `listVoices()`. Added integration test in `tests/ttsSynthesis.test.ts` verifying prebuilt voice availability on empty `DATA_DIR` and verified directly in fresh Docker container.
4. **VoiceStudioPanel Select Styling, State Reset & Toggle Sync:** Changed `<select>` elements to `className="select-tactile"`, added `useEffect` keyed on `story.id` to stop audition and reset transient banners/casting defaults, synced `versionLabel` ('Bedtime Solo' <-> 'Bedtime Cast') on mode toggle, and normalized saved `casting` in `synthesizeFullStory`.
5. **Preserve Active Audio Version in Reader:** In `App.tsx` `onStoryUpdated`, preserved currently playing `activeAudioVersion` if its `version_id` still exists in the updated story, falling back to default/null only when deleted. Verified via component test in `tests/ui.test.tsx`.
6. **Cloud Run Production Environment Variable Documentation:** Documented required environment variables (`SESSION_SECRET` >= 32 chars, `GEMINI_API_KEY`, `GCS_BUCKET_NAME`, `ADMIN_GOOGLE_EMAIL`, `GOOGLE_CLIENT_ID`) in `deploy.sh` comments and pre-flight output (never echoing secrets).

---

## 5. Security & Guardrail Audit Checklist

| Item | Status | Verification Note |
| :--- | :---: | :--- |
| Zero over-engineering | PASS | No databases (SQLite/Postgres/Redis), no queues (BullMQ), no ffmpeg. Simple atomic JSON/WAV storage. |
| Node ESM `.js` relative imports | PASS | All relative imports in `server/**` and `shared/**` use explicit `.js`. |
| Gemini 3.8 TTS Multi-Speaker Exact-2 Rule | PASS | Calls with 1 distinct speaker use single-speaker `voiceConfig`; sub-batches with 2 speakers use `multiSpeakerVoiceConfig` with `length === 2`. |
| RIFF-Safe PCM concatenation | PASS | Chunks stripped via `extractPcmFromWavOrRaw`, 150ms silence inserted between batches, wrapped once via `wrapPcmAsWav`. Zero mid-audio RIFF headers. |
| Automatic publish on synthesis | PASS | Story status set to `'published'` upon first audio version synthesis. |
| Last version draft reversion | PASS | When 0 versions remain, story status reverts to `'draft'` and disappears from public catalog. |
| Single-admin auth protection | PASS | All `/api/admin/voices/*` and `/api/admin/stories/:id/synthesize` routes protected by `requireAdmin`. |
| Secret safety | PASS | `.env` never read into audit, never printed, excluded in `.gitignore` and `.dockerignore`. |
| Single audit location | PASS | Report written exclusively to `docs/audits/phase-4-audit.md`. |
| Tag withheld | PASS | `phase-4-verified` tag withheld pending Architect code + visual review. |
