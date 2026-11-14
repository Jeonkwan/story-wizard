import { test, expect, type Page } from '@playwright/test';

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

test.describe('Phase 17: M4A Streaming, Lossless WAV Download & Dynamic Private Podcast RSS', () => {
  test('verifies .m4a 206 streaming, WAV download link, Podcasts tab CRUD, Studio Podcast Release, RSS XML & responsive viewports', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];
    let receivedM4a206 = false;

    await setupExternalMocks(page);

    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('response', (response) => {
      if (response.url().includes('.m4a') && response.status() === 206) {
        receivedM4a206 = true;
      }
    });

    // -------------------------------------------------------------------------
    // 1. Mobile Reader (375x812, Dark Theme): .m4a HTTP 206 + WAV Download Link
    // -------------------------------------------------------------------------
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const trainCard = page.locator('.story-card', { hasText: 'The Sleepy Little Train' });
    await expect(trainCard).toBeVisible();
    await trainCard.getByRole('button', { name: /Read & Listen/i }).click();

    const wavDownloadBtn = page.getByTestId('reader-download-wav-btn');
    await expect(wavDownloadBtn).toBeVisible();
    await expect(wavDownloadBtn).toHaveAttribute(
      'href',
      /\/api\/stories\/2026-11-04-sleepy-little-train\/audios\/v1-owl-solo\.wav\?download=1$/
    );

    // Verify player uses .m4a default source and streams HTTP 206 on play/seek
    const audioEl = page.locator('audio');
    await expect(audioEl).toHaveAttribute('src', /\.m4a$/);

    await page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio) return;
      try {
        await audio.play();
      } catch {
        // Headless autoplay may settle asynchronously
      }
      audio.currentTime = 0.5;
    });

    await expect.poll(() => receivedM4a206, { timeout: 5000 }).toBe(true);

    // Zero horizontal overflow on mobile reader
    const mobileReaderOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(mobileReaderOverflow).toBe(false);

    await page.screenshot({
      path: 'qa-screenshots/phase17-mobile-reader-wav-download-dark.png',
      fullPage: false,
    });

    // -------------------------------------------------------------------------
    // 2. Desktop Admin Login & Podcasts Tab (/admin/podcasts)
    // -------------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(devLoginBtn).toBeVisible();
    await devLoginBtn.click();

    // Navigate to 📻 Podcasts tab
    const podcastsTab = page.getByTestId('admin-tab-podcasts');
    await expect(podcastsTab).toBeVisible();
    await podcastsTab.click();
    await expect(page).toHaveURL(/\/admin\/podcasts/);

    // Create a private podcast feed
    const podcastTitle = 'QA Bedtime Podcast';
    await page.getByTestId('new-podcast-btn').click();
    await page.getByTestId('podcast-title-input').fill(podcastTitle);
    await page.getByTestId('podcast-author-input').fill('Storyteller QA');
    await page.getByTestId('podcast-description-input').fill('Private bedtime feed for E2E verification');
    await page.getByTestId('save-podcast-btn').click();

    const createdPodcastId = 'qa-bedtime-podcast';
    const podcastCard = page.getByTestId(`podcast-card-${createdPodcastId}`);
    await expect(podcastCard).toBeVisible();

    try {
      // -----------------------------------------------------------------------
      // 3. Desktop Workbench: Dynamic Podcast Release Panel & ⬇ WAV Button
      // -----------------------------------------------------------------------
      await page.getByRole('button', { name: /Stories Workbench/i }).click();
      const sleepyTrainItem = page.locator('.studio-story-item', {
        hasText: 'The Sleepy Little Train',
      });
      await expect(sleepyTrainItem).toBeVisible();
      await sleepyTrainItem.click();

      // Switch to Script Editor tab to access Step 3 Voice Studio Panel
      await page.getByRole('tab', { name: /Script Editor/i }).click();

      // Scroll to Voice Studio Panel (Step 3)
      const voicePanel = page.locator('.voice-studio-panel');
      await expect(voicePanel).toBeVisible();
      await voicePanel.scrollIntoViewIfNeeded();

      // Verify ⬇ WAV button on version card
      const studioWavBtn = page.getByTestId('download-wav-v1-owl-solo');
      await expect(studioWavBtn).toBeVisible();
      await expect(studioWavBtn).toHaveAttribute(
        'href',
        '/api/stories/2026-11-04-sleepy-little-train/audios/v1-owl-solo.wav?download=1'
      );

      // Verify dynamic Podcast Release panel appears and release the story
      const releasePanel = page.getByTestId('story-podcast-release-panel');
      await expect(releasePanel).toBeVisible();

      const releaseBtn = page.getByTestId(`podcast-release-btn-${createdPodcastId}`);
      await expect(releaseBtn).toBeVisible();
      await releaseBtn.click();
      await expect(releaseBtn).toContainText('✓ Released');

      await releasePanel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'qa-screenshots/phase17-desktop-workbench-podcast-release-dark.png',
        fullPage: false,
      });

      // -----------------------------------------------------------------------
      // 4. Desktop & Mobile Podcasts Tab Verification + RSS Feed XML Check
      // -----------------------------------------------------------------------
      await page.getByTestId('admin-tab-podcasts').click();
      await expect(podcastCard).toBeVisible();
      await expect(
        page.getByTestId(`podcast-episode-${createdPodcastId}-2026-11-04-sleepy-little-train`)
      ).toBeVisible();

      // Zero horizontal overflow on desktop podcasts tab
      const desktopPodcastOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(desktopPodcastOverflow).toBe(false);

      await page.screenshot({
        path: 'qa-screenshots/phase17-desktop-podcasts-tab-dark.png',
        fullPage: false,
      });

      // Fetch private RSS feed URL and verify valid RSS 2.0 XML + .m4a enclosure
      const rssUrl = await page.getByTestId(`rss-link-input-${createdPodcastId}`).inputValue();
      expect(rssUrl).toContain(`/api/podcasts/${createdPodcastId}/feed.xml?token=`);

      const rssResponse = await page.request.get(rssUrl);
      expect(rssResponse.status()).toBe(200);
      expect(rssResponse.headers()['content-type']).toContain('application/rss+xml');
      const rssXml = await rssResponse.text();
      expect(rssXml).toContain('<rss version="2.0"');
      expect(rssXml).toContain('<title>The Sleepy Little Train</title>');
      expect(rssXml).toContain('v1-owl-solo.m4a');
      expect(rssXml).toContain('type="audio/x-m4a"');

      // Mobile Podcasts Tab (375x812) + zero horizontal overflow
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(podcastCard).toBeVisible();
      const mobilePodcastOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(mobilePodcastOverflow).toBe(false);

      await page.screenshot({
        path: 'qa-screenshots/phase17-mobile-podcasts-tab-dark.png',
        fullPage: false,
      });
    } finally {
      // Clean up test podcast so local ./data/podcasts stays clean across runs
      await page.request.delete(`/api/admin/podcasts/${createdPodcastId}`).catch(() => undefined);
    }

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
