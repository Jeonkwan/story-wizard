# Phase 2 Architect Code & Visual Review

> **Reviewed Commit:** `63cec83` (`feat(phase-2): kinetic construct public reader and docked audio player`)  
> **Reviewer:** Lead Architect & Orchestrator  
> **Target Builder:** Phase 2 Frontend & E2E Subagent (`403e3d9b-a5c4-418f-86b4-a14a9090924b`)

---

## Summary
The Kinetic Construct typography, formatted reader layout, vocal tag stripping, search/tag/series catalog filtering, and Playwright WAV Range-seeking integration are well structured. However, independent visual inspection of `qa-screenshots/phase2-reader-dark.png` and code review of `client/**` uncovered **4 concrete issues** (including a critical Dark Mode button contrast flash bug visible in the screenshot).

Resolve every item below, check them off `[x]`, add regression assertions, re-capture screenshots, update `docs/audits/phase-2-audit.md`, and commit `fix(phase-2): address code and visual review findings`.

---

## Actionable Findings

- [x] **1. [Critical Visual & Accessibility] Dark Mode `.btn-tactile` White-on-Light Contrast Flash & Missing `color-scheme`**
  - **Evidence:** In `qa-screenshots/phase2-reader-dark.png`, `.btn-tactile` buttons (`☀️ Light Mode`, `🎙️ Director Studio`, `← Back to Library`, `1.0x`) rendered with a bright near-white background (`~#EAEBEE`) and `#F1F5F9` light text (unreadable!), and `.btn-tactile-primary` (`▶ Play`) rendered `#E0E7FF` instead of `#1E1B4B`.
  - **Root Causes:**
    1. In `client/styles/kinetic.css` (line 112), `.btn-tactile` has `transition: transform 0.1s ease, box-shadow 0.1s ease, background-color 0.15s ease;` (and `.tag-pill` has `transition: all 0.15s ease;`) without matching `color` transition—causing `color` to jump instantaneously to `#F1F5F9` while `background-color` lags for 150ms during theme switches (causing a white-on-white flash in real usage and in immediate screenshots).
    2. `:root` and `:root[data-theme="dark"], body[data-theme="dark"]` lack `color-scheme: light;` / `color-scheme: dark;`, and `.select-tactile option` lacks explicit `background-color: var(--bg-surface); color: var(--ink-primary);`, which causes native `<select>` dropdown popups on Windows/Chromium to render white popup backgrounds with light text.
  - **Required Fix:**
    1. Remove `background-color` from `.btn-tactile` transition (`transition: transform 0.1s ease, box-shadow 0.1s ease;`) and change `.tag-pill` transition to `transition: border-color 0.1s ease;` so theme switches update all surfaces and text instantaneously in lockstep without contrast flash.
    2. Add `color-scheme: light;` to `:root`, `color-scheme: dark;` to `:root[data-theme="dark"], body[data-theme="dark"]`, and explicit `.select-tactile option { background-color: var(--bg-surface); color: var(--ink-primary); }`.
    3. Add a tiny inline theme-init `<script>` in `index.html` `<head>` that checks `localStorage.getItem('story_theme') === 'dark'` and sets `data-theme="dark"` on `document.documentElement` before first paint to prevent reload flash.
    4. In `tests/e2e/storybook.spec.ts`, after toggling Dark Mode, explicitly assert via `getComputedStyle` that `.btn-tactile` (`themeBtn`) has dark background `rgb(22, 31, 44)` (`#161F2C`) and light text `rgb(241, 245, 249)` (`#F1F5F9`), and `.btn-tactile-primary` (`Play`) has background `rgb(30, 27, 75)` (`#1E1B4B`), then re-capture `qa-screenshots/phase2-reader-dark.png` and `qa-screenshots/phase2-reader-light.png`.

- [x] **2. [Bug] `AudioPlayerBar` Silently Loses `0.9x` `playbackRate` & Active Playback Reset on Version Switch**
  - **Evidence:** In `client/components/AudioPlayerBar.tsx`, when a user toggles speed to `0.9x` and then switches the Audio Version `<select>`, changing `<audio src={activeVersion.audio_url} />` causes HTMLMediaElement's media load algorithm to reset `audio.playbackRate` back to `1.0`, while React state still displays `0.9x`!
  - **Required Fix:**
    1. When `activeVersion.version_id` changes, explicitly pause `audioRef.current`, reset `audioRef.current.currentTime = 0`, and re-apply `audioRef.current.defaultPlaybackRate = playbackRate` and `audioRef.current.playbackRate = playbackRate` (also re-apply `playbackRate` inside `handleLoadedMetadata` so browser media load never overrides it).
    2. Add a unit test in `tests/ui.test.tsx` verifying that toggling speed to `0.9x` and then switching audio versions preserves `audioElement.playbackRate === 0.9`.

- [x] **3. [Routing & History Consistency] Centralize `pushState` & Support `/stories/:id` Back/Forward Navigation**
  - **Evidence:** `Masthead.tsx` calls `window.history.pushState` inside `handleNav` while `App.tsx` (line 120) also manually calls `window.history.pushState` before `handleNavigate('/')`. Meanwhile, opening a story (`handleSelectStory`) does not update the URL (`/stories/:id`), so clicking Browser Back exits the app instead of returning to the library, and refreshing `/stories/:id` loses the open story.
  - **Required Fix:**
    1. Centralize `window.history.pushState` inside `App.tsx` (only pushing when `window.location.pathname !== nextPath` so clicking the current nav item never creates duplicate history entries) and remove duplicate `pushState` from `Masthead.tsx` (keep `Masthead` calling `onNavigate(targetPath)` or falling back to `pushState` only if `onNavigate` is omitted in standalone unit tests).
    2. Support `/stories/:id` cleanly in `App.tsx`: `handleSelectStory(id)` navigates to `/stories/${encodeURIComponent(id)}`, `handleBackToLibrary` navigates to `/`, and when `currentPath` matches `/^\/stories\/([^/]+)$/` (on initial load or `popstate` browser Back/Forward), load that story automatically (or clear `activeStory` when `popstate` returns to `/`).
    3. Add an assertion in `tests/e2e/storybook.spec.ts` (or `tests/ui.test.tsx`) verifying `/stories/2026-11-04-sleepy-little-train` URL updates on opening a story and `page.goBack()` returns cleanly to the catalog.

- [x] **4. [Reader & Mobile Clearance] Empty-After-Cleaning Turn Guard & Mobile Docked Player Clearance**
  - **Evidence:**
    1. In `client/components/StoryReader.tsx` (lines 50–82), if a turn contains only vocal tags (e.g., `<sigh>` or `<long pause>`), `cleanTextForReader` returns `""`, causing `StoryReader` to either consume `hasRenderedFirstNarrator` on an empty `<p>` (stealing the drop-cap!) or render empty quotes `“”`.
    2. Line 14 hardcodes inline `style={{ paddingBottom: '110px' }}`, overriding `.reader-wrapper { padding-bottom: 120px; }` in `kinetic.css`. On mobile (`<= 768px`), `.docked-audio-content` stacks vertically to ~155–170px tall, which can overlap the bottom of the last paragraph.
  - **Required Fix:**
    1. In `StoryReader.tsx`, if `!cleanedText`, return `null` before touching `hasRenderedFirstNarrator`. Remove inline `style={{ paddingBottom: '110px' }}` so `kinetic.css` controls `.reader-wrapper` spacing.
    2. In `client/styles/kinetic.css` inside `@media (max-width: 768px)`, set `.reader-wrapper { padding-bottom: 195px; }`.
    3. Add a unit test case in `tests/ui.test.tsx` verifying that a tag-only leading narrator turn (`"<long pause>"`) is omitted and the next real narrator turn receives `.opening-narration`.
