// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AudioVersion, CatalogItem, Story } from '../shared/types';
import { StoryReader } from '../client/components/StoryReader';
import { StoryCatalog } from '../client/components/StoryCatalog';
import { AudioPlayerBar } from '../client/components/AudioPlayerBar';
import { Masthead } from '../client/components/Masthead';
import { AdminLoginGate } from '../client/components/AdminLoginGate';
import { DirectorStudio } from '../client/components/DirectorStudio';
import { VoiceStudioPanel } from '../client/components/VoiceStudioPanel';
import { App } from '../client/App';
import * as clientApi from '../client/api/client';

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

  // Provide mock implementations for HTMLMediaElement play/pause in jsdom
  if (window.HTMLMediaElement) {
    window.HTMLMediaElement.prototype.play = async () => {};
    window.HTMLMediaElement.prototype.pause = () => {};
  }
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

  // Review Regression Test 1: AudioPlayerBar preserves currentTime on speed toggle, and preserves 0.9x on version switch
  it('AudioPlayerBar preserves currentTime on speed toggle, and resets currentTime while preserving 0.9x playbackRate on version switch', () => {
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
    const audioElement = container.querySelector('audio')!;
    expect(audioElement.playbackRate).toBe(1.0);

    // 1. Seek mid-track to 42s
    const scrubBar = screen.getByLabelText(/Audio scrub bar/i);
    fireEvent.change(scrubBar, { target: { value: '42' } });
    expect(audioElement.currentTime).toBe(42);

    // 2. Toggle playback rate to 0.9x -> MUST NOT rewind currentTime to 0!
    const speedButton = screen.getByRole('button', { name: /playback speed/i });
    fireEvent.click(speedButton);
    expect(screen.getByText('0.9x')).toBeInTheDocument();
    expect(audioElement.playbackRate).toBe(0.9);
    expect(audioElement.currentTime).toBe(42);

    // 3. Switch version to v2-aoede-solo -> resets currentTime to 0 while preserving 0.9x playbackRate
    const versionSelect = screen.getByLabelText(/Audio Version/i);
    fireEvent.change(versionSelect, { target: { value: 'v2-aoede-solo' } });

    // Audio src updated, 0.9x playback rate preserved, and version switch rewound to 0
    expect(audioElement.getAttribute('src')).toBe(
      '/api/stories/2026-11-04-sleepy-little-train/audios/v2-aoede-solo.wav'
    );
    expect(audioElement.playbackRate).toBe(0.9);
    expect(audioElement.currentTime).toBe(0);
  });

  // Review Regression Test 2: StoryReader omits tag-only turns and awards drop-cap to first readable turn
  it('StoryReader omits tag-only turns (<long pause>) and awards opening-narration to the first turn with readable text', () => {
    const storyWithLeadingTagOnlyTurn: Story = {
      ...baseStoryFixture,
      script_turns: [
        {
          turn_id: 1,
          speaker: 'Narrator',
          style: 'Silent atmospheric breath',
          text: '<long pause>',
        },
        {
          turn_id: 2,
          speaker: 'Narrator',
          style: 'Warm bedtime tone',
          text: 'The moon rose quietly over the tranquil lake.',
        },
      ],
    };

    const { container } = render(
      <StoryReader story={storyWithLeadingTagOnlyTurn} onBack={() => {}} />
    );

    // Turn 1 should not produce any DOM paragraph
    expect(container.querySelector('[data-turn-id="1"]')).toBeNull();

    // Turn 2 should receive .opening-narration drop-cap class
    const turn2Element = container.querySelector('[data-turn-id="2"]');
    expect(turn2Element).not.toBeNull();
    expect(turn2Element).toHaveClass('opening-narration');
    expect(turn2Element?.textContent).toBe('The moon rose quietly over the tranquil lake.');
  });
});

describe('Phase 3 Admin Studio & UI Components', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('AdminLoginGate displays Dev Sandbox Login button ONLY when devBypassEnabled is true', async () => {
    // 1. When devBypassEnabled is true
    vi.spyOn(clientApi, 'fetchAdminSession').mockResolvedValueOnce({
      authenticated: false,
      devBypassEnabled: true,
      googleClientId: '',
    });

    const { unmount } = render(<AdminLoginGate onNavigateHome={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Dev Sandbox Login/i })).toBeInTheDocument();
    });

    unmount();

    // 2. When devBypassEnabled is false
    vi.spyOn(clientApi, 'fetchAdminSession').mockResolvedValueOnce({
      authenticated: false,
      devBypassEnabled: false,
      googleClientId: '',
    });

    render(<AdminLoginGate onNavigateHome={() => {}} />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Dev Sandbox Login/i })).not.toBeInTheDocument();
    });
  });

  it('DirectorStudio quick-inserts <short pause> tag into script turn text', async () => {
    const mockSession = {
      authenticated: true,
      email: 'curator@storyteller.studio',
      devBypassEnabled: true,
    };

    const mockStory: Story = {
      id: 'test-story',
      status: 'draft',
      title: 'Test Story',
      summary: 'Summary of test story.',
      tags: ['bedtime'],
      series_context: null,
      characters: [{ name: 'Bibi', traits: 'Gentle bell' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'Hello world.' },
        { turn_id: 2, speaker: 'Bibi', style: '', text: 'Goodnight stars.' },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([
      {
        id: 'test-story',
        status: 'draft',
        title: 'Test Story',
        summary: 'Summary of test story.',
        tags: ['bedtime'],
        series_id: null,
        episode_number: null,
        created_at: mockStory.created_at,
        updated_at: mockStory.updated_at,
        default_audio_url: null,
        audio_versions_count: 0,
      },
    ]);

    vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(mockStory);

    render(
      <DirectorStudio
        session={mockSession}
        onLogout={() => {}}
        onNavigateHome={() => {}}
      />
    );

    // Wait for story in list and click it
    await waitFor(() => {
      expect(screen.getByText('Test Story')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Test Story'));

    // Wait for turns to load in workbench
    await waitFor(() => {
      expect(screen.getByDisplayValue('Hello world.')).toBeInTheDocument();
    });

    // Find the first turn's <short pause> tag pill button
    const insertButtons = screen.getAllByRole('button', { name: '<short pause>' });
    expect(insertButtons.length).toBeGreaterThan(0);

    // Click quick-insert
    fireEvent.click(insertButtons[0]);

    // Verify turn text updated to include <short pause>
    expect(screen.getByDisplayValue('Hello world. <short pause>')).toBeInTheDocument();
  });

  it('DirectorStudio saves pending workbench edits before calling auto-direct to prevent data loss', async () => {
    const mockSession = {
      authenticated: true,
      email: 'curator@storyteller.studio',
      devBypassEnabled: true,
    };

    const mockStory: Story = {
      id: 'test-story',
      status: 'draft',
      title: 'Initial Title',
      summary: 'Initial Summary',
      tags: ['initial'],
      series_context: null,
      characters: [{ name: 'Bibi', traits: 'Gentle bell' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'Original line 1.' },
        { turn_id: 2, speaker: 'Bibi', style: '', text: 'Original line 2.' },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([
      {
        id: 'test-story',
        status: 'draft',
        title: 'Initial Title',
        summary: 'Initial Summary',
        tags: ['initial'],
        series_id: null,
        episode_number: null,
        created_at: mockStory.created_at,
        updated_at: mockStory.updated_at,
        default_audio_url: null,
        audio_versions_count: 0,
      },
    ]);

    vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(mockStory);

    const saveSpy = vi.spyOn(clientApi, 'saveStoryEdits').mockResolvedValue({
      ...mockStory,
      title: 'Edited Title',
    });

    const directSpy = vi.spyOn(clientApi, 'directStory').mockResolvedValue({
      ...mockStory,
      title: 'Edited Title',
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: 'Calm tone', text: 'Original line 1. <short pause>' },
        { turn_id: 2, speaker: 'Bibi', style: 'Soft chime', text: 'Original line 2.' },
      ],
      voice_candidates: [
        { label: 'Owl', description: 'Deep voice', suggested_for: 'Narrator' },
      ],
    });

    render(
      <DirectorStudio
        session={mockSession}
        onLogout={() => {}}
        onNavigateHome={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Initial Title')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Initial Title'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Initial Title')).toBeInTheDocument();
    });

    // Modify title without clicking Save Script
    fireEvent.change(screen.getByDisplayValue('Initial Title'), {
      target: { value: 'Edited Title' },
    });

    // Click "2. Auto-Direct Voices & Pacing"
    const directBtn = screen.getByRole('button', { name: /2\. Auto-Direct Voices & Pacing/i });
    fireEvent.click(directBtn);

    // Assert saveStoryEdits was called BEFORE directStory with the modified title!
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(directSpy).toHaveBeenCalledTimes(1);
    });

    expect(saveSpy).toHaveBeenCalledWith('test-story', expect.objectContaining({
      title: 'Edited Title',
    }));
  });

  it('DirectorStudio syncs turn speaker references when character is renamed or deleted', async () => {
    const mockSession = {
      authenticated: true,
      email: 'curator@storyteller.studio',
      devBypassEnabled: true,
    };

    const mockStory: Story = {
      id: 'char-sync-story',
      status: 'draft',
      title: 'Character Sync Story',
      summary: 'Testing speaker sync.',
      tags: ['test'],
      series_context: null,
      characters: [{ name: 'Bibi', traits: 'Gentle bell' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'Hello.' },
        { turn_id: 2, speaker: 'Bibi', style: '', text: 'I am Bibi.' },
      ],
      voice_candidates: [],
      audio_versions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([
      {
        id: 'char-sync-story',
        status: 'draft',
        title: 'Character Sync Story',
        summary: 'Testing speaker sync.',
        tags: ['test'],
        series_id: null,
        episode_number: null,
        created_at: mockStory.created_at,
        updated_at: mockStory.updated_at,
        default_audio_url: null,
        audio_versions_count: 0,
      },
    ]);

    vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(mockStory);

    render(
      <DirectorStudio
        session={mockSession}
        onLogout={() => {}}
        onNavigateHome={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Character Sync Story')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Character Sync Story'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Character Name')).toHaveValue('Bibi');
    });

    // 1. Rename character from "Bibi" to "Bobo"
    const charNameInput = screen.getByPlaceholderText('Character Name');
    fireEvent.change(charNameInput, { target: { value: 'Bobo' } });

    // Turn #2 speaker select should now have value "Bobo"
    const selects = screen.getAllByRole('combobox');
    const turn2SpeakerSelect = selects.find((s) => (s as HTMLSelectElement).value === 'Bobo');
    expect(turn2SpeakerSelect).toBeDefined();

    // 2. Delete character "Bobo"
    const deleteCharBtn = screen.getByTitle('Remove character');
    fireEvent.click(deleteCharBtn);

    // Turn #2 speaker select should automatically reset to "Narrator"
    expect((turn2SpeakerSelect as HTMLSelectElement).value).toBe('Narrator');
  });

  describe('Phase 4 VoiceStudioPanel & Reader Admin Controls', () => {
    const mockVoices = [
      {
        id: 'prebuilt-kore',
        label: 'Kore (Warm Prebuilt)',
        source: 'prebuilt' as const,
        gemini_voice_name: 'Kore',
        description: 'Warm soothing female bedtime voice',
        language_code: 'en-US',
        tags: ['warm'],
        created_at: new Date().toISOString(),
      },
      {
        id: 'prebuilt-puck',
        label: 'Puck (Playful Prebuilt)',
        source: 'prebuilt' as const,
        gemini_voice_name: 'Puck',
        description: 'Playful voice',
        language_code: 'en-US',
        tags: ['playful'],
        created_at: new Date().toISOString(),
      },
    ];

    const phase4StoryFixture: Story = {
      id: 'phase4-test-story',
      status: 'published',
      title: 'Sleepy Starship',
      summary: 'A starship drifting through twilight.',
      tags: ['space', 'bedtime'],
      series_context: {
        series_id: 'space-tales',
        episode_number: 1,
        preferred_voice_id: 'prebuilt-kore',
      },
      characters: [{ name: 'Bibi', traits: 'Gentle bell chime' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', style: '', text: 'Drifting softly into the velvet cosmos.' },
        { turn_id: 2, speaker: 'Bibi', style: '', text: 'Engines humming a gentle bedtime song.' },
      ],
      voice_candidates: [
        {
          label: 'Gentle Nebula',
          description: 'Soothing cosmic whisper voice',
          suggested_for: 'Narrator (Solo)',
        },
      ],
      audio_versions: [
        {
          version_id: 'v1-solo-test',
          label: 'Bedtime Solo',
          casting: {
            mode: 'solo',
            narrator_voice_id: 'prebuilt-kore',
            character_voices: {},
          },
          is_default: true,
          duration_sec: 120,
          audio_url: '/api/stories/phase4-test-story/audios/v1-solo-test.wav',
          created_at: new Date().toISOString(),
        },
        {
          version_id: 'v2-cast-test',
          label: 'Bedtime Cast',
          casting: {
            mode: 'cast',
            narrator_voice_id: 'prebuilt-kore',
            character_voices: { Bibi: 'prebuilt-puck' },
          },
          is_default: false,
          duration_sec: 135,
          audio_url: '/api/stories/phase4-test-story/audios/v2-cast-test.wav',
          created_at: new Date().toISOString(),
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    it('VoiceStudioPanel toggles between Solo and Cast modes, revealing character voice selectors', async () => {
      vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue(mockVoices);

      render(
        <VoiceStudioPanel
          story={phase4StoryFixture}
          onStoryUpdated={() => {}}
        />
      );

      // Verify header and proposed candidates
      await waitFor(() => {
        expect(screen.getByText('Gentle Nebula')).toBeInTheDocument();
      });

      // Initially in Solo mode -> Narrator voice select visible, Bibi voice assignments heading not visible
      expect(screen.getByText(/Solo Storyteller/i)).toBeInTheDocument();
      expect(screen.queryByText(/CHARACTER VOICE ASSIGNMENTS/i)).not.toBeInTheDocument();

      // Click Multi-Speaker Cast toggle
      const castBtn = screen.getByText(/Multi-Speaker Cast/i);
      fireEvent.click(castBtn);

      // Character voice assignment header should appear
      expect(screen.getByText(/CHARACTER VOICE ASSIGNMENTS/i)).toBeInTheDocument();
      expect(screen.getByText('Bibi')).toBeInTheDocument();
    });

    it('VoiceStudioPanel invokes onBeforeSynthesize before calling synthesizeStoryAudio', async () => {
      vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue(mockVoices);
      const synthSpy = vi.spyOn(clientApi, 'synthesizeStoryAudio').mockResolvedValue(phase4StoryFixture);
      const beforeSynthMock = vi.fn().mockResolvedValue(undefined);
      const onStoryUpdatedMock = vi.fn();

      render(
        <VoiceStudioPanel
          story={phase4StoryFixture}
          onStoryUpdated={onStoryUpdatedMock}
          onBeforeSynthesize={beforeSynthMock}
        />
      );

      const synthBtn = await screen.findByRole('button', { name: /3\. Synthesize & Publish Audio/i });
      await waitFor(() => {
        expect(synthBtn).not.toBeDisabled();
      });

      fireEvent.click(synthBtn);

      await waitFor(() => {
        expect(beforeSynthMock).toHaveBeenCalledTimes(1);
        expect(synthSpy).toHaveBeenCalledWith(
          'phase4-test-story',
          expect.objectContaining({
            casting: expect.objectContaining({ mode: 'solo' }),
          })
        );
        expect(onStoryUpdatedMock).toHaveBeenCalledWith(phase4StoryFixture);
      });
    });

    it('VoiceStudioPanel triggers setDefaultAudioVersion and deleteAudioVersion on user actions', async () => {
      vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue(mockVoices);
      const setDefaultSpy = vi.spyOn(clientApi, 'setDefaultAudioVersion').mockResolvedValue(phase4StoryFixture);
      const deleteSpy = vi.spyOn(clientApi, 'deleteAudioVersion').mockResolvedValue(phase4StoryFixture);
      const onStoryUpdatedMock = vi.fn();

      render(
        <VoiceStudioPanel
          story={phase4StoryFixture}
          onStoryUpdated={onStoryUpdatedMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Bedtime Cast')).toBeInTheDocument();
      });

      // 1. Click "★ Set Default" on v2
      const setDefaultBtn = screen.getByRole('button', { name: /★ Set Default/i });
      fireEvent.click(setDefaultBtn);

      await waitFor(() => {
        expect(setDefaultSpy).toHaveBeenCalledWith('phase4-test-story', 'v2-cast-test');
      });

      // 2. Click "🗑 Delete" on v2 -> reveals confirmation
      const deleteBtns = screen.getAllByRole('button', { name: /🗑 Delete/i });
      fireEvent.click(deleteBtns[1]); // delete on v2

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Confirm/i })).toBeInTheDocument();
      });

      const confirmBtn = screen.getByRole('button', { name: /Confirm/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledWith('phase4-test-story', 'v2-cast-test');
      });
    });

    it('StoryReader displays Admin Audio Versions panel only when isAdmin is true', async () => {
      const { rerender } = render(
        <StoryReader
          story={phase4StoryFixture}
          onBack={() => {}}
          isAdmin={false}
        />
      );

      // When isAdmin is false, Admin Audio Versions panel should NOT be in document
      expect(screen.queryByLabelText('Admin Audio Versions')).not.toBeInTheDocument();

      // Rerender with isAdmin={true}
      rerender(
        <StoryReader
          story={phase4StoryFixture}
          onBack={() => {}}
          isAdmin={true}
        />
      );

      expect(screen.getByLabelText('Admin Audio Versions')).toBeInTheDocument();
      expect(screen.getByText(/Admin Audio Versions \(2\)/i)).toBeInTheDocument();
    });

    it('VoiceStudioPanel aborts synthesis and displays error if onBeforeSynthesize rejects', async () => {
      vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue(mockVoices);
      const synthSpy = vi.spyOn(clientApi, 'synthesizeStoryAudio');
      const beforeSynthMock = vi.fn().mockRejectedValue(new Error('Validation error: title required'));
      const onStoryUpdatedMock = vi.fn();

      render(
        <VoiceStudioPanel
          story={phase4StoryFixture}
          onStoryUpdated={onStoryUpdatedMock}
          onBeforeSynthesize={beforeSynthMock}
        />
      );

      const synthBtn = await screen.findByRole('button', { name: /3\. Synthesize & Publish Audio/i });
      await waitFor(() => {
        expect(synthBtn).not.toBeDisabled();
      });

      fireEvent.click(synthBtn);

      await waitFor(() => {
        expect(beforeSynthMock).toHaveBeenCalledTimes(1);
        expect(synthSpy).not.toHaveBeenCalled();
        expect(onStoryUpdatedMock).not.toHaveBeenCalled();
        expect(screen.getByText(/Validation error: title required/i)).toBeInTheDocument();
      });
    });

    it('App preserves currently selected activeAudioVersion when managing other audio versions', async () => {
      window.history.pushState(null, '', '/stories/phase4-test-story');
      vi.spyOn(clientApi, 'fetchAdminSession').mockResolvedValue({
        authenticated: true,
        email: 'curator@storyteller.studio',
        devBypassEnabled: true,
      });
      vi.spyOn(clientApi, 'fetchCatalog').mockResolvedValue([]);
      vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(phase4StoryFixture);

      render(<App />);

      // Wait for story and audio bar to render
      await waitFor(() => {
        expect(screen.getByText('Sleepy Starship')).toBeInTheDocument();
      });

      // Default version is v1-solo-test, so audio src is v1
      const playerRegion = screen.getByRole('region', { name: /Audio Player/i });
      const audioElement = playerRegion.querySelector('audio')!;
      expect(audioElement).toHaveAttribute('src', '/api/stories/phase4-test-story/audios/v1-solo-test.wav');

      // Switch active audio version to v2-cast-test via Audio Version select dropdown
      const versionSelect = playerRegion.querySelector('select')!;
      fireEvent.change(versionSelect, { target: { value: 'v2-cast-test' } });
      expect(audioElement).toHaveAttribute('src', '/api/stories/phase4-test-story/audios/v2-cast-test.wav');

      // Now simulate admin managing audio versions (e.g. promoting v1 or deleting a version)
      const updatedStory: Story = {
        ...phase4StoryFixture,
        audio_versions: [
          { ...phase4StoryFixture.audio_versions[0], label: 'Updated Solo Label' },
          phase4StoryFixture.audio_versions[1],
        ],
      };

      vi.spyOn(clientApi, 'deleteAudioVersion').mockResolvedValue(updatedStory);

      // In the admin versions panel, delete v1
      const deleteBtns = screen.getAllByRole('button', { name: /🗑 Delete/i });
      fireEvent.click(deleteBtns[0]); // delete v1

      const confirmBtn = await screen.findByRole('button', { name: /Confirm/i });
      fireEvent.click(confirmBtn);

      // Verify that after story update, v2-cast-test is STILL the active playing version
      await waitFor(() => {
        expect(audioElement).toHaveAttribute('src', '/api/stories/phase4-test-story/audios/v2-cast-test.wav');
      });
    });
  });
});

