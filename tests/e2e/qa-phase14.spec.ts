import { test, expect } from '@playwright/test';

test.describe('Phase 14: One-Tap Chained Pipeline, Story Length & iPhone Safe-Area Support', () => {
  test('verifies viewport-fit=cover, safe-area bounds, zero horizontal overflow, and captures required screenshots', async ({
    page,
    context,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

    // =========================================================================
    // 1. Viewport Meta Tag & iPhone Safe-Area Prerequisite Check
    // =========================================================================
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const viewportMeta = page.locator('meta[name="viewport"]');
    await expect(viewportMeta).toHaveAttribute('content', /viewport-fit=cover/);

    // =========================================================================
    // 2. Mobile Viewport (375x812): Studio Step 1 One-Tap Creation in Dark Mode
    // =========================================================================
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Authenticate with dev bypass if login gate is displayed
    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    try {
      await devLoginBtn.waitFor({ state: 'visible', timeout: 5000 });
      await devLoginBtn.click();
    } catch {
      // Already authenticated
    }

    // Verify Dark Mode is active
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // If an existing story was loaded, switch to Create mode (click + Create New Story or mobile drawer + Create)
    const newStoryBtn = page.getByRole('button', { name: /\+ Create New Story/i });
    if (await newStoryBtn.isVisible()) {
      await newStoryBtn.click();
    }

    // Verify Mobile Topbar bounds and non-clipping
    const mobileTopBar = page.locator('.studio-mobile-topbar');
    await expect(mobileTopBar).toBeVisible();
    const topBarBox = await mobileTopBar.boundingBox();
    expect(topBarBox).not.toBeNull();
    if (topBarBox) {
      expect(topBarBox.x).toBeGreaterThanOrEqual(-1);
      expect(topBarBox.x + topBarBox.width).toBeLessThanOrEqual(376);
    }

    // Verify Target Age Range pills
    const toddlerPill = page.getByRole('button', { name: /Ages 2–4 · Toddler/i });
    const earlyReaderPill = page.getByRole('button', { name: /Ages 5–7 · Early Reader/i });
    await expect(toddlerPill).toBeVisible();
    await expect(earlyReaderPill).toBeVisible();
    await expect(earlyReaderPill).toHaveClass(/active/);

    // Verify Story Length selector and 4 pills
    await expect(page.getByText('STORY LENGTH:')).toBeVisible();
    const lengthSelector = page.getByTestId('story-length-selector');
    await expect(lengthSelector).toBeVisible();

    const quickPill = page.getByRole('button', { name: /⚡ Quick \(~1–2 min\)/i });
    const standardPill = page.getByRole('button', { name: /📖 Standard \(~3–4 min\)/i });
    const extendedPill = page.getByRole('button', { name: /🌙 Extended \(~5–7 min\)/i });
    const epicPill = page.getByRole('button', { name: /🏔️ Deep Dive \(~8–10 min\)/i });

    await expect(quickPill).toBeVisible();
    await expect(standardPill).toBeVisible();
    await expect(extendedPill).toBeVisible();
    await expect(epicPill).toBeVisible();
    await expect(standardPill).toHaveClass(/active/);

    // Verify separate VOCABULARY COMPLEXITY selector is removed
    await expect(page.getByText('VOCABULARY COMPLEXITY:')).not.toBeVisible();

    // Verify Narrator Voice select and Auto-Synthesize toggle
    const narratorSelect = page.getByRole('combobox', { name: /Narrator Voice/i });
    await expect(narratorSelect).toBeVisible();

    const autoSynthToggle = page.getByTestId('auto-synthesize-toggle');
    await expect(autoSynthToggle).toBeVisible();
    await expect(autoSynthToggle).toBeChecked();

    // Verify One-Tap primary CTA button
    const ctaBtn = page.locator('.studio-sticky-footer button[type="submit"]');
    await expect(ctaBtn).toBeVisible();
    await expect(ctaBtn).toContainText('✨ Create Story & Generate Audio');

    // Verify Sticky Footer safe area bounding box
    const stickyFooter = page.locator('.studio-sticky-footer');
    await expect(stickyFooter).toBeVisible();
    await stickyFooter.scrollIntoViewIfNeeded();
    const stickyBox = await stickyFooter.boundingBox();
    expect(stickyBox).not.toBeNull();
    if (stickyBox) {
      expect(stickyBox.y + stickyBox.height).toBeLessThanOrEqual(813);
    }

    // Verify zero horizontal overflow at 375x812
    const mobileCreateOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileCreateOverflow).toBe(true);

    // Capture Screenshot 1: phase14-mobile-onetap-create-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase14-mobile-onetap-create-dark.png',
      fullPage: false,
    });

    // =========================================================================
    // 3. Mobile Viewport (375x812): Public Reader + Docked Audio Bar with Safe-Area
    // =========================================================================
    await page.goto('/stories/2026-11-04-sleepy-little-train', { waitUntil: 'domcontentloaded' });

    // Verify Reader and Docked Audio Bar are present
    const readerContainer = page.locator('.reader-wrapper');
    await expect(readerContainer).toBeVisible({ timeout: 10000 });

    const dockedBar = page.locator('.docked-audio-bar');
    await expect(dockedBar).toBeVisible();

    // Verify docked audio bar bounding box respects viewport edges and does not clip
    const dockedBarBox = await dockedBar.boundingBox();
    expect(dockedBarBox).not.toBeNull();
    if (dockedBarBox) {
      expect(dockedBarBox.x).toBeGreaterThanOrEqual(-1);
      expect(dockedBarBox.x + dockedBarBox.width).toBeLessThanOrEqual(376);
      expect(dockedBarBox.y + dockedBarBox.height).toBeLessThanOrEqual(813);
    }

    // Verify reader-wrapper has safe bottom spacing
    const readerPaddingBottom = await page.evaluate(() => {
      const el = document.querySelector('.reader-wrapper');
      return el ? window.getComputedStyle(el).paddingBottom : '';
    });
    expect(parseFloat(readerPaddingBottom)).toBeGreaterThanOrEqual(100);

    // Verify zero horizontal overflow on public reader
    const readerOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(readerOverflow).toBe(true);

    // Capture Screenshot 2: phase14-mobile-reader-safearea-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase14-mobile-reader-safearea-dark.png',
      fullPage: false,
    });

    // =========================================================================
    // 4. Desktop Viewport (1440x900): Studio Step 1 with Story Length & One-Tap Card
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Open Step 1 Create view if workbench is currently shown
    const desktopNewStoryBtn = page.getByRole('button', { name: /\+ Create New Story/i });
    if (await desktopNewStoryBtn.isVisible()) {
      await desktopNewStoryBtn.click();
    }

    // Verify desktop studio Step 1 panel is visible
    const desktopStep1Panel = page.locator('#step-1-panel');
    await expect(desktopStep1Panel).toBeVisible();

    // Verify Story Length selector on desktop
    const desktopLengthSelector = desktopStep1Panel.getByTestId('story-length-selector');
    await expect(desktopLengthSelector).toBeVisible();

    // Verify Narrator Voice & Auto-Audio card on desktop
    const desktopNarratorCard = desktopStep1Panel.locator('.narrator-auto-audio-card');
    await expect(desktopNarratorCard).toBeVisible();
    await expect(desktopNarratorCard.getByRole('combobox', { name: /Narrator Voice/i })).toBeVisible();
    await expect(desktopNarratorCard.getByTestId('auto-synthesize-toggle')).toBeChecked();

    // Verify zero horizontal overflow on desktop
    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(desktopOverflow).toBe(true);

    // Capture Screenshot 3: phase14-desktop-onetap-create-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase14-desktop-onetap-create-dark.png',
      fullPage: false,
    });

    // Verify no catastrophic page crashes occurred
    expect(pageErrors).toEqual([]);
  });
});
