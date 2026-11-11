# Workspace Agent Rules — Storyteller Studio

Always read `HANDOFF_PLAN.md`, `SUBAGENT_ORCHESTRATION_PLAYBOOK.md`, and check `docs/reviews/` before starting or resuming any build phase.

---

## 1. Architect-Orchestrator & Subagent Workflow

Storyteller Studio strictly enforces a two-tier agentic architecture: **Lead Architect Parent Agent** + **Dedicated Per-Phase Builder Subagents** (`Model: "flash"` / Gemini 3.8 Flash).

### A. Role Boundaries & Delegation
- **Lead Architect (Parent Agent — High Reasoning / Pro):**
  - Owns system design, shared types (`shared/types.ts`), API contracts, and orchestrating the build roadmap.
  - **Does NOT write implementation features directly:** Always delegates implementation, test writing, and even deep research / information gathering to subagents (`invoke_subagent` with `Model: "flash"`).
  - **Firsthand Verification:** Must personally read every new/modified source file line-by-line, inspect every captured screenshot in `qa-screenshots/` with multimodal vision, and run verification commands directly. Never blindly trusts a subagent's audit report.
  - **Owns Milestone Tags:** Only the Lead Architect moves or creates `phase-N-verified` or `phase-N-qa-complete` tags after independent verification.
- **Phase Builder Engineer (Subagent — Fast Execution / Flash):**
  - Implements the assigned phase features cleanly following `AGENTS.md` guardrails.
  - Writes comprehensive unit, integration, and Playwright E2E tests.
  - Captures high-resolution visual screenshots into `qa-screenshots/`.
  - Authors the phase audit report ONLY to `docs/audits/phase-N-audit.md`.
  - Commits `feat(phase-N): <concise summary>` inside WSL.
  - Never tags milestones.

### B. Context-Aware Task Grouping & The Iterative Review Loop
- **Context-Aware Subagent Grouping (Token & Context Efficiency):**
  - Decide whether tasks/phases should be assigned to a **single cohesive subagent** or **separate dedicated subagents** based on context overlap:
  - When multiple tasks or sub-phases touch the **same files, components, CSS tokens, or test suites**, group them together and hand them to the **SAME** subagent so it leverages its existing working memory without wasting tokens re-reading the codebase from scratch.
  - When phases have clean, decoupled boundaries (e.g., independent backend storage work vs. frontend UI overhaul), spawn a dedicated subagent per phase to keep context windows lean.
- **Per-Phase Review & Messaging Loop:**
  1. When a builder subagent reports completion, the Lead Architect inspects the git diff, tests, and screenshots firsthand (never blindly trusting the subagent's self-audit).
  2. If any bugs, contrast issues, or edge cases exist, the Architect writes `docs/reviews/phase-N-review.md` with open `[ ]` items and commits `docs(review): add Phase N review findings`.
  3. The Architect re-messages the **SAME** active subagent via `send_message(Recipient: <conversationId>)`. Never spawn a new subagent to fix an active phase's review items.
  4. The builder subagent fixes each item, adds regression tests, marks items `[x]`, updates `docs/audits/phase-N-audit.md`, and commits `fix(phase-N): address code review findings`.

### C. On-Demand Orchestration Planning Mode (Explicit User Request Only)
- **Trigger Condition:** Do **NOT** run Orchestration Planning Mode on every session. Activate it **ONLY** when the user explicitly requests it (e.g., *"let's do orchestration planning"*, *"let's turn this into an orchestration plan"*, or *"prepare an orchestration plan for another agent session"*).
- **Workflow:** When explicitly triggered, immediately read and follow `.agents/skills/orchestration-planning/SKILL.md`:
  1. Do **not** implement the production feature or spawn builder subagents in the planning session.
  2. Explore the codebase, align with the user on design/architecture decisions, audit exact file and test-line impacts, decide the optimal **Context-Aware Subagent Grouping**, persist the self-contained blueprint into `HANDOFF_PLAN.md`, and output a **Ready-to-Paste Orchestrator Kickstart Prompt** for the next agent session.

### D. Active Subagent Monitoring & Process Deadlock Recovery
- Subagents running terminal tasks can become blocked by commands that prompt on stdin (e.g., interactive prompts or unauthenticated `git pull`).
- When a subagent enters `state: "waiting_for_dependents"` or appears stalled, the Lead Architect must:
  1. Inspect the subagent's transcript (`Get-Content <subagent-dir>/transcript.jsonl -Tail 20`).
  2. Identify the hanging PID in WSL (`ps aux | grep <command>`).
  3. Terminate the blocking process (`kill -9 <pid>`).
  4. Verify the subagent immediately resumes execution without losing working memory.

### E. Single Audit Location & Production ESM Verification
- **Single Audit Path:** Write completion audit reports ONLY to `docs/audits/phase-N-audit.md` (never create duplicate `PHASE_N_AUDIT.md` at root).
- **Mandatory Production ESM Check:** Passing `vitest` (`npm test`) is NOT sufficient because Vitest/tsx resolves extensionless imports that crash native Node ESM (`npm start`). Every phase MUST verify that `npx tsc -p tsconfig.server.json` succeeds under `"module": "NodeNext", "moduleResolution": "NodeNext"` and that compiled `dist/server/**/*.js` modules import cleanly under plain `node` (`tests/esm-build.test.ts`).

---

## 2. Non-Negotiable Technical Guardrails
- **Zero Over-Engineering:** No databases (Postgres/SQLite/Redis), no queues (BullMQ/Cloud Tasks), no `ffmpeg`, and no legacy `@google/generative-ai` (use `@google/genai >= 2.24.0` only).
- **ESM Relative Imports:** In `server/**` and `shared/**`, always include explicit `.js` extensions on relative imports (e.g., `import { cleanTextForReader } from '../../shared/textClean.js'`) so compiled `dist/server/*.js` runs natively in Node ESM.
- **Gemini 3.8 TTS Multi-Speaker Exact-2 Rule:** `multiSpeakerVoiceConfig.speakerVoiceConfigs` MUST contain **exact 2** speakers (`length === 2`). If a batch or sub-batch has **1** distinct speaker, use single-speaker `speechConfig.voiceConfig` instead (passing 1 speaker inside `multiSpeakerVoiceConfig` returns `HTTP 400 INVALID_ARGUMENT`).
- **Git Discipline:** Never commit `.env`, `node_modules/`, `dist/`, `data/`, or `qa-screenshots/`.

---

## 3. Environment & Remote Synchronization (WSL + Windows)
- **Execution Engine:** Run all server, build, test, and git commands inside WSL via `wsl -- bash -lc "cd /home/ubuntu/story-wizard && <command>"`.
- **Git Credential Bridge:** WSL git must use the Windows GitHub CLI credential helper to prevent interactive stdin credential prompts:
  ```bash
  git config --global credential.helper '/mnt/c/Program\ Files/GitHub\ CLI/gh.exe auth git-credential'
  ```
- **Mobile Tunneling Skill:** Refer to `.agents/skills/mobile-tunnel-preview/SKILL.md` when previewing or exposing the service to external mobile devices for touch and audio QA (`npm run tunnel`).
- **Remote Push:** Always push branch `main` and all tags to remote GitHub:
  ```bash
  git push origin main && git push origin --tags
  ```
