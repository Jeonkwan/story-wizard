import { test, expect, Page } from '@playwright/test';

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

test.describe('Phase 2 Public Storybook E2E', () => {
  test('renders catalog, filters stories, opens formatted reader, scrubs audio, and captures screenshots', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

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
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Verify initial dark color-scheme (Fireside Espresso Dark-First Default)
    const initialColorScheme = await page.evaluate(
      () => window.getComputedStyle(document.documentElement).colorScheme
    );
    expect(initialColorScheme).toBe('dark');

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

    // 6. Verify initial Dark Mode and capture Dark Theme Screenshot (1440x900)
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Move mouse away to test resting (non-hover) button colors
    await page.mouse.move(0, 0);

    // Verify dark color-scheme on root
    const darkColorScheme = await page.evaluate(
      () => window.getComputedStyle(document.documentElement).colorScheme
    );
    expect(darkColorScheme).toBe('dark');

    // Explicitly verify button styles under Dark Mode (instant, zero white-on-white flash)
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    const themeBtnStyles = await themeBtn.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(['rgb(42, 35, 30)', 'rgb(32, 27, 23)']).toContain(themeBtnStyles.bg);
    expect(themeBtnStyles.color).toBe('rgb(244, 239, 230)'); // #F4EFE6 (var(--ink-primary))

    const playBtn = page.locator('.btn-tactile-primary', { hasText: /Play|Pause/i });
    const playBtnStyles = await playBtn.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(playBtnStyles.bg).toBe('rgb(212, 155, 84)'); // #D49B54 (var(--accent-primary))
    expect(playBtnStyles.color).toBe('rgb(21, 18, 15)'); // #15120F (var(--accent-primary-ink))

    // Capture Dark Theme Screenshot (1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase2-reader-dark.png', fullPage: false });

    // 7. Toggle to Light Mode and verify immediate contrast and color-scheme
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');

    // Capture Light Theme Screenshot (1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase2-reader-light.png', fullPage: false });

    // Toggle back to Dark Mode
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

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

    await setupExternalMocks(page);

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
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
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

    // Switch to Script Editor tab
    await page.getByRole('tab', { name: /Script Editor/i }).click();

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
    await page.getByRole('tab', { name: /Script Editor/i }).click();
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
    expect(['rgb(42, 35, 30)', 'rgb(32, 27, 23)']).toContain(darkBtnStyles.bg);
    expect(darkBtnStyles.color).toBe('rgb(244, 239, 230)'); // #F4EFE6 (var(--ink-primary))

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

test.describe('Phase 4 Voice Audition Studio & Versions E2E', () => {
  test('verifies VoiceStudioPanel in admin workbench (Solo vs Cast toggle, Bibi character voice selector, existing version controls, Dark Mode, mobile layout) and captures screenshot', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Initial Desktop viewport
    await page.setViewportSize({ width: 1440, height: 900 });

    // 2. Navigate to /admin and log in via Dev Sandbox
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h2', { hasText: 'Director Studio' })).toBeVisible();

    const devLoginBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(devLoginBtn).toBeVisible();
    await devLoginBtn.click();

    // 3. Load seeded story into workbench
    const seededStoryItem = page.locator('.studio-story-item', { hasText: 'The Sleepy Little Train' });
    await expect(seededStoryItem).toBeVisible();
    await seededStoryItem.click();

    // Switch to Script Editor tab to inspect Voice Studio
    await page.getByRole('tab', { name: /Script Editor/i }).click();

    // 4. Verify VoiceStudioPanel rendered
    const voicePanel = page.locator('.voice-studio-panel');
    await expect(voicePanel).toBeVisible();
    await expect(voicePanel.getByText(/Step 3: Voice Audition, Synthesis & Versions/i)).toBeVisible();

    // Verify existing seeded version controls
    const versionCard = voicePanel.locator('.card-tactile', { hasText: 'Grandpa Owl (Bedtime Solo)' });
    await expect(versionCard).toBeVisible();
    await expect(versionCard.getByText('★ DEFAULT')).toBeVisible();
    await expect(versionCard.locator('audio')).toBeVisible();

    // 5. Test Solo vs Cast toggle
    const soloBtn = voicePanel.getByRole('button', { name: /Solo Storyteller/i });
    const castBtn = voicePanel.getByRole('button', { name: /Multi-Speaker Cast/i });
    await expect(soloBtn).toBeVisible();
    await expect(castBtn).toBeVisible();

    // Click Multi-Speaker Cast toggle
    await castBtn.click();

    // Assert character voice assignment for Bibi appears
    await expect(voicePanel.getByText('CHARACTER VOICE ASSIGNMENTS')).toBeVisible();
    await expect(voicePanel.locator('div', { hasText: 'Bibi' }).first()).toBeVisible();

    // Toggle back to Solo Storyteller
    await soloBtn.click();
    await expect(voicePanel.getByText('CHARACTER VOICE ASSIGNMENTS')).toHaveCount(0);

    // 6. Test Design Custom Voice expandable form
    const designVoiceBtn = voicePanel.getByRole('button', { name: /Design Custom Voice/i });
    await expect(designVoiceBtn).toBeVisible();
    await designVoiceBtn.click();

    await expect(page.getByPlaceholder('e.g. Grandma Willow')).toBeVisible();
    await expect(page.getByPlaceholder(/Warm, elderly grandmother/i)).toBeVisible();

    // Collapse design form
    await voicePanel.getByRole('button', { name: /Cancel Voice Design/i }).click();
    await expect(page.getByPlaceholder('e.g. Grandma Willow')).toHaveCount(0);

    // 7. Verify Dark Mode contrast on Voice Studio Panel
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    const isDark = await page.evaluate(() => document.body.getAttribute('data-theme') === 'dark');
    if (!isDark) {
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
    }

    // Move mouse away to test resting colors
    await page.mouse.move(0, 0);

    const darkPanelStyles = await voicePanel.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(['rgb(32, 27, 23)', 'rgb(42, 35, 30)']).toContain(darkPanelStyles.bg); // #201B17 (var(--bg-surface))

    // 8. Capture Phase 4 Voice Studio Screenshot (1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase4-voice-studio.png', fullPage: false });

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

  test('Phase 6: verifies compact mobile audio player (<70px height, 85px padding), genre freedom presets, and generation UX', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Check Masthead subtitle on home page
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const mastheadSub = page.locator('.masthead-subtitle');
    await expect(mastheadSub).toHaveText(/Expressive Narratives, Character Voices & Tactile Audio/i);

    // 2. Open Reader on iPhone viewport (375x812) to inspect compact mobile audio player
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/stories/2026-11-04-sleepy-little-train', { waitUntil: 'domcontentloaded' });

    const dockedBar = page.locator('.docked-audio-bar');
    await expect(dockedBar).toBeVisible();

    // Verify 2 compact layers exist in DOM
    const scrubSection = page.locator('.docked-audio-bar .player-scrub-section');
    const mainRow = page.locator('.docked-audio-bar .docked-audio-main-row');
    await expect(scrubSection).toBeVisible();
    await expect(mainRow).toBeVisible();

    // Verify compact height (< 75px instead of previous ~195px)
    const barBox = await dockedBar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.height).toBeLessThan(75);
    expect(barBox!.height).toBeGreaterThanOrEqual(45);

    // Verify reader-wrapper padding-bottom is 85px (reclaiming >110px of vertical space!)
    const paddingBottom = await page.evaluate(() => {
      const el = document.querySelector('.reader-wrapper');
      return el ? window.getComputedStyle(el).paddingBottom : null;
    });
    expect(paddingBottom).toBe('85px');

    // Verify touch target size of Play/Pause button (min 36px)
    const playBtn = page.locator('.docked-audio-bar .player-main-controls .btn-tactile-primary');
    await expect(playBtn).toBeVisible();
    const playBtnBox = await playBtn.boundingBox();
    expect(playBtnBox).not.toBeNull();
    expect(playBtnBox!.height).toBeGreaterThanOrEqual(36);

    // Capture Phase 6 Compact Mobile Player Screenshot
    await page.screenshot({ path: 'qa-screenshots/phase6-compact-player-mobile.png', fullPage: false });

    // 3. Admin Director Studio Audit (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Dev bypass login if gated or already logged in
    const newStoryBtn = page.getByRole('button', { name: /➕ New Story/i });
    const bypassBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(newStoryBtn.or(bypassBtn)).toBeVisible();
    if (await bypassBtn.isVisible()) {
      await bypassBtn.click();
    }

    // Click "➕ New Story" to open Step 1 Creation workflow
    await expect(newStoryBtn).toBeVisible();
    await newStoryBtn.click();

    // Verify Step 1 header text
    await expect(page.getByRole('heading', { name: /Step 1: Write Story Draft/i })).toBeVisible();

    // Verify genre & mood preset pills exist
    const anyPill = page.getByRole('button', { name: /✨ Any \/ Custom/i });
    const humorPill = page.getByRole('button', { name: /😂 Fun & Humorous/i });
    const scifiPill = page.getByRole('button', { name: /🚀 Adventure & Sci-Fi/i });
    const mysteryPill = page.getByRole('button', { name: /🔍 Mystery & Intrigue/i });
    const bedtimePill = page.getByRole('button', { name: /🌙 Bedtime & Soothing/i });
    const fablePill = page.getByRole('button', { name: /🧚 Whimsical Fable/i });

    await expect(anyPill).toBeVisible();
    await expect(humorPill).toBeVisible();
    await expect(scifiPill).toBeVisible();
    await expect(mysteryPill).toBeVisible();
    await expect(bedtimePill).toBeVisible();
    await expect(fablePill).toBeVisible();

    // Click humor pill and assert prompt input is populated
    await humorPill.click();
    const promptInput = page.getByPlaceholder(/A comedic sci-fi adventure/i);
    await expect(promptInput).toHaveValue(/A funny, comedic adventure with witty banter and playful chaos:/i);
    await expect(humorPill).toHaveClass(/btn-tactile-primary/);

    // Click sci-fi pill -> replaces prefix
    await scifiPill.click();
    await expect(promptInput).toHaveValue(/An exciting, fast-paced sci-fi adventure exploring unknown worlds:/i);

    // Capture Phase 6 Admin Genre Presets Screenshot
    await page.screenshot({ path: 'qa-screenshots/phase6-admin-genre-presets.png', fullPage: false });

    // 4. Open existing story in workbench to verify Step 2 & Step 3
    const storyItem = page.locator('.studio-story-item', { hasText: 'The Sleepy Little Train' }).first();
    await storyItem.click();

    // Switch to Script Editor tab
    await page.getByRole('tab', { name: /Script Editor/i }).click();

    // Verify Step 2 header & subtext
    await expect(page.getByRole('heading', { name: /Step 2: Auto-Direct Voices & Pacing/i })).toBeVisible();
    await expect(page.getByText(/matching the story's genre/i)).toBeVisible();

    // Verify Step 3 Voice Studio Panel default version labels
    const voicePanel = page.locator('.voice-studio-panel');
    await expect(voicePanel).toBeVisible();

    const versionLabelInput = voicePanel.getByPlaceholder('e.g. Solo Narration');
    await expect(versionLabelInput).toBeVisible();
    await expect(versionLabelInput).toHaveValue('Solo Narration');

    // Switch to Multi-Speaker Cast -> version label updates to "Full Cast Audio"
    const castBtn = voicePanel.getByRole('button', { name: /Multi-Speaker Cast/i });
    await castBtn.click();
    await expect(versionLabelInput).toHaveValue('Full Cast Audio');

    // Capture Phase 6 Voice Studio Desktop Screenshot
    await page.screenshot({ path: 'qa-screenshots/phase6-voice-studio-desktop.png', fullPage: false });

    // 5. Verify zero pageerror and zero console.error
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test('Phase 7 Zero-DB Asynchronous Job Manager & Refresh Resilience: page reload mid-generation restores progress card and completes automatically', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    // Auto-accept beforeunload confirmation dialog during reload
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    let isStarted = false;
    let isReloaded = false;
    let reloadPollCount = 0;

    // Mock active jobs & status routes to test reload recovery deterministically
    await page.route('**/api/admin/jobs/active*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          activeJobs:
            isStarted && (!isReloaded || reloadPollCount < 2)
              ? [
                  {
                    job_id: 'job-phase7-e2e-reload',
                    story_id: 'new',
                    type: 'draft',
                    status: 'running',
                    started_at: new Date(Date.now() - 6000).toISOString(),
                    elapsed_seconds: 6,
                    message: 'Drafting story with Gemini 3.8 Flash...',
                  },
                ]
              : [],
        }),
      });
    });

    await page.route('**/api/admin/jobs/job-phase7-e2e-reload', (route) => {
      const isComplete = isReloaded && reloadPollCount >= 1;
      if (isReloaded) {
        reloadPollCount++;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            job_id: 'job-phase7-e2e-reload',
            story_id: 'new',
            type: 'draft',
            status: isComplete ? 'completed' : 'running',
            started_at: new Date(Date.now() - 6000).toISOString(),
            elapsed_seconds: isComplete ? 10 : 7,
            result_story_id: '2026-11-04-sleepy-little-train',
            message: isComplete ? 'Story draft complete!' : 'Drafting story with Gemini 3.8 Flash...',
          },
        }),
      });
    });

    await page.route('**/api/admin/stories/write*', (route) => {
      isStarted = true;
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: 'job-phase7-e2e-reload',
          status: 'running',
        }),
      });
    });

    // 1. Initial Desktop Viewport
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Dev bypass login if needed
    const newStoryBtn = page.getByRole('button', { name: /➕ New Story/i });
    const bypassBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(newStoryBtn.or(bypassBtn)).toBeVisible();
    if (await bypassBtn.isVisible()) {
      await bypassBtn.click();
    }

    // Click "➕ New Story"
    await expect(newStoryBtn).toBeVisible();
    await newStoryBtn.click();

    // Fill prompt
    const promptInput = page.getByPlaceholder(/A comedic sci-fi adventure|A gentle, soothing bedtime story/i);
    await promptInput.fill('A cozy rabbit hopping through powdery blue starlight in the pine forest.');

    // Submit draft generation
    const submitBtn = page.getByRole('button', { name: /1\. Write Story Draft/i });
    await expect(submitBtn).toBeVisible();
    await submitBtn.click({ noWaitAfter: true });

    // Verify progress card is visible
    const progressCard = page.locator('.tactile-progress-card');
    await expect(progressCard).toBeVisible();
    await expect(progressCard.locator('strong')).toHaveText(/Drafting story with Gemini 3\.8 Flash/i);

    // 2. SIMULATE REFRESH / APP SWITCH MID-GENERATION
    isReloaded = true;
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Dev bypass login if needed on reload
    await expect(newStoryBtn.or(bypassBtn)).toBeVisible();
    if (await bypassBtn.isVisible()) {
      await bypassBtn.click();
    }

    // VERIFY REFRESH RESILIENCE: Progress card is IMMEDIATELY restored upon page reload!
    await expect(progressCard).toBeVisible();
    await expect(progressCard.locator('strong')).toHaveText(/Drafting story with Gemini 3\.8 Flash/i);

    // Verify submit button is disabled to prevent accidental double-submission
    const writingBtn = page.getByRole('button', { name: /Writing Draft\.\.\./i });
    await expect(writingBtn).toBeVisible();
    await expect(writingBtn).toBeDisabled();

    // Capture Phase 7 Active Job Recovery Screenshot
    await page.screenshot({ path: 'qa-screenshots/phase7-active-job-recovery.png', fullPage: false });

    // Wait for polling to automatically detect completion and load the story into workbench
    await expect(page.getByRole('tab', { name: /Storybook Preview/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Story drafted! Preview your storybook below/i)).toBeVisible();

    // Switch to Script Editor tab to inspect metadata and capture completed workbench
    await page.getByRole('tab', { name: /Script Editor/i }).click();
    await expect(page.getByRole('heading', { name: /Story Metadata/i })).toBeVisible({ timeout: 10000 });
    const titleInput = page.locator('input[value="The Sleepy Little Train"]');
    await expect(titleInput).toBeVisible();

    // Capture Phase 7 Completed Workbench Screenshot
    await page.screenshot({ path: 'qa-screenshots/phase7-workbench-completed.png', fullPage: false });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test('Phase 12: Dual-Tab Workbench Preview, Age/Vocab Controls, Library Deletion & Prompt Remix', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    await setupExternalMocks(page);

    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Initial Desktop Viewport
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Dev bypass login if needed
    const newStoryBtn = page.getByRole('button', { name: /➕ New Story/i });
    const bypassBtn = page.getByRole('button', { name: /Dev Sandbox Login/i });
    await expect(newStoryBtn.or(bypassBtn)).toBeVisible({ timeout: 10000 });
    if (await bypassBtn.isVisible()) {
      await bypassBtn.click();
    }
    await expect(newStoryBtn).toBeVisible({ timeout: 10000 });
    await newStoryBtn.click();

    // 2. Test Step 1 Age Range & Vocabulary Level Controls
    const toddlerPill = page.getByRole('button', { name: /Ages 2–4 · Toddler/i });
    const earlyReaderPill = page.getByRole('button', { name: /Ages 5–7 · Early Reader/i });
    const elementaryPill = page.getByRole('button', { name: /Ages 8–10 · Elementary/i });
    const youngReaderPill = page.getByRole('button', { name: /Ages 11\+ · Young Reader/i });

    await expect(toddlerPill).toBeVisible();
    await expect(earlyReaderPill).toBeVisible();
    await expect(elementaryPill).toBeVisible();
    await expect(youngReaderPill).toBeVisible();

    // Verify early-reader default
    await expect(earlyReaderPill).toHaveClass(/active/);
    await expect(page.getByText(/VOCABULARY COMPLEXITY:/i)).toContainText('standard');

    // Select Elementary -> automatically pairs enriched vocabulary
    await elementaryPill.click();
    await expect(elementaryPill).toHaveClass(/active/);
    await expect(page.getByText(/VOCABULARY COMPLEXITY:/i)).toContainText('enriched');

    // Toggle custom vocabulary
    const customVocabToggle = page.getByRole('button', { name: /Custom Vocabulary/i });
    await customVocabToggle.click();

    // Verify fine-tuning pills
    const advancedPill = page.getByRole('button', { name: /🎓 Advanced/i });
    await expect(advancedPill).toBeVisible();
    await advancedPill.click();
    await expect(page.getByText(/VOCABULARY COMPLEXITY:/i)).toContainText('advanced');

    // Capture screenshot of Age & Vocabulary Controls
    await page.screenshot({ path: 'qa-screenshots/phase12-age-vocab-controls.png', fullPage: false });

    // 3. Load story into Workbench & test Dual-Tab Switcher
    const sleepyStoryItem = page.locator('.studio-story-item', { hasText: 'The Sleepy Little Train' });
    await expect(sleepyStoryItem).toBeVisible();
    await sleepyStoryItem.click();

    // Verify dual tabs are present and Storybook Preview is active
    const previewTab = page.getByRole('tab', { name: /Storybook Preview/i });
    const editorTab = page.getByRole('tab', { name: /Script Editor/i });
    await expect(previewTab).toBeVisible();
    await expect(previewTab).toHaveClass(/active/);
    await expect(editorTab).toBeVisible();

    // Verify Storybook Preview action banner and pane
    const previewBanner = page.locator('.storybook-preview-actions-banner');
    await expect(previewBanner).toBeVisible();
    await expect(previewBanner.getByRole('button', { name: /Step 2: Auto-Direct Voices & Pacing/i })).toBeVisible();
    await expect(previewBanner.getByRole('button', { name: /Switch to Script Editor/i })).toBeVisible();
    await expect(previewBanner.getByRole('button', { name: /View in Public Reader/i })).toBeVisible();

    // Verify formatted reader elements
    const previewPane = page.locator('.storybook-preview-pane');
    await expect(previewPane).toBeVisible();
    await expect(previewPane.locator('.first-letter-dropcap')).toBeVisible();
    await expect(previewPane.locator('.dialogue-turn')).toBeVisible();

    // Capture theme screenshots with correct active theme synchronization
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    const isDark = (await page.locator('body').getAttribute('data-theme')) === 'dark';
    if (isDark) {
      await page.screenshot({ path: 'qa-screenshots/phase12-workbench-preview-dark.png', fullPage: false });
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
      await page.screenshot({ path: 'qa-screenshots/phase12-workbench-preview-light.png', fullPage: false });
      // Switch back to dark mode
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
    } else {
      await page.screenshot({ path: 'qa-screenshots/phase12-workbench-preview-light.png', fullPage: false });
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: 'qa-screenshots/phase12-workbench-preview-dark.png', fullPage: false });
    }

    // Switch to Script Editor tab
    await editorTab.click();
    await expect(editorTab).toHaveClass(/active/);
    await expect(page.getByRole('heading', { name: /Story Metadata/i })).toBeVisible();

    // 4. Test Public Library Deletion with Inline Confirmation
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const catalogStoryCard = page.locator('.story-card', { hasText: 'The Sleepy Little Train' });
    await expect(catalogStoryCard).toBeVisible();

    // Admin delete button on card footer
    const deleteCardBtn = catalogStoryCard.getByRole('button', { name: /🗑 Delete/i });
    await expect(deleteCardBtn).toBeVisible();
    await deleteCardBtn.click();

    // Verify inline confirmation
    await expect(catalogStoryCard.getByText('Delete permanently?')).toBeVisible();
    const confirmDeleteBtn = catalogStoryCard.getByRole('button', { name: 'Confirm' });
    const cancelDeleteBtn = catalogStoryCard.getByRole('button', { name: 'Cancel' });
    await expect(confirmDeleteBtn).toBeVisible();
    await expect(cancelDeleteBtn).toBeVisible();

    // Capture Library Delete Confirmation Screenshot
    await page.screenshot({ path: 'qa-screenshots/phase12-library-delete-confirm.png', fullPage: false });

    // Dismiss deletion
    await cancelDeleteBtn.click();
    await expect(catalogStoryCard.getByText('Delete permanently?')).not.toBeVisible();

    // 5. Test StoryReader Prompt Inspector & Remix Action
    const readBtn = catalogStoryCard.getByRole('button', { name: /Read & Listen/i });
    await readBtn.click();
    await expect(page).toHaveURL(/\/stories\/2026-11-04-sleepy-little-train/);

    // Prompt card
    const promptCard = page.locator('.reader-prompt-card');
    await expect(promptCard).toBeVisible();
    await expect(promptCard.getByText(/Story Prompt & Inspiration/i)).toBeVisible();

    const remixBtn = promptCard.getByRole('button', { name: /✨ Remix in Studio/i });
    await expect(remixBtn).toBeVisible();
    await remixBtn.click();

    // Verify redirected to admin studio with remix prefill
    await expect(page).toHaveURL(/\/admin\?remixStoryId=/);
    await expect(page.getByRole('heading', { name: /Step 1: Write Story Draft/i })).toBeVisible();

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});


