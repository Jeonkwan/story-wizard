import { test, expect } from '@playwright/test';

test.describe('Phase 13: Fireside Espresso UI Redesign, Dark-First Default & Compact Mobile Ergonomics', () => {
  test('verifies dark-first default, mobile topbar, story drawer, reader styling, zero overflow, and visual captures', async ({
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
    // 1. Mobile Viewport (375x812): Studio Step 1 in Fireside Espresso Dark
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

    // Verify Dark-First default theme on body and html
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Verify Sticky Mobile Top Bar is visible on mobile
    const mobileTopBar = page.locator('.studio-mobile-topbar');
    await expect(mobileTopBar).toBeVisible();

    // Verify Drawer Button and Step Switcher buttons
    const drawerTrigger = page.getByTestId('mobile-stories-drawer-btn');
    await expect(drawerTrigger).toBeVisible();

    const step1DraftBtn = page.getByTestId('mobile-step-draft');
    await expect(step1DraftBtn).toBeVisible();
    await expect(step1DraftBtn).toHaveAttribute('aria-pressed', 'true');

    // Verify Step 1 Panel is in the DOM
    const step1Panel = page.locator('#step-1-panel');
    await expect(step1Panel).toBeVisible();

    // Verify compact 2-col grids and continuity accordion
    await expect(page.locator('.studio-mode-grid')).toBeVisible();
    await expect(page.locator('.continuity-accordion')).toBeVisible();
    await expect(page.locator('.studio-sticky-footer')).toBeVisible();

    // Check zero horizontal overflow at 375x812
    const mobileStep1Overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(mobileStep1Overflow).toBe(true);

    // Capture Screenshot 1: phase13-mobile-studio-espresso-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase13-mobile-studio-espresso-dark.png',
      fullPage: false,
    });

    // =========================================================================
    // 2. Mobile Viewport (375x812): Slide-Up Story Archive Drawer Open
    // =========================================================================
    await drawerTrigger.click();

    const drawer = page.locator('.studio-archive-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.locator('.studio-archive-drawer-backdrop')).toBeVisible();

    // Check zero horizontal overflow while drawer is open
    const drawerOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(drawerOverflow).toBe(true);

    // Capture Screenshot 2: phase13-mobile-drawer-espresso-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase13-mobile-drawer-espresso-dark.png',
      fullPage: false,
    });

    // Select a story in the drawer (The Sleepy Little Train)
    const trainStoryItem = drawer.locator('.studio-story-item', { hasText: 'The Sleepy Little Train' }).first();
    await expect(trainStoryItem).toBeVisible();
    await trainStoryItem.click();

    // Drawer auto-closes
    await expect(drawer).not.toBeVisible();

    // =========================================================================
    // 3. Mobile Viewport (375x812): Workbench Step 2 Preview & Script
    // =========================================================================
    const workbench = page.locator('#step-2-panel');
    await expect(workbench).toBeVisible();

    // Topbar reflects step 2 is active
    const step2ScriptBtn = page.getByTestId('mobile-step-script');
    await expect(step2ScriptBtn).toHaveAttribute('aria-pressed', 'true');

    // Dual tab switcher is visible
    const previewTab = page.getByRole('tab', { name: /Storybook Preview/i });
    const editorTab = page.getByRole('tab', { name: /Script Editor/i });
    await expect(previewTab).toBeVisible();
    await expect(editorTab).toBeVisible();

    // Check zero horizontal overflow in workbench
    const workbenchOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(workbenchOverflow).toBe(true);

    // Capture Screenshot 3: phase13-mobile-workbench-espresso-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase13-mobile-workbench-espresso-dark.png',
      fullPage: false,
    });

    // =========================================================================
    // 4. Mobile Viewport (375x812): Reader in Fireside Espresso Dark
    // =========================================================================
    await page.goto('/stories/2026-11-04-sleepy-little-train', { waitUntil: 'domcontentloaded' });

    // Verify Reader page and docked glass audio player
    await expect(page.locator('.reader-wrapper')).toBeVisible();
    await expect(page.locator('.docked-audio-bar')).toBeVisible();
    await expect(page.locator('.opening-narration')).toBeVisible();
    await expect(page.locator('.dialogue-turn').first()).toBeVisible();

    // Verify Dark Theme on Reader
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Check zero horizontal overflow on Reader
    const darkReaderOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(darkReaderOverflow).toBe(true);

    // Capture Screenshot 4: phase13-mobile-reader-espresso-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase13-mobile-reader-espresso-dark.png',
      fullPage: false,
    });

    // =========================================================================
    // 5. Mobile Viewport (375x812): Reader in Daylight Latte Light
    // =========================================================================
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');

    // Check zero horizontal overflow on Light Reader
    const lightReaderOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(lightReaderOverflow).toBe(true);

    // Capture Screenshot 5: phase13-mobile-reader-latte-light.png
    await page.screenshot({
      path: 'qa-screenshots/phase13-mobile-reader-latte-light.png',
      fullPage: false,
    });

    // =========================================================================
    // 6. Desktop Viewport (1440x900): 2-Column Studio in Fireside Espresso Dark
    // =========================================================================
    // Switch back to Dark Mode
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // On Desktop, the 2-column sidebar is visible and mobile topbar is hidden
    await expect(page.locator('.studio-sidebar')).toBeVisible();
    await expect(mobileTopBar).not.toBeVisible();

    // Check zero horizontal overflow on Desktop
    const desktopStudioOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(desktopStudioOverflow).toBe(true);

    // Capture Screenshot 6: phase13-desktop-studio-espresso-dark.png
    await page.screenshot({
      path: 'qa-screenshots/phase13-desktop-studio-espresso-dark.png',
      fullPage: false,
    });

    // Verify clean logs with zero unhandled exceptions
    expect(pageErrors).toEqual([]);
  });
});
