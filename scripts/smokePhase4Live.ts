import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { GeminiTtsService } from '../server/services/geminiTts.js';
import type { VoiceEntry } from '../shared/types.js';

async function runLiveTtsSmoke() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.log(
      '[smoke:live:tts] GEMINI_API_KEY not set. Skipping live Gemini 3.8 Flash-Lite TTS smoke test.'
    );
    process.exit(0);
  }

  console.log(
    '[smoke:live:tts] GEMINI_API_KEY detected. Starting conditional live smoke test with gemini-3.8-flash-lite-tts...'
  );

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-live-tts-'));
  try {
    const config = loadConfig({
      DATA_DIR: tmpDir,
      GEMINI_API_KEY: apiKey,
      GEMINI_TTS_LITE_MODEL: process.env.GEMINI_TTS_LITE_MODEL || 'gemini-3.8-flash-lite-tts',
    });
    const storage = new LocalStorageAdapter(tmpDir);

    const starterVoices: VoiceEntry[] = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt',
        gemini_voice_name: 'Kore',
        description: 'Warm soothing female bedtime voice',
        language_code: 'en-US',
        tags: ['warm'],
        created_at: new Date().toISOString(),
      },
    ];
    await storage.saveVoices(starterVoices);

    const ttsService = new GeminiTtsService(config, storage);

    let wav: Buffer | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[smoke:live:tts] Calling Gemini 3.8 Flash-Lite TTS (previewVoice, attempt ${attempt}/3)...`);
        const previewResult = await ttsService.previewVoice({
          voiceId: 'prebuilt-kore',
          sampleText: 'The sleepy moon smiled down on the quiet valley, whispering a gentle goodnight.',
        });
        wav = previewResult.wav;
        break;
      } catch (err) {
        lastErr = err;
        console.log(`[smoke:live:tts] Attempt ${attempt} encountered error: ${err instanceof Error ? err.message : err}`);
        if (attempt < 3) {
          console.log('[smoke:live:tts] Retrying after 2s pause...');
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (!wav) {
      throw lastErr || new Error('previewVoice failed after 3 attempts');
    }

    if (wav.subarray(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('Returned buffer does not start with RIFF header');
    }
    if (wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
      throw new Error('Returned buffer does not have WAVE format tag');
    }

    const sampleRate = wav.readUInt32LE(24);
    if (sampleRate !== 24000) {
      throw new Error(`Expected sample rate 24000 Hz, got ${sampleRate}`);
    }

    if (wav.length <= 10000) {
      throw new Error(`Expected > 10,000 bytes for 5s audition, got ${wav.length} bytes`);
    }

    if (wav.indexOf('RIFF', 4) !== -1) {
      throw new Error('Detected mid-stream embedded RIFF header in synthesized audio');
    }

    console.log(
      `[smoke:live:tts] Live audition succeeded! Synthesized valid RIFF WAV (${wav.length} bytes, ${sampleRate} Hz)`
    );
    console.log('[smoke:live:tts] ALL LIVE GEMINI 3.8 FLASH-LITE TTS CHECKS PASSED!');
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    console.log('[smoke:live:tts] Temporary smoke directory cleaned up.');
  }
}

runLiveTtsSmoke().catch((err) => {
  console.error('[smoke:live:tts] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && (err as any).cause) {
    console.error('[smoke:live:tts] CAUSE:', (err as any).cause);
  }
  process.exit(1);
});
