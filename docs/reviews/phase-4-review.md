# Phase 4 Architectural & Code Review

> **Reviewer:** Lead Architect & Orchestrator  
> **Reviewed Commit:** `5b021bd` (`feat(phase-4): voice audition studio, chunked gemini 3.8 tts, and cloud run dockerfile`)  
> **Target Subagent:** `da622836-7d4c-4b59-9229-2a04ab0afb5e` (`Phase 4 Voice Studio, TTS Engine & Cloud Run Builder`)  
> **Status:** Open items require remediation, regression tests, and fresh Docker + E2E verification before `phase-4-verified` tag

---

## Summary Assessment

The core Phase 4 architecture in `5b021bd` is well-structured:
- `GeminiTtsService` cleanly enforces the **Gemini 3.8 TTS Multi-Speaker Exact-2 Rule** (`distinctSpeakers.length === 1` -> single `voiceConfig`, `distinctSpeakers.length === 2` -> `multiSpeakerVoiceConfig` with `speakerVoiceConfigs.length === 2`).
- RIFF WAV de-duplication (`extractPcmFromWavOrRaw` + `N - 1` `createSilencePcm(150)` pads + single `wrapPcmAsWav`) produces clean 24kHz 16-bit mono WAV files with zero embedded mid-stream `"RIFF"` headers.
- Visual inspection of `qa-screenshots/phase4-voice-studio.png` confirms clean Kinetic Construct Dark Mode rendering at `1440x900`, and container inspection confirms non-root `USER node` execution and zero `.env` leakage inside `/app`.

However, independent verification uncovered **1 `tsc --noEmit` build failure** and **5 real-world functional/edge-case bugs** that must be resolved before tagging `phase-4-verified`.

---

## Actionable Review Checklist

- [ ] **1. [CRITICAL] Fix TypeScript Strictness Failure in `scripts/smokePhase3Live.ts` (`npm run typecheck`):**
  - **Issue:** `npm run typecheck` (`tsc --noEmit`) currently fails with `TS7006` at `scripts/smokePhase3Live.ts:75` and `:82` (`Parameter 't' implicitly has an 'any' type`, `Parameter 'v' implicitly has an 'any' type`) introduced when retry loops typed `draft` and `directed` as `any`.
  - **Fix:** Import `type { Story } from '../shared/types.js'`, declare `let draft: Story | null = null;` and `let directed: Story | null = null;`, and add `if (!draft) throw new Error(...)` / `if (!directed) throw new Error(...)` guards after each retry loop. Always run `npm run typecheck` as part of final verification before committing.

- [ ] **2. [HIGH] Prevent `DirectorStudio` + `VoiceStudioPanel` from Swallowing Save Failures or Missing Unsaved Characters Before Synthesis:**
  - **Issue A (Error Swallowing -> Stale Disk Synthesis & Data Loss):** `DirectorStudio.tsx` passes `onBeforeSynthesize={handleSaveScript}`, but `handleSaveScript` catches `saveStoryEdits` errors internally without rethrowing. If saving pending script/metadata edits fails validation (`400`), `VoiceStudioPanel.handleSynthesize` proceeds anyway—synthesizing **stale disk data** and then overwriting the user's unsaved workbench state via `onStoryUpdated(updatedStory)`.
  - **Issue B (Unsaved Characters Invisible in Cast Mode):** `DirectorStudio.tsx` passes `story={activeStory}` rather than live `editedCharacters` to `VoiceStudioPanel`. If an admin adds or renames a character in the Characters Bible and switches to **Multi-Speaker Cast** before clicking *"Save Script"*, the character is missing from `VoiceStudioPanel`'s character voice selectors, causing Cast synthesis to fail with `400 Missing or invalid voice for character`.
  - **Fix:**
    1. Extract `persistWorkbenchEdits(): Promise<Story>` in `DirectorStudio.tsx` that persists pending edits, syncs `activeStory` / `editedTurns`, and **throws** on error. Pass `onBeforeSynthesize={async () => { await persistWorkbenchEdits(); }}` so `VoiceStudioPanel` aborts synthesis and displays the error in `synthError` if saving fails (while `handleSaveScript` catches errors from `persistWorkbenchEdits` for the bottom *"Save Script"* button).
    2. Pass `{ ...activeStory, characters: editedCharacters }` (or an explicit `characters={editedCharacters}` prop) to `VoiceStudioPanel` so live character additions/renames immediately appear in **Multi-Speaker Cast** selectors.
    3. Add a component regression test in `tests/ui.test.tsx` asserting that when `saveStoryEdits` rejects, clicking *"3. Synthesize & Publish Audio"* aborts without calling `synthesizeStoryAudio` and surfaces the error message.

- [ ] **3. [HIGH] Guarantee Built-In Prebuilt Voices Exist Out-of-the-Box on Fresh Cloud Run / Empty GCS or Docker `/app/data` (`server/services/geminiTts.ts`):**
  - **Issue:** On a fresh Cloud Run deployment (empty GCS bucket) or fresh Docker container (`/app/data` without running `npm run seed`), `voices.json` does not exist yet, causing `GET /api/admin/voices` to return `[]` and leaving `VoiceStudioPanel` with zero selectable prebuilt voices (`Kore`, `Puck`, `Aoede`).
  - **Fix:**
    1. Export `DEFAULT_PREBUILT_VOICES: VoiceEntry[]` (`prebuilt-kore`, `prebuilt-puck`, `prebuilt-aoede`) in `server/services/geminiTts.ts` and implement `async listVoices(): Promise<VoiceEntry[]>` on `GeminiTtsService` that merges `DEFAULT_PREBUILT_VOICES` with stored `voices.json` entries (deduplicating by `id` so stored entries take precedence and all 3 starter prebuilt voices are always present even when `voices.json` is missing/empty).
    2. Use `listVoices()` in `GET /api/admin/voices`, `previewVoice`, and `synthesizeFullStory`, and seed `DEFAULT_PREBUILT_VOICES` when `createAndSaveVoice` initializes `voices.json` from empty/missing state so prebuilt voices are never lost.
    3. Add an integration test in `tests/ttsSynthesis.test.ts` verifying that on a brand-new empty `DATA_DIR` (without calling `storage.saveVoices`), `GET /api/admin/voices` returns the 3 prebuilt voices and `POST /api/admin/stories/:id/synthesize` with `prebuilt-kore` succeeds.

- [ ] **4. [MEDIUM] Fix `VoiceStudioPanel.tsx` `<select>` Dark-Mode Class, Story-Switch State Reset & Default Label Sync:**
  - **Issue:**
    1. `VoiceStudioPanel.tsx` lines 514 and 563 apply `className="input-tactile"` instead of `className="select-tactile"` on `<select>` dropdowns (missing `.select-tactile option` dark-mode styling in `kinetic.css`).
    2. When switching between stories in `DirectorStudio` (`story.id` changes while `VoiceStudioPanel` stays mounted), transient banners (`synthSuccess`, `synthError`, `voiceCreateSuccess`, `voiceCreateError`, `auditionError`, `versionActionError`, `confirmDeleteId`) and `narratorVoiceId` persist from the previous story instead of resetting to the newly selected story's `series_context?.preferred_voice_id`.
    3. Toggling `castingMode` between `'solo'` and `'cast'` leaves `versionLabel` stuck at `'Bedtime Solo'` even if untouched, and `GeminiTtsService.synthesizeFullStory` stores raw `input.casting` without normalizing `character_voices` to `{}` when omitted or in `'solo'` mode.
  - **Fix:**
    1. Change both `<select>` elements in `VoiceStudioPanel.tsx` to `className="select-tactile"`.
    2. Add a `useEffect` keyed on `story.id` in `VoiceStudioPanel.tsx` that calls `stopAudition()`, clears transient banners/confirmations, and resets `narratorVoiceId` / `versionLabel` for the new story.
    3. When switching `castingMode`, if `versionLabel` is `'Bedtime Solo'` (switching to `'cast'`) update it to `'Bedtime Cast'`, and if `'Bedtime Cast'` (switching to `'solo'`) update it to `'Bedtime Solo'`.
    4. In `GeminiTtsService.synthesizeFullStory`, normalize the saved `AudioVersion.casting` object (`character_voices: casting.mode === 'cast' ? { ...filteredCharacterVoices } : {}`).

- [ ] **5. [MEDIUM] Preserve Currently Playing Audio Version in `App.tsx` When Admin Manages Other Versions in `StoryReader`:**
  - **Issue:** In `client/App.tsx` lines 155–163, `StoryReader`'s `onStoryUpdated` callback unconditionally sets `setActiveAudioVersion(defaultVer)`. If an admin is actively listening to `v1` and deletes unused `v2` (or promotes `v2` to default), `AudioPlayerBar` abruptly switches away from `v1` and resets playback to `00:00`.
  - **Fix:** In `App.tsx` `onStoryUpdated`, check if the current `activeAudioVersion?.version_id` still exists in `updatedStory.audio_versions`: if so, update `activeAudioVersion` to that matching `AudioVersion` entry (preserving `version_id` and playback position); only fall back to `defaultVer` (or `null` when `0` versions remain) if the active version was deleted. Add a regression test in `tests/ui.test.tsx`.

- [ ] **6. [LOW] Document Required Cloud Run Production Environment Variables in `deploy.sh`:**
  - **Issue:** `server/config.ts` fails closed on Cloud Run (`K_SERVICE` / `NODE_ENV=production`) if `SESSION_SECRET` (`>= 32` chars) is unset, and production usage requires `GEMINI_API_KEY`, `ADMIN_GOOGLE_EMAIL`, `GOOGLE_CLIENT_ID`, and `GCS_BUCKET_NAME`. `deploy.sh` currently invokes `gcloud run deploy` without documenting these required env vars / Secret Manager flags.
  - **Fix:** Document all required Cloud Run env vars / `--set-secrets` / `--set-env-vars` examples clearly in `deploy.sh` (and print a clear reminder before/after `gcloud run deploy` without ever echoing secret values).
