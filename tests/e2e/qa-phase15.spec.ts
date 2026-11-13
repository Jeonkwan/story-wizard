import { test, expect } from '@playwright/test';

test.describe('Phase 15: Fire-and-Go Background Generation, Durable Job History & Activity Tray', () => {
  test('verifies activity tray running state, queue another button, completed state in light mode, mobile responsive layout, and captures screenshots', async ({
    page,
    context,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write', 'notifications']).catch(() => {});

    // Mock Google accounts / fonts if requested
    await page.route('https://accounts.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } };',
      });
    });

    // =========================================================================
    // 1. Desktop Viewport (1440x900): In-Flight Background Job & Activity Tray (Dark Mode)
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });

    // Mock active background job in jobs endpoint
    const mockRunningJob = {
      job_id: 'job-phase15-qa-running',
      story_id: 'new',
      type: 'draft',
      status: 'running',
      started_at: new Date(Date.now() - 14_000).toISOString(),
      elapsed_seconds: 14,
      title: 'A Gentle Dragon in the Whispering Forest',
      stage: 'drafting',
      message: 'Drafting story with Gemini 3.8 Flash... (14s)',
    };

    // Route /api/admin/jobs to return the in-flight job
    await page.route(/\/api\/admin\/jobs(\?.*)?$/, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jobs: [mockRunningJob] }),
        });
      }
      return route.continue();
    });

    // Route /api/admin/jobs/active to return running draft
    await page.route(/\/api\/admin\/jobs\/active(\?.*)?$/, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activeJobs: [mockRunningJob] }),
      });
    });

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
    const themeBtn = page.getByRole('button', { name: /Dark Mode|Light Mode/i });
    const isDark = (await page.locator('body').getAttribute('data-theme')) === 'dark';
    if (!isDark) {
      await themeBtn.click();
      await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
    }

    // Verify Activity Tray is rendered
    const activityTray = page.locator('[data-testid="generation-activity-tray"]');
    await expect(activityTray).toBeVisible();
    await expect(activityTray.getByText('Generation Activity')).toBeVisible();
    await expect(activityTray.getByText('⏳ Running')).toBeVisible();
    await expect(activityTray.getByText('A Gentle Dragon in the Whispering Forest')).toBeVisible();

    // Verify sidebar shows synthetic GENERATING card
    const syntheticItem = page.locator('.studio-story-item', { hasText: 'GENERATING' });
    await expect(syntheticItem).toBeVisible();
    await expect(syntheticItem.getByText('A Gentle Dragon in the Whispering Forest')).toBeVisible();

    // Verify Step 1 progress card and "+ Queue Another Story" button
    const queueAnotherBtn = page.locator('[data-testid="queue-another-story-btn"]');
    await expect(queueAnotherBtn).toBeVisible();
    await expect(page.getByText(/Running in the background — you can safely switch stories, queue another, or close this tab/i)).toBeVisible();

    // Verify sidebar stories, + New Story, and Public Library remain UNLOCKED
    const newStoryBtn = page.getByRole('button', { name: /➕ New Story/i });
    await expect(newStoryBtn).toBeEnabled();
    const publicLibBtn = page.getByRole('button', { name: /← Public Library/i });
    await expect(publicLibBtn).toBeEnabled();

    // Capture Screenshot 1: Activity Tray Running (Dark Mode, 1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase15-activity-tray-running-dark.png', fullPage: false });

    // Click "+ Queue Another Story" button and verify form resets while tray continues tracking
    await queueAnotherBtn.click();
    const promptTextarea = page.getByPlaceholder(/A comedic sci-fi adventure/i);
    await expect(promptTextarea).toBeVisible();
    await expect(promptTextarea).toBeEnabled();
    await expect(activityTray).toBeVisible();

    // =========================================================================
    // 2. Desktop Viewport (1440x900): Completed Job Row in Light Mode (Open Story → & Dismiss)
    // =========================================================================
    const mockCompletedJob = {
      job_id: 'job-phase15-qa-comp',
      story_id: '2026-11-04-sleepy-little-train',
      result_story_id: '2026-11-04-sleepy-little-train',
      type: 'draft',
      status: 'completed',
      started_at: new Date(Date.now() - 30_000).toISOString(),
      finished_at: new Date(Date.now() - 5_000).toISOString(),
      elapsed_seconds: 25,
      title: 'The Sleepy Little Train',
      stage: 'completed',
      message: 'Drafting, directing & audio synthesis complete!',
    };

    // Update jobs endpoint mock to return completed job
    await page.route(/\/api\/admin\/jobs(\?.*)?$/, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jobs: [mockCompletedJob] }),
        });
      }
      return route.continue();
    });
    await page.route(/\/api\/admin\/jobs\/active(\?.*)?$/, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activeJobs: [] }),
      });
    });

    // Mock DELETE /api/admin/jobs/:jobId
    await page.route(/\/api\/admin\/jobs\/[^/?]+$/, (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.continue();
    });

    // Switch to Light Mode
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');

    // Wait for activity tray to poll and show completed job
    await expect(activityTray.getByText('✓ Ready')).toBeVisible();
    await expect(activityTray.getByText('The Sleepy Little Train')).toBeVisible();
    const openStoryBtn = activityTray.getByRole('button', { name: /Open Story →/i });
    await expect(openStoryBtn).toBeVisible();
    const dismissBtn = activityTray.getByTitle(/Dismiss job/i);
    await expect(dismissBtn).toBeVisible();

    // Capture Screenshot 2: Activity Tray Completed (Light Mode, 1440x900)
    await page.screenshot({ path: 'qa-screenshots/phase15-activity-tray-completed-light.png', fullPage: false });

    // Test Open Story button
    await openStoryBtn.click();
    await expect(page.locator('.storybook-preview-pane')).toBeVisible();

    // =========================================================================
    // 3. Mobile Viewport (375x812): Activity Tray in Dark Mode
    // =========================================================================
    // Switch back to Dark Mode
    await themeBtn.click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');

    // Mock both a running job and a completed job for mobile view
    const mockMobileJobs = [
      {
        job_id: 'job-mobile-run',
        story_id: 'new',
        type: 'draft',
        status: 'running',
        started_at: new Date(Date.now() - 8_000).toISOString(),
        elapsed_seconds: 8,
        title: 'Brave Firefly Adventures',
        stage: 'drafting',
        message: 'Drafting story with Gemini 3.8 Flash... (8s)',
      },
      {
        job_id: 'job-mobile-comp',
        story_id: '2026-11-04-sleepy-little-train',
        result_story_id: '2026-11-04-sleepy-little-train',
        type: 'direct',
        status: 'completed',
        started_at: new Date(Date.now() - 40_000).toISOString(),
        finished_at: new Date(Date.now() - 10_000).toISOString(),
        elapsed_seconds: 16,
        title: 'The Sleepy Little Train',
        stage: 'completed',
        message: 'Directing complete!',
      },
    ];

    await page.route(/\/api\/admin\/jobs(\?.*)?$/, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jobs: mockMobileJobs }),
        });
      }
      return route.continue();
    });
    await page.route(/\/api\/admin\/jobs\/active(\?.*)?$/, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activeJobs: [mockMobileJobs[0]] }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Verify activity tray visible in mobile layout
    await expect(activityTray).toBeVisible();
    await expect(activityTray.getByText('Brave Firefly Adventures')).toBeVisible();
    await expect(activityTray.getByText('The Sleepy Little Train')).toBeVisible();

    // Verify zero horizontal scrollbar overflow
    const hasNoHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth <= window.innerWidth;
    });
    expect(hasNoHorizontalOverflow).toBe(true);

    // Capture Screenshot 3: Mobile Activity Tray (Dark Mode, 375x812)
    await page.screenshot({ path: 'qa-screenshots/phase15-mobile-activity-tray-dark.png', fullPage: false });

    // Verify zero page errors
    expect(pageErrors).toEqual([]);
  });
});
