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

    // 4. Click "Read & Listen" to open formatted StoryReader
    const readBtn = storyCard.getByRole('button', { name: /Read & Listen/i });
    await readBtn.click();

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

    // 7. Toggle Dark Mode and Capture Dark Theme Screenshot (1440x900)
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    await page.screenshot({ path: 'qa-screenshots/phase2-reader-dark.png', fullPage: false });

    // 8. Mobile Responsiveness check at 375x812 (zero horizontal overflow)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(200);

    const hasNoHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth;
    });
    expect(hasNoHorizontalOverflow).toBe(true);

    // 9. Assert zero uncaught page errors and zero console.error messages
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
