import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../server/config.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import { GeminiStoryService } from '../server/services/geminiStory.js';
import type { Story } from '../shared/types.js';

async function runLiveSmoke() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.log('[smoke:live] GEMINI_API_KEY not set. Skipping live Gemini 4 Hydrogen smoke test.');
    process.exit(0);
  }

  console.log('[smoke:live] GEMINI_API_KEY detected. Starting conditional live smoke test with gemini-4-hydrogen (thinkingLevel=LOW)...');

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-live-smoke-'));
  try {
    const config = loadConfig({
      DATA_DIR: tmpDir,
      GEMINI_API_KEY: apiKey,
      GEMINI_TEXT_MODEL: process.env.GEMINI_TEXT_MODEL || 'gemini-4-hydrogen',
      GEMINI_THINKING_LEVEL: process.env.GEMINI_THINKING_LEVEL || 'LOW',
    });
    const storage = new LocalStorageAdapter(tmpDir);
    const storyService = new GeminiStoryService(config, storage);

    let draft: Story | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[smoke:live] Calling Gemini 4 Hydrogen (generateStoryDraft, attempt ${attempt}/3)...`);
        draft = await storyService.generateStoryDraft({
          mode: 'fresh',
          prompt: 'A tiny gentle hedgehog named Bibi settles into a mossy den for sleep as stars appear.',
        });
        break;
      } catch (err) {
        console.log(`[smoke:live] Draft attempt ${attempt} error: ${err instanceof Error ? err.message : err}`);
        if (attempt < 3) {
          console.log('[smoke:live] Retrying after 2s pause...');
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }

    if (!draft) {
      throw new Error('generateStoryDraft failed to return a draft story');
    }
    if (draft.status !== 'draft') {
      throw new Error(`Expected draft status "draft", got "${draft.status}"`);
    }
    if (!draft.script_turns || draft.script_turns.length < 2) {
      throw new Error(`Expected >= 2 script turns, got ${draft.script_turns?.length}`);
    }
    console.log(`[smoke:live] Draft generated successfully! Title: "${draft.title}", turns: ${draft.script_turns.length}`);

    let directed: Story | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[smoke:live] Calling Gemini 4 Hydrogen (directStoryScript, attempt ${attempt}/3)...`);
        directed = await storyService.directStoryScript(draft.id);
        break;
      } catch (err) {
        console.log(`[smoke:live] Direct attempt ${attempt} error: ${err instanceof Error ? err.message : err}`);
        if (attempt < 3) {
          console.log('[smoke:live] Retrying after 2s pause...');
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }

    if (!directed) {
      throw new Error('directStoryScript failed to return a directed story');
    }

    if (!directed.voice_candidates || directed.voice_candidates.length < 1) {
      throw new Error('Expected at least 1 voice candidate from director');
    }
    const missingStyles = directed.script_turns.filter((t) => !t.style || !t.style.trim());
    if (missingStyles.length > 0) {
      throw new Error(`Turns missing style acting notes: ${missingStyles.length}`);
    }

    console.log(
      `[smoke:live] Directing complete! Voice candidates: ${directed.voice_candidates
        .map((v) => v.label)
        .join(', ')}`
    );
    console.log('[smoke:live] Sample turn 1 directed text:', directed.script_turns[0].text);
    console.log('[smoke:live] Sample turn 1 style note:', directed.script_turns[0].style);
    console.log('[smoke:live] ALL LIVE GEMINI 4 HYDROGEN CHECKS PASSED!');
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    console.log('[smoke:live] Temporary smoke directory cleaned up.');
  }
}

runLiveSmoke().catch((err) => {
  console.error('[smoke:live] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && (err as any).cause) {
    console.error('[smoke:live] CAUSE:', (err as any).cause);
  }
  process.exit(1);
});
