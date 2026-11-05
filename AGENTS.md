# Workspace Agent Rules — Storyteller Studio

Always read `HANDOFF_PLAN.md` and check `docs/reviews/` before starting or resuming any build phase.

## 1. Architect / Builder Workflow
- **Fix Review Findings First:** Before starting Phase `N`, check if `docs/reviews/phase-(N-1)-review.md` exists with open `[ ]` items. Resolve every review item, add regression tests, check them off `[x]`, and commit `fix(phase-(N-1)): address code review findings` before starting Phase `N` features.
- **Single Audit Location:** Write your phase completion audit report ONLY to `docs/audits/phase-N-audit.md` (never create duplicate `PHASE_N_AUDIT.md` files at the workspace root).
- **Mandatory Production ESM Check:** Passing `vitest` (`npm test`) is NOT sufficient because Vitest/tsx resolves extensionless imports that crash native Node ESM (`npm start`). Every phase from Phase 0 onward MUST verify that `npx tsc -p tsconfig.server.json` succeeds under `"module": "NodeNext", "moduleResolution": "NodeNext"` and that compiled `dist/server/**/*.js` modules import cleanly under plain `node`.

## 2. Non-Negotiable Technical Guardrails
- **Zero Over-Engineering:** No databases (Postgres/SQLite/Redis), no queues (BullMQ/Cloud Tasks), no `ffmpeg`, and no legacy `@google/generative-ai` (use `@google/genai >= 2.24.0` only).
- **ESM Relative Imports:** In `server/**` and `shared/**`, always include explicit `.js` extensions on relative imports (e.g., `import { cleanTextForReader } from '../../shared/textClean.js'`) so compiled `dist/server/*.js` runs natively in Node ESM.
- **Gemini 3.8 TTS Multi-Speaker Exact-2 Rule:** `multiSpeakerVoiceConfig.speakerVoiceConfigs` MUST contain **exact 2** speakers (`length === 2`). If a batch or sub-batch has **1** distinct speaker, use single-speaker `speechConfig.voiceConfig` instead (passing 1 speaker inside `multiSpeakerVoiceConfig` returns `HTTP 400 INVALID_ARGUMENT`).
- **Git Discipline:** Never commit `.env`, `node_modules/`, `dist/`, `data/`, or `qa-screenshots/`. Move or create the `phase-N-verified` tag ONLY after all tests, build checks, and review fixes pass.
