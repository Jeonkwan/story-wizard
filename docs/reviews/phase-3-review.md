# Phase 3 Architect Code & Visual Review

> **Reviewed Commit:** `dea4240` (`feat(phase-3): admin director studio, writer-director pipeline, and sequel mode`)  
> **Reviewer:** Lead Architect & Orchestrator  
> **Target Builder:** Phase 3 Admin Studio & Pipeline Subagent (`2e9fb993-3796-4687-9178-3dd5619ba2c2`)

---

## Summary
The `GeminiStoryService` (`gemini-3.8-flash` structured output), Mode A / Mode B sequel continuity, admin REST endpoints, Dark Slate two-column `DirectorStudio` UI (`qa-screenshots/phase3-admin-studio.png`), and live Gemini 3.8 smoke verification are cleanly structured.

Independent line-by-line review of `server/**`, `client/**`, and `tests/**` uncovered **6 concrete edge-case & workflow bugs** to resolve before tagging `phase-3-verified`. Check off `[x]` every item below, add regression tests, update `docs/audits/phase-3-audit.md`, and commit `fix(phase-3): address code review findings`.

---

## Actionable Findings

- [x] **1. [Bug — Validator] `splitTextAtSentenceBoundaries` Can Tear `<short pause>` Across Word Splits or Emit Tag-Only Trailing Chunks**
  - **Evidence:** In `server/lib/validators.ts`, `validateManualStoryEdit` preserves multi-word vocal tags (`<short pause>`, `<long pause>`) and then calls `splitTextAtSentenceBoundaries(sanitizedText, 600)` (line 522).
    1. If a `> 600`-char turn lacks sentence punctuation, `trimmed.split(/\s+/)` (line 59) splits `<short pause>` into `"<short"` and `"pause>"`, tearing the vocal tag in half at a chunk boundary!
    2. If a `~595`-char sentence ends with trailing `<short pause>`, `sentenceRegex` matches `<short pause>` as a trailing non-punctuation segment; since `595 + 14 > 600`, `splitTextAtSentenceBoundaries` emits `"<short pause>"` as a standalone `ScriptTurn` (`cleanTextForReader(chunk) === ""`), which then fails `validateManualStoryEdit` (`has empty text`) on the very next save!
  - **Required Fix:**
    1. In `splitTextAtSentenceBoundaries`, tokenize whitespace-fallback keeping `<[^>]+>` angle-bracket tags intact as atomic tokens so `<short pause>` / `<long pause>` are never split mid-tag.
    2. Post-process split chunks in `validateManualStoryEdit` (or `splitTextAtSentenceBoundaries`): if any chunk has `cleanTextForReader(chunk) === ''` (contains only vocal tags), merge it into the adjacent chunk rather than creating a tag-only `ScriptTurn`.
    3. Add unit tests in `tests/validators.test.ts` covering both cases (`> 600`-char unpunctuated text containing `<short pause>` near index `598`, and a `595`-char sentence followed by `<short pause>`).

- [x] **2. [Workflow Bug — UI Data Loss] Clicking `"2. Auto-Direct Voices & Pacing"` Wipes Unsaved Workbench Edits**
  - **Evidence:** In `client/components/DirectorStudio.tsx` (`handleAutoDirect`, lines 199–214), if an admin edits `editedTitle`, `editedSummary`, `editedTags`, `editedCharacters`, or `editedTurns` and then clicks `"🎬 2. Auto-Direct Voices & Pacing"` at the top of the workbench without having scrolled down to click `"💾 Save Script"`, `handleAutoDirect` calls `POST /api/admin/stories/:id/direct` against the stale disk `story.json` and overwrites `activeStory` and `editedTurns`—silently discarding all unsaved prose/character edits!
  - **Required Fix:**
    1. Track `isDirty` (or always persist current `editedTitle`, `editedSummary`, `editedTags`, `editedCharacters`, `editedTurns` via `saveStoryEdits` right before calling `directStory(activeStory.id)` when `isDirty` is true), and sync all local state fields from the directed response.
    2. Add a component test in `tests/ui.test.tsx` verifying that modifying a turn's text and clicking `"2. Auto-Direct Voices & Pacing"` calls `saveStoryEdits` before `directStory` so unsaved prose edits are preserved.

- [x] **3. [State Bug — UI Speaker Sync] Renaming or Deleting a Character Orphans Turn `speaker` References**
  - **Evidence:** In `client/components/DirectorStudio.tsx` (`handleCharacterChange` & `handleDeleteCharacter`, lines 285–302), renaming character `"Bibi"` -> `"Bobo"` or deleting `"Bibi"` leaves existing turns with `turn.speaker === "Bibi"`. Because `"Bibi"` is no longer an `<option>` in the speaker `<select>`, HTML `<select>` visually displays `"Narrator"` while React state retains `"Bibi"`, causing `"💾 Save Script"` to fail with `400 Unknown speaker: "Bibi"`.
  - **Required Fix:**
    1. In `handleCharacterChange`, when `field === 'name'`, update any `editedTurns` whose `turn.speaker === prevName` (when `prevName` was non-empty) to the new character name.
    2. In `handleDeleteCharacter`, reset any `editedTurns` whose `turn.speaker === deletedChar.name` back to `'Narrator'`.
    3. Add a unit/component test in `tests/ui.test.tsx` verifying character rename updates turn speakers cleanly.

- [x] **4. [Race Condition — Google Sign-In] `AdminLoginGate` Misses Async GSI Script Load**
  - **Evidence:** `index.html` loads `<script src="https://accounts.google.com/gsi/client" async defer></script>`. In `client/components/AdminLoginGate.tsx` (lines 67–99), `GET /api/admin/me` resolves in `< 10ms` locally/on Cloud Run, often before the external GSI script finishes loading. When `window.google?.accounts?.id` is not yet defined at `t=10ms`, the effect exits and never renders the Google Sign-In button once the script finishes loading.
  - **Required Fix:** If `session?.googleClientId` is non-empty and `!window.google?.accounts?.id`, attach a `load` event listener to `document.querySelector('script[src*="accounts.google.com/gsi/client"]')` (with cleanup on unmount) so `initialize` + `renderButton` runs as soon as the script loads.

- [x] **5. [Backend Robustness] `seriesId` Hyphen Trimming & Safe LLM JSON Parsing in `GeminiStoryService`**
  - **Evidence:**
    1. In `server/services/geminiStory.ts` (lines 300–304), `input.seriesId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-')` does not collapse multiple hyphens or strip leading/trailing hyphens (unlike `generateStorySlug`), so an admin typing `"Sleepy Train!"` produces `"sleepy-train-"` or `"-train"` (which fails `SLUG_REGEX` if leading hyphen).
    2. Lines 192 & 251 call `JSON.parse(response.text ?? '{}')` directly; if the model ever wraps JSON in markdown fences or truncates output on quota/token limits, `SyntaxError` bubbles as `500` instead of `ValidationError` (`400`).
  - **Required Fix:**
    1. Normalize `seriesId` with `.replace(/[^a-z0-9-_]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '')` before `validateSlug`.
    2. Add a small `parseLLMJson<T>(rawText: string | undefined, stage: string): T` helper in `geminiStory.ts` that strips optional ````json ... ```` fences and wraps `JSON.parse` errors in `ValidationError`. Add unit coverage in `tests/pipelineApi.test.ts`.

- [x] **6. [E2E Verification] Verify Reloaded Text Value & Restore Seeded Story State**
  - **Evidence:** In `tests/e2e/storybook.spec.ts` (lines 224–237), after clicking `<short pause>`, saving, and calling `page.reload()`, line 237 only checks `toBeVisible()` on `textarea` without asserting that `toHaveValue(/<short pause>/)` actually persisted across reload, and leaves an extra `<short pause>` mutated on disk.
  - **Required Fix:** Record the initial `textarea` value before editing, insert a distinctive edit + `<short pause>`, save, `page.reload()`, assert the reloaded `textarea` `inputValue()` contains both the edit and `<short pause>`, and then restore & save the original text so `./data/` remains idempotent. Also scroll or capture so `qa-screenshots/phase3-admin-studio.png` stays crisp!
