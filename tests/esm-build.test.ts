import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('Native Node ESM Build Verification', () => {
  it('compiles with tsconfig.server.json and dynamically imports server modules in plain node', () => {
    // 1. Compile server with tsconfig.server.json (module: NodeNext)
    expect(() => {
      execSync('npx tsc -p tsconfig.server.json', { stdio: 'pipe' });
    }).not.toThrow();

    // 2. Import compiled modules in a native Node sub-process (NOT inside Vite/bundler environment)
    const nodeCmd = `node -e "await import('./dist/server/lib/validators.js'); await import('./dist/server/lib/wav.js'); await import('./dist/server/services/geminiStory.js'); await import('./dist/server/services/geminiTts.js'); await import('./dist/server/routes/adminStories.js'); await import('./dist/server/routes/adminVoices.js'); await import('./dist/server/routes/adminTranscribe.js'); await import('./dist/server/app.js'); await import('./dist/shared/voiceSamples.js'); console.log('ESM_VERIFIED')"`;
    const result = execSync(nodeCmd, { encoding: 'utf-8' });
    expect(result.trim()).toBe('ESM_VERIFIED');
  }, 30000);
});
