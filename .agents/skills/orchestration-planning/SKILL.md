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
Because the next Orchestrator Agent session will start with a fresh context window and delegate implementation to a fast `flash` subagent, gather all high-leverage technical context upfront:
1. **Backward-Compatibility & Shared Contracts:** Identify existing types, CSS custom properties, API routes, or storage schemas referenced across the codebase so the new implementation does not silently break inline styles or callers.
2. **Exact Impacted Test Files & Line Numbers:** Grep and read `tests/**/*.test.ts(x)` and `tests/e2e/**/*.spec.ts` to find every existing assertion that will be affected by the planned changes (e.g., default states, DOM structure, computed styles, border widths, or theme sequences). Record the exact file paths and line numbers so the subagent updates them cleanly on the first pass.

### Step 3: Context-Aware Subagent Grouping Strategy
Decide how the next Orchestrator Agent should group the work across `phase-builder` (`Model: "flash"`) subagents based on **context cohesion and token efficiency**:
- **When to Group Tasks/Phases into the SAME Subagent:**
  - If multiple tasks or sub-phases modify the **same files, components, CSS tokens, or E2E test suites**, group them into a **single cohesive subagent assignment** (or instruct the Orchestrator to reuse the same subagent via `send_message`).
  - *Why:* The subagent already holds those files, DOM structures, and test fixtures in working memory—spawning a second subagent would waste thousands of tokens re-reading the same context from scratch and risk mismatches between implementation and tests.
- **When to Split Into Separate Subagents:**
  - If phases have clean, decoupled architectural boundaries (e.g., **Phase A:** Backend Storage & Gemini API Routes vs. **Phase B:** Frontend Studio UI & Playwright E2E), assign each phase to its own dedicated subagent so neither subagent's context window gets bloated.

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
1. `AGENTS.md` (strict two-tier Architect + Flash Subagent workflow, non-negotiable technical guardrails, and firsthand verification rules)
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
1. Define the `phase-builder` subagent via `define_subagent` (`EnableWriteTools: true`, `EnableSubagentTools: false`, `EnableMCPTools: false`).
2. **Subagent Grouping Strategy:** <State whether to group all of Phase N into one cohesive `phase-builder` (`Model: "flash"`, `Workspace: "inherit"`) subagent so related files/tests share the same context window, or how to sequence subagents across phases.>
3. When the subagent completes, perform strict **Firsthand Verification** (never blindly trust the subagent's self-audit):
   - Read every modified/created source and test file line-by-line (`read_file` / `git diff`).
   - Inspect all captured `qa-screenshots/phase<N>-*.png` images using `read_file` vision.
   - Run `npm run typecheck`, `npx tsc -p tsconfig.server.json`, `npm test`, and `npm run build && npx playwright test` firsthand in WSL.
4. **Iterative Review Loop with the SAME Subagent:** If any bugs, edge cases, visual flaws, or test discrepancies exist, write `docs/reviews/phase-<N>-review.md` with open `[ ]` items and message the **SAME** subagent via `send_message(Recipient: <conversationId>)` to fix them, add regression tests, and iterate until 100% of validation gates pass.
5. Once 100% verified, check off Phase <N> in `HANDOFF_PLAN.md`, tag `phase-<N>-verified`, and sync both `/mnt/c/Users/m93/projects/story-wizard` and `/home/ubuntu/story-wizard`.
```
