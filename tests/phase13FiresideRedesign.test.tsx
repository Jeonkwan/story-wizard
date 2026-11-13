// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Masthead } from '../client/components/Masthead';
import { DirectorStudio } from '../client/components/DirectorStudio';
import * as clientApi from '../client/api/client';
import type { Story, CatalogItem } from '../shared/types';

// Standard clean Storage mock for jsdom environment under Node 22
const memoryStore = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key: string) => memoryStore.get(key) ?? null,
  setItem: (key: string, val: string) => memoryStore.set(key, String(val)),
  removeItem: (key: string) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
  get length() {
    return memoryStore.size;
  },
  key: (index: number) => Array.from(memoryStore.keys())[index] ?? null,
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
  writable: true,
});
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
}

describe('Phase 13: Fireside Espresso & Daylight Latte Theme System', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme');
  });

  it('initializes Masthead with Dark-First default (Fireside Espresso) when localStorage is empty', () => {
    render(<Masthead />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.body.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('story_theme')).toBe('dark');

    const toggleBtn = screen.getByRole('button', { name: /switch to light mode/i });
    expect(toggleBtn).toBeInTheDocument();
  });

  it('respects saved light theme from localStorage if previously chosen', () => {
    localStorage.setItem('story_theme', 'light');

    render(<Masthead />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('story_theme')).toBe('light');

    const toggleBtn = screen.getByRole('button', { name: /switch to dark mode/i });
    expect(toggleBtn).toBeInTheDocument();
  });

  it('toggles deterministically between dark and light, keeping documentElement and body in sync', () => {
    render(<Masthead />);

    // Starts dark
    expect(document.body.getAttribute('data-theme')).toBe('dark');
    const toggleBtn = screen.getByRole('button', { name: /switch to light mode/i });

    // Click 1 -> switches to light
    fireEvent.click(toggleBtn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('story_theme')).toBe('light');

    // Click 2 -> switches back to dark
    fireEvent.click(toggleBtn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.body.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('story_theme')).toBe('dark');
  });
});

describe('Phase 13: DirectorStudio Compact Mobile Ergonomics & Drawer', () => {
  const mockStories: CatalogItem[] = [
    {
      id: 'story-1-orbit',
      title: 'The Orbiting Otter',
      summary: 'An otter launches an acorn into orbit.',
      tags: ['space', 'otter'],
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
      series_id: null,
      episode_number: null,
      default_audio_url: null,
      audio_versions_count: 0,
      status: 'draft',
    },
    {
      id: 'story-2-lantern',
      title: 'The Whispering Lantern',
      summary: 'A glowing lantern guides lost fireflies.',
      tags: ['bedtime', 'magic'],
      created_at: '2026-11-02T00:00:00.000Z',
      updated_at: '2026-11-02T00:00:00.000Z',
      series_id: null,
      episode_number: null,
      default_audio_url: null,
      audio_versions_count: 0,
      status: 'published',
    },
  ];

  const mockStoryDetail: Story = {
    id: 'story-1-orbit',
    title: 'The Orbiting Otter',
    summary: 'An otter launches an acorn into orbit.',
    tags: ['space', 'otter'],
    status: 'draft',
    series_context: null,
    characters: [{ name: 'Ollie', traits: 'enthusiastic astronaut' }],
    script_turns: [
      {
        turn_id: 1,
        speaker: 'Narrator',
        text: 'Ollie the otter adjusted his bubble helmet with utmost precision.',
        style: 'Warm bedtime cadence',
      },
      {
        turn_id: 2,
        speaker: 'Ollie',
        text: 'Three, two, one, splashdown among the stars!',
        style: 'Playful excitement',
      },
    ],
    voice_candidates: [],
    audio_versions: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue(mockStories);
    vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(mockStoryDetail);
    vi.spyOn(clientApi, 'fetchActiveJobs').mockResolvedValue([]);
    vi.spyOn(clientApi, 'fetchRecentJobs').mockResolvedValue([]);
    vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders sticky mobile topbar with stories drawer button and 3-step switcher', async () => {
    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    const drawerTrigger = screen.getByTestId('mobile-stories-drawer-btn');
    expect(drawerTrigger).toBeInTheDocument();
    expect(drawerTrigger).toHaveTextContent(/Stories \(2\)/i);

    const step1Draft = screen.getByTestId('mobile-step-draft');
    const step2Script = screen.getByTestId('mobile-step-script');
    const step3Voices = screen.getByTestId('mobile-step-voices');

    expect(step1Draft).toBeInTheDocument();
    expect(step2Script).toBeInTheDocument();
    expect(step3Voices).toBeInTheDocument();

    // In initial create mode (no active story selected):
    expect(step1Draft).toHaveAttribute('aria-pressed', 'true');
    expect(step2Script).toBeDisabled();
    expect(step3Voices).toBeDisabled();
  });

  it('opens and closes the slide-up Story Archive Drawer', async () => {
    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    const drawerTrigger = screen.getByTestId('mobile-stories-drawer-btn');
    // Initially drawer is not visible
    expect(screen.queryByTestId('close-stories-drawer-btn')).not.toBeInTheDocument();

    // Click trigger to open drawer
    fireEvent.click(drawerTrigger);
    const closeBtn = screen.getByTestId('close-stories-drawer-btn');
    expect(closeBtn).toBeInTheDocument();

    // Verify stories are listed in drawer
    expect(screen.getByTestId('drawer-story-item-story-1-orbit')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-story-item-story-2-lantern')).toBeInTheDocument();

    // Click close button
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId('close-stories-drawer-btn')).not.toBeInTheDocument();
  });

  it('selecting a story in the drawer loads it into workbench, auto-closes drawer and switches to step 2', async () => {
    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    const drawerTrigger = screen.getByTestId('mobile-stories-drawer-btn');
    fireEvent.click(drawerTrigger);

    const storyItem = screen.getByTestId('drawer-story-item-story-1-orbit');
    await act(async () => {
      fireEvent.click(storyItem);
    });

    // Drawer auto-closed
    expect(screen.queryByTestId('close-stories-drawer-btn')).not.toBeInTheDocument();

    // Story loaded and active step switches to script
    await waitFor(() => {
      expect(screen.getByTestId('mobile-step-script')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('mobile-step-script')).not.toBeDisabled();
      expect(screen.getByTestId('mobile-step-voices')).not.toBeDisabled();
    });

    // Workbench panel is rendered with id="step-2-panel"
    expect(document.getElementById('step-2-panel')).toBeInTheDocument();
  });

  it('switches between Step 1 Draft, Step 2 Script, and Step 3 Voices via mobile step buttons', async () => {
    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    // Load story into workbench
    const drawerTrigger = screen.getByTestId('mobile-stories-drawer-btn');
    fireEvent.click(drawerTrigger);
    await act(async () => {
      fireEvent.click(screen.getByTestId('drawer-story-item-story-1-orbit'));
    });

    const step1Draft = screen.getByTestId('mobile-step-draft');
    const step2Script = screen.getByTestId('mobile-step-script');
    const step3Voices = screen.getByTestId('mobile-step-voices');

    // Switch to Voices (Step 3)
    await act(async () => {
      fireEvent.click(step3Voices);
    });
    expect(step3Voices).toHaveAttribute('aria-pressed', 'true');
    expect(document.getElementById('step-3-panel')).toBeInTheDocument();

    // Switch to Draft (Step 1)
    await act(async () => {
      fireEvent.click(step1Draft);
    });
    expect(step1Draft).toHaveAttribute('aria-pressed', 'true');
    expect(document.getElementById('step-1-panel')).toBeInTheDocument();

    // Switch back to Script (Step 2)
    await act(async () => {
      fireEvent.click(step2Script);
    });
    expect(step2Script).toHaveAttribute('aria-pressed', 'true');
    expect(document.getElementById('step-2-panel')).toBeInTheDocument();
  });

  it('keeps continuity accordion open by default so optional lore and slug are accessible without interaction', async () => {
    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    const continuityDetails = document.querySelector('.continuity-accordion');
    expect(continuityDetails).toBeInTheDocument();
    expect(continuityDetails).toHaveAttribute('open');

    // Input fields are queryable without { hidden: true }
    const seriesInput = screen.getByPlaceholderText(/space-mechanics-adventures/i);
    expect(seriesInput).toBeVisible();

    const loreTextarea = screen.getByPlaceholderText(/optional world details/i);
    expect(loreTextarea).toBeVisible();
  });
});
