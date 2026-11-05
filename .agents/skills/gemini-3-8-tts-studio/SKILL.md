---
name: gemini-3-8-tts-studio
description: Authoritative guide for generating bedtime narratives, directing voice acting, and synthesizing speech with @google/genai and Gemini 3.8 models (gemini-3.8-flash, gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts).
---

# Gemini 3.8 TTS & Story Studio Skill

## Model Selection
- Narrative Writer & Voice Director LLM: `gemini-3.8-flash` (`GEMINI_TEXT_MODEL`).
- 5-Second Audition Preview TTS: `gemini-3.8-flash-lite-tts` (`GEMINI_TTS_LITE_MODEL`).
- Full Studio Story TTS: `gemini-3.8-flash-tts` (`GEMINI_TTS_MODEL`).

## SDK Requirements
- Use exclusively `@google/genai` (`>= 2.24.0`). Never use legacy `@google/generative-ai`.
- Client initialization:
  ```ts
  import { GoogleGenAI, Type } from '@google/genai';
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  ```

## Writer & Director Structured Output
- Writer LLM generates structured JSON containing `title`, `summary`, `tags`, `characters`, `script_turns`.
- Director LLM annotates `script_turns` with sustained `style` notes (e.g., `"Warm, calm bedtime cadence"`, `"Speaking dialogue as Bibi: gentle bell chime"`) and approved point-in-time inline tags.

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

## TTS Synthesis Rules
1. **Solo Mode (Default):**
   - Single narrator voice reads all turns.
   - `speechMetadata.speaker` is normalized to `"Narrator"`.
   - Character vocal traits are prepended into `speechMetadata.style`.
2. **Cast Mode:**
   - Contiguous turns sharing `<= 2` distinct speakers are grouped into sub-batches using `multiSpeakerVoiceConfig`.
   - `gemini-3.8-flash-tts` enforces a hard limit of at most 2 distinct speakers per API call.
3. **Chunking & Audio Concatenation:**
   - Batches must be `<= 12` turns and `<= 3,000` chars.
   - Strip RIFF headers from every chunk using `extractPcmFromWavOrRaw()` to get pure 24kHz 16-bit mono PCM.
   - Insert `createSilencePcm(150)` (150ms of zeros) between sub-batches.
   - Prepend a single canonical 44-byte RIFF header using `wrapPcmAsWav()` at the very end.
