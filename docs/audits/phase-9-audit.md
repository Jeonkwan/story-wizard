# Phase 9 Engineering Audit Report: Backend Voice Lifecycle, Emotion-Preserving Pacing Guardrails & Multimodal Dictation STT API

> **Target Audience:** Lead Architect / Senior Reviewing Agent  
> **Milestone:** Phase 9 (Backend Voice Lifecycle — Staged Draft Voices & CRUD, Emotion-Preserving Pacing Guardrails, & Multimodal Dictation STT API)  
> **Repository:** `/home/ubuntu/story-wizard`  
> **Status:** All Phase 9 Objectives & Verification Criteria 100% Complete & Passing (166/166 Unit & Integration Tests Green across 10 Test Files, 8/8 Playwright E2E Tests Passing, NodeNext Native ESM Build Verified)

---

## 1. Executive Summary & Verification Matrix

Phase 9 implements the complete backend voice lifecycle, staged voice draft orchestration, emotional-preserving pacing guardrails for kids' storytelling, audio preview streaming with HTTP 206 partial content support, and a high-capacity multimodal speech-to-text dictation API.

All work strictly obeys the architectural guardrails: zero unapproved dependencies, NodeNext explicit `.js` relative imports across `server/**` and `shared/**`, strict TypeScript typing, strict Saved-Voice Protection Invariants, and zero client UI scope expansion (client was kept cleanly compiling with minimal backward-compatible signatures).

### Key Deliverables Implemented:
1. **Shared Voice Types & Sample Presets (`shared/types.ts`, `shared/voiceSamples.ts`):**
   - Added `VoicePace` union (`'slow' | 'calm' | 'natural' | 'lively'`), `VoiceSamplePreset` interface, `VoiceEntry.default_pace?`, and `VoiceCasting.pace?`.
   - Defined `MAX_VOICE_PREVIEW_CHARS = 320`, four standard `VOICE_SAMPLE_PRESETS` (`playful-dialogue`, `magical-wonder`, `action-adventure`, `silly-comedy`), and `DEFAULT_VOICE_SAMPLE`.
2. **Preview Audio Persistence in Storage Adapters (`server/storage/*`):**
   - Extended `StorageAdapter`, `LocalStorageAdapter`, and `GcsStorageAdapter` with `saveVoicePreview(voiceId, wavBuffer)`, `deleteVoicePreview(voiceId)` (idempotent), and `getVoicePreviewStream(voiceId)`.
   - Stored at `voices/${voiceId}/preview.wav` with strict `validateSlug(voiceId, 'voiceId')` verification.
3. **Voice Preview Audio Streaming with HTTP Range (`server/routes/public.ts`):**
   - Extracted shared `streamAudioWithRange` helper eliminating duplicated HTTP Range code between story audio and voice previews.
   - Added `GET /api/voices/:id/preview.wav` supporting `200 OK`, `206 Partial Content`, `416 Range Not Satisfiable`, `404 Not Found` (when no preview exists), and `400 Bad Request` (invalid slug). Includes `Accept-Ranges: bytes` and `Cache-Control: public, max-age=3600`.
4. **Staged Draft Voice Creation & Saved-Voice Protection (`server/services/geminiTts.ts`):**
   - Implemented `deleteCustomVoice?` in `TtsProvider` and `GoogleGenAITtsProvider`. Bare voice IDs (`/^voice_[a-zA-Z0-9_-]+$/`) are validated, `voices/` prefixes are stripped, and 404/not-found responses are swallowed idempotently.
   - Staged draft `previewVoice`: Case A (saved voice synthesis) vs. Case B (unsaved prompt creates real prompted voice take, NEVER falls back to `'Kore'`). Exposes `X-Draft-Voice-Name` and `Access-Control-Expose-Headers`.
   - Take regeneration automatically deletes the replaced draft take while enforcing the Saved-Voice Protection Invariant (never deletes a voice currently in `voices.json`).
5. **Promotion-on-Save & Voice Entry CRUD (`server/services/geminiTts.ts`, `server/routes/adminVoices.ts`):**
   - `createAndSaveVoice` promotes `stagedGeminiVoiceName` directly without calling `createPromptedVoice` a second time.
   - Validates staged voice ID collision against existing voices (rejects with 409 Conflict if already saved).
   - Validates and caches preview WAV via `extractPcmFromWavOrRaw` and `wrapPcmAsWav`, setting `preview_audio_url` and `default_pace`.
   - Voice CRUD: `PATCH /api/voices/:id` (updates label, description, tags, default_pace), `DELETE /api/voices/:id` (rejects prebuilt with 400; removes designed voice from `voices.json`, deletes cached preview, best-effort deletes custom Gemini voice), and `DELETE /api/voices/draft/:geminiVoiceName` (discards draft with 409 conflict protection).
6. **Kids Anti-Rush Script Direction & Pacing Guardrails (`server/services/geminiStory.ts`, `server/services/geminiTts.ts`):**
   - `directScript` tuned in a single LLM call to separate theatrical excitement from speaking speed, forbidding rapid-tempo directives like "speak fast", "rush through", "hyperactive speed".
   - `sanitizeLiteralTempoPhrases`: neutralizes literal tempo directives using the exact canonical replacement table while preserving emotional tone words ("excited", "joyful", "panicked", etc.), cleanly clamped to <= 280 characters.
   - Synthesis anchors `PACE_SYNTHESIS_ANCHOR` and `PACE_VOICE_PROMPT_CLAUSE` injected for consistent acoustic pacing.
   - Hard batch limits: lowered to `MAX_TTS_BATCH_TURNS = 6` and `MAX_TTS_BATCH_CHARS = 1500` across both solo and cast branches to prevent pacing compression on long segments.
   - Maintained the Exact-2 Speaker Rule for Gemini `multiSpeakerVoiceConfig`.
7. **Multimodal Speech-to-Text Dictation API (`server/routes/adminTranscribe.ts`):**
   - Route `POST /api/admin/transcribe` secured with `requireAdmin`.
   - Route-level `express.json({ limit: '12mb' })` mounted before the global 1mb parser in `server/app.ts`.
   - Strips data URL prefix (`data:audio/...;base64,`), validates base64 content, rejects payloads > 8MB decoded with 413, enforces supported `audio/*` MIME types, and strips audio codec parameters (`audio/webm;codecs=opus` -> `audio/webm`) before calling Gemini `inlineData`.
   - Injectable `transcribeAudio` implemented on `StoryLLMProvider` using `config.geminiTextModel`.

---

## 2. Phase 9 Validation Gate Matrix

| Validation Gate | Requirements & Contract Verified | Test File | Status |
| :--- | :--- | :--- | :--- |
| **Gate 1: Staged Draft Preview & Saved-Voice Protection** | Unsaved prompt calls `createPromptedVoice` (never Kore); returns `X-Draft-Voice-Name`; draft reuse skips create; regenerateTake deletes old draft take using bare ID; saved voice ID cannot be deleted during draft discard/take change | `tests/phase9VoiceLifecycle.test.ts` | **PASS** |
| **Gate 2: Promotion-on-Save & Preview WAV Cache** | `createAndSaveVoice` promotes staged ID without calling `createPromptedVoice`; rejects duplicate staged ID with 409; caches preview WAV; sets `preview_audio_url` and `default_pace`; `GET /api/voices/:id/preview.wav` serves 200, 206 Range, 416, 404 | `tests/phase9VoiceLifecycle.test.ts` | **PASS** |
| **Gate 3: Voice Entry CRUD & Invariants** | `PATCH /api/voices/:id` updates metadata and default_pace; `DELETE /api/voices/:id` rejects prebuilt with 400; removes designed voice, deletes preview, calls `deleteCustomVoice`; `DELETE /draft/:geminiVoiceName` protects saved voices with 409 | `tests/phase9VoiceLifecycle.test.ts` | **PASS** |
| **Gate 4: Single-Call Direct Script & Anti-Rush** | `directScript` makes exactly 1 LLM call; system prompt separates theatrical energy from tempo; `validators.ts` preserves emotional adjectives; test turns retain rich style tags | `tests/phase9VoiceLifecycle.test.ts` | **PASS** |
| **Gate 5: Audio Pacing Guardrails & Batch Limits** | `sanitizeLiteralTempoPhrases` neutralizes speed commands, preserves emotion, clamps <= 280 chars; pace anchors injected; batch turns <= 6 and chars <= 1500 in solo & cast; Exact-2 speaker rule enforced | `tests/phase9VoiceLifecycle.test.ts`, `tests/ttsSynthesis.test.ts` | **PASS** |
| **Gate 6: Multimodal Transcribe STT API** | Auth gate requires admin; accepts audio payloads up to 8MB decoded; rejects > 8MB with 413; strips base64 prefix and audio codecs; returns `{ text }` from mocked STT | `tests/phase9VoiceLifecycle.test.ts` | **PASS** |
| **Regression & System Verification** | Native NodeNext ESM build passes; all existing pipeline, TTS, storage, and E2E tests pass without regressions | `tests/esm-build.test.ts`, `tests/e2e/*.spec.ts` | **PASS** |

---

## 3. Test Execution Verification

All tests run inside WSL Ubuntu-26.04 (`/home/ubuntu/story-wizard`):

### 1. TypeScript Strict Check (`npm run typecheck`):
```bash
> storyteller-studio@1.0.0 typecheck
> tsc --noEmit
Exit code: 0
```

### 2. Server NodeNext ESM Check (`npx tsc -p tsconfig.server.json`):
```bash
Exit code: 0
```

### 3. Unit & Integration Test Suite (`npm test`):
```bash
 RUN  v3.2.7 /home/ubuntu/story-wizard

 ✓ tests/jobManager.test.ts (7 tests)
 ✓ tests/deploymentConfig.test.ts (27 tests)
 ✓ tests/wav.test.ts (6 tests)
 ✓ tests/validators.test.ts (19 tests)
 ✓ tests/ttsSynthesis.test.ts (6 tests)
 ✓ tests/storageAndAuth.test.ts (31 tests)
 ✓ tests/pipelineApi.test.ts (12 tests)
 ✓ tests/phase9VoiceLifecycle.test.ts (34 tests)
 ✓ tests/ui.test.tsx (23 tests)
 ✓ tests/esm-build.test.ts (1 test)

 Test Files  10 passed (10)
      Tests  166 passed (166)
   Duration  5.40s
Exit code: 0
```

### 4. Production Client & Server Build (`npm run build`):
```bash
> storyteller-studio@1.0.0 build
> tsc -p tsconfig.server.json && vite build

vite v6.4.5 building for production...
✓ 38 modules transformed.
dist/client/index.html                   1.18 kB │ gzip:   0.60 kB
dist/client/assets/index-DPu3aSxL.css   12.71 kB │ gzip:   2.96 kB
dist/client/assets/index-plY_cjk-.js   551.03 kB │ gzip: 150.42 kB
✓ built in 1.99s
Exit code: 0
```

### 5. Playwright End-to-End Regression Test Suite (`npm run test:e2e`):
```bash
> storyteller-studio@1.0.0 test:e2e
> npm run seed && npm run build && playwright test

Running 8 tests using 1 worker

  ✓ 1 [chromium] › tests/e2e/qa-phase5.spec.ts:47:3 › Phase 5 Public Library & Kinetic Construct Visual Audit (1.5s)
  ✓ 2 [chromium] › tests/e2e/qa-phase5.spec.ts:198:3 › Phase 5 Formatted Reader & Docked Audio Player with HTTP 206 Range Scrubbing (1.3s)
  ✓ 3 [chromium] › tests/e2e/qa-phase5.spec.ts:396:3 › Phase 5 Admin Director & Voice Studio Audit (3.5s)
  ✓ 4 [chromium] › tests/e2e/storybook.spec.ts:30:3 › Phase 2 Public Storybook E2E (1.0s)
  ✓ 5 [chromium] › tests/e2e/storybook.spec.ts:189:3 › Phase 3 Admin Director Studio E2E (2.1s)
  ✓ 6 [chromium] › tests/e2e/storybook.spec.ts:304:3 › Phase 4 Voice Audition Studio & Versions E2E (1.7s)
  ✓ 7 [chromium] › tests/e2e/storybook.spec.ts:412:3 › Phase 4 Voice Audition Studio & Versions E2E (Phase 6) (1.6s)
  ✓ 8 [chromium] › tests/e2e/storybook.spec.ts:549:3 › Phase 4 Voice Audition Studio & Versions E2E (Phase 7) (4.5s)

  8 passed (19.1s)
Exit code: 0
```

---

## 4. Architectural Decisions & Guardrails Compliance

1. **Zero Unapproved Dependencies:**
   - No new npm packages were added. All functionality was implemented using existing packages (`@google/genai`, `express`, `cookie-parser`).
2. **NodeNext Explicit `.js` Relative Imports:**
   - Every internal import in new files (`server/routes/adminTranscribe.ts`, `shared/voiceSamples.ts`, `tests/phase9VoiceLifecycle.test.ts`) and modified files incorporates the explicit `.js` extension required by NodeNext ESM.
   - Dynamic imports tested and verified in `tests/esm-build.test.ts`.
3. **Saved-Voice Protection Invariant:**
   - Both draft preview take regeneration and explicit draft deletion route (`DELETE /api/admin/voices/draft/:geminiVoiceName`) verify that the voice name does not belong to any voice in `voices.json`.
   - On draft replacement during preview, deletion is a silent no-op if the ID is a saved voice. On the explicit draft deletion route, a 409 Conflict is returned.
4. **Google GenAI Voices Bare ID Requirement:**
   - `@google/genai` constructs API paths by percent-encoding voice IDs. Passing `'voices/voice_...'` results in `'.../voices/voices%2Fvoice_...'`, failing with 404/400.
   - `TtsProvider.deleteCustomVoice` strips the prefix (`replace(/^voices\//, '')`) and validates against `/^voice_[a-zA-Z0-9_-]+$/`.
5. **Exact-2 Speaker Rule Preservation:**
   - In `synthesizeFullStory`, Gemini's `multiSpeakerVoiceConfig` is used strictly when there are exactly 2 unique speakers in the batch. If 1 unique speaker is present, single `voiceConfig` is used.
6. **Large Payload Route-Level Body Parsers:**
   - Registered `express.json({ limit: '12mb' })` on `/api/admin/transcribe` and `express.json({ limit: '4mb' })` on `/api/admin/voices` before the global 1mb JSON body parser in `server/app.ts`.
7. **E2E Playwright Isolation:**
   - Explicitly configured `GCS_BUCKET_NAME=""` in `playwright.config.ts` web server launch command so that the E2E runner consistently serves from the seeded `./data` directory rather than attempting to connect to external GCS.

---

## 5. Modified and Added Files

### Added Files:
- `shared/voiceSamples.ts`: Sample presets, char limit constant, default sample.
- `server/routes/adminTranscribe.ts`: Transcribe audio route with 12MB limit, auth guard, codec stripper, STT provider call.
- `tests/phase9VoiceLifecycle.test.ts`: Comprehensive test suite containing 34 tests validating all 6 gates, error cases, and storage methods.
- `docs/audits/phase-9-audit.md`: This audit report.

### Modified Files:
- `shared/types.ts`: `VoicePace`, `VoiceSamplePreset`, `VoiceEntry.default_pace?`, `VoiceCasting.pace?`.
- `server/storage/storageAdapter.ts`: `saveVoicePreview`, `deleteVoicePreview`, `getVoicePreviewStream` signatures.
- `server/storage/localStorage.ts`: Implemented preview storage methods and slug validator.
- `server/storage/gcsStorage.ts`: Implemented GCS preview storage methods.
- `server/routes/public.ts`: Extracted `streamAudioWithRange` helper, added `GET /api/voices/:id/preview.wav`.
- `server/routes/adminVoices.ts`: Staged voice preview, promotion, draft deletion, CRUD operations, pace validation.
- `server/services/geminiTts.ts`: Staged draft preview, `deleteCustomVoice`, pacing guardrails, batch caps, promotion.
- `server/services/geminiStory.ts`: Anti-rush prompt tuning, `transcribeAudio` provider method.
- `server/app.ts`: Body parser registration ordering, transcribe router mount.
- `client/api/client.ts`: Backward-compatible parameter signatures for voice preview & create.
- `scripts/smokePhase4Live.ts`: Updated to read `.wav` from `PreviewVoiceResult`.
- `playwright.config.ts`: Added `GCS_BUCKET_NAME=""` to test server command.
- `tests/ttsSynthesis.test.ts`: Updated batch count assertions for 6-turn limits.
- `tests/esm-build.test.ts`: Added `adminTranscribe.js` and `voiceSamples.js` verification.
