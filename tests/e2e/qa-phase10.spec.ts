import { test, expect, Page } from '@playwright/test';

async function setupPhase10Mocks(page: Page) {
  // Google login & fonts mocking
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

  // Multimodal Transcribe STT mock
  await page.route('**/api/admin/transcribe', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'A curious hedgehog with shiny boots' }),
    });
  });

  // Browser MediaDevices & MediaRecorder mock injection
  await page.addInitScript(() => {
    class MockMediaStreamTrack {
      kind = 'audio';
      enabled = true;
      readyState = 'live';
      stop() {
        this.readyState = 'ended';
      }
    }
    class MockMediaStream {
      tracks = [new MockMediaStreamTrack()];
      getTracks() {
        return this.tracks;
      }
      getAudioTracks() {
        return this.tracks;
      }
    }
    class MockMediaRecorder {
      static isTypeSupported(type: string) {
        return type === 'audio/webm;codecs=opus' || type === 'audio/webm' || type === 'audio/mp4';
      }
      state = 'inactive';
      stream: any;
      mimeType = 'audio/webm';
      ondataavailable: any = null;
      onstop: any = null;
      constructor(stream: any, options: any) {
        this.stream = stream;
        if (options?.mimeType) this.mimeType = options.mimeType;
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        if (this.ondataavailable) {
          this.ondataavailable({
            data: new Blob(['mock-audio-pcm-bytes'], { type: this.mimeType }),
          });
        }
        if (this.onstop) this.onstop();
      }
    }

    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => new MockMediaStream() as any;
    } else {
      (navigator as any).mediaDevices = {
        getUserMedia: async () => new MockMediaStream() as any,
      };
    }
    (window as any).MediaRecorder = MockMediaRecorder;
  });
}

test.describe('Phase 10: Mobile Focus Composer, Voice Dictation & Fine-Grained Player Speeds', () => {
  test('verifies Focus Composer modal, vocal tag insertion, player speed cycling and mobile zero-overflow in light/dark themes', async ({
    page,
  }) => {
    await setupPhase10Mocks(page);

    // =========================================================================
    // 1. Desktop Light Theme: Reader AudioPlayerBar Speed Cycling
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Open "The Sleepy Little Train" into StoryReader
    const trainCard = page.locator('.story-card', { hasText: 'The Sleepy Little Train' });
    await expect(trainCard).toBeVisible();
    await trainCard.getByRole('button', { name: /Read & Listen/i }).click();
    await expect(page).toHaveURL(/\/stories\/2026-11-04-sleepy-little-train/);

    // Verify Reader and Docked Audio Player Bar loaded
    const audioBar = page.locator('.docked-audio-bar');
    await expect(audioBar).toBeVisible();

    // Test playback speed cycling: 1.0x -> 1.1x -> 1.25x -> 0.8x -> 0.9x -> 1.0x
    const speedBtn = page.getByRole('button', { name: /playback speed/i });
    await expect(speedBtn).toHaveText('1.0x');

    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.1x');

    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.25x');

    // Capture Screenshot 1: phase10-player-speeds-desktop.png
    await page.screenshot({
      path: 'qa-screenshots/phase10-player-speeds-desktop.png',
      fullPage: false,
    });

    await speedBtn.click();
    await expect(speedBtn).toHaveText('0.8x');

    await speedBtn.click();
    await expect(speedBtn).toHaveText('0.9x');

    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.0x');

    // =========================================================================
    // 2. Mobile Viewport (375x812) Player Bar Ergonomics & Clearance
    // =========================================================================
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(100);

    // Check zero horizontal overflow at 375px
    const mobileReaderOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileReaderOverflow).toBe(true);

    // Verify mobile player height <= 68px
    const playerHeight = await audioBar.evaluate((el) => el.getBoundingClientRect().height);
    expect(playerHeight).toBeLessThanOrEqual(68);

    // Cycle speed once on mobile
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.1x');

    // Capture Screenshot 2: phase10-player-speeds-mobile.png
    await page.screenshot({
      path: 'qa-screenshots/phase10-player-speeds-mobile.png',
      fullPage: false,
    });

    // =========================================================================
    // 3. Admin Studio: Story Prompt Focus Composer (Desktop Light Theme)
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Navigate to /admin and login with dev bypass
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    try {
      await devLoginBtn.waitFor({ state: 'visible', timeout: 5000 });
      await devLoginBtn.click();
    } catch {
      // Already authenticated
    }

    await expect(page.locator('.studio-sidebar')).toBeVisible();

    // Click "➕ New Story" to reveal Step 1 form
    const newStoryBtn = page.getByRole('button', { name: /➕ New Story/i });
    await newStoryBtn.click();

    // Verify Expand trigger exists beside Story Prompt
    const expandPromptBtn = page.getByRole('button', {
      name: /expand story prompt in focus editor/i,
    });
    await expect(expandPromptBtn).toBeVisible();

    // Open Focus Composer modal
    await expandPromptBtn.click();

    const composerModal = page.getByRole('dialog', { name: 'Story Prompt' });
    await expect(composerModal).toBeVisible();

    // Check live word and char counter
    const counterBadge = composerModal.locator('.focus-composer-counter');
    await expect(counterBadge).toBeVisible();

    // Fill in rich story prompt inside expanded composer
    const composerTextarea = composerModal.locator('.focus-composer-textarea');
    await composerTextarea.fill(
      'A whimsical tale about Barnaby the Bear who discovers a pocket-sized orchestra tuning their instruments inside an ancient hollow oak tree.'
    );

    // Test embedded Mic Dictation Button inside Focus Composer modal
    const modalDictateBtn = composerModal.getByRole('button', { name: /voice dictation/i });
    await expect(modalDictateBtn).toBeVisible();
    await modalDictateBtn.click();

    // Wait for recording indicator
    const modalStopBtn = composerModal.getByRole('button', { name: /stop recording/i });
    await expect(modalStopBtn).toBeVisible();
    await modalStopBtn.click();

    // Mock transcript appended with smart space
    await expect(composerTextarea).toHaveValue(/A curious hedgehog with shiny boots/);

    // Capture Screenshot 3: phase10-composer-desktop-light.png
    await page.screenshot({
      path: 'qa-screenshots/phase10-composer-desktop-light.png',
      fullPage: false,
    });

    // Close composer via [✓ Done]
    const doneBtn = composerModal.getByRole('button', {
      name: /save and close focus composer/i,
    });
    await doneBtn.click();
    await expect(composerModal).not.toBeVisible();

    // =========================================================================
    // 4. Admin Studio: Script Dialogue Focus Composer with Vocal Tags (Desktop Dark Theme)
    // =========================================================================
    // Select an existing story from sidebar
    const storyItem = page.locator('.studio-story-item').first();
    await storyItem.click();

    const workbench = page.locator('.studio-workbench');
    await expect(workbench).toBeVisible();

    // Switch to Dark Mode
    const darkThemeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    await darkThemeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Locate first script turn card
    const firstTurn = workbench.locator('.turn-card').first();
    await expect(firstTurn).toBeVisible();

    // Open Focus Composer on Turn Dialogue
    const expandDialogueBtn = firstTurn.getByRole('button', {
      name: /expand turn #1 dialogue/i,
    });
    await expect(expandDialogueBtn).toBeVisible();
    await expandDialogueBtn.click();

    const dialogueModal = page.getByRole('dialog', { name: /Turn #1 Dialogue/i });
    await expect(dialogueModal).toBeVisible();

    // Verify quick vocal tag pills in composer
    const vocalTagsBar = dialogueModal.locator('.focus-composer-vocal-tags');
    await expect(vocalTagsBar).toBeVisible();

    const shortPausePill = dialogueModal.getByRole('button', { name: 'Insert <short pause>' });
    const sighPill = dialogueModal.getByRole('button', { name: 'Insert <sigh>' });
    await expect(shortPausePill).toBeVisible();
    await expect(sighPill).toBeVisible();

    // Insert <short pause>
    await shortPausePill.click();

    // Capture Screenshot 4: phase10-composer-desktop-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase10-composer-desktop-dark.png',
      fullPage: false,
    });

    // Close dialogue composer
    const dialogueDoneBtn = dialogueModal.getByRole('button', {
      name: /save and close focus composer/i,
    });
    await dialogueDoneBtn.click();
    await expect(dialogueModal).not.toBeVisible();

    // =========================================================================
    // 5. Mobile Fullscreen Focus Composer (375x812) Light & Dark Themes
    // =========================================================================
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(100);

    // Switch back to Light Theme for Mobile Light Screenshot
    await darkThemeBtn.click();
    await expect(page.locator('body')).not.toHaveAttribute('data-theme', 'dark');

    // Open dialogue Focus Composer on mobile
    await expandDialogueBtn.click();
    await expect(dialogueModal).toBeVisible();

    // Check zero horizontal overflow on mobile modal
    const mobileComposerOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileComposerOverflow).toBe(true);

    // Verify mobile modal is fullscreen (height matches viewport)
    const modalSheet = dialogueModal.locator('.focus-composer-sheet');
    const sheetBox = await modalSheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.height).toBeGreaterThanOrEqual(800);

    // Capture Screenshot 5: phase10-composer-mobile-light.png
    await page.screenshot({
      path: 'qa-screenshots/phase10-composer-mobile-light.png',
      fullPage: false,
    });

    // Switch to Dark Theme while modal is open
    await page.evaluate(() => document.body.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(100);

    // Insert <breath> tag on mobile
    const breathPill = dialogueModal.getByRole('button', { name: 'Insert <breath>' });
    await breathPill.click();

    // Capture Screenshot 6: phase10-composer-mobile-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase10-composer-mobile-dark.png',
      fullPage: false,
    });

    // Close modal on mobile
    await dialogueDoneBtn.click();
    await expect(dialogueModal).not.toBeVisible();

    // Ensure page horizontal scroll is clean
    const finalMobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(finalMobileOverflow).toBe(true);
  });
});
