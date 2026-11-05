# Storyteller Studio & Audio Engine — Engineering Handoff & Phased Build Spec

> **Purpose of this Document:** Self-contained architectural blueprint, API/schema specification, SDK reference, and 5-phase implementation & verification runbook. Designed so an engineer or coding agent in a fresh session can build, test, and ship the entire application phase-by-phase with **zero ambiguity and zero over-engineering**.

---

## 0. How to Use This Handoff (Instructions for Executing Agent)

1. **Work Strictly One Phase at a Time:** Complete only the requested phase (e.g., Phase 0, then Phase 1, etc.). Do **not** jump ahead to later phases until every test and validation check in the current phase passes.
2. **Respect Anti-Over-Engineering Guardrails:**
   - **NO Database:** Do not add PostgreSQL, SQLite, Firestore, Prisma, or Redis. All persistence lives in GCS JSON/WAV objects (with automatic local `./data/` filesystem fallback).
   - **NO Background Queues:** Do not add BullMQ, Cloud Tasks, Pub/Sub, or separate worker containers. Run synthesis synchronously over HTTP inside the single Cloud Run container (`--timeout=300`).
   - **NO Heavy Frameworks or Media Binaries:** Use a single **Node.js 22 + TypeScript** repo serving an **Express** API and a **Vite + React** SPA from one container. Do **not** install `ffmpeg`; handle 24kHz 16-bit mono PCM and 44-byte RIFF/WAV headers in pure TypeScript (`Buffer`).
   - **NO Legacy Gemini SDK:** Never install `@google/generative-ai`. Exclusively use **`@google/genai`** (`>= 2.24.0`).
   - **NO Fake Remote Skill Installs:** Do not run `antigravity skills add` or fetch nonexistent GitHub URLs. Create workspace skills directly inside `.agents/skills/`.
3. **Git Version Control Protocol (Mandatory Across All Phases):**
   - This workspace is an active Git repository (`main` branch, LF line endings enforced via `.gitattributes` for seamless WSL <-> Windows interoperability).
   - **Start Clean:** Run `git status` before beginning each phase to ensure no untracked junk or half-broken edits exist.
   - **Recover Cleanly:** If an experiment breaks tests, use `git diff` to inspect changes or `git checkout -- <path>` to revert cleanly instead of stacking workarounds.
   - **Commit & Tag per Phase:** Never commit `.env`, `data/`, `dist/`, `node_modules/`, or `qa-screenshots/`. Once **all** checks in a phase's Validation Gate pass:
     1. Check off `[x]` the completed items in Section 11 (`Progress Tracker`) of `HANDOFF_PLAN.md`.
     2. Stage and commit with a clear conventional message: `git add -A && git commit -m "feat(phase-N): <concise summary>"`
     3. Create a milestone tag for instant rollback if needed: `git tag phase-N-verified`
4. **Definition of Done per Phase:**
   - Any open review items in `docs/reviews/` from the prior phase are resolved and checked off `[x]`.
   - All TypeScript compiles cleanly (`npm run typecheck` -> exit `0`) AND `npx tsc -p tsconfig.server.json` (`NodeNext` ESM) emits valid `.js`-specifier imports in `dist/server/` that load cleanly in native `node`.
   - All unit/API/component tests pass (`npm test` -> exit `0`).
   - From Phase 2 onward, real headless Chromium E2E checks pass (`npm run test:e2e` -> exit `0`) and save visual checkpoint screenshots to `qa-screenshots/`.
   - A concise phase completion audit is saved to `docs/audits/phase-N-audit.md` (single location—never duplicate at repo root).
   - Changes are committed and tagged (`phase-N-verified`) in Git.

---

## 1. System Architecture & Runtime Boundaries

```text
+-------------------+        GET /api/catalog, /api/stories/:id        +-------------------------------------------+
|  Public Listener  | -----------------------------------------------> |         Cloud Run Single Container        |
| (No Auth Needed)  | <----- Range-Streamed WAV (206 Partial) -------- |     Node 22 + Express + Static React      |
+-------------------+                                                  |                                           |
                                                                       |  +-------------------------------------+  |
+-------------------+   Google ID Token -> HttpOnly Session Cookie     |  | Public Reader API + Static Assets   |  |
|   Studio Admin    | -----------------------------------------------> |  +-------------------------------------+  |
| (Strict 1 Email)  |   POST /api/admin/* (Write/Direct/Voices/Synth)  |  | Admin Studio API (Auth Gate)        |  |
+-------------------+                                                  |  | Writer -> Val1 -> Director -> Val2  |  |
                                                                       |  +-------------------------------------+  |
                                                                       +------------+-----------------+------------+
                                                                                    |                 |
                                                    @google/genai SDK               |                 | StorageAdapter
                                         +------------------------------------------+                 +-------------------------+
                                         v                                                                                      v
                       +-----------------------------------+                                          +-----------------------------------+
                       |          Google Gemini API        |                                          |  GCS Bucket (or ./data/ Fallback) |
                       | - gemini-3.8-flash (Writer/Dir)   |                                          | - catalog.json   (ifGenMatch)     |
                       | - gemini-3.8-flash-lite-tts (5s)  |                                          | - voices.json    (ifGenMatch)     |
                       | - gemini-3.8-flash-tts (Full WAV) |                                          | - stories/{id}/story.json         |
                       | - ai.voices.create (Voice Design) |                                          | - stories/{id}/audios/{ver}.wav   |
                       +-----------------------------------+                                          +-----------------------------------+
```

### Key Architectural Decisions (Refined from Initial Draft)
1. **Model Selection:**
   - Narrative Writer & Voice Director LLM: `gemini-3.8-flash` (configurable via `GEMINI_TEXT_MODEL`; replaces deprecated `gemini-3.5-flash`).
   - 5-Second Audition Preview TTS: `gemini-3.8-flash-lite-tts` (`GEMINI_TTS_LITE_MODEL`).
   - Full Studio Story TTS: `gemini-3.8-flash-tts` (`GEMINI_TTS_MODEL`).
2. **Draft vs. Published Lifecycle:**
   - Creating/directing a story saves immediately as `status: "draft"` in `story.json` and `catalog.json` so work is never lost on refresh, while public `GET /api/catalog` filters strictly to `status === "published"`.
   - Synthesizing at least one audio version promotes the story to `status: "published"` (or admin can toggle unpublish). Deleting the last remaining audio version automatically reverts the story to `status: "draft"` and clears `default_audio_url`.
3. **Solo Storyteller vs. Multi-Speaker Cast Modes:**
   - `gemini-3.8-flash-tts` requires every `speechMetadata.speaker` in a request to map to a configured speaker voice, and `multiSpeakerVoiceConfig` supports **at most 2 distinct speakers per API call**.
   - **`solo` Mode (Default):** One narrator voice reads all turns. `story.json` keeps character names in `turn.speaker` for UI dialogue badges, while the TTS adapter maps `speechMetadata.speaker` to the single narrator and prepends character vocal traits into `speechMetadata.style` (e.g., `"As Bibi (gentle bell chime): warm, sleepy"`).
   - **`cast` Mode (Optional):** Maps `"Narrator"` and each character in `characters[]` to voice IDs in `voices.json`. During synthesis, contiguous turns sharing `<= 2` distinct speakers are grouped into sub-batches using `multiSpeakerVoiceConfig`, and raw PCM outputs are stitched with a `150ms` silence pad at speaker-group transitions.
4. **Chunked TTS + RIFF-Safe PCM Stitching:**
   - `gemini-3.8-flash-tts` has an **8,192 input token limit** and returns `audio/wav` (with RIFF headers) by default.
   - Long scripts are batched (`<= 12` turns and `<= 3,000` chars per batch). For every returned audio chunk, the server parses and strips any existing RIFF/WAV header to extract pure 24kHz 16-bit mono PCM bytes, concatenates all PCM buffers, calculates exact `duration_sec`, and prepends **one** canonical 44-byte RIFF/WAV header.
5. **Clean Visual Reader Regex:**
   - The Reader UI strips **only** angle-bracket vocal tags (`/<[^>]+>/g`) so legitimate prose parentheses like `(which was painted bright blue)` are never deleted. Validator 2 strips/rejects parenthetical stage directions like `(whispering)` before saving.
6. **Admin Session Cookie:**
   - Google ID tokens expire after 1 hour. `POST /api/admin/login` verifies the Google ID token (`email_verified === true` and `email.toLowerCase() === ADMIN_GOOGLE_EMAIL.toLowerCase()`) and issues a signed `HttpOnly`, `SameSite=Strict` HMAC-SHA256 cookie valid for 7 days (`SESSION_SECRET`).

---

## 2. Target Repository Layout

Keep the codebase flat and modular (single `package.json` at root for simple Cloud Run builds):

```text
/home/ubuntu/story-wizard/
├── .agents/
│   └── skills/
│       ├── gemini-3-8-tts-studio/
│       │   └── SKILL.md
│       └── gcs-json-catalog/
│           └── SKILL.md
├── shared/
│   ├── types.ts                 # All shared TS interfaces & API payload contracts
│   └── textClean.ts             # Approved vocal tags list + reader tag-stripping helper
├── server/
│   ├── index.ts                 # Express app entry & static SPA serving on PORT (8080)
│   ├── app.ts                   # Express app factory (injectable services for supertest)
│   ├── config.ts                # Env var parsing & safety assertions
│   ├── middleware/
│   │   └── auth.ts              # Google ID token verifier + HMAC session cookie middleware
│   ├── storage/
│   │   ├── storageAdapter.ts    # Interface: readJson, writeJsonAtomic, writeAudio, streamAudio, deleteFile
│   │   ├── localStorage.ts      # ./data/ implementation with Range slice streaming
│   │   └── gcsStorage.ts        # @google-cloud/storage with ifGenerationMatch + Range streaming
│   ├── lib/
│   │   ├── wav.ts               # extractPcmFromWavOrRaw(), createSilencePcm(), wrapPcmAsWav()
│   │   └── validators.ts        # validateWriterOutput() (Val 1) & validateDirectorOutput() (Val 2)
│   ├── services/
│   │   ├── geminiStory.ts       # Writer LLM & Director LLM calls (gemini-3.8-flash)
│   │   └── geminiTts.ts         # Preview TTS, Voices API create/list, Chunked Full TTS
│   └── routes/
│       ├── public.ts            # GET /api/catalog, /api/stories/:id, /api/stories/:id/audios/:file
│       ├── auth.ts              # POST /api/admin/login, POST /api/admin/logout, GET /api/admin/me
│       ├── adminStories.ts      # Write, Direct, Update Draft, Synthesize, Version Default/Delete, Delete Story
│       └── adminVoices.ts       # GET /api/admin/voices, POST /api/admin/voices/preview, POST /api/admin/voices
├── client/
│   ├── index.html               # Google Fonts (Fraunces, Bitter, Fira Code) + Google Identity script
│   ├── main.tsx                 # React entry
│   ├── App.tsx                  # Route switch: Public Library/Reader vs /admin Studio
│   ├── styles/
│   │   └── kinetic.css          # Exact Kinetic Construct CSS tokens (light/dark), tactile cards, reader styles
│   ├── api/
│   │   └── client.ts            # Typed fetch wrapper
│   └── components/
│       ├── Masthead.tsx         # Title, theme toggle, Admin Studio link / login status
│       ├── StoryCatalog.tsx     # Instant search, tag pills, series filter, story cards
│       ├── StoryReader.tsx      # Drop-cap prose, dialogue speaker badges, admin inline version actions
│       ├── AudioPlayerBar.tsx   # Docked bottom player, scrub bar, timecode, version switcher dropdown
│       ├── AdminLoginGate.tsx   # Google Sign-In button + dev-mode bypass button (non-prod only)
│       ├── DirectorStudio.tsx   # Mode A/B form, Writer->Director stepper, inline turn editor
│       └── VoiceStudioPanel.tsx # Voice picker, 5s audition preview, custom voice creator, Solo/Cast synth
├── scripts/
│   └── seedLocalData.ts         # Generates ./data/ sample catalog, voices, story, and valid 1s WAV
├── tests/
│   ├── wav.test.ts              # Unit tests: RIFF header parsing, PCM stitching, silence, duration
│   ├── validators.test.ts       # Unit tests: Validator 1, Validator 2, and reader tag cleaner
│   ├── storageAndAuth.test.ts   # Integration: Range 206/416, atomic write, path traversal, auth cookie
│   ├── pipelineApi.test.ts      # Integration: Mocked Writer/Director/Sequel/Draft lifecycle
│   ├── ttsSynthesis.test.ts     # Integration: Chunking, Solo vs >2 speaker Cast sub-batching, version delete
│   ├── ui.test.tsx              # Component/DOM tests: Reader tag cleaning, search filter, version switch
│   └── e2e/
│       └── storybook.spec.ts    # Headless Playwright Chromium E2E + qa-screenshots/ capture
├── .gitattributes               # Enforces LF line endings across WSL & Windows
├── .gitignore                   # Excludes .env, node_modules, dist, data, qa-screenshots
├── Dockerfile                   # Single multi-stage Node 22 Alpine build
├── .dockerignore
├── deploy.sh                    # gcloud run deploy helper (--timeout=300 --memory=512Mi)
├── playwright.config.ts         # Headless Chromium config pointing at built local server
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 3. Environment Variables (`server/config.ts`)

| Variable | Required in Prod | Default | Purpose |
| :--- | :---: | :--- | :--- |
| `PORT` | No | `8080` | HTTP port for Cloud Run & local server |
| `NODE_ENV` | Yes | `development` | `development` \| `test` \| `production` |
| `GEMINI_API_KEY` | Yes | — | API key passed to `new GoogleGenAI({ apiKey })` |
| `GEMINI_TEXT_MODEL` | No | `gemini-3.8-flash` | Model for Writer & Director stages |
| `GEMINI_TTS_MODEL` | No | `gemini-3.8-flash-tts` | Model for full studio audio synthesis |
| `GEMINI_TTS_LITE_MODEL` | No | `gemini-3.8-flash-lite-tts` | Model for 5-second voice audition previews |
| `GCS_BUCKET_NAME` | Yes (Cloud Run) | `""` | If unset/empty, `StorageAdapter` uses local `DATA_DIR` |
| `DATA_DIR` | No | `./data` | Local filesystem fallback root when `GCS_BUCKET_NAME` is empty |
| `ADMIN_GOOGLE_EMAIL` | Yes | — | Exact Google email allowed into `/admin` and `/api/admin/*` |
| `GOOGLE_CLIENT_ID` | Yes | `""` | OAuth 2.0 Web Client ID for Google Identity Services ID token audience check |
| `SESSION_SECRET` | Yes | (32+ char random in dev) | HMAC-SHA256 secret for signing admin `HttpOnly` session cookies (throw at startup in `production` if missing or `< 32` chars) |
| `DEV_ADMIN_BYPASS` | **Never in Prod** | `false` | Allows `POST /api/admin/login` with `{ devBypass: true }` **ONLY** when `NODE_ENV !== 'production'` AND `!process.env.K_SERVICE`. Must be hard-ignored on Cloud Run (`K_SERVICE` present) or in `production`. |

### Local `.env` Loading & Offline-First Test Rule
- Use Node 22's built-in `--env-file-if-exists=.env` flag in `"dev"` and `"start"` scripts (no `dotenv` package needed), and ensure `.gitignore` + `.dockerignore` exclude `.env`, `node_modules/`, `dist/`, and `data/`.
- **All `npm test` suites MUST pass 100% offline with zero API keys set** (using local `./data/` temp directories, `DEV_ADMIN_BYPASS=true` in test env, and injected `StoryLLMProvider` / `TtsProvider` mocks).
- **Conditional Live Smoke Test (`npm run test:live`):** If `process.env.GEMINI_API_KEY` IS present in `.env`, run a tiny 1-request live smoke script at the end of Phase 3 (2-turn Writer + Director call) and Phase 4 (5-second `gemini-3.8-flash-lite-tts` preview) to verify real `@google/genai` wire compatibility without burning significant quota.

---

## 4. Canonical Data Contracts (`shared/types.ts`)

All JSON files in GCS / `./data/` and API payloads MUST conform to these exact schemas:

```ts
export type StoryStatus = 'draft' | 'published';

export interface CatalogItem {
  id: string;                      // e.g. "2026-11-04-sleepy-little-train"
  status: StoryStatus;             // Public GET /api/catalog returns ONLY "published"
  title: string;
  summary: string;
  tags: string[];
  series_id: string | null;
  episode_number: number | null;
  created_at: string;              // ISO 8601
  updated_at: string;              // ISO 8601
  default_audio_url: string | null;// "/api/stories/{id}/audios/{version_id}.wav" or null if draft
  audio_versions_count: number;
}

export interface CharacterProfile {
  name: string;                    // e.g. "Bibi" (never "Narrator" — Narrator is implicit)
  traits: string;                  // Personality + vocal timbre hint, e.g. "Gentle bell chime, curious"
}

export interface ScriptTurn {
  turn_id: number;                 // 1-indexed contiguous integer (1, 2, 3...)
  speaker: string;                 // "Narrator" or exact match to a CharacterProfile.name
  style: string;                   // Sustained acting note for speechMetadata.style (empty string "" right after Writer, populated by Director)
  text: string;                    // Verbatim spoken text; after Director may include approved <...> vocal tags
}

export interface VoiceDesignCandidate {
  label: string;                   // e.g. "Cozy Grandpa Owl"
  description: string;             // Natural-language prompt for ai.voices.create
  suggested_for: string;           // "Narrator (Solo)" or character name
}

export interface VoiceCasting {
  mode: 'solo' | 'cast';
  narrator_voice_id: string;       // References VoiceEntry.id in voices.json
  character_voices: Record<string, string>; // Used in 'cast' mode: { [characterName]: voiceEntryId }
}

export interface AudioVersion {
  version_id: string;              // Immutable slug, e.g. "v1-owl-solo-1762350000"
  label: string;                   // e.g. "Grandpa Owl (Bedtime Solo)"
  casting: VoiceCasting;
  is_default: boolean;
  duration_sec: number;
  audio_url: string;               // "/api/stories/{story_id}/audios/{version_id}.wav"
  created_at: string;
}

export interface SeriesContext {
  series_id: string;
  episode_number: number;
  previous_story_id?: string;
  preferred_voice_id?: string;
}

export interface Story {
  id: string;
  status: StoryStatus;
  title: string;
  summary: string;
  tags: string[];
  series_context: SeriesContext | null;
  characters: CharacterProfile[];
  script_turns: ScriptTurn[];
  voice_candidates: VoiceDesignCandidate[]; // Populated by Director LLM
  audio_versions: AudioVersion[];
  created_at: string;
  updated_at: string;
}

export interface VoiceEntry {
  id: string;                      // Slug ID in voices.json, e.g. "prebuilt-kore" or "cozy-grandpa-owl"
  label: string;                   // Human title, e.g. "Kore (Warm Prebuilt)" or "Grandpa Owl"
  source: 'prebuilt' | 'designed';
  gemini_voice_name: string;       // Prebuilt name ("Kore", "Puck", "Aoede", "Charon", "Fenrir") OR custom "voice_..." ID from ai.voices.create
  description: string;
  language_code: string;           // Default "en-US"
  tags: string[];
  preview_audio_url?: string;      // Optional cached "/api/voices/{id}/preview.wav"
  created_at: string;
}
```

### Approved Point-in-Time Inline Vocal Tags (`shared/textClean.ts`)
Only these exact lowercase angle-bracket tags are permitted inside `ScriptTurn.text` sent to `gemini-3.8-flash-tts`:
```ts
export const APPROVED_VOCAL_TAGS = new Set([
  '<sigh>',
  '<laugh>',
  '<chuckle>',
  '<gasp>',
  '<yawn>',
  '<breath>',
  '<short pause>',
  '<long pause>',
]);

// Used by StoryReader UI ONLY — preserves normal prose parentheses like "(painted bright blue)"!
export function cleanTextForReader(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim();
}
```

---

## 5. Authoritative `@google/genai` & Audio Implementation Reference

> **CRITICAL FOR EXECUTING AGENT:** Copy these exact SDK patterns. Do not guess method names or mix Python snake_case where TypeScript camelCase is expected.

### 5.1 SDK Initialization (`@google/genai >= 2.24.0`)
```ts
import { GoogleGenAI, Type } from '@google/genai';

export function createGenAIClient(apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  return new GoogleGenAI({ apiKey });
}
```

### 5.2 Writer & Director Structured Output (`gemini-3.8-flash`)
```ts
const response = await ai.models.generateContent({
  model: config.geminiTextModel, // "gemini-3.8-flash"
  contents: promptText,
  config: {
    systemInstruction: writerSystemPrompt,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      required: ['title', 'summary', 'tags', 'characters', 'script_turns'],
      properties: {
        title: { type: Type.STRING },
        summary: { type: Type.STRING },
        tags: { type: Type.ARRAY, items: { type: Type.STRING } },
        characters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            required: ['name', 'traits'],
            properties: {
              name: { type: Type.STRING },
              traits: { type: Type.STRING },
            },
          },
        },
        script_turns: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            required: ['turn_id', 'speaker', 'text'],
            properties: {
              turn_id: { type: Type.INTEGER },
              speaker: { type: Type.STRING },
              text: { type: Type.STRING },
            },
          },
        },
      },
    },
  },
});
const parsed = JSON.parse(response.text ?? '{}');
```

### 5.3 Creating Custom Voices (`ai.voices.create`)
```ts
const created = await ai.voices.create({
  store: true,
  voice: {
    model: config.geminiTtsModel, // "gemini-3.8-flash-tts"
    type: 'prompted',
    displayName: label,
    languageCode: languageCode ?? 'en-US',
    prompted: {
      input: descriptionPrompt,
    },
  },
});
// Persist created.id (starts with "voice_...") in voices.json as gemini_voice_name!
```

### 5.4 Building `voiceConfig` Helper (Prebuilt vs. Designed `voice_...`)
```ts
function toGeminiVoiceConfig(voice: VoiceEntry) {
  if (voice.source === 'prebuilt') {
    return { prebuiltVoiceConfig: { voiceName: voice.gemini_voice_name } };
  }
  // Custom Voice Design ID ("voice_...")
  return { voice: voice.gemini_voice_name };
}
```

### 5.5 TTS Synthesis Payloads (`solo` vs `cast` Mode)

* **Solo Mode Batch Request (`<= 12` turns & `<= 3,000` chars per batch):**
  Every turn's `speechMetadata.speaker` is normalized to `"Narrator"`. If `turn.speaker !== "Narrator"`, prepend character voice context into `style` so the solo narrator performs distinct character voices without triggering multi-speaker validation errors:
  ```ts
  const parts = batchTurns.map((turn) => {
    const charTrait = characterMap.get(turn.speaker);
    const effectiveStyle =
      turn.speaker === 'Narrator'
        ? turn.style || 'Warm, calm bedtime storytelling cadence'
        : `Speaking dialogue as ${turn.speaker}${charTrait ? ` (${charTrait})` : ''}: ${turn.style || 'expressive, gentle'}`;
    return {
      text: turn.text,
      speechMetadata: {
        speaker: 'Narrator',
        style: effectiveStyle,
      },
    };
  });

  const res = await ai.models.generateContent({
    model: config.geminiTtsModel, // or geminiTtsLiteModel for 5s preview
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: toGeminiVoiceConfig(narratorVoice),
      },
    },
  });
  ```

* **Cast Mode Sub-Batching Rule (`multiSpeakerVoiceConfig` 2-Speaker Ceiling):**
  `multiSpeakerVoiceConfig` accepts **at most 2 distinct speakers** per call (or single-speaker `voiceConfig` when a sub-batch has 1 speaker):
  1. Walk `script_turns` in order and group contiguous turns into a sub-batch as long as `distinctSpeakers.size <= 2`, `turns.length <= 12`, and `charCount <= 3000`. Start a new sub-batch whenever adding the next turn would introduce a 3rd speaker or exceed batch size.
  2. If a sub-batch has **1 distinct speaker**, call `generateContent` with single `voiceConfig` for that speaker's mapped `VoiceEntry`.
  3. If a sub-batch has **2 distinct speakers**, call `generateContent` with `multiSpeakerVoiceConfig`:
     ```ts
     speechConfig: {
       multiSpeakerVoiceConfig: {
         speakerVoiceConfigs: Array.from(distinctSpeakers).map((spk) => ({
           speaker: spk,
           voiceConfig: toGeminiVoiceConfig(resolveVoiceForSpeaker(spk)),
         })),
       },
     }
     ```
  4. Extract raw PCM from every returned audio chunk (`inlineData.data` base64 -> `Buffer`), insert `createSilencePcm(150)` (`150ms` = `7,200` zero bytes at 24kHz 16-bit mono) between sub-batches, and wrap the concatenated PCM once with `wrapPcmAsWav(fullPcm, 24000, 1, 16)`.

### 5.6 RIFF-Safe PCM Extractor & WAV Wrapper (`server/lib/wav.ts`)
`gemini-3.8-flash-tts` returns `audio/wav` (which already includes a RIFF header) or `audio/L16` raw PCM. **Never blindly prepend a WAV header onto a buffer that already starts with `"RIFF"`!**
```ts
export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8); // 48,000

export function extractPcmFromWavOrRaw(input: Buffer): Buffer {
  if (input.length >= 44 && input.subarray(0, 4).toString('ascii') === 'RIFF' && input.subarray(8, 12).toString('ascii') === 'WAVE') {
    // Walk RIFF chunks to find 'data' chunk offset safely (handles optional LIST/JUNK chunks)
    let offset = 12;
    while (offset + 8 <= input.length) {
      const chunkId = input.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = input.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      if (chunkId === 'data') {
        return input.subarray(dataStart, Math.min(dataStart + chunkSize, input.length));
      }
      offset = dataStart + chunkSize + (chunkSize % 2); // word-aligned
    }
  }
  return input; // Already raw PCM
}

export function createSilencePcm(durationMs: number): Buffer {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2, 0); // 16-bit mono = 2 bytes/sample
}

export function wrapPcmAsWav(pcm: Buffer): { wav: Buffer; durationSec: number } {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                              // PCM fmt chunk size
  header.writeUInt16LE(1, 20);                               // AudioFormat = 1 (PCM)
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);// BlockAlign = 2
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return {
    wav: Buffer.concat([header, pcm]),
    durationSec: Math.max(1, Math.round(dataSize / BYTES_PER_SECOND)),
  };
}
```

---

## 6. Deterministic Validators (`server/lib/validators.ts`)

### Validator 1: Post-Writer Check (`validateWriterOutput`)
1. `title` and `summary` must be non-empty trimmed strings; `tags` must be a non-empty string array (lowercased, deduplicated).
2. `characters` must be an array of `{ name, traits }` with unique non-empty names, none named `"Narrator"` (case-insensitive).
3. `script_turns` must contain `>= 2` turns.
4. Re-index or verify `turn_id` is strictly contiguous `1..N`.
5. Every `turn.speaker` must equal `"Narrator"` or match a `characters[].name` (case-insensitive match normalized to canonical casing; unknown speakers raise a structured `ValidationError`).
6. Auto-split any single turn whose `text.length > 600` characters at sentence boundaries (`. `, `! `, `? `) so no turn bloats TTS pacing, then re-number `turn_id` `1..N`.
7. Strip any premature `<...>` tags from Writer output (vocal tags belong to Step 2 Director).

### Validator 2: Post-Director Check (`validateDirectorOutput`)
1. `directedTurns.length` MUST equal `writerTurns.length`, with identical `turn_id` and `speaker` at every index.
2. **Spoken Text Integrity Check:** Strip all `<[^>]+>` tags and parenthetical stage cues from `directedTurn.text` and compare normalized words against `writerTurn.text`. If the Director rewrote story prose instead of only inserting vocal tags, keep `writerTurn.text` + valid extracted tags (never lose story words!).
3. **Tag Whitelist Filter:** Find every `<[^>]+>` match in `turn.text`:
   - Normalize lowercase inside brackets (e.g. `<Short Pause>` -> `<short pause>`).
   - If in `APPROVED_VOCAL_TAGS`, keep it; otherwise **strip it** so invalid tags are never read aloud or rejected by TTS.
4. **Parenthetical Stage Direction Sanitizer:** If Director injected leading/inline stage notes like `(whispering)` or `(softly)` that were NOT present in `writerTurn.text`, move their text into `turn.style` and strip them from `turn.text`.
5. Ensure `turn.style` is a non-empty string (fallback: `"Warm, gentle storytelling tone"`) and `<= 200` chars.
6. Ensure `voice_candidates` has `1..3` valid `{ label, description, suggested_for }` entries.

---

## 7. Design System Tokens ("Kinetic Construct" UI)

Use these exact visual tokens in `client/styles/kinetic.css` (from the approved design spec):
- **Fonts:** `Fraunces` (700/800 headings & drop-cap), `Bitter` (400/500 story prose at `1.2rem`–`1.25rem`, line-height `1.65`), `Fira Code` (mono badges, buttons, timecodes, filters).
- **Light Theme (`:root` — Warm Alabaster):**
  - `--bg-canvas: #F4F0E6`, `--bg-surface: #FAF7F0`, `--bg-well: #EAE4D7`
  - `--ink-primary: #111111`, `--ink-prose: #222222`, `--ink-muted: #4A4740`
  - `--accent-module: #3730A3` (`#E0E7FF` bg), `--accent-root: #15803D` (`#DCFCE7` bg), `--accent-state: #9A3412` (`#FFEDD5` bg)
- **Dark Theme (`[data-theme="dark"]`):**
  - `--bg-canvas: #0E131B`, `--bg-surface: #161F2C`, `--bg-well: #1E293B`
  - `--ink-primary: #F1F5F9`, `--ink-prose: #E2E8F0`, `--ink-muted: #94A3B8`
- **Tactile Chrome:** `2px solid var(--ink-primary)` borders, `2px 2px 0px var(--ink-primary)` shadows (`4px 4px 0px` hover), `6px` border radius.
- **Reader Formatting:**
  - Opening `"Narrator"` paragraph renders a `Fraunces` 3.2rem ornamental float drop-cap (`first-letter`).
  - Character dialogue (`speaker !== "Narrator"`) renders inside an indented left-bordered block with a `Fira Code` speaker pill badge (`Bibi`).
  - All `ScriptTurn.text` passes through `cleanTextForReader(turn.text)` (`/<[^>]+>/g` removed; normal parentheses preserved).

---

## 8. Detailed 5-Phase Implementation & Validation Plan

---

### PHASE 0: Scaffolding, Workspace Skills, Shared Contracts & Pure Audio/Validator Core

#### Scope
1. Verify `.gitignore` and `.gitattributes` are in place, create `.env.example`, and initialize `package.json` with scripts:
   - `"dev"`: concurrent `tsx watch --env-file-if-exists=.env server/index.ts` + `vite` (with `/api` proxy to `:8080`)
   - `"build"`: `tsc -p tsconfig.server.json && vite build`
   - `"start"`: `node --env-file-if-exists=.env dist/server/index.js`
   - `"typecheck"`: `tsc --noEmit`
   - `"test"`: `vitest run` *(configure `vitest` in `vite.config.ts` with `exclude: ['node_modules', 'dist', 'tests/e2e/**']` so Vitest never tries to execute Playwright specs!)*
   - `"test:e2e"`: `playwright test`
   - `"seed"`: `tsx scripts/seedLocalData.ts`
2. Install exact minimal dependencies + Option A Headless Chromium inside WSL:
   - Runtime: `express`, `cookie-parser`, `@google/genai`, `@google-cloud/storage`, `google-auth-library`, `react`, `react-dom`
   - Dev/Test: `typescript`, `tsx`, `vite`, `@vitejs/plugin-react`, `vitest`, `supertest`, `@types/express`, `@types/cookie-parser`, `@types/supertest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `@playwright/test`
   - Run `npx playwright install --with-deps chromium` once so real headless Chromium + required Linux shared libraries (`libnss3`, `libasound2t64`, etc.) are ready in WSL.
   - Create `playwright.config.ts` targeting `testDir: './tests/e2e'`, `headless: true`, `browserName: 'chromium'`, with a `webServer` block starting the built server on a dedicated test port (e.g., `PORT=8181 DEV_ADMIN_BYPASS=true npm start`).
3. Create `.agents/skills/gemini-3-8-tts-studio/SKILL.md` and `.agents/skills/gcs-json-catalog/SKILL.md` documenting the exact rules from Sections 4, 5, and 6 (with valid YAML `name` and `description` frontmatter).
4. Implement `shared/types.ts`, `shared/textClean.ts`, `server/lib/wav.ts`, and `server/lib/validators.ts`.

#### Phase 0 Tests & Validation Gate (`tests/wav.test.ts`, `tests/validators.test.ts`)
- [x] **WAV Unit Tests:**
  - `wrapPcmAsWav` outputs a buffer of length `44 + pcm.length` starting with `RIFF....WAVEfmt ` and `24000` sample rate at byte offset `24`.
  - `extractPcmFromWavOrRaw` cleanly strips the header from a wrapped WAV **and** from a WAV containing an extra `LIST` metadata chunk before `data`, returning byte-identical original PCM.
  - Concatenating two WAV buffers via `extractPcmFromWavOrRaw` + `createSilencePcm(150)` + `wrapPcmAsWav` yields exact expected byte length and `durationSec` with **no** embedded `"RIFF"` bytes after byte `0`.
- [x] **Validator & Cleaner Unit Tests:**
  - `cleanTextForReader('Hello <short pause> world (painted blue)! <sigh>')` returns `'Hello world (painted blue)!'` (parentheses intact!).
  - `validateWriterOutput` rejects unknown speakers, re-indexes turn IDs, strips premature `<sigh>` tags, and splits a `950`-char multi-sentence turn into `< 600`-char turns.
  - `validateDirectorOutput` normalizes `<Short Pause>` -> `<short pause>`, strips unauthorized `<explosion>`, relocates `(whispering)` to `style`, and restores Writer prose if Director mutated words.
- [x] **Playwright Binary Smoke Check:** `npx playwright --version` succeeds and headless Chromium launches cleanly in a 3-line smoke test (`browser.newPage()`).
- [x] Run `npm run typecheck && npm test`, update Progress Tracker, commit (`feat(phase-0): scaffold workspace, skills, wav and validator core`), and tag `phase-0-verified`.

---

### PHASE 1: Dual-Mode Storage, Audio HTTP Range Streaming, Seed Data & Admin Auth

#### Scope
1. **`StorageAdapter` (`server/storage/`):**
   - Path-safety check: validate `storyId` and `versionId` against `/^[a-z0-9][a-z0-9-_]{1,80}$/` to block `../` path traversal.
   - `LocalStorageAdapter`: reads/writes under `DATA_DIR` (`./data`). Atomic writes write to `.tmp-${pid}-${Date.now()}` then `fs.promises.rename()`. Supports byte-range read streams `fs.createReadStream(filePath, { start, end })` + total byte `size`.
   - `GcsStorageAdapter`: reads/writes to `gs://${GCS_BUCKET_NAME}`. Implements `updateJsonAtomic<T>(objectPath, mutatorFn)` by fetching `[contents]` + `[metadata]` (`generation`), applying `mutatorFn`, saving with `{ preconditionOpts: { ifGenerationMatch: generation } }` (using `0` when creating a missing file), and retrying up to 3 times on HTTP `412`. Streams audio via `file.createReadStream({ start, end })`.
2. **Seed Script (`scripts/seedLocalData.ts`):**
   - Populates `./data/voices.json` with 3 starter prebuilt voices (`Kore`, `Puck`, `Aoede`), `./data/stories/2026-11-04-sleepy-little-train/story.json` (`status: "published"`), a valid 2-second synthesized soft-tone WAV file `v1-owl-solo.wav` generated via `wrapPcmAsWav`, and `./data/catalog.json`.
3. **Auth Middleware (`server/middleware/auth.ts`) & Routes (`server/routes/auth.ts`):**
   - `POST /api/admin/login`:
     - Standard path: verifies `idToken` with `OAuth2Client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })`, checks `payload.email_verified === true` and `payload.email.toLowerCase() === ADMIN_GOOGLE_EMAIL.toLowerCase()`. Unmatched email -> `403 Forbidden`.
     - Dev/Test bypass path: ONLY if `NODE_ENV !== 'production' && !process.env.K_SERVICE && DEV_ADMIN_BYPASS === 'true'`, accepts `{ devBypass: true }`.
     - Issues `story_admin_session` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in prod, `Max-Age=604800`) containing `base64url(JSON({ email, exp })) + "." + hmacSha256`.
   - `POST /api/admin/logout`: clears cookie.
   - `GET /api/admin/me`: returns `{ authenticated: boolean, email?: string }`.
   - `requireAdmin` middleware protects all `/api/admin/*` routes (`401` if unauthenticated, `403` if email mismatch).
4. **Public Routes (`server/routes/public.ts`):**
   - `GET /api/catalog`: returns `CatalogItem[]` sorted newest-first. Filters to `status === 'published'` unless valid admin session cookie is present AND `?includeDrafts=true`.
   - `GET /api/stories/:id`: returns `Story`. If `story.status === 'draft'` and caller is not admin -> `404`.
   - `GET /api/stories/:id/audios/:filename`:
     - Parses `Range: bytes=start-end` header:
       - No `Range` header -> `200 OK` with `Accept-Ranges: bytes`, `Content-Length: total`, `Content-Type: audio/wav`, `Cache-Control: public, max-age=31536000, immutable`.
       - Valid `Range` -> `206 Partial Content` with `Content-Range: bytes start-end/total`, `Content-Length: (end - start + 1)`, streaming only the requested slice.
       - Out-of-bounds `Range` -> `416 Range Not Satisfiable` with `Content-Range: bytes */total`.

#### Phase 1 Tests & Validation Gate (`tests/storageAndAuth.test.ts`)
- [x] **Catalog & Draft Privacy Test:** Seed 1 `"published"` story and 1 `"draft"` story in a temp `DATA_DIR`. Verify unauthenticated `GET /api/catalog` returns only the published story and `GET /api/stories/draft-id` returns `404`, while authenticated admin receives both.
- [x] **HTTP Range Streaming Tests:**
  - `GET .../v1-owl-solo.wav` without `Range` -> `200`, starts with `"RIFF"`, `Accept-Ranges: bytes`.
  - `GET .../v1-owl-solo.wav` with `Range: bytes=0-43` -> `206`, `Content-Length: 44`, `Content-Range: bytes 0-43/<total>`, exact 44-byte WAV header returned.
  - `GET .../v1-owl-solo.wav` with `Range: bytes=9999999-10000000` -> `416`.
- [x] **Path Traversal Test:** `GET /api/stories/..%2Fsecret/audios/test.wav` -> `400` or `404`.
- [x] **GCS Atomic Retry Unit Test:** Mock `@google-cloud/storage` Bucket/File to throw `{ code: 412 }` on first `save()` and succeed on second `save()`, verifying `updateJsonAtomic` re-reads the new generation and merges without data loss.
- [x] **Auth Security Tests:**
  - Wrong Google email (`attacker@gmail.com`) -> `403`.
  - Tampered session cookie HMAC signature -> `401`.
  - When `K_SERVICE="storyteller"` or `NODE_ENV="production"`, `{ devBypass: true }` returns `401` even if `DEV_ADMIN_BYPASS="true"`.
- [x] Run `npm run seed && npm run typecheck && npm test` -> **100% green**, update Progress Tracker, commit (`feat(phase-1): dual-mode storage, range streaming, and admin auth`), and tag `phase-1-verified`.

---

### PHASE 2: Public Storybook UI, Formatted Reader & Docked Audio Player

#### Scope
1. Implement `client/styles/kinetic.css` with Warm Alabaster + Dark Mode theme toggle (persisted in `localStorage`).
2. **Public Library (`StoryCatalog.tsx`):**
   - Search bar (instant client-side match across `title`, `summary`, `tags`), clickable tag filter pills, and series filter dropdown (`All Stories` or specific `series_id` sorted by `episode_number`).
   - Tactile cards showing title, episode badge (if in a series), summary, tags, version count, and *"Read & Listen"* button.
3. **Formatted Story Reader (`StoryReader.tsx`):**
   - Slide-over drawer or dedicated reader pane with `Fraunces` title, series breadcrumb, and tag pills.
   - Renders `script_turns`:
     - Opening `"Narrator"` turn gets ornamental drop-cap styling.
     - Subsequent `"Narrator"` turns render as clean `Bitter` prose paragraphs.
     - Character turns (`speaker !== "Narrator"`) render with indented accent border and speaker name pill badge (`Bibi`).
     - Uses `cleanTextForReader(turn.text)` so `<sigh>` / `<short pause>` are never shown visually while prose `(parentheses)` stay intact.
4. **Docked Bottom Audio Player (`AudioPlayerBar.tsx`):**
   - Play/Pause button, current time / duration (`01:12 / 04:00`), interactive seek/scrub range slider, playback speed toggle (`0.9x`, `1.0x`), and **Voice Version Selector** dropdown switching `audio.src` across `story.audio_versions` (defaulting to `is_default === true`).

#### Phase 2 Tests & Validation Gate (`tests/ui.test.tsx` + `tests/e2e/storybook.spec.ts`)
- [x] **Component Tests (`@testing-library/react`):**
  - Renders seeded story in `StoryReader`: asserts `<short pause>` in `turn.text` is absent from DOM while `(painted bright blue)` in `turn.text` IS rendered in DOM, and character speaker badge `"Bibi"` renders.
  - Typing in search input and clicking a tag pill filters displayed story cards accurately.
  - Switching the Audio Version dropdown updates the `<audio>` element's `src` attribute to the selected version's `audio_url`.
  - Clicking Dark Mode toggle sets `data-theme="dark"` on `document.body`.
- [x] **Headless Chromium E2E & Visual Capture (`npm run build && npm run test:e2e`):**
  - Asserts zero `pageerror` and zero `console.error` events on load, search, story open, theme toggle, and mobile viewport (`375x812`) horizontal-overflow check (`document.documentElement.scrollWidth <= window.innerWidth`).
  - Verifies the `<audio>` element loads seeded WAV metadata (`audio.duration > 0`) and supports seeking (`audio.currentTime = 0.5`).
  - Saves `qa-screenshots/phase2-reader-light.png` and `qa-screenshots/phase2-reader-dark.png` (and inspect them with `read_file` if multimodal vision is supported).
- [x] Commit (`feat(phase-2): kinetic construct public reader and docked audio player`) and tag `phase-2-verified`.

---

### PHASE 3: Admin Director Studio — Writer, Director, Sequels & Draft Editor

#### Scope
1. **`GeminiStoryService` (`server/services/geminiStory.ts`):**
   - Define a clean `StoryLLMProvider` interface so tests inject deterministic mocks while production calls `GoogleGenAI` (`gemini-3.8-flash`).
   - **Step 1 (`generateStoryDraft`):**
     - **Mode A (Fresh):** Takes `{ prompt, referenceText?, seriesId? }`.
     - **Mode B (Sequel):** Loads `previousStoryId` from storage, extracts `series_id`, `episode_number + 1`, `characters[]` (character bible), `preferred_voice_id`, and `previous.summary`, and instructs Writer LLM to maintain character continuity while introducing new episodic events.
     - Runs **Validator 1** (`validateWriterOutput`). Saves `story.json` (`status: 'draft'`) and upserts `catalog.json` atomically.
   - **Step 2 (`directStoryScript`):**
     - Takes `story.id` (uses current `story.script_turns` and `story.characters`).
     - Prompts `gemini-3.8-flash` to annotate every turn with sustained `style` cues, inject natural point-in-time vocal tags from `APPROVED_VOCAL_TAGS` (`<sigh>`, `<short pause>`, etc.), and propose 3 `voice_candidates`.
     - Runs **Validator 2** (`validateDirectorOutput`). Updates `story.json` draft.
2. **Admin Story Endpoints (`server/routes/adminStories.ts`):**
   - `GET /api/admin/stories` — returns full catalog including `"draft"` stories.
   - `POST /api/admin/stories/write` — executes Step 1 + Validator 1, saves & returns `Story`.
   - `POST /api/admin/stories/:id/direct` — executes Step 2 + Validator 2, saves & returns `Story`.
   - `PUT /api/admin/stories/:id` — saves manual admin edits to `title`, `summary`, `tags`, `characters`, `script_turns` (runs Validator 1 + tag sanitizer on save!).
   - `PATCH /api/admin/stories/:id/status` — toggles `"draft"` / `"published"` (rejects `"published"` with `400` if `audio_versions.length === 0`!).
   - `DELETE /api/admin/stories/:id` — deletes all `audios/*.wav`, `story.json`, and removes item from `catalog.json` atomically.
3. **Admin Studio UI (`AdminLoginGate.tsx`, `DirectorStudio.tsx`):**
   - Accessible via `/admin` route (or Studio tab in Masthead). Shows Google Sign-In button (plus clear *"Dev Sandbox Login"* button ONLY when server reports dev bypass enabled).
   - Sidebar/list of existing stories (`DRAFT` vs `PUBLISHED` pills) to resume editing or start a sequel.
   - Mode A / Mode B toggle -> *"1. Write Story"* button -> *"2. Auto-Direct Voices & Pacing"* button.
   - **Editable Script Workbench:** Editable table/cards for every `ScriptTurn` (`speaker` dropdown, `style` input, `text` textarea with quick-insert buttons for `<short pause>`, `<sigh>`, `<chuckle>`, `<breath>`, plus Add/Delete Turn buttons and *"Save Script"*).

#### Phase 3 Tests & Validation Gate (`tests/pipelineApi.test.ts`)
- [x] **Mode A & Draft Isolation Test:** `POST /api/admin/stories/write` creates a `"draft"` story; public `GET /api/catalog` still excludes it; `POST /api/admin/stories/:id/direct` populates `style`, approved `<...>` tags, and 3 `voice_candidates`.
- [x] **Mode B Sequel Continuity Test:** Creating a sequel from seeded episode `1` automatically sets `series_context.episode_number === 2`, carries `series_id`, and passes prior `characters` into the Writer prompt.
- [x] **Publish Guardrail Test:** `PATCH /api/admin/stories/:id/status` with `{ status: "published" }` on a story with `0` audio versions returns `400 Bad Request`.
- [x] **Manual Edit Sanitization Test:** `PUT /api/admin/stories/:id` with an invalid `<cough_loudly>` tag strips the invalid tag while saving edited prose and styles.
- [x] **Delete Story Cleanup Test:** `DELETE /api/admin/stories/:id` removes story from `catalog.json` and deletes `story.json` + audio files.
- [x] **Headless Chromium E2E (`tests/e2e/storybook.spec.ts`):** Logs into `/admin` via Dev Sandbox button, edits a draft story's turn inline, inserts `<short pause>` via quick-tag button, saves cleanly with zero console errors, and captures `qa-screenshots/phase3-admin-studio.png`.
- [x] Run `npm run typecheck && npm test && npm run build && npm run test:e2e` -> **100% green**, commit (`feat(phase-3): admin director studio, writer-director pipeline, and sequel mode`), and tag `phase-3-verified`.

---

### PHASE 4: Voice Audition Studio, Chunked Gemini 3.8 TTS, Version Manager & Cloud Run Packaging

#### Scope
1. **`GeminiTtsService` (`server/services/geminiTts.ts`):**
   - Injectable `TtsProvider` interface for fast offline unit/integration tests + real `GoogleGenAI` implementation.
   - `previewVoice({ voiceEntryOrPrompt, sampleText })`: synthesizes 1–2 sentences (`<= 220` chars) via `gemini-3.8-flash-lite-tts` and returns a valid RIFF WAV `Buffer`.
   - `createAndSaveVoice({ label, description, languageCode, tags })`: calls `ai.voices.create({ store: true, voice: { model: 'gemini-3.8-flash-tts', type: 'prompted', displayName: label, languageCode, prompted: { input: description } } })`, stores optional cached preview WAV, and appends `VoiceEntry` to `voices.json` atomically.
   - `synthesizeFullStory(story, casting, label)`:
     - Implements Section 5.5 & 5.6: batches turns (`<= 12` turns & `<= 3,000` chars; plus `<= 2` distinct speakers per sub-batch in `cast` mode), extracts raw PCM with `extractPcmFromWavOrRaw`, inserts `150ms` silence between batches, wraps once with `wrapPcmAsWav`, writes `stories/{id}/audios/{version_id}.wav`, appends `AudioVersion` to `story.json` (setting `is_default: true` if first version or `makeDefault: true`), sets `story.status = 'published'`, and atomically updates `catalog.json`.
2. **Voice & Audio Version Endpoints (`server/routes/adminVoices.ts`, `server/routes/adminStories.ts`):**
   - `GET /api/admin/voices` — lists `voices.json`.
   - `POST /api/admin/voices/preview` — returns `audio/wav` 5s preview (`gemini-3.8-flash-lite-tts`).
   - `POST /api/admin/voices` — creates custom voice via Voices API + saves to `voices.json`.
   - `POST /api/admin/stories/:id/synthesize` — runs full synthesis (`solo` or `cast`) and publishes.
   - `PATCH /api/admin/stories/:id/versions/:versionId/default` — marks version as `is_default: true` (clearing others) and updates `catalog.json.default_audio_url`.
   - `DELETE /api/admin/stories/:id/versions/:versionId` — deletes `.wav` file, removes from `audio_versions`:
     - If deleted version was default and other versions remain -> promotes newest remaining version to `is_default: true` and updates `catalog.json.default_audio_url`.
     - If `0` versions remain -> sets `story.status = 'draft'`, `default_audio_url = null`, `audio_versions_count = 0` in `catalog.json`!
3. **Voice Studio UI (`VoiceStudioPanel.tsx`) & Reader Admin Controls:**
   - Displays `story.voice_candidates` with one-click *"5s Preview"* (`gemini-3.8-flash-lite-tts`) and *"Save to Voice Library"* (`ai.voices.create`).
   - Casting selector: **Solo Storyteller** (pick 1 voice from `voices.json`) vs **Multi-Speaker Cast** (pick voice per speaker: `Narrator` + `characters[]`), version label input, and *"Synthesize & Publish Audio"* button with clear elapsed-time progress state.
   - Logged-in admins also see inline *"★ Set Default"* and *"🗑 Delete Version"* controls in both the Studio and the `StoryReader` version list.
4. **Cloud Run Packaging (`Dockerfile`, `.dockerignore`, `deploy.sh`):**
   - Multi-stage `node:22-alpine` `Dockerfile` (`npm ci` -> `npm run build` -> prune devDependencies -> non-root `USER node` -> `EXPOSE 8080` -> `CMD ["node", "dist/server/index.js"]`).
   - `deploy.sh` documenting exact `gcloud run deploy storyteller-studio --source . --allow-unauthenticated --timeout=300 --memory=512Mi --cpu=1` command + required env vars.

#### Phase 4 Tests & Final Release Gate (`tests/ttsSynthesis.test.ts` + Full E2E Smoke)
- [ ] **Long-Story Batching & RIFF De-duplication Test:** Feed a 28-turn story in `solo` mode with a mock `TtsProvider` that returns valid WAV buffers (complete with 44-byte RIFF headers) for each batch. Assert:
  1. Provider was called `3` times (`12 + 12 + 4` turns) with `speechMetadata.speaker === "Narrator"` and character traits folded into `speechMetadata.style`.
  2. Saved `.wav` file has `"RIFF"` ONLY at byte `0` (no mid-stream RIFF header pops) and exact expected total byte size (`44 + sum(pcm) + 2 * silence150ms`).
- [ ] **3-Character Cast Mode Sub-Batching Test:** Feed a story with `"Narrator"`, `"Bibi"`, and `"Owl"` (`3` distinct speakers) in `cast` mode. Assert `TtsProvider` never receives a `multiSpeakerVoiceConfig` with `> 2` `speakerVoiceConfigs` in any single call, and every turn's `speechMetadata.speaker` matches one of that call's configured speakers.
- [ ] **Version Promotion & Last-Version Deletion Test:**
  - Synthesize `v1` (becomes default, `status === "published"`), then `v2` (`makeDefault: false`).
  - `PATCH .../v2/default` -> updates `catalog.json.default_audio_url` to `v2`.
  - `DELETE .../v2` -> automatically promotes `v1` back to `is_default: true` and updates `catalog.json.default_audio_url` to `v1`.
  - `DELETE .../v1` -> `0` versions left; story automatically reverts to `status: "draft"` and disappears from public `GET /api/catalog`!
- [ ] **Full Build, Headless Chromium E2E & Container Smoke Test:**
  - Extend `tests/e2e/storybook.spec.ts` to verify Voice Studio panel rendering (`Solo` vs `Cast` toggle, version default/delete controls) and capture `qa-screenshots/phase4-voice-studio.png`.
  - `npm run typecheck && npm test && npm run build && npm run test:e2e` -> all exit `0`.
  - Run `docker build -t storyteller-studio .` and verify container starts cleanly on `PORT=8080` and responds `200` on `/` and `/api/catalog`.
- [ ] Commit (`feat(phase-4): voice audition studio, chunked gemini 3.8 tts, and cloud run dockerfile`) and tag `phase-4-verified`.

---

## 9. Common Pitfalls Checklist (Read Before Coding)

1. **Do NOT use `/<[a-z\s]+>|\([^)]+\)/gi` in the Reader UI:** That regex deletes normal story parentheses. Always use `cleanTextForReader` (`/<[^>]+>/g`).
2. **Do NOT concatenate raw Gemini WAV responses without `extractPcmFromWavOrRaw()`:** `gemini-3.8-flash-tts` returns `audio/wav` with RIFF headers; concatenating two WAV files directly embeds a 44-byte header mid-audio and leaves the initial WAV `dataSize` truncated to only the first chunk!
3. **Do NOT pass > 2 speakers in a single `multiSpeakerVoiceConfig`:** Always group contiguous turns into `<= 2`-speaker sub-batches in `cast` mode, or normalize to `"Narrator"` in `solo` mode.
4. **Do NOT buffer entire `.wav` files into `res.send()` without `Range` handling:** iOS Safari `<audio>` requires `206 Partial Content` + `Accept-Ranges: bytes` to scrub/seek.
5. **Do NOT allow `DEV_ADMIN_BYPASS` when `NODE_ENV === 'production'` or `process.env.K_SERVICE` is defined.**
6. **Do NOT let Vitest pick up Playwright specs:** Always set `test.exclude: ['node_modules', 'dist', 'tests/e2e/**']` in `vite.config.ts`.
7. **Do NOT run Windows `npm install` inside the WSL directory (`\\wsl.localhost\...`):** Linux and Windows native `node_modules` (`esbuild`, Rollup, Playwright) are OS-specific. Follow Section 10 when inspecting from Windows Antigravity.

---

## 10. Phase 5: Windows Antigravity Visual & Live Browser QA Handoff

Once `phase-4-verified` is tagged in WSL, you can run a final interactive GUI browser & audio polish pass from **Antigravity on Windows** (where the built-in `/browser` tool drives desktop Chrome natively).

### How to Connect Windows Antigravity Safely (Pick Workflow A or B)

* **Workflow A — Hybrid Mode (Fastest, Zero Duplicate Files — Recommended):**
  1. Keep the server running inside WSL (`cd /home/ubuntu/story-wizard && DEV_ADMIN_BYPASS=true npm run dev` or `npm start` on `:8080`). WSL2 automatically exposes `http://localhost:8080` (and `:5173`) to Windows Chrome!
  2. In **Windows Antigravity**, open folder: `\\wsl.localhost\Ubuntu\home\ubuntu\story-wizard`
  3. **Important:** Let the Windows agent edit source files and drive `/browser` against `http://localhost:8080`, and instruct it to run `npm` / `git` commands via `wsl -d Ubuntu -- bash -lc "..."` so WSL's Linux `node_modules` binaries stay intact.
* **Workflow B — Separate Native Windows Git Clone:**
  1. In Windows PowerShell, clone directly from your WSL Git repo:
     ```powershell
     git clone "\\wsl.localhost\Ubuntu\home\ubuntu\story-wizard" C:\dev\story-wizard
     cd C:\dev\story-wizard
     npm ci
     ```
  2. Open `C:\dev\story-wizard` in Windows Antigravity, run QA & fixes natively on Windows, commit, and run `git push origin main` (this repo is pre-configured with `receive.denyCurrentBranch=updateInstead` so pushing updates WSL `/home/ubuntu/story-wizard` cleanly!).

### Ready-to-Paste Prompt for Windows Antigravity Session (Phase 5 QA & Polish)

```text
Read HANDOFF_PLAN.md first to understand the architecture, Kinetic Construct design tokens, and guardrails for Storyteller Studio. Phases 0–4 were built and verified in WSL Ubuntu (tagged `phase-4-verified`).

Environment rule (Hybrid WSL + Windows):
- If this workspace is opened via `\\wsl.localhost\Ubuntu\home\ubuntu\story-wizard`, DO NOT run Windows `npm install` here (which would overwrite Linux `node_modules`). Instead, execute server/build/test commands inside WSL via:
  `wsl -d Ubuntu -- bash -lc "cd /home/ubuntu/story-wizard && <command>"`
- Ensure the app is running inside WSL (`DEV_ADMIN_BYPASS=true npm start` or `npm run dev`) and accessible at `http://localhost:8080`.

Use your interactive browser capabilities (`/browser`) on `http://localhost:8080` to perform a thorough Phase 5 Visual, UX, and Audio QA pass:
1. Public Library & Kinetic Construct Visual Audit:
   - Inspect both Desktop (`1440x900`) and Mobile (`375x812`) viewports in Light (Warm Alabaster) and Dark themes.
   - Verify Fraunces + Bitter + Fira Code typography, 2px tactile borders/shadows, zero horizontal overflow, instant search/tag/series filtering, and smooth Reader layout (ornamental drop-cap on opening narration, character dialogue badges, `<tag>` stripping without losing normal parentheses).
2. Docked Audio Player & Range Scrubbing:
   - Play a story's audio, drag/scrub the timeline slider forward and backward (confirming HTTP 206 Range seeking works cleanly), test `0.9x` / `1.0x` playback speed, and switch between audio versions.
3. Admin Director & Voice Studio (`/admin`):
   - Log in via Dev Sandbox Login (or Google OAuth if configured), walk through creating/editing a story draft, verify quick-insert vocal tag pills (`<short pause>`, `<sigh>`), test Voice Audition preview & Solo/Cast synthesis controls (including live Gemini calls if `GEMINI_API_KEY` is configured in `.env`), and test "Set Default" / "Delete Version".
4. Fix & Verify:
   - Check browser DevTools console and network tabs for any warnings, failed requests, layout shifts, or rough UX edges.
   - Fix any issues cleanly without over-engineering, re-verify in `/browser` and run full `npm run typecheck && npm test && npm run test:e2e` (via WSL if using Hybrid Mode), commit fixes as `fix(qa): <summary>`, check off Phase 5 in HANDOFF_PLAN.md, and tag `phase-5-qa-complete`.
```

---

## 11. Progress Tracker (Update as Phases Complete)

- [x] **Phase 0:** Scaffolding, `.agents/skills/`, Playwright Headless Chromium Setup, Shared Types, WAV & Validator Core + Unit Tests (`phase-0-verified`)
- [x] **Phase 1:** Dual-Mode Storage (`./data` + GCS `ifGenerationMatch`), Audio `Range` Streaming, Seed Data & Single-Admin Auth + Integration Tests (`phase-1-verified`)
- [x] **Phase 2:** Public Storybook UI (Kinetic Construct Theme, Instant Filter, Formatted Reader, Docked Audio Player) + Component & Headless E2E Tests (`phase-2-verified`)
- [x] **Phase 3:** Admin Director Studio (Mode A/B Writer -> Val 1 -> Director -> Val 2, Sequels, Draft Editor) + Pipeline & Headless E2E Tests (`phase-3-verified`)
- [ ] **Phase 4:** Voice Audition Studio (`voices.json`), Chunked Gemini 3.8 TTS (`solo` & `cast`), Version Manager & Cloud Run `Dockerfile` + Release Gate (`phase-4-verified`)
- [ ] **Phase 5:** Interactive Windows Antigravity `/browser` Visual, Mobile, & Audio Scrubbing QA Pass (`phase-5-qa-complete`)
