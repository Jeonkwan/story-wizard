// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { AudioVersion, CatalogItem, Story } from '../shared/types';
import { StoryReader } from '../client/components/StoryReader';
import { StoryCatalog } from '../client/components/StoryCatalog';
import { AudioPlayerBar } from '../client/components/AudioPlayerBar';
import { Masthead } from '../client/components/Masthead';

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

describe('Phase 2 UI Component Tests', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    memoryStore.clear();
  });

  const baseStoryFixture: Story = {
    id: '2026-11-04-sleepy-little-train',
    status: 'published',
    title: 'The Sleepy Little Train',
    summary: 'A cozy little blue train journeys up the misty hillside under a sleepy crescent moon.',
    tags: ['bedtime', 'train', 'soothing'],
    series_context: {
      series_id: 'little-tram-adventures',
      episode_number: 1,
      preferred_voice_id: 'prebuilt-kore',
    },
    characters: [
      {
        name: 'Bibi',
        traits: 'Gentle bell chime whistle, curious and sleepy little locomotive',
      },
    ],
    script_turns: [
      {
        turn_id: 1,
        speaker: 'Narrator',
        style: 'Warm, gentle bedtime storytelling tone',
        text: 'Once upon a time, at the edge of the quiet whispering woods, there rested a cheerful little train (which was painted bright blue). <short pause> The silver moon climbed into the velvety evening sky.',
      },
      {
        turn_id: 2,
        speaker: 'Bibi',
        style: 'Sleepy, soft bell tone whistle',
        text: 'Puff-puff! Are we ready to climb the star mountain track tonight? <sigh>',
      },
      {
        turn_id: 3,
        speaker: 'Narrator',
        style: 'Soothing and peaceful',
        text: 'The pine trees softly swayed as the train wheels began to roll along the peaceful valley track.',
      },
    ],
    voice_candidates: [],
    audio_versions: [
      {
        version_id: 'v1-owl-solo',
        label: 'Grandpa Owl (Bedtime Solo)',
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {},
        },
        is_default: true,
        duration_sec: 120,
        audio_url: '/api/stories/2026-11-04-sleepy-little-train/audios/v1-owl-solo.wav',
        created_at: '2026-11-04T00:00:00.000Z',
      },
      {
        version_id: 'v2-aoede-solo',
        label: 'Aoede (Melodic Solo)',
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-aoede',
          character_voices: {},
        },
        is_default: false,
        duration_sec: 125,
        audio_url: '/api/stories/2026-11-04-sleepy-little-train/audios/v2-aoede-solo.wav',
        created_at: '2026-11-04T01:00:00.000Z',
      },
    ],
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
  };

  const catalogFixture: CatalogItem[] = [
    {
      id: '2026-11-04-sleepy-little-train',
      status: 'published',
      title: 'The Sleepy Little Train',
      summary: 'A cozy little blue train journeys up the misty hillside under a sleepy crescent moon.',
      tags: ['bedtime', 'train', 'soothing'],
      series_id: 'little-tram-adventures',
      episode_number: 1,
      created_at: '2026-11-04T00:00:00.000Z',
      updated_at: '2026-11-04T00:00:00.000Z',
      default_audio_url: '/api/stories/2026-11-04-sleepy-little-train/audios/v1-owl-solo.wav',
      audio_versions_count: 2,
    },
    {
      id: '2026-11-05-starry-night-owl',
      status: 'published',
      title: 'The Starry Night Owl',
      summary: 'A wise old owl perches in the ancient oak tree counting constellations.',
      tags: ['bedtime', 'owl', 'stars'],
      series_id: null,
      episode_number: null,
      created_at: '2026-11-05T00:00:00.000Z',
      updated_at: '2026-11-05T00:00:00.000Z',
      default_audio_url: '/api/stories/2026-11-05-starry-night-owl/audios/v1-kore.wav',
      audio_versions_count: 1,
    },
    {
      id: '2026-11-06-ocean-drifter',
      status: 'published',
      title: 'Ocean Drifter',
      summary: 'A tiny paper boat sails gently over calm glassy waves.',
      tags: ['ocean', 'water', 'calm'],
      series_id: null,
      episode_number: null,
      created_at: '2026-11-06T00:00:00.000Z',
      updated_at: '2026-11-06T00:00:00.000Z',
      default_audio_url: null,
      audio_versions_count: 0,
    },
  ];

  // Gate Test 1: StoryReader tag stripping & character badge
  it('StoryReader hides <short pause> / <sigh> while rendering (which was painted bright blue) AND speaker badge "Bibi"', () => {
    render(<StoryReader story={baseStoryFixture} onBack={() => {}} />);

    // Prose parentheses MUST be preserved
    expect(screen.getByText(/which was painted bright blue/i)).toBeInTheDocument();

    // Vocal tags MUST be stripped from reader display
    expect(screen.queryByText(/<short pause>/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/<sigh>/i)).not.toBeInTheDocument();

    // Speaker badge for Bibi MUST be rendered
    const speakerBadge = screen.getByText('Bibi');
    expect(speakerBadge).toBeInTheDocument();
    expect(speakerBadge).toHaveClass('speaker-badge');
  });

  // Gate Test 2: StoryCatalog search input and tag pill filtering
  it('Search input + tag pill filtering in StoryCatalog filters multi-story fixtures accurately', () => {
    render(<StoryCatalog catalog={catalogFixture} onSelectStory={() => {}} />);

    // Initial render shows all 3 stories
    expect(screen.getByText('The Sleepy Little Train')).toBeInTheDocument();
    expect(screen.getByText('The Starry Night Owl')).toBeInTheDocument();
    expect(screen.getByText('Ocean Drifter')).toBeInTheDocument();

    // Search filter test: type "owl"
    const searchInput = screen.getByLabelText(/Search stories/i);
    fireEvent.change(searchInput, { target: { value: 'owl' } });

    expect(screen.getByText('The Starry Night Owl')).toBeInTheDocument();
    expect(screen.queryByText('The Sleepy Little Train')).not.toBeInTheDocument();
    expect(screen.queryByText('Ocean Drifter')).not.toBeInTheDocument();

    // Clear search filter
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByText('The Sleepy Little Train')).toBeInTheDocument();

    // Tag filter pill test: click "#train"
    const trainTagPill = screen.getByRole('button', { name: /#train/i });
    fireEvent.click(trainTagPill);

    expect(screen.getByText('The Sleepy Little Train')).toBeInTheDocument();
    expect(screen.queryByText('The Starry Night Owl')).not.toBeInTheDocument();
    expect(screen.queryByText('Ocean Drifter')).not.toBeInTheDocument();

    // Click "#bedtime": matches both train and owl stories
    const bedtimeTagPill = screen.getByRole('button', { name: /#bedtime/i });
    fireEvent.click(bedtimeTagPill);

    expect(screen.getByText('The Sleepy Little Train')).toBeInTheDocument();
    expect(screen.getByText('The Starry Night Owl')).toBeInTheDocument();
    expect(screen.queryByText('Ocean Drifter')).not.toBeInTheDocument();

    // Reset to "All"
    const allTagPill = screen.getByRole('button', { name: /All/i });
    fireEvent.click(allTagPill);
    expect(screen.getByText('Ocean Drifter')).toBeInTheDocument();
  });

  // Gate Test 3: AudioPlayerBar version selector updates audio src
  it("Switching the Audio Version <select> in AudioPlayerBar updates <audio>'s src attribute to the chosen version's audio_url", () => {
    function AudioPlayerHarness() {
      const [activeVer, setActiveVer] = useState<AudioVersion>(baseStoryFixture.audio_versions[0]);
      return (
        <AudioPlayerBar
          story={baseStoryFixture}
          activeVersion={activeVer}
          onVersionChange={(ver) => setActiveVer(ver)}
        />
      );
    }

    const { container } = render(<AudioPlayerHarness />);

    const audioElement = container.querySelector('audio');
    expect(audioElement).not.toBeNull();
    expect(audioElement?.getAttribute('src')).toBe(
      '/api/stories/2026-11-04-sleepy-little-train/audios/v1-owl-solo.wav'
    );

    const versionSelect = screen.getByLabelText(/Audio Version/i);
    expect(versionSelect).toHaveValue('v1-owl-solo');

    // Switch version to v2-aoede-solo
    fireEvent.change(versionSelect, { target: { value: 'v2-aoede-solo' } });

    expect(audioElement?.getAttribute('src')).toBe(
      '/api/stories/2026-11-04-sleepy-little-train/audios/v2-aoede-solo.wav'
    );
  });

  // Gate Test 4: Dark Mode toggle sets data-theme="dark" on document.body
  it('Clicking the Dark Mode toggle sets data-theme="dark" on document.body', () => {
    expect(document.body.getAttribute('data-theme')).not.toBe('dark');

    render(<Masthead />);

    const toggleButton = screen.getByRole('button', { name: /Dark Mode|Light Mode/i });
    fireEvent.click(toggleButton);

    expect(document.body.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('story_theme')).toBe('dark');

    // Click again to toggle back to light mode
    fireEvent.click(toggleButton);
    expect(document.body.getAttribute('data-theme')).not.toBe('dark');
    expect(localStorage.getItem('story_theme')).toBe('light');
  });
});
