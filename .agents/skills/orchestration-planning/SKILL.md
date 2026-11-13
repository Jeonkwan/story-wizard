---
name: orchestration-planning
description: >-
  On-demand workflow for "Orchestration Planning" sessions. Activate ONLY when the user
  explicitly asks to do "orchestration planning", "turn this into an orchestration plan",
  or prepare a detailed handoff plan and kickstart prompt for another Orchestrator Agent session.
---

# Orchestration Planning & Handoff Skill

## 1. Activation Rule (Explicit User Request Only)

> **IMPORTANT:** Do **NOT** activate Orchestration Planning Mode on normal coding, debugging, or execution sessions. Activate this workflow **ONLY** when the user explicitly requests it (e.g., *"Let's do orchestration planning"*, *"Turn this into an orchestration plan"*, *"Prepare a plan for another orchestrator agent session"*).

When Orchestration Planning Mode is active:
- **Your Role:** Lead Discovery Architect & Handoff Planner.
- **What You DO:** Explore the codebase, evaluate external references critically, build scratch previews/prototypes if helpful, align with the user on open design/architecture decisions, audit exact file and test impacts, decide how to group tasks across subagents to maximize shared context and minimize token waste, persist the complete blueprint into `HANDOFF_PLAN.md`, and produce a **Ready-to-Paste Orchestrator Kickstart Prompt** for the next agent session.
- **What You DO NOT Do:** Do **not** implement the production feature or spawn `phase-builder` subagents to execute the build in the current session (unless the user explicitly tells you to switch from planning to execution).

---

## 2. The 5-Step Orchestration Planning Protocol

### Step 1: Critical Evaluation, Exploration & User Alignment
1. **Verify Against the Real Codebase:** Never blindly trust external design docs, handoff packages, or assumptions. Inspect the actual working files (`shared/types.ts`, `server/**`, `client/**`, `tests/**`) to identify what fits, what conflicts, and what would break existing features.
2. **Surface Doubts & Clarify Early:** Present clear findings, recommendations, and trade-offs (with visual previews in `<appDataDir>/brain/<conversation-id>/scratch/` when UI changes are involved) and confirm key decisions with the user before locking the blueprint.

### Step 2: Exhaustive Context & Test-Impact Audit
Because the next Orchestrator Agent session will start with a fresh context window and may delegate implementation to a **Gemini 4 Hydrogen** (`high` reasoning effort) subagent, gather all high-leverage technical context upfront:
1. **Backward-Compatibility & Shared Contracts:** Identify existing types, CSS custom properties, API routes, or storage schemas referenced across the codebase so the new implementation does not silently break inline styles or callers.
2. **Exact Impacted Test Files & Line Numbers:** Grep and read `tests/**/*.test.ts(x)` and `tests/e2e/**/*.spec.ts` to find every existing assertion that will be affected by the planned changes (e.g., default states, DOM structure, computed styles, border widths, or theme sequences). Record the exact file paths and line numbers so the subagent updates them cleanly on the first pass.

### Step 3: Workload Evaluation, Execution Mode Selection, & Subagent Grouping
Evaluate the **number of files, workload size, and architectural complexity**, and explicitly recommend one of the **3 Execution Modes** (plus how to group any subagent tasks):

1. **Choose the Optimal Execution Mode:**
   - **Mode 1 — Direct Main Agent Execution (No Subagent Needed):**
     - Recommend this when the change is small or surgical (e.g., 1–3 files, targeted bugfix, small config/type adjustment, or standalone documentation) where spawning a subagent would waste more tokens feeding context than executing directly.
   - **Mode 2 — Hybrid Execution (Main Agent + Subagent Partnership):**
     - Recommend this when the Main Agent should directly implement foundational/high-reasoning pieces (e.g., `shared/types.ts`, core API/service contracts, subtle state logic, and all standalone documentation) while delegating bounded, high-volume tasks (e.g., multi-component UI updates, bulk unit tests, Playwright E2E specs, and screenshot capture) to a **Gemini 4 Hydrogen** (`Model: "inherit"`, `high` reasoning effort) subagent within its scope.
   - **Mode 3 — Full Subagent Delegation (Large / Multi-File Feature Phases):**
     - Recommend this when a phase involves heavy multi-file implementation and extensive test suites best executed end-to-end by a **Gemini 4 Hydrogen** (`Model: "inherit"`, `high` reasoning effort) subagent under the Main Agent's Firsthand Verification and Review Loop.

2. **Documentation vs. Inline Code Comments Ownership Rule (Non-Negotiable):**
   - **Standalone Documentation -> Main Agent ONLY:** All project, architecture, skill, and review documentation (`HANDOFF_PLAN.md`, `AGENTS.md`, `SUBAGENT_ORCHESTRATION_PLAYBOOK.md`, `README.md`, `.agents/skills/*/SKILL.md`, `docs/reviews/*.md`, guides) **must be authored by the Main Agent**.
   - **Inline Comments & Function Docstrings -> Whoever Writes the Code:** Whoever writes a piece of code writes its inline comments and JSDoc/TSDoc function docstrings (if the subagent writes the code, the subagent writes its inline comments/docstrings; if the Main Agent writes the code, the Main Agent writes its inline comments/docstrings).

3. **Context-Aware Subagent Grouping (When Using Mode 2 Hybrid or Mode 3 Full Subagent):**
   - **Group into the SAME Subagent:** When multiple tasks or sub-phases touch the **same files, components, CSS tokens, or E2E test suites**, group them into a **single cohesive subagent assignment** (or reuse the same subagent via `send_message`) so it leverages its existing working memory without wasting tokens re-reading context from scratch.
   - **Split into Separate Subagents:** Only split across separate subagents when phases have clean, decoupled architectural boundaries (e.g., Backend Storage/API vs. Frontend Studio UI).

### Step 4: Persist the Self-Contained Blueprint to Repository Disk (`HANDOFF_PLAN.md`)
> **CRITICAL RULE:** Artifacts written to `<appDataDir>/brain/<conversation-id>/` belong only to the current conversation ID and are **not** automatically loaded by a new agent session.

1. Write the complete, self-contained phase blueprint directly into `HANDOFF_PLAN.md` in the repository root (and add the phase entry to the Progress Tracker in Section 11 of `HANDOFF_PLAN.md`).
2. Include in the `HANDOFF_PLAN.md` section:
   - **Confirmed User Decisions & Non-Negotiable Guardrails**
   - **Exact Shared Types / CSS Token / API Contracts**
   - **Component-by-Component or Module-by-Module Implementation Checklist**
   - **Exact Existing Test Files & Line Numbers to Update + New Validation Gate Tests**
   - **Recommended Subagent Grouping & Iteration Strategy**
3. **Sync Windows & WSL Repositories:** Ensure `HANDOFF_PLAN.md` is synced and committed in both `/mnt/c/Users/m93/projects/story-wizard` and `/home/ubuntu/story-wizard` so the next session sees a clean, identical `git status` in both environments.

### Step 5: Generate the Ready-to-Paste Orchestrator Kickstart Prompt
Conclude your response by providing a clean, copy-pasteable **Kickstart Prompt** inside a fenced `text` code block for the user to paste into the new Orchestrator Agent session.

---

## 3. Template: Ready-to-Paste Orchestrator Kickstart Prompt

Always tailor and output this template at the end of an Orchestration Planning session:

```text
You are the Lead Architect & Orchestrator Agent for Storyteller Studio (`story-wizard`).

Before taking any action, read these three files in full:
1. `AGENTS.md` (workload-aware Architect + Gemini 4 Hydrogen High Subagent workflow, non-negotiable technical guardrails, and firsthand verification rules)
2. `SUBAGENT_ORCHESTRATION_PLAYBOOK.md` (subagent definition, context-aware task grouping, deadlock recovery, and iterative review loop)
3. `HANDOFF_PLAN.md` — specifically **Section <M> (Phase <N>: <Phase Title>)**, which contains the complete, user-approved specification, exact contracts, component/module checklist, and exact line numbers of existing unit/E2E tests that must be updated.

### Key Architectural & Design Decisions (Already Approved by User):
1. <Decision 1 summary>
2. <Decision 2 summary>
3. <Decision 3 summary>

### Critical Environment Note (Windows <-> WSL Sync):
- File tools (`read_file`, `edit_file`, `write_file`) operate on `c:\Users\m93\projects\story-wizard` (`/mnt/c/Users/m93/projects/story-wizard`), while build/test commands run inside WSL at `/home/ubuntu/story-wizard`.
- Always sync changes between `/mnt/c/Users/m93/projects/story-wizard` and `/home/ubuntu/story-wizard` before running `npm run typecheck`, `npm test`, `npm run build`, or `npx playwright test`.

### Your Orchestration Mission:
1. **Execution Mode & Subagent Strategy:** <State the recommended mode based on file count/complexity: (A) Direct Main Agent Execution, (B) Hybrid Approach (specify exact files Main Agent handles vs. exact scope delegated to `phase-builder` Gemini 4 Hydrogen subagent), or (C) Full Subagent Delegation (and whether grouped into one cohesive `phase-builder` subagent or split across decoupled phases). Note: All standalone documentation must be written by the Main Agent, while inline comments and function docstrings are written by whoever writes the code.>
2. If spawning a subagent (Hybrid or Full Delegation), define `phase-builder` via `define_subagent` (`EnableWriteTools: true`, `EnableSubagentTools: false`, `EnableMCPTools: false`) and invoke with **Gemini 4 Hydrogen (`high` default reasoning effort — `Model: "inherit"` when parent runs Hydrogen High)** and `Workspace: "inherit"`.
3. When the subagent completes, perform strict **Firsthand Verification** (never blindly trust the subagent's self-audit):
   - Read every modified/created source and test file line-by-line (`read_file` / `git diff`).
   - Inspect all captured `qa-screenshots/phase<N>-*.png` images using `read_file` vision.
   - Run `npm run typecheck`, `npx tsc -p tsconfig.server.json`, `npm test`, and `npm run build && npx playwright test` firsthand in WSL.
4. **Iterative Review Loop with the SAME Subagent:** If any bugs, edge cases, visual flaws, or test discrepancies exist, write `docs/reviews/phase-<N>-review.md` with open `[ ]` items and message the **SAME** subagent via `send_message(Recipient: <conversationId>)` to fix them, add regression tests, and iterate until 100% of validation gates pass.
5. Once 100% verified, check off Phase <N> in `HANDOFF_PLAN.md`, tag `phase-<N>-verified`, and sync both `/mnt/c/Users/m93/projects/story-wizard` and `/home/ubuntu/story-wizard`.
```
