# Phase 3 Engineering Audit Report: Admin Director Studio, Writer-Director Pipeline & Sequels

> **Target Audience:** Lead Architect / Senior Reviewing Agent  
> **Milestone:** Phase 3 (Admin Director Studio & Pipeline Builder)  
> **Repository:** `/home/ubuntu/story-wizard`  
> **Status:** All Phase 3 Requirements Implemented & Verified (100% Green, 68/68 Vitest Unit/Integration Tests + Live Gemini 3.8 Smoke Test + Playwright Headless Chromium E2E)

---

## 1. Executive Summary & Objective

Phase 3 delivers the full admin creation and direction pipeline for **Storyteller Studio**, enabling creators to write bedtime stories with Gemini 3.8 Flash, direct voice acting, propose custom voice candidates, edit scripts turn-by-turn with quick vocal tags, produce episodic sequels with character continuity, and manage library drafts with atomic storage synchronization.

All requirements outlined in `HANDOFF_PLAN.md` (Sections 4, 5.1–5.2, 6, 7, 8 **PHASE 3**, and 11) have been strictly implemented with zero over-engineering:
- **No external databases or queues:** Atomic JSON and WAV persistence via `StorageAdapter` (`updateJsonAtomic`).
- **Native Node ESM compliance:** Explicit `.js` extensions on all relative imports across `server/**` and `shared/**`.
- **Offline-first test isolation:** Injected `StoryLLMProvider` mocks for all CI tests, plus a live smoke test script confirming real `@google/genai` wire compatibility against `gemini-3.8-flash`.

---

## 2. Architecture & File Layout

```text
/home/ubuntu/story-wizard/
├── server/
│   ├── app.ts                         # Increased JSON body limit to 1MB, mounted admin stories router, mapped ValidationError to 400
│   ├── routes/
│   │   ├── auth.ts                    # Admin auth routes (/login, /logout, /me returning googleClientId), removed probe route
│   │   └── adminStories.ts            # Admin stories router (/stories, /write, /:id/direct, PUT /:id, PATCH status, DELETE /:id)
│   ├── services/
│   │   └── geminiStory.ts             # GeminiStoryService, StoryLLMProvider, GoogleGenAIStoryLLMProvider (gemini-3.8-flash), slug generation
│   └── lib/
│       └── validators.ts              # Added validateManualStoryEdit (tag sanitizer, case normalizer, cleanTextForReader non-empty check)
├── client/
│   ├── api/
│   │   └── client.ts                  # Typed admin API helpers (fetchAdminSession, writeStoryDraft, directStory, saveStoryEdits, etc.)
│   ├── App.tsx                        # Routed /admin to AdminLoginGate, auto-refreshes public catalog on navigation
│   ├── styles/
│   │   └── kinetic.css                # Responsive two-column studio grid, tactile badges, turn cards, mobile collapse <= 900px
│   └── components/
│       ├── AdminLoginGate.tsx         # Google OAuth button + conditional Dev Sandbox Login gated on devBypassEnabled
│       └── DirectorStudio.tsx         # Two-column creation/edit workbench, quick vocal tag pill inserter, character bible editor
├── scripts/
│   └── smokePhase3Live.ts             # Conditional live smoke script testing real Gemini 3.8 Flash writer & director pipeline
├── tests/
│   ├── validators.test.ts             # 17 unit tests including validateManualStoryEdit
│   ├── pipelineApi.test.ts            # 6 integration tests covering Gates 1–6 (Mode A/B, Draft isolation, Guardrails, Delete)
│   ├── ui.test.tsx                    # 8 jsdom component tests including AdminLoginGate & DirectorStudio quick-tag insertion
│   ├── esm-build.test.ts              # Verified plain node dynamic imports of geminiStory.js & adminStories.js
│   └── e2e/
│       └── storybook.spec.ts          # Playwright Chromium E2E: Admin login, quick-tag editing, saving, dark mode, mobile 375x812
└── qa-screenshots/
    └── phase3-admin-studio.png        # 1440x900 Dark Mode screenshot of Director Studio workbench
```

---

## 3. Detailed Component Implementations

### 3.1 Validator Enhancement for Manual Admin Edits (`server/lib/validators.ts`)
- Added `validateManualStoryEdit(raw: WriterOutputInput): ValidatedWriterOutput`.
- Enforces all core invariants: non-empty trimmed `title` and `summary`, lowercased deduplicated `tags`, unique non-`"Narrator"` characters, `>= 2` turns, contiguous `turn_id` `1..N`, valid canonical `speaker`, style trimmed to `<= 200` chars, and auto-splitting of turns with `text.length > 600` chars at sentence boundaries.
- **Tag sanitization:** Normalizes tag casing (e.g., `<SHORT PAUSE>` -> `<short pause>`), preserves all 8 approved tags in `APPROVED_VOCAL_TAGS`, strips unauthorized tags (e.g., `<cough_loudly>`), and throws `ValidationError` if `cleanTextForReader(turn.text)` is empty after tag stripping.

### 3.2 `GeminiStoryService` & `StoryLLMProvider` (`server/services/geminiStory.ts`)
- Defined `StoryLLMProvider` with deterministic typed interfaces: `generateWriterDraft(input)` and `directScript(input)`.
- Implemented `GoogleGenAIStoryLLMProvider` using `@google/genai` (`new GoogleGenAI({ apiKey })`) targeting `gemini-3.8-flash`, with `responseMimeType: 'application/json'` and strict `responseSchema` (`Type.OBJECT`, `Type.ARRAY`, `Type.STRING`, `Type.INTEGER`).
- Implemented lazy client initialization so the service initializes cleanly in offline test suites when `GEMINI_API_KEY` is not present.
- **Deterministic Slug Generation:** Builds `YYYY-MM-DD-<kebab-title>` matching `SLUG_REGEX` (`/^[a-z0-9][a-z0-9-_]{1,80}$/`), checking existing `catalog.json` IDs and appending `-2`, `-3` on collisions.
- **Mode A (Fresh):** Generates bedtime narrative, creates draft story, isolates it from public catalog, and saves `story.json` + upserts `catalog.json` atomically.
- **Mode B (Sequel):** Loads prior episode, carries `series_id` (or previous story ID), increments `episode_number = prior + 1`, extracts prior `characters[]` (character bible) and preferred voice ID, passing them to Writer LLM to ensure seamless narrative continuity.
- **Step 2 (Auto-Direct):** Directs turns with sustained acting notes in `style`, injects inline vocal tags from `APPROVED_VOCAL_TAGS`, preserves spoken text verbatim, proposes 1–3 `voice_candidates`, validates with `validateDirectorOutput`, and updates `story.json` + `catalog.json` atomically.

### 3.3 Admin REST API (`server/routes/adminStories.ts`)
All endpoints are secured by `createRequireAdminMiddleware` and wrapped with `asyncHandler`:
1. `GET /api/admin/stories` — returns all `CatalogItem[]` (drafts + published), sorted newest-first (`created_at` descending).
2. `POST /api/admin/stories/write` — validates request body (`400` on missing prompt or invalid mode), calls `generateStoryDraft`, returns `201` `Story`.
3. `POST /api/admin/stories/:id/direct` — executes `directStoryScript(id)`, returns `Story`.
4. `PUT /api/admin/stories/:id` — validates manual edits with `validateManualStoryEdit` and validates optional `voice_candidates`, saves `story.json`, and syncs `catalog.json` atomically.
5. `PATCH /api/admin/stories/:id/status` — toggles `'draft' | 'published'`. **Enforces publishing guardrail:** returns `400 Bad Request` if `story.audio_versions.length === 0`.
6. `DELETE /api/admin/stories/:id` — deletes all `.wav` audio files via `storage.deleteAudio`, removes the story directory via `storage.deleteStory`, and atomically removes the item from `catalog.json`.

### 3.4 Frontend Director Studio (`client/**`)
- **`AdminLoginGate.tsx`:** Fetches session on mount; renders Google OAuth button via `window.google?.accounts?.id` when configured; renders `"⚡ Dev Sandbox Login"` button **ONLY** when `devBypassEnabled === true`.
- **`DirectorStudio.tsx`:**
  - Tactile two-column layout (`.studio-layout`) collapsing to 1 column on mobile `<= 900px`.
  - **Left Rail:** Shows admin email, Logout, `+ New Story`, Public Library shortcut, and story list with `DRAFT` / `PUBLISHED` badges, episode badges, and `Sequel →` shortcuts.
  - **Creation Form:** Tabbed Mode A (Fresh Story) vs Mode B (Episode Sequel with previous story dropdown and episode counter), prompt textarea, optional reference material textarea.
  - **Story Workbench:**
    - Title, Summary, Tags metadata editor.
    - Publish / Revert to Draft button with guardrail tooltip when 0 audio versions exist.
    - Two-step inline delete confirmation (`🗑 Delete Story` -> `Confirm` / `Cancel`).
    - Step 2 Auto-Direct banner (`🎬 2. Auto-Direct Voices & Pacing`) and display of proposed voice candidates.
    - Character Bible editor (add/edit/remove characters and vocal traits).
    - Turn-by-Turn Script editor: Turn # badge, Speaker select, Style input, Spoken Text textarea, and quick-insert vocal tag pills (`<short pause>`, `<sigh>`, `<chuckle>`, `<yawn>`, `<breath>`, etc.) that insert cleanly at cursor position.
    - Prominent sticky save bar with `"💾 Save Script"` button and `"✓ Saved successfully"` confirmation banner.
- **`App.tsx`:** Integrated `/admin` route with `<AdminLoginGate>`, and added automatic public catalog re-fetching on navigating back to library so newly published or updated stories display immediately.

---

## 4. Verification & Test Evidence

### 4.1 Vitest Unit & Integration Suites (`npm test`)
```text
 ✓ tests/wav.test.ts (6 tests) 16ms
 ✓ tests/validators.test.ts (17 tests) 30ms
 ✓ tests/pipelineApi.test.ts (6 tests) 263ms
 ✓ tests/storageAndAuth.test.ts (30 tests) 381ms
 ✓ tests/ui.test.tsx (8 tests) 707ms
 ✓ tests/esm-build.test.ts (1 test) 3581ms

 Test Files  6 passed (6)
      Tests  68 passed (68)
   Duration  4.26s
```

All 6 Phase 3 validation gates in `tests/pipelineApi.test.ts` passed:
1. **Gate 1: Mode A & Draft Isolation:** `POST /api/admin/stories/write` creates a draft story; public `GET /api/catalog` excludes it; `POST .../direct` populates `style`, approved tags, and voice candidates.
2. **Gate 2: Mode B Sequel Continuity:** Creating a sequel from episode 1 sets `series_context.episode_number === 2`, carries `series_id`, and passes prior characters bible to Writer LLM.
3. **Gate 3: Publish Guardrail:** `PATCH .../status` with `status: 'published'` on a story with 0 audio versions returns `400 Bad Request`; succeeds with `200` once audio exists, and reverts to draft with `200`.
4. **Gate 4: Manual Edit Sanitization:** `PUT .../stories/:id` strips unauthorized `<cough_loudly>` tag while preserving `<short pause>` and prose parentheses, updating `catalog.json`.
5. **Gate 5: Delete Story Cleanup:** `DELETE .../stories/:id` deletes `.wav` audio files, `story.json`, and removes entry from `catalog.json`.
6. **Gate 6: Unauthenticated 401 Enforcement:** Rejects unauthenticated requests with `401` across all admin story routes.

### 4.2 Native Node ESM Verification (`tests/esm-build.test.ts`)
- `tsconfig.server.json` compiled with `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`.
- Verified that `./dist/server/services/geminiStory.js` and `./dist/server/routes/adminStories.js` import and execute cleanly under plain `node`.

### 4.3 Live Gemini 3.8 Flash Smoke Test (`npm run test:live`)
Executed real wire calls to Gemini 3.8 Flash using `GEMINI_API_KEY`:
```text
[smoke:live] GEMINI_API_KEY detected. Starting conditional live smoke test with gemini-3.8-flash...
[smoke:live] Calling Gemini 3.8 Flash (generateStoryDraft)...
[smoke:live] Draft generated successfully! Title: "Bibi and the Starlit Moss", turns: 5
[smoke:live] Calling Gemini 3.8 Flash (directStoryScript)...
[smoke:live] Directing complete! Voice candidates: Warm Bedtime Storyteller, Tiny Sleepy Critter
[smoke:live] Sample turn 1 directed text: The golden hue of late afternoon softly dissolved into lavender dusk across the forest floor. <short pause> Beneath the twisted roots of an ancient oak, <short pause> tiny Bibi gave a slow, contented stretch. <breath> Her spines, usually neat and tidy, were relaxed as she carried a final feather-light sprig of velvet moss into her hollow.
[smoke:live] Sample turn 1 style note: Warm, soothing bedtime cadence, hushed tone with gentle deceleration.
[smoke:live] ALL LIVE GEMINI 3.8 FLASH CHECKS PASSED!
[smoke:live] Temporary smoke directory cleaned up.
```

### 4.4 Playwright Headless Chromium E2E (`npm run test:e2e`)
```text
Running 2 tests using 1 worker
  ✓ Phase 2 Public Storybook E2E (1.5s)
  ✓ Phase 3 Admin Director Studio E2E (1.8s)
  2 passed (5.1s)
```
- Logs into `/admin` via Dev Sandbox Login.
- Loads seeded story into workbench.
- Quick-inserts `<short pause>` into script turn #1.
- Saves script and asserts `"✓ Saved successfully"`.
- Reloads page and verifies persistence.
- Asserts Dark Mode contrast (`.btn-tactile` evaluates to `#161F2C` background with `#F1F5F9` text).
- Asserts mobile `375x812` zero horizontal overflow (`scrollWidth <= innerWidth`).
- Verified zero `pageerror` and zero `console.error` events.
- Captured `qa-screenshots/phase3-admin-studio.png` at `1440x900`.

---

## 5. Security & Guardrail Audit Checklist

| Item | Status | Verification Note |
| :--- | :---: | :--- |
| Zero over-engineering | PASS | No databases, no BullMQ, no ffmpeg. Simple atomic JSON/WAV storage. |
| Node ESM `.js` relative imports | PASS | All relative imports in `server/**` and `shared/**` use explicit `.js`. |
| Publish guardrail (0 audio versions) | PASS | `PATCH /stories/:id/status` returns `400` when `audio_versions.length === 0`. |
| Tag sanitization on manual edit | PASS | `validateManualStoryEdit` strips unauthorized `<...>` tags and normalizes approved tags. |
| Non-empty prose after tag removal | PASS | `cleanTextForReader(turn.text)` validated non-empty; prevents drop-cap stealing. |
| Path traversal protection | PASS | All `:id` and `:seriesId` params validated against `SLUG_REGEX`. |
| Single-admin auth protection | PASS | All `/api/admin/stories/*` routes protected by `requireAdmin`. |
| Secret safety | PASS | `.env` never read into audit, never printed, excluded in `.gitignore`. |
| Single audit location | PASS | Report written exclusively to `docs/audits/phase-3-audit.md`. |
