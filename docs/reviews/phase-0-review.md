# Phase 0 Architectural & Code Review (`5378b5a`)

> **Reviewed By:** Lead Architect  
> **Verdict:** **Conditional Pass — 5 Required Fixes Before Starting Phase 1**  
> Unit tests (`17/17`) and core `wav.ts` / `validators.ts` logic are clean and well-structured, **but an independent Node ESM production-import test uncovered a blocker (`ERR_MODULE_NOT_FOUND`) plus 4 important hygiene/edge-case items** that were missed by `PHASE_0_AUDIT.md`.

---

## Required Action Items for Builder Agent (Complete & Commit Before Phase 1)

- [x] **1. [CRITICAL] Fix Native Node ESM Server Compilation (`tsconfig.server.json` + `.js` Imports)**
  - **Finding:** `package.json` declares `"type": "module"`, while `tsconfig.server.json` uses `"module": "ESNext", "moduleResolution": "bundler"`, and `server/lib/validators.ts` imports `'../../shared/textClean'` without `.js`. Running `npx tsc -p tsconfig.server.json` and importing `./dist/server/lib/validators.js` in native Node crashes with:
    `ERR_MODULE_NOT_FOUND: Cannot find module '.../dist/shared/textClean' imported from .../dist/server/lib/validators.js`
    *(Vitest hid this because Vite rewrites extensionless imports on the fly, whereas `npm start` / Cloud Run uses plain `node`!)*
  - **Fix:**
    1. Update `tsconfig.server.json` `compilerOptions` to `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` so `tsc -p tsconfig.server.json` enforces valid Node ESM specifiers at compile time.
    2. Update relative imports in `server/lib/validators.ts` (and all future `server/**` and `shared/**` files) to use `.js` extensions (`'../../shared/textClean.js'`, `'../../shared/types.js'`). Note: Vite, Vitest, and `tsx` all resolve `.js` -> `.ts` natively.
    3. Add a test or script check verifying `npx tsc -p tsconfig.server.json` compiles cleanly and `import('./dist/server/lib/validators.js')` + `import('./dist/server/lib/wav.js')` succeed in plain `node`.

- [x] **2. [HIGH] Align `@types/express` Version with Runtime `express` (`package.json`)**
  - **Finding:** `package.json` pairs `"express": "^4.21.2"` with `"@types/express": "^5.0.0"` (Express v5 types). Express 5 changed `req.params` typing and `RequestHandler` return-type compatibility, which causes spurious TS errors on Express 4 route handlers in Phase 1.
  - **Fix:** Pin `"@types/express": "^4.17.21"` in `package.json` and run `npm install` so `package-lock.json` matches Express 4.

- [x] **3. [MEDIUM] Harden Two Edge Cases in `wav.ts` and `validators.ts`**
  - **Finding A (`server/lib/validators.ts` lines 58–72):** In `splitTextAtSentenceBoundaries`, if an input contains a single unbroken token `> 600` chars with zero spaces, the word-boundary fallback pushes the whole `> 600`-char string without slicing it. Slice any single oversized word (`word.length > maxLen`) into `<= maxLen` chunks so the `<= 600` invariant holds unconditionally, and add a unit test in `tests/validators.test.ts`.
  - **Finding B (`server/lib/wav.ts`):** Ensure `extractPcmFromWavOrRaw` and `wrapPcmAsWav` enforce 2-byte (16-bit mono sample) alignment (`evenLen = buf.length - (buf.length % 2)`) so an odd-length truncated buffer can never invert 16-bit sample byte order when concatenating PCM chunks. Add a unit test in `tests/wav.test.ts`.

- [x] **4. [LOW] Prevent Orphan Background Server in `"dev"` Script (`package.json`)**
  - **Finding:** `"dev": "tsx watch --env-file-if-exists=.env server/index.ts & vite"` leaves `tsx watch` running in the background holding port `8080` after `Ctrl+C`.
  - **Fix:** Update `"dev"` to clean up child processes on exit without adding dependencies:
    `"dev": "bash -c 'trap \"kill 0\" INT TERM EXIT; tsx watch --env-file-if-exists=.env server/index.ts & vite; wait'"`

- [x] **5. [LOW] Consolidate Duplicate Audit Files**
  - **Finding:** Identical audit reports were committed at both `./PHASE_0_AUDIT.md` and `./docs/phase-0-audit.md`.
  - **Fix:** Remove root `./PHASE_0_AUDIT.md`, move `./docs/phase-0-audit.md` to `./docs/audits/phase-0-audit.md` (following `AGENTS.md`), commit all 5 fixes as `fix(phase-0): resolve architect code review findings`, and update tag `git tag -f phase-0-verified`.
