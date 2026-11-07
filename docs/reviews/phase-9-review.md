# Phase 9 Architectural & Code Review

> **Reviewer:** Lead Architect & Orchestrator
> **Reviewed Commit:** `db367b8` (`feat(phase-9): staged voice lifecycle, pacing guardrails, and multimodal transcribe api`)
> **Target Subagent:** `efe2abad-db70-4d71-9dcc-d55d29b8fa8c` (`Phase 9 Voice Lifecycle Builder`)
> **Status:** Open items require remediation and regression tests before `phase-9-verified` tag

Firsthand verification: `typecheck`, `tsc -p tsconfig.server.json`, `npm test` (166/166), `build`, `test:e2e` (8/8) all green in WSL. Zero extensionless relative imports. `ai.voices.delete(id: string)` signature confirmed against installed `.d.ts`. The items below are correctness/robustness gaps found by line-by-line reading.

---

## Actionable Review Checklist

- [x] **1. [HIGH] Fragile string-matched HTTP status mapping + wrong status for unknown voices (`server/routes/adminVoices.ts:137-145, 193-200`; `server/services/geminiTts.ts` `updateVoice`/`deleteVoice`/`discardDraftVoice`/`createAndSaveVoice`):**
  - **Issue:** 409 is derived from `err.message.includes('already exists')` / `includes('currently saved')`. Any reworded message silently downgrades to 400. Unknown voice IDs in `PATCH`/`DELETE /api/admin/voices/:id` and `previewVoice({voiceId})` throw `ValidationError` → 400 instead of 404.
  - **Fix:** Introduce typed `ConflictError` (409) and `NotFoundError` (404) (e.g. in `server/lib/validators.ts` or a small `server/lib/errors.ts`) and map them centrally (existing error middleware or the route handlers by `instanceof`, not message text). Use `ConflictError` for staged-ID collision and saved-voice draft protection; `NotFoundError` for missing voices. Add tests: `PATCH /api/admin/voices/does-not-exist` → 404, `DELETE /api/admin/voices/does-not-exist` → 404, preview with unknown `voiceId` → 404.

- [x] **2. [HIGH] `createAndSaveVoice` preview caching is not best-effort (`server/services/geminiTts.ts:532-552`):**
  - **Issue:** Spec says the fallback preview synthesis is *best-effort*. Currently if `previewVoice(...)` (fallback path) or `saveVoicePreview` throws, the whole save fails AFTER `createPromptedVoice` already created a stored Gemini voice → orphaned `voice_...` and user-visible failure. Also an invalid `previewWavBuffer` (garbage/non-audio base64) is silently wrapped as PCM noise.
  - **Fix:** (a) Validate `previewWavBuffer`: must be a RIFF/WAVE buffer (or reject with 400 at the route: `previewAudioBase64 must be a WAV file`). (b) Wrap fallback synthesis + `saveVoicePreview` in try/catch; on failure persist the voice WITHOUT `preview_audio_url`. (c) If `voices.json` persistence fails after a fresh (non-staged) `createPromptedVoice`, best-effort `deleteCustomVoice` the orphan. Tests: fallback synthesis throws → 201 with no `preview_audio_url`; non-WAV `previewAudioBase64` → 400 and `createPromptedVoice` not called.

- [x] **3. [MEDIUM] Missing coverage for required invariants (`tests/phase9VoiceLifecycle.test.ts`):**
  - **Issue:** Several spec invariants are implemented but untested or weakly asserted.
  - **Fix:** Add tests for:
    - Cast mode **single-speaker sub-batch** uses `speechConfig.voiceConfig` and has NO `multiSpeakerVoiceConfig` (e.g. Narrator ×3, then Pip+Narrator, then a 3rd speaker forcing a split).
    - Cast mode per-speaker `default_pace` fallback when `casting.pace` is unset (Narrator `prebuilt-kore` → `natural` anchor, `designed-saved-hero` → `lively` anchor) and `casting.pace` overriding both.
    - Solo mode falls back to `narratorVoice.default_pace` when `casting.pace` unset; persisted `AudioVersion.casting.pace` equals the request value.
    - Case A preview (`voiceId: 'designed-saved-hero'`): `createPromptedVoice` NOT called, no `X-Draft-Voice-Name` header, `voiceConfig` equals `{ voice: 'voice_saved_hero_123' }`, style contains `PACE_SYNTHESIS_ANCHOR.lively`.
    - Sample text longer than 320 chars is clamped to exactly `MAX_VOICE_PREVIEW_CHARS`.
    - Regenerate-take test: assert `deleteVoiceCalls` `toEqual(['voice_draft_dragon_99'])` (exact) and that changing `draftGeminiVoiceName` vs `previousDraftGeminiVoiceName` without `regenerateTake` deletes the previous one but reuses the new draft.
    - `POST /api/admin/voices` accepts a JSON body > 1MB (≤ 2MB preview) proving the `4mb` route parser precedes the global `1mb` parser.
    - `401` without cookie on `POST /api/admin/voices/preview`, `PATCH`, `DELETE /voices/:id`, and `DELETE /voices/draft/:name`.
    - Non-staged save path (no `stagedGeminiVoiceName`) calls `createPromptedVoice` exactly once with the pace clause appended and caches `sampleAudioWav`.

- [x] **4. [LOW] Tempo rewrite produces broken grammar (`server/services/geminiTts.ts:207`):**
  - **Issue:** `"as he runs full speed toward the exit"` → `"as he with playful urgency toward the exit"` (the verb is deleted). This degrades the acting note the TTS model reads.
  - **Fix:** Keep the verb: `(runs|running) full speed` → `$1 with playful urgency` (→ `"as he runs with playful urgency toward the exit"`). Update the table test accordingly.

- [x] **5. [LOW] Clamp cuts mid-word (`sanitizeLiteralTempoPhrases` / `buildTurnStyle`):**
  - **Issue:** `slice(0, N)` can cut words in half; spec asks for clean clamping.
  - **Fix:** Clamp at the last whitespace/punctuation boundary ≤ N (strip trailing `,;:`). Test that a clamped result does not end with a partial word from the input.
