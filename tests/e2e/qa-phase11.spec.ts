import { test, expect, Page } from '@playwright/test';

async function setupPhase11Mocks(page: Page) {
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

  // Mock voice preview to return valid WAV with X-Draft-Voice-Name header
  await page.route('**/api/admin/voices/preview', async (route) => {
    // 44-byte minimal valid RIFF WAV
    const wavHex =
      '524946462c00000057415645666d74201000000001000100401f0000401f00000100080064617461080000000000000000000000';
    const wavBuf = Buffer.from(wavHex, 'hex');

    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Draft-Voice-Name': 'voice_e2e_staged_take_42',
        'Access-Control-Expose-Headers': 'X-Draft-Voice-Name',
      },
      body: wavBuf,
    });
  });

  // Multimodal Transcribe STT mock
  await page.route('**/api/admin/transcribe', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'A wise old grandfather owl with warm baritone laughter' }),
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

test.describe('Phase 11: Standalone Voice Library, Staged Voice Designer & Story Narration Workflow', () => {
  test('verifies desktop & mobile voice library navigation, staged designer, narration modal, and visual captures', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await setupPhase11Mocks(page);

    // =========================================================================
    // 1. Desktop Light Theme: Login & Navigation to Voice Library
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Authenticate with dev bypass if login gate is displayed
    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    try {
      await devLoginBtn.waitFor({ state: 'visible', timeout: 5000 });
      await devLoginBtn.click();
    } catch {
      // Already authenticated
    }

    // Verify Admin Navigation Tabs are visible
    const storiesTab = page.getByRole('button', { name: /📖 Stories Workbench/i });
    const voicesTab = page.getByRole('button', { name: /🎙️ Voice Library/i });
    await expect(storiesTab).toBeVisible({ timeout: 8000 });
    await expect(voicesTab).toBeVisible({ timeout: 8000 });

    // Click Voice Library tab
    await voicesTab.click();
    await expect(page).toHaveURL(/\/admin\/voices/);

    // Verify Voice Library components loaded
    await expect(page.getByRole('heading', { name: /Custom Voice Designer/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Saved Voice Catalog/i })).toBeVisible();

    // Switch to Light Mode for Screenshot 1
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    if ((await page.locator('body').getAttribute('data-theme')) === 'dark') {
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
    }

    // Capture Screenshot 1: phase11-voice-library-desktop-light.png
    await page.screenshot({
      path: 'qa-screenshots/phase11-voice-library-desktop-light.png',
      fullPage: false,
    });

    // =========================================================================
    // 2. Desktop Dark Theme: Visual Verification
    // =========================================================================
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Capture Screenshot 2: phase11-voice-library-desktop-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase11-voice-library-desktop-dark.png',
      fullPage: false,
    });

    // Toggle back to light mode
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');

    // =========================================================================
    // 3. Staged Draft Voice State Machine in Action
    // =========================================================================
    // Fill out Voice Designer
    const labelInput = page.getByLabel(/Voice Label \*/i);
    await labelInput.fill('Sir Barnaby Badger');

    const promptTextarea = page.locator('#voice-designer-prompt');
    await promptTextarea.fill('Gentle old badger knight who speaks with humorous chivalric pride and warm grandfatherly laughter.');

    // Select Pace
    const livelyPaceBtn = page.getByRole('button', { name: /⚡ Lively/i });
    await livelyPaceBtn.click();

    // Select Expressive Sample Preset
    const adventurePreset = page.getByRole('button', { name: /Bouncy Adventure/i });
    await adventurePreset.click();

    // Click Preview Voice
    const previewBtn = page.getByRole('button', { name: /🔊 Preview Voice/i });
    await previewBtn.click();

    // Verify Staged Take Badge appears
    const stagedBadge = page.locator('[role="status"]', { hasText: /Voice Take Staged/i });
    await expect(stagedBadge).toBeVisible();

    // Verify "🎲 New Voice Take" button appears
    const newTakeBtn = page.getByRole('button', { name: /🎲 New Voice Take/i });
    await expect(newTakeBtn).toBeVisible();

    // Capture Screenshot 3: phase11-staged-voice-designer.png
    await page.screenshot({
      path: 'qa-screenshots/phase11-staged-voice-designer.png',
      fullPage: false,
    });

    // =========================================================================
    // 4. Saved Voice Card & Copy Prompt
    // =========================================================================
    // Locate Kore card in catalog
    const koreCard = page.locator('.voice-card', { hasText: 'Kore' }).first();
    await expect(koreCard).toBeVisible();

    // Check full prompt text block
    await expect(koreCard.locator('p')).toContainText(/bedtime storytelling cadence|warm/i);

    // Test Copy Prompt button
    const copyBtn = koreCard.getByRole('button', { name: /📋 Copy Prompt/i });
    await copyBtn.click();
    await expect(koreCard.getByText(/✓ Copied!/i)).toBeVisible();

    // =========================================================================
    // 5. Narrate a Story Modal Workflow
    // =========================================================================
    const narrateBtn = koreCard.getByRole('button', { name: /🎬 Narrate a Story/i });
    await narrateBtn.click();

    // Verify Narrate Modal opens
    const modal = page.locator('[role="dialog"]', { hasText: /Narrate a Story with/i });
    await expect(modal).toBeVisible();

    // Verify modal options
    await expect(modal.getByLabel(/Target Story \*/i)).toBeVisible();
    await expect(modal.getByLabel(/Audio Version Label/i)).toBeVisible();
    await expect(modal.getByRole('button', { name: /🐢 Slow/i })).toBeVisible();
    await expect(modal.getByRole('button', { name: /⚡ Generate Solo Audio Now/i })).toBeVisible();
    await expect(modal.getByRole('button', { name: /🎛️ Open in Story Step 3/i })).toBeVisible();

    // Capture Screenshot 4: phase11-narrate-story-modal.png
    await page.screenshot({
      path: 'qa-screenshots/phase11-narrate-story-modal.png',
      fullPage: false,
    });

    // Close modal
    await modal.getByRole('button', { name: '✕' }).click();
    await expect(modal).not.toBeVisible();

    // =========================================================================
    // 6. Mobile Viewport (375x812) Ergonomics & Overflow Check
    // =========================================================================
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(200);

    // Verify zero horizontal overflow at 375px
    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileOverflow).toBe(true);

    // Capture Screenshot 5: phase11-voice-library-mobile-light.png
    await page.screenshot({
      path: 'qa-screenshots/phase11-voice-library-mobile-light.png',
      fullPage: false,
    });

    // Toggle dark mode on mobile
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Verify zero horizontal overflow in dark mode
    const mobileDarkOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileDarkOverflow).toBe(true);

    // Capture Screenshot 6: phase11-voice-library-mobile-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase11-voice-library-mobile-dark.png',
      fullPage: false,
    });
  });
});
