import { test, expect } from '@playwright/test';

test.describe('Phase 2 Public Storybook E2E', () => {
  test('renders catalog, filters stories, opens formatted reader, scrubs audio, and captures screenshots', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    // Route accounts.google.com to a clean mock to prevent external network flakes
    await page.route('https://accounts.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } };',
      });
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Desktop viewport initially
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Verify initial light color-scheme
    const initialColorScheme = await page.evaluate(
      () => window.getComputedStyle(document.documentElement).colorScheme
    );
    expect(initialColorScheme).toBe('light');

    // 2. Verify seeded story card is present
    const storyTitle = page.locator('.story-card-title', { hasText: 'The Sleepy Little Train' });
    await expect(storyTitle).toBeVisible();

    const storyCard = page.locator('.story-card', { hasText: 'The Sleepy Little Train' });
    await expect(storyCard).toBeVisible();

    // 3. Test search filter
    const searchInput = page.getByLabel('Search stories');
    await searchInput.fill('xyzNonexistentStoryQuery');
    await expect(storyCard).not.toBeVisible();
    await expect(page.getByText('No stories found matching your filter criteria.')).toBeVisible();

    // Clear search filter -> card returns
    await searchInput.fill('');
    await expect(storyCard).toBeVisible();

    // 4. Click "Read & Listen" to open formatted StoryReader and assert URL update
    const readBtn = storyCard.getByRole('button', { name: /Read & Listen/i });
    await readBtn.click();

    // Verify URL synced to /stories/:id
    await expect(page).toHaveURL(/\/stories\/2026-11-04-sleepy-little-train/);

    // Verify Reader view is loaded
    const readerTitle = page.locator('.reader-title');
    await expect(readerTitle).toHaveText('The Sleepy Little Train');

    // Verify prose parentheses preserved
    const blueTrainProse = page.getByText('(which was painted bright blue)');
    await expect(blueTrainProse).toBeVisible();

    // Verify vocal tags stripped from DOM
    const rawShortPause = page.locator('text="<short pause>"');
    await expect(rawShortPause).toHaveCount(0);
    const rawSigh = page.locator('text="<sigh>"');
    await expect(rawSigh).toHaveCount(0);

    // Verify character speaker badge for Bibi
    const bibiBadge = page.locator('.speaker-badge', { hasText: 'Bibi' });
    await expect(bibiBadge).toBeVisible();

    // 5. Verify <audio> loads real WAV metadata (duration > 0)
    const audioElement = page.locator('audio');
    await expect(audioElement).toBeAttached();

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

    // Verify HTTP Range seeking on audio
    const seekSuccess = await page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio) return false;
      audio.currentTime = 0.5;
      return new Promise<boolean>((resolve) => {
        audio.addEventListener('seeked', () => resolve(Math.abs(audio.currentTime - 0.5) < 0.15), {
          once: true,
        });
        setTimeout(() => resolve(Math.abs(audio.currentTime - 0.5) < 0.15), 4000);
      });
    });
    expect(seekSuccess).toBe(true);

    // 6. Capture Light Theme Screenshot (1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase2-reader-light.png', fullPage: false });

    // 7. Toggle Dark Mode and verify immediate contrast and color-scheme
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Move mouse away to test resting (non-hover) button colors
    await page.mouse.move(0, 0);

    // Verify dark color-scheme on root
    const darkColorScheme = await page.evaluate(
      () => window.getComputedStyle(document.documentElement).colorScheme
    );
    expect(darkColorScheme).toBe('dark');

    // Explicitly verify button styles under Dark Mode (instant, zero white-on-white flash)
    const themeBtnStyles = await themeBtn.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(themeBtnStyles.bg).toBe('rgb(22, 31, 44)'); // #161F2C (var(--bg-surface))
    expect(themeBtnStyles.color).toBe('rgb(241, 245, 249)'); // #F1F5F9 (var(--ink-primary))

    const playBtn = page.locator('.btn-tactile-primary', { hasText: /Play|Pause/i });
    const playBtnStyles = await playBtn.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(playBtnStyles.bg).toBe('rgb(30, 27, 75)'); // #1E1B4B (var(--accent-module-bg))

    // Capture Dark Theme Screenshot (1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase2-reader-dark.png', fullPage: false });

    // 8. Test Browser Back/Forward navigation with URL synchronization
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(storyCard).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/stories\/2026-11-04-sleepy-little-train/);
    await expect(readerTitle).toHaveText('The Sleepy Little Train');

    // 9. Mobile Responsiveness check at 375x812 (zero horizontal overflow & clearance)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(200);

    const hasNoHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth;
    });
    expect(hasNoHorizontalOverflow).toBe(true);

    // 10. Assert zero uncaught page errors and zero console.error messages
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe('Phase 3 Admin Director Studio E2E', () => {
  test('logs into admin studio, edits story turn with quick tag, saves script, checks dark mode & mobile layout, and captures screenshot', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await page.route('https://accounts.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } };',
      });
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. Navigate to /admin
    await page.goto('/admin');
    await expect(page.locator('h2', { hasText: 'Director Studio' })).toBeVisible();

    // 2. Click Dev Sandbox Login
    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(devLoginBtn).toBeVisible();
    await devLoginBtn.click();

    // 3. Verify Director Studio loads with story list
    const sidebar = page.locator('.studio-sidebar');
    await expect(sidebar).toBeVisible();
    const seededStoryItem = page.locator('.studio-story-item', { hasText: 'The Sleepy Little Train' });
    await expect(seededStoryItem).toBeVisible();

    // 4. Click seeded story to load into workbench
    await seededStoryItem.click();

    // Verify workbench is loaded
    await expect(page.locator('.studio-workbench')).toBeVisible();
    const saveScriptBtn = page.getByRole('button', { name: /Save Script/i });
    await expect(saveScriptBtn).toBeVisible();

    // 5. Test quick-insert vocal tag pill into turn #1
    const firstTurnCard = page.locator('.turn-card').first();
    const turnTextarea = firstTurnCard.locator('textarea');
    await expect(turnTextarea).toBeVisible();

    // Record original text for idempotent restoration
    const originalTurnText = await turnTextarea.inputValue();

    const testTag = '<short pause>';
    const shortPausePill = firstTurnCard.getByRole('button', { name: testTag });
    await expect(shortPausePill).toBeVisible();
    await shortPausePill.click();

    const expectedEditedText = await turnTextarea.inputValue();
    expect(expectedEditedText).toContain(testTag);

    // Click "Save Script"
    await saveScriptBtn.click();

    // Verify "✓ Saved successfully" banner
    await expect(page.getByText('✓ Saved successfully')).toBeVisible();

    // 6. Reload page and assert persisted value
    await page.reload();
    await seededStoryItem.click();
    const reloadedTextarea = page.locator('.turn-card').first().locator('textarea');
    await expect(reloadedTextarea).toBeVisible();
    await expect(reloadedTextarea).toHaveValue(expectedEditedText);

    // Idempotent cleanup: restore original turn text and save
    await reloadedTextarea.fill(originalTurnText);
    const reloadedSaveBtn = page.getByRole('button', { name: /Save Script/i });
    await reloadedSaveBtn.click();
    await expect(page.getByText('✓ Saved successfully')).toBeVisible();

    // 7. Verify Dark Mode contrast on /admin
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    const isDark = await page.evaluate(() => document.body.getAttribute('data-theme') === 'dark');
    if (!isDark) {
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
    }

    // Move mouse away to test resting button colors
    await page.mouse.move(0, 0);

    const darkBtnStyles = await themeBtn.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(darkBtnStyles.bg).toBe('rgb(22, 31, 44)'); // #161F2C
    expect(darkBtnStyles.color).toBe('rgb(241, 245, 249)'); // #F1F5F9

    // 8. Capture Phase 3 Admin Studio Screenshot (1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase3-admin-studio.png', fullPage: false });

    // 9. Mobile Responsiveness check at 375x812 (zero horizontal overflow)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(200);

    const hasNoHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth;
    });
    expect(hasNoHorizontalOverflow).toBe(true);

    // 10. Assert zero pageerror and zero console.error
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

