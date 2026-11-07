import { test, expect, Page } from '@playwright/test';
import { wrapPcmAsWav, SAMPLE_RATE } from '../../server/lib/wav.js';

async function setupExternalMocks(page: Page) {
  await page.route('https://accounts.google.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } };',
    });
  });

  await page.route('https://fonts.googleapis.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '/* mock google fonts css */',
    });
  });

  await page.route('https://fonts.gstatic.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'font/woff2',
      body: Buffer.alloc(0),
    });
  });
}

// Pre-create a lightweight 1-second sine wave WAV buffer for mock preview route
function createMockPreviewWav(): Buffer {
  const numSamples = SAMPLE_RATE * 1;
  const pcm = Buffer.alloc(numSamples * 2);
  const freq = 440;
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.2;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    pcm.writeInt16LE(int16, i * 2);
  }
  return wrapPcmAsWav(pcm).wav;
}

const mockPreviewWavBuffer = createMockPreviewWav();

test.describe('Phase 5 Public Library & Kinetic Construct Visual Audit', () => {
  test('verifies desktop/mobile viewports, light/dark themes, typography tokens, filtering, and captures library screenshots', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Desktop Viewport (1440x900) — Light Theme (Warm Alabaster)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Check color scheme & tokens
    const rootColorScheme = await page.evaluate(
      () => window.getComputedStyle(document.documentElement).colorScheme
    );
    expect(rootColorScheme).toBe('light');

    // Verify Fraunces editorial serif heading
    const mastheadTitle = page.locator('.masthead-title');
    await expect(mastheadTitle).toBeVisible();
    const headingFont = await mastheadTitle.evaluate((el) => window.getComputedStyle(el).fontFamily);
    expect(headingFont).toContain('Fraunces');

    // Verify Bitter body serif in story summaries
    const storySummary = page.locator('.story-card-summary').first();
    await expect(storySummary).toBeVisible();
    const bodyFont = await storySummary.evaluate((el) => window.getComputedStyle(el).fontFamily);
    expect(bodyFont).toContain('Bitter');

    // Verify Fira Code metadata badges
    const monoBadge = page.locator('.badge-mono').first();
    await expect(monoBadge).toBeVisible();
    const badgeFont = await monoBadge.evaluate((el) => window.getComputedStyle(el).fontFamily);
    expect(badgeFont).toContain('Fira Code');

    // Verify Tactile 2px borders and shadows on cards
    const card = page.locator('.story-card').first();
    const cardStyles = await card.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return {
        borderWidth: s.borderWidth,
        borderStyle: s.borderStyle,
        boxShadow: s.boxShadow,
      };
    });
    expect(cardStyles.borderWidth).toBe('2px');
    expect(cardStyles.borderStyle).toBe('solid');
    expect(cardStyles.boxShadow).toContain('2px 2px 0px');

    // Verify stories are rendered
    await expect(page.locator('.story-card', { hasText: 'The Sleepy Little Train' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Star Mountain Express' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Whispering Owl' })).toBeVisible();

    // Verify series badge on episodic stories
    const seriesBadge = page.locator('.series-badge', { hasText: 'little-tram-adventures' }).first();
    await expect(seriesBadge).toBeVisible();

    // Test instant search input
    const searchInput = page.getByLabel('Search stories');
    await searchInput.fill('Whispering Owl');
    await expect(page.locator('.story-card', { hasText: 'The Whispering Owl' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Sleepy Little Train' })).not.toBeVisible();
    await searchInput.fill('');
    await expect(page.locator('.story-card', { hasText: 'The Sleepy Little Train' })).toBeVisible();

    // Test tag filtering
    const trainTagPill = page.locator('.tag-pill', { hasText: '#train' });
    await trainTagPill.click();
    await expect(page.locator('.story-card', { hasText: 'The Sleepy Little Train' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Star Mountain Express' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Whispering Owl' })).not.toBeVisible();

    // Reset tag filter
    const allTagPill = page.locator('.tag-pill', { hasText: 'All' });
    await allTagPill.click();
    await expect(page.locator('.story-card', { hasText: 'The Whispering Owl' })).toBeVisible();

    // Test series filter dropdown
    const seriesSelect = page.getByLabel('Filter by series');
    await seriesSelect.selectOption('little-tram-adventures');
    await expect(page.locator('.story-card', { hasText: 'The Sleepy Little Train' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Star Mountain Express' })).toBeVisible();
    await expect(page.locator('.story-card', { hasText: 'The Whispering Owl' })).not.toBeVisible();

    // Reset series filter
    await seriesSelect.selectOption('all');
    await expect(page.locator('.story-card', { hasText: 'The Whispering Owl' })).toBeVisible();

    // Zero horizontal overflow on Desktop
    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(desktopOverflow).toBe(true);

    // Capture Screenshot 1: phase5-library-desktop-light.png
    await page.screenshot({ path: 'qa-screenshots/phase5-library-desktop-light.png', fullPage: false });

    // 2. Toggle to Dark Theme
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    const darkRootScheme = await page.evaluate(
      () => window.getComputedStyle(document.documentElement).colorScheme
    );
    expect(darkRootScheme).toBe('dark');

    // Move mouse away to capture resting state
    await page.mouse.move(0, 0);

    // Capture Screenshot 2: phase5-library-desktop-dark.png
    await page.screenshot({ path: 'qa-screenshots/phase5-library-desktop-dark.png', fullPage: false });

    // 3. Mobile Viewport (375x812) — Dark Theme
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(200);

    const mobileDarkOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileDarkOverflow).toBe(true);

    // Capture Screenshot 3: phase5-library-mobile-dark.png
    await page.screenshot({ path: 'qa-screenshots/phase5-library-mobile-dark.png', fullPage: false });

    // 4. Mobile Viewport (375x812) — Light Theme
    await themeBtn.click();
    await expect(page.locator('body')).not.toHaveAttribute('data-theme', 'dark');
    await page.waitForTimeout(200);

    const mobileLightOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileLightOverflow).toBe(true);

    // Capture Screenshot 4: phase5-library-mobile-light.png
    await page.screenshot({ path: 'qa-screenshots/phase5-library-mobile-light.png', fullPage: false });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe('Phase 5 Formatted Reader & Docked Audio Player with HTTP 206 Range Scrubbing', () => {
  test('verifies reader drop-cap, dialogue badges, vocal tag stripping, docked player track info, speed toggle, 206 scrubbing, and captures screenshots', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];
    let received206Range = false;

    await setupExternalMocks(page);

    // Monitor for HTTP 206 Partial Content Range streaming
    page.on('response', (response) => {
      if (response.url().includes('.wav') && response.status() === 206) {
        received206Range = true;
      }
    });

    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Desktop Viewport (1440x900) Light Theme
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Ensure light theme
    const isDark = await page.evaluate(() => document.body.getAttribute('data-theme') === 'dark');
    if (isDark) {
      await page.getByRole('button', { name: /Light Mode|Dark Mode/i }).click();
    }

    // Open "The Sleepy Little Train"
    const trainCard = page.locator('.story-card', { hasText: 'The Sleepy Little Train' });
    await trainCard.getByRole('button', { name: /Read & Listen/i }).click();

    // Verify Reader URL
    await expect(page).toHaveURL(/\/stories\/2026-11-04-sleepy-little-train/);

    // Verify Title in Fraunces & Series Context badge
    const readerTitle = page.locator('.reader-title');
    await expect(readerTitle).toHaveText('The Sleepy Little Train');
    const seriesContext = page.locator('.reader-title-area .series-badge');
    await expect(seriesContext).toHaveText('little-tram-adventures · Episode 1');

    // Verify Ornamental Drop-Cap on opening narration (.first-letter-dropcap)
    const dropCapPara = page.locator('.first-letter-dropcap');
    await expect(dropCapPara).toBeVisible();
    await expect(dropCapPara).toHaveClass(/opening-narration/);

    // Verify Character Dialogue block and speaker badge for Bibi
    const dialogueTurn = page.locator('.dialogue-turn');
    await expect(dialogueTurn).toBeVisible();
    const bibiBadge = dialogueTurn.locator('.speaker-badge');
    await expect(bibiBadge).toHaveText('Bibi');

    // Verify Vocal Tag Stripping: <short pause>, <sigh> are stripped, but prose (which was painted bright blue) is preserved
    const proseBlue = page.getByText('(which was painted bright blue)');
    await expect(proseBlue).toBeVisible();
    await expect(page.locator('text="<short pause>"')).toHaveCount(0);
    await expect(page.locator('text="<sigh>"')).toHaveCount(0);
    await expect(page.locator('text="<whisper>"')).toHaveCount(0);

    // Verify Docked Audio Player Bar & Track Info
    const dockedBar = page.locator('.docked-audio-bar');
    await expect(dockedBar).toBeVisible();

    const trackTitle = dockedBar.locator('.player-track-title');
    await expect(trackTitle).toHaveText('The Sleepy Little Train');

    const trackVersion = dockedBar.locator('.player-track-version');
    await expect(trackVersion).toHaveText('Grandpa Owl (Bedtime Solo)');

    // Verify <audio> loads duration cleanly (no NaN)
    const duration = await page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio) return 0;
      if (audio.readyState >= 1 && audio.duration > 0) return audio.duration;
      return new Promise<number>((resolve) => {
        audio.addEventListener('loadedmetadata', () => resolve(audio.duration), { once: true });
        setTimeout(() => resolve(audio.duration || 0), 4000);
      });
    });
    expect(duration).toBeGreaterThan(0);
    expect(Number.isFinite(duration)).toBe(true);

    const timecode = page.locator('.player-timecode');
    await expect(timecode).not.toContainText('NaN');

    // Verify Play / Pause button in docked audio player
    const playBtn = page.locator('.docked-audio-bar .btn-tactile-primary', { hasText: /Play|Pause/i });
    await expect(playBtn).toBeVisible();
    await playBtn.click();

    // Test Fine-Grained Playback Rate cycling (1.0x -> 1.1x -> 1.25x -> 0.8x -> 0.9x -> 1.0x) and verify currentTime preservation
    await page.evaluate(() => {
      const audio = document.querySelector('audio');
      if (audio) audio.currentTime = 0.8;
    });

    const speedBtn = page.getByRole('button', { name: /playback speed/i });
    await expect(speedBtn).toHaveText('1.0x');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.1x');

    // Confirm playback position was preserved
    const timeAfterSpeedChange = await page.evaluate(() => {
      const audio = document.querySelector('audio');
      return audio ? audio.currentTime : 0;
    });
    expect(Math.abs(timeAfterSpeedChange - 0.8)).toBeLessThan(0.15);

    // Cycle through remaining speeds back to 1.0x
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.25x');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('0.8x');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('0.9x');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.0x');

    // Test HTTP 206 Range timeline scrubbing forward & backward
    const scrubForwardOk = await page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio) return false;
      audio.currentTime = 1.2;
      return new Promise<boolean>((resolve) => {
        audio.addEventListener('seeked', () => resolve(Math.abs(audio.currentTime - 1.2) < 0.2), {
          once: true,
        });
        setTimeout(() => resolve(Math.abs(audio.currentTime - 1.2) < 0.2), 3000);
      });
    });
    expect(scrubForwardOk).toBe(true);

    const scrubBackwardOk = await page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio) return false;
      audio.currentTime = 0.4;
      return new Promise<boolean>((resolve) => {
        audio.addEventListener('seeked', () => resolve(Math.abs(audio.currentTime - 0.4) < 0.2), {
          once: true,
        });
        setTimeout(() => resolve(Math.abs(audio.currentTime - 0.4) < 0.2), 3000);
      });
    });
    expect(scrubBackwardOk).toBe(true);

    // Verify 206 Partial Content was received during Range stream requests
    expect(received206Range).toBe(true);

    // Test Audio Version Selector Dropdown
    const versionSelect = page.getByLabel('Audio Version');
    await expect(versionSelect).toHaveValue('v1-owl-solo');

    // Switch to version 2 (Aoede)
    await versionSelect.selectOption('v2-aoede-solo');

    // Audio src and track version updated
    const newSrc = await page.evaluate(() => document.querySelector('audio')?.getAttribute('src'));
    expect(newSrc).toContain('v2-aoede-solo.wav');
    await expect(trackVersion).toHaveText('Aoede (Melodic Solo)');

    // Reset back to default v1
    await versionSelect.selectOption('v1-owl-solo');

    // Capture Screenshot 5: phase5-reader-desktop-light.png
    await page.screenshot({ path: 'qa-screenshots/phase5-reader-desktop-light.png', fullPage: false });

    // 2. Toggle to Dark Theme on Reader
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Move mouse away
    await page.mouse.move(0, 0);

    // Capture Screenshot 6: phase5-reader-desktop-dark.png
    await page.screenshot({ path: 'qa-screenshots/phase5-reader-desktop-dark.png', fullPage: false });

    // 3. Mobile Viewport (375x812) Dark Reader
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(200);

    // Check zero horizontal overflow
    const readerMobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(readerMobileOverflow).toBe(true);

    // Check that docked audio bar does not obscure prose (clearance)
    const readerWrapper = page.locator('.reader-wrapper');
    const paddingBottom = await readerWrapper.evaluate((el) => window.getComputedStyle(el).paddingBottom);
    expect(parseInt(paddingBottom, 10)).toBeGreaterThanOrEqual(80);

    // Capture Screenshot 7: phase5-reader-mobile-dark.png
    await page.screenshot({ path: 'qa-screenshots/phase5-reader-mobile-dark.png', fullPage: false });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe('Phase 5 Admin Director & Voice Studio Audit', () => {
  test('verifies dev bypass login, turn editing, tag insertion, character add/delete, voice preview, casting toggle, version controls, and captures admin screenshots', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

    // Mock 5s voice preview route to ensure deterministic, quota-independent test execution
    await page.route('**/api/admin/voices/preview', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'audio/wav',
        body: mockPreviewWavBuffer,
      });
    });

    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Initial Desktop Viewport
    await page.setViewportSize({ width: 1440, height: 900 });

    // Navigate to /admin
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h2', { hasText: 'Director Studio' })).toBeVisible();

    // 2. Dev Sandbox Login
    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(devLoginBtn).toBeVisible();
    await devLoginBtn.click();

    // 3. Director Studio loads with story list
    const sidebar = page.locator('.studio-sidebar');
    await expect(sidebar).toBeVisible();

    const sleepyTrainItem = page.locator('.studio-story-item', { hasText: 'The Sleepy Little Train' });
    await expect(sleepyTrainItem).toBeVisible();
    await sleepyTrainItem.click();

    const workbench = page.locator('.studio-workbench');
    await expect(workbench).toBeVisible();

    // Switch to Script Editor tab to inspect turns
    await page.getByRole('tab', { name: /Script Editor/i }).click();

    // 4. Test Turn Editing & Quick Vocal Tag Pills
    const firstTurn = workbench.locator('.turn-card').first();
    const turnTextarea = firstTurn.locator('textarea');
    await expect(turnTextarea).toBeVisible();

    const originalTurnText = await turnTextarea.inputValue();

    // Insert quick vocal tag pill <short pause>
    const shortPausePill = firstTurn.getByRole('button', { name: '<short pause>' });
    await expect(shortPausePill).toBeVisible();
    await shortPausePill.click();

    const editedTextWithTag = await turnTextarea.inputValue();
    expect(editedTextWithTag).toContain('<short pause>');

    // 5. Test Character Addition & Deletion
    const addCharBtn = workbench.getByRole('button', { name: /➕ Add Character/i });
    await expect(addCharBtn).toBeVisible();
    await addCharBtn.click();

    const charInputs = workbench.locator('input[placeholder="Character Name"]');
    const newCharInput = charInputs.last();
    await newCharInput.fill('Conductor Owl');

    const traitInputs = workbench.locator('input[placeholder*="Vocal traits"]');
    const newTraitInput = traitInputs.last();
    await newTraitInput.fill('Warm, booming bedtime whistle');

    // Delete newly added character to clean up
    const deleteCharBtn = workbench.locator('button[title="Remove character"]').last();
    await deleteCharBtn.click();
    await expect(page.locator('input[value="Conductor Owl"]')).toHaveCount(0);

    // 6. Test Turn Addition & Deletion
    const turnCountBefore = await workbench.locator('.turn-card').count();
    const addTurnBelowBtn = firstTurn.getByRole('button', { name: '+ Turn Below' });
    await addTurnBelowBtn.click();

    const turnCountAfterAdd = await workbench.locator('.turn-card').count();
    expect(turnCountAfterAdd).toBe(turnCountBefore + 1);

    // Delete the added turn (turn #2)
    const addedTurnDeleteBtn = workbench.locator('.turn-card').nth(1).getByRole('button', { name: 'Delete' });
    await addedTurnDeleteBtn.click();

    const turnCountAfterDelete = await workbench.locator('.turn-card').count();
    expect(turnCountAfterDelete).toBe(turnCountBefore);

    // 7. Save Script & Persist Verification
    const saveScriptBtn = page.getByRole('button', { name: /Save Script/i });
    await saveScriptBtn.click();
    await expect(page.getByText('✓ Saved successfully')).toBeVisible();

    // Restore original turn text and save cleanly (idempotent)
    await turnTextarea.fill(originalTurnText);
    await saveScriptBtn.click();
    await expect(page.getByText('✓ Saved successfully')).toBeVisible();

    // Capture Screenshot 8: phase5-admin-director.png
    await page.screenshot({ path: 'qa-screenshots/phase5-admin-director.png', fullPage: false });

    // 8. Voice Studio Panel Verification
    const voicePanel = page.locator('.voice-studio-panel');
    await expect(voicePanel).toBeVisible();
    await voicePanel.scrollIntoViewIfNeeded();

    // Verify prebuilt voices listed in narrator selector
    const narratorSelect = voicePanel.locator('select').first();
    const optionsText = await narratorSelect.allTextContents();
    expect(optionsText[0]).toContain('Kore');
    expect(optionsText[0]).toContain('Puck');
    expect(optionsText[0]).toContain('Aoede');

    // Test 5s Voice Audition Preview Player
    const previewBtn = voicePanel.locator('.btn-tactile', { hasText: '🔊 Preview' }).first();
    await expect(previewBtn).toBeVisible();
    await previewBtn.click();

    // While auditioning, button toggles to "⏹ Stop"
    await expect(voicePanel.locator('.btn-tactile', { hasText: '⏹ Stop' })).toBeVisible();
    await voicePanel.locator('.btn-tactile', { hasText: '⏹ Stop' }).click();
    await expect(voicePanel.locator('.btn-tactile', { hasText: '🔊 Preview' }).first()).toBeVisible();
    await expect(page.locator('text="Audition error"')).toHaveCount(0);

    // Test Solo vs Multi-Speaker Cast toggle
    const soloBtn = voicePanel.getByRole('button', { name: /Solo Storyteller/i });
    const castBtn = voicePanel.getByRole('button', { name: /Multi-Speaker Cast/i });

    await castBtn.click();
    await expect(voicePanel.getByText('CHARACTER VOICE ASSIGNMENTS')).toBeVisible();
    await expect(voicePanel.locator('div', { hasText: 'Bibi' }).first()).toBeVisible();

    await soloBtn.click();
    await expect(voicePanel.getByText('CHARACTER VOICE ASSIGNMENTS')).toHaveCount(0);

    // Test "Set Default" Version operation
    const aoedeVersionCard = voicePanel.locator('.card-tactile', { hasText: 'Aoede (Melodic Solo)' });
    await expect(aoedeVersionCard).toBeVisible();

    const setDefaultBtn = aoedeVersionCard.getByRole('button', { name: /★ Set Default/i });
    await setDefaultBtn.click();

    // Aoede card now shows "★ DEFAULT"
    await expect(aoedeVersionCard.getByText('★ DEFAULT')).toBeVisible();

    // Restore v1-owl-solo as default
    const owlVersionCard = voicePanel.locator('.card-tactile', { hasText: 'Grandpa Owl (Bedtime Solo)' });
    await owlVersionCard.getByRole('button', { name: /★ Set Default/i }).click();
    await expect(owlVersionCard.getByText('★ DEFAULT')).toBeVisible();

    // Capture Screenshot 9: phase5-admin-voice-studio.png
    await page.screenshot({ path: 'qa-screenshots/phase5-admin-voice-studio.png', fullPage: false });

    // 9. Verify Reader Inline Version Controls for Admins
    await page.goto('/stories/2026-11-04-sleepy-little-train', { waitUntil: 'domcontentloaded' });
    const readerAdminPanel = page.locator('.reader-admin-panel');
    await expect(readerAdminPanel).toBeVisible();
    await expect(readerAdminPanel.getByText('ADMIN AUDIO VERSIONS')).toBeVisible();

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
