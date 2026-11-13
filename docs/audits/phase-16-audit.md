# Phase 16 Audit Report — Switch Text/Multimodal LLM to `gemini-4-hydrogen` (`LOW` Reasoning) & Subagent Model Policy Update

> **Execution Mode:** Mode 1 — Direct Main Agent Execution (surgical refactor across config, `GoogleGenAIStoryLLMProvider`, documentation, and targeted tests per `AGENTS.md` §1.A & §1.B)  
> **Milestone Tag:** `phase-16-verified`

---

## 1. Summary of Changes

### A. Text & Multimodal LLM Migration (`gemini-4-hydrogen` + `LOW` Reasoning Effort)
- **`server/config.ts`:**
  - Updated `geminiTextModel` default from `'gemini-3.8-flash'` to `'gemini-4-hydrogen'`.
  - Added `geminiThinkingLevel: string` to `AppConfig`, configured via `GEMINI_THINKING_LEVEL` (normalized uppercase, defaulting to `'LOW'`).
  - Preserved TTS models untouched (`geminiTtsModel: 'gemini-3.8-flash-tts'`, `geminiTtsLiteModel: 'gemini-3.8-flash-lite-tts'`).
- **`server/services/geminiStory.ts`:**
  - Imported `ThinkingLevel` from `@google/genai` (verified against `node_modules/@google/genai/dist/genai.d.ts`).
  - Added `resolveThinkingLevel(level?: string): ThinkingLevel` mapping `'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'THINKING_LEVEL_UNSPECIFIED'` with fallback to `ThinkingLevel.LOW`.
  - Updated `GoogleGenAIStoryLLMProvider` default `model = 'gemini-4-hydrogen'` and optional `thinkingLevel` parameter defaulting to `ThinkingLevel.LOW`.
  - Added `thinkingConfig: { thinkingLevel: this.thinkingLevel }` across all three `ai.models.generateContent` calls (`generateWriterDraft`, `directScript`, `transcribeAudio`).
  - Updated `GeminiStoryService` constructor to pass `config.geminiThinkingLevel` into `GoogleGenAIStoryLLMProvider`.
- **`server/services/jobManager.ts`:**
  - Updated default text job status strings (`draft` and `direct`) to reference `Gemini 4 Hydrogen`, leaving `synthesize` on `Gemini 3.8 Flash TTS`.
  - Serialized `persistStoryActiveJob()` through `enqueuePersist()` and awaited active-job clearing promises in `markRunningJobsInterrupted()` to prevent concurrent file write races during shutdown/restart reconciliation.
- **`server/routes/adminStories.ts`, `server/routes/adminTranscribe.ts`, `client/components/DirectorStudio.tsx`, `.env.example`, `scripts/smokePhase3Live.ts`:**
  - Updated `.env.example` with `GEMINI_TEXT_MODEL=gemini-4-hydrogen` and `GEMINI_THINKING_LEVEL=LOW` (keeping TTS vars unchanged).
  - Updated stale text/STT comments, smoke script model defaults, and UI copy for Writer/Director stages to reference `Gemini 4 Hydrogen` while leaving all `Gemini 3.8 Flash TTS` copy intact.

### B. Documentation Update — Subagent Model Policy (`Gemini 4 Hydrogen` High)
- Updated `AGENTS.md`, `SUBAGENT_ORCHESTRATION_PLAYBOOK.md`, `.agents/skills/orchestration-planning/SKILL.md`, `.agents/skills/gemini-3-8-tts-studio/SKILL.md`, and `HANDOFF_PLAN.md` so builder subagent guidance recommends **Gemini 4 Hydrogen** (`high` default reasoning effort; invoked via `Model: "inherit"` when parent runs Hydrogen High) instead of `flash`, and reflects `gemini-4-hydrogen` + `GEMINI_THINKING_LEVEL=LOW` for text/multimodal generation.

### C. Automated Tests Added / Updated
- **`tests/deploymentConfig.test.ts`:** Added assertions verifying `loadConfig({})` defaults (`geminiTextModel: 'gemini-4-hydrogen'`, `geminiThinkingLevel: 'LOW'`, `geminiTtsModel: 'gemini-3.8-flash-tts'`, `geminiTtsLiteModel: 'gemini-3.8-flash-lite-tts'`) and env override normalization (`GEMINI_TEXT_MODEL`, `GEMINI_THINKING_LEVEL`).
- **`tests/pipelineApi.test.ts`:** Added `Phase 16` tests verifying `resolveThinkingLevel` and confirming `GoogleGenAIStoryLLMProvider` passes `model: 'gemini-4-hydrogen'` and `config.thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }` on `generateWriterDraft`, `directScript`, and `transcribeAudio`.
- **`tests/ui.test.tsx`, `tests/e2e/storybook.spec.ts`, `tests/e2e/qa-phase15.spec.ts`:** Updated text-stage UI status message assertions/fixtures to `Gemini 4 Hydrogen`.

---

## 2. Verification Results

- **`npm run typecheck`:** Passed (`0` errors).
- **`npx tsc -p tsconfig.server.json`:** Passed cleanly under `NodeNext` ESM resolution.
- **`npm test` (`vitest run`):** **275/275 tests passed across 14 test files**, including `tests/esm-build.test.ts` (native Node ESM import check) and `tests/jobManager.test.ts` (`15/15`).
- **`npm run build`:** Passed (`tsc -p tsconfig.server.json && vite build`).
- **`npm run seed && npx playwright test`:** **14/14 E2E specs passed** in headless Chromium.
- **Conditional Live Smoke Check (`scripts/smokePhase3Live.ts`):** Skipped cleanly because neither Windows nor WSL `.env` has a live `GEMINI_API_KEY` configured (placeholder/empty).
