---
name: gemini-3-8-tts-studio
description: Authoritative guide for generating multi-genre children's narratives, directing voice acting without rushing speech, designing/managing custom prompted voices, transcribing voice dictation, and synthesizing speech with @google/genai, Gemini 4 Hydrogen (gemini-4-hydrogen), and Gemini 3.8 TTS models (gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts).
---

# Gemini Story Writer/Director (`gemini-4-hydrogen`) & Gemini 3.8 TTS Studio Skill

## Model Selection
- Narrative Writer, Voice Director & Audio Dictation STT LLM: `gemini-4-hydrogen` (`GEMINI_TEXT_MODEL`, with `thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }` via `GEMINI_THINKING_LEVEL=LOW` for cost/latency control).
- 5-Second Audition Preview TTS: `gemini-3.8-flash-lite-tts` (`GEMINI_TTS_LITE_MODEL`).
- Full Studio Story TTS: `gemini-3.8-flash-tts` (`GEMINI_TTS_MODEL`).

## SDK Requirements
- Use exclusively `@google/genai` (`>= 2.24.0`, verified against `v2.32.0`). Never use legacy `@google/generative-ai`.
- Client initialization:
  ```ts
  import { GoogleGenAI, Type } from '@google/genai';
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  ```

## Custom Voice Design & Staged Draft Lifecycle (`ai.voices.*`)
1. **`ai.voices.create` Constraints:**
   - `voice.type: 'prompted'` **requires `store: true`** (`store: false` returns `INVALID_ARGUMENT`).
   - Returns `created.id` as a bare ID like `"voice_abc123def456"` (plus optional `created.sample_audio?.data` base64 WAV).
   - `generateContent` (`SpeechConfig` / `VoiceConfig`) has **no** inline `prompted` config; custom voices must be referenced via `voiceConfig: { voice: "voice_abc123def456" }`.
2. **`ai.voices.delete` Runtime URL Encoding Rule (CRITICAL):**
   - Inside `@google/genai` (`dist/node/index.mjs`), `voicesDelete` constructs the URL via `/{api_version}/voices/{voicesId}` with percent-encoding (`encodeSimple`).
   - **Always pass the bare voice ID (`"voice_abc123def456"`)**—strip any leading `"voices/"` prefix via `voiceId.replace(/^voices\//, '')` before calling `await ai.voices.delete(bareId)`! Passing `"voices/voice_..."` will percent-encode the slash into `/voices/voices%2Fvoice_...` and fail with 404/400.
3. **Staged Draft Voice Pattern ("What You Preview Is 100% What You Save"):**
   - Never fall back to prebuilt `'Kore'` when previewing an unsaved voice prompt (`description`).
   - On unsaved prompt preview, call `ai.voices.create({ store: true, ... })` to obtain a real `voice_...` ID, synthesize the sample text with `gemini-3.8-flash-lite-tts` using `voiceConfig: { voice: geminiVoiceName }`, and return the WAV with `X-Draft-Voice-Name: <geminiVoiceName>`.
   - Reusing `draftGeminiVoiceName` lets the user audition different sample presets or paces on the exact same voice take; clicking **"Regenerate Take"** or discarding calls `ai.voices.delete(bareOldDraftId)` (after verifying the ID is not in saved `voices.json`).
   - Clicking **"Save Voice"** promotes `stagedGeminiVoiceName` directly into `voices.json` without calling `ai.voices.create` a second time, guaranteeing 100% vocal identity parity between preview and saved voice.

## Multimodal Audio Dictation (Speech-to-Text with `gemini-4-hydrogen`)
Pass recorded browser audio (`audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav`) inline via `Part.inlineData`:
```ts
const response = await ai.models.generateContent({
  model: config.geminiTextModel, // 'gemini-4-hydrogen'
  contents: [
    {
      inlineData: {
        data: audioBase64, // Raw base64 bytes (strip any "data:audio/...;base64," prefix first)
        mimeType,          // e.g. 'audio/webm' or 'audio/mp4'
      },
    },
    'Transcribe the spoken audio accurately with natural punctuation. Output ONLY the transcribed text without commentary or quotes.',
  ],
  config: {
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
  },
});
const transcript = (response.text || '').trim();
```

## Writer & Single-Call Director Pacing Guardrails
- Writer LLM generates structured JSON containing `title`, `summary`, `tags`, `characters`, `script_turns`.
- Director LLM (`directScript` — **1 single LLM call**, no extra LLM pass) annotates `script_turns` with sustained `style` notes and approved inline tags.
- **Anti-Rush Acting Rule (Young Children Ages 3–8):**
  - Turn-level `speechMetadata.style` overrides base voice prompt pacing in Gemini TTS.
  - Instruct the Director LLM to separate **emotional energy** from **speaking speed**: encourage vivid theatrical emotions, character mimicry, playful pitch, dramatic urgency, and `<short pause>` / `<breath>` comedic beats, while **never** emitting literal fast-rate directives (`"at high speed"`, `"cartoonish speed"`, `"fast-paced"`, `"full speed"`, `"rapid-fire"`, `"speaking rapidly"`).
  - Do **not** aggressively strip emotional words (`excited`, `frantic`, `breathless`, `chaotic`, `urgent`) in Validator 2—preserve emotional richness!

## Approved Point-in-Time Vocal Tags
Only these exact 8 lowercase angle-bracket tags are permitted in `ScriptTurn.text`:
- `<sigh>`
- `<laugh>`
- `<chuckle>`
- `<gasp>`
- `<yawn>`
- `<breath>`
- `<short pause>`
- `<long pause>`

All other tags are stripped by Validator 2 before reaching TTS synthesis.
Reader UI preserves prose parentheses `(like this)` and only strips `/<[^>]+>/g`.

## TTS Synthesis, Pacing & Chunking Rules
1. **No Numeric `speakingRate` in `@google/genai`:**
   - `SpeechConfig`, `VoiceConfig`, and `SpeechMetadata` have **no** numeric `speakingRate` field.
   - Control synthesis pace (`VoicePace = 'slow' | 'calm' | 'natural' | 'lively'`) via:
     1. Voice creation prompt (`PromptedVoice.input`).
     2. Surgical literal tempo-phrase neutralization on `turn.style` (replacing only explicit rate commands like `"at high speed"` -> `"with high animated energy"`, `"cartoonish speed"` -> `"animated cartoon energy"`, `"fast-paced"` -> `"lively, energetic"` so existing saved stories don't race while keeping 100% of emotional acting words intact).
     3. Appending a structured clarity & pace anchor to `speechMetadata.style` (enforcing clear, intelligible word articulation for young listeners).
2. **Solo Mode (Default):**
   - Single narrator voice reads all turns (`speechMetadata.speaker = "Narrator"`).
   - Character traits + acting style + pace anchor are combined cleanly into `speechMetadata.style`.
3. **Cast Mode & Exact-2 Speaker API Rule:**
   - Contiguous turns sharing `<= 2` distinct speakers are grouped into sub-batches.
   - **Exact-2 Speaker API Rule:** `multiSpeakerVoiceConfig.speakerVoiceConfigs` MUST contain **exact 2** speakers (`length === 2`). If a sub-batch has **1** distinct speaker, call `generateContent` using single-speaker `speechConfig.voiceConfig` (passing 1 speaker inside `multiSpeakerVoiceConfig` fails with `HTTP 400 INVALID_ARGUMENT`).
4. **Tighter Chunking & Audio Concatenation (Anti-Autoregressive Drift):**
   - Batches must be **`<= 6` turns and `<= 1,500` chars** (reduced from 12 turns / 3,000 chars to eliminate autoregressive tempo acceleration across long multi-turn calls).
   - Strip RIFF headers from every chunk using `extractPcmFromWavOrRaw()` to get pure 24kHz 16-bit mono PCM.
   - Insert `createSilencePcm(150)` (150ms of zeros) between sub-batches.
   - Prepend a single canonical 44-byte RIFF header using `wrapPcmAsWav()` at the very end.
