// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MicDictationButton,
  appendWithSmartSpace,
  getSupportedAudioMimeType,
} from '../client/components/MicDictationButton';
import {
  ExpandableFocusComposer,
  countWords,
} from '../client/components/ExpandableFocusComposer';
import { AudioPlayerBar } from '../client/components/AudioPlayerBar';
import { DirectorStudio } from '../client/components/DirectorStudio';
import * as clientApi from '../client/api/client';
import type { Story } from '../shared/types';

// Provide mock implementations for HTMLMediaElement in jsdom
if (typeof window !== 'undefined' && window.HTMLMediaElement) {
  window.HTMLMediaElement.prototype.play = async () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
}

// Mock MediaStream and MediaStreamTrack
class MockMediaStreamTrack {
  kind = 'audio';
  enabled = true;
  readyState = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[];
  constructor() {
    this.tracks = [new MockMediaStreamTrack()];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

// Mock MediaRecorder
class MockMediaRecorder {
  static isTypeSupported = vi.fn((type: string): boolean => {
    return type === 'audio/webm;codecs=opus' || type === 'audio/webm';
  });

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  stream: MockMediaStream;
  mimeType: string;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = options?.mimeType || 'audio/webm';
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({
        data: new Blob(['fake-audio-bytes'], { type: this.mimeType }),
      });
    }
    if (this.onstop) {
      this.onstop();
    }
  }
}

describe('Phase 10: Client API Layer & Helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('blobToBase64 converts blob data to base64 string', async () => {
    const testString = 'Hello Storyteller Multimodal Audio';
    const blob = new Blob([testString], { type: 'text/plain' });
    const b64 = await clientApi.blobToBase64(blob);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
    // Base64 decode check
    const decoded = atob(b64);
    expect(decoded).toBe(testString);
  });

  it('previewVoiceAudio reads X-Draft-Voice-Name header and returns blob + draft voice name', async () => {
    const mockBlob = new Blob(['RIFF....WAVE'], { type: 'audio/wav' });
    const mockHeaders = new Headers();
    mockHeaders.set('X-Draft-Voice-Name', 'voice_custom_staged_123');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      headers: mockHeaders,
      blob: async () => mockBlob,
    } as any);

    const result = await clientApi.previewVoiceAudio({
      description: 'Warm gentle owl voice',
      sampleText: 'Goodnight forest.',
    });

    expect(result.blob).toBe(mockBlob);
    expect(result.draftGeminiVoiceName).toBe('voice_custom_staged_123');
  });

  it('updateVoice calls PATCH /api/admin/voices/:id with payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'voice-owl', label: 'Grandpa Owl Updated' }),
    } as any);

    const updated = await clientApi.updateVoice('voice-owl', { label: 'Grandpa Owl Updated' });
    expect(updated.label).toBe('Grandpa Owl Updated');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/admin/voices/voice-owl',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Grandpa Owl Updated' }),
      })
    );
  });

  it('deleteVoice calls DELETE /api/admin/voices/:id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, deletedId: 'voice-owl' }),
    } as any);

    const result = await clientApi.deleteVoice('voice-owl');
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/admin/voices/voice-owl',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('discardDraftVoice calls DELETE /api/admin/voices/draft/:geminiVoiceName', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as any);

    const result = await clientApi.discardDraftVoice('voice_draft_temp_999');
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/admin/voices/draft/voice_draft_temp_999',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('transcribeAudioBlob calls POST /api/admin/transcribe with base64 and contextHint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'The cozy little train steamed through the moonlight.' }),
    } as any);

    const blob = new Blob(['sample-audio-data'], { type: 'audio/webm' });
    const text = await clientApi.transcribeAudioBlob(blob, 'story_prompt');

    expect(text).toBe('The cozy little train steamed through the moonlight.');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/admin/transcribe',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('appendWithSmartSpace handles empty values, leading/trailing whitespace intelligently', () => {
    expect(appendWithSmartSpace('', 'hello')).toBe('hello');
    expect(appendWithSmartSpace('  ', 'hello')).toBe('hello');
    expect(appendWithSmartSpace('Once upon', 'a time')).toBe('Once upon a time');
    expect(appendWithSmartSpace('Once upon ', 'a time')).toBe('Once upon a time');
    expect(appendWithSmartSpace('Once upon', '')).toBe('Once upon');
  });

  it('countWords counts words accurately with multiple spaces', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('  One   two   three four   ')).toBe(4);
  });
});

describe('Phase 10: MicDictationButton Component', () => {
  let originalMediaDevices: any;
  let originalMediaRecorder: any;

  beforeEach(() => {
    originalMediaDevices = navigator.mediaDevices;
    originalMediaRecorder = (window as any).MediaRecorder;

    // Default mock implementation
    const mockGetUserMedia = vi.fn(async () => new MockMediaStream());
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: mockGetUserMedia },
      configurable: true,
      writable: true,
    });
    (window as any).MediaRecorder = MockMediaRecorder;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
      writable: true,
    });
    (window as any).MediaRecorder = originalMediaRecorder;
    vi.restoreAllMocks();
  });

  it('renders idle state with 🎤 Dictate (or compact 🎤)', () => {
    const onTranscript = vi.fn();
    const { rerender } = render(<MicDictationButton onTranscript={onTranscript} />);
    expect(screen.getByRole('button', { name: /voice dictation/i })).toHaveTextContent('🎤 Dictate');

    rerender(<MicDictationButton onTranscript={onTranscript} compact={true} />);
    expect(screen.getByRole('button', { name: /voice dictation/i })).toHaveTextContent('🎤');
  });

  it('starts recording, displays live timer and crimson pulse dot, then stops and transcribes', async () => {
    const onTranscript = vi.fn();
    vi.spyOn(clientApi, 'transcribeAudioBlob').mockResolvedValueOnce('Once upon a starlit forest');

    render(<MicDictationButton onTranscript={onTranscript} contextHint="story_prompt" />);

    const dictateBtn = screen.getByRole('button', { name: /voice dictation/i });
    await act(async () => {
      fireEvent.click(dictateBtn);
    });

    // Recording state active
    expect(screen.getByRole('timer')).toBeInTheDocument();
    const stopBtn = screen.getByRole('button', { name: /stop recording/i });
    expect(stopBtn).toHaveTextContent('⏹ Done');

    // Click stop -> triggers transcription
    await act(async () => {
      fireEvent.click(stopBtn);
    });

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith('Once upon a starlit forest');
    });

    // Returned to idle
    expect(screen.getByRole('button', { name: /voice dictation/i })).toBeInTheDocument();
  });

  it('CRITICAL INVARIANT: releases all MediaStreamTracks on recording stop AND on component unmount', async () => {
    let capturedStream: MockMediaStream | null = null;
    const mockGetUserMedia = vi.fn(async () => {
      capturedStream = new MockMediaStream();
      return capturedStream;
    });
    (navigator.mediaDevices as any).getUserMedia = mockGetUserMedia;

    const onTranscript = vi.fn();
    vi.spyOn(clientApi, 'transcribeAudioBlob').mockResolvedValueOnce('Test transcript');

    const { unmount } = render(<MicDictationButton onTranscript={onTranscript} />);

    // 1. Start recording
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /voice dictation/i }));
    });
    expect(capturedStream).not.null;
    const track1 = capturedStream!.getTracks()[0];
    expect(track1.stop).not.toHaveBeenCalled();

    // 2. Stop recording -> track must be stopped
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    });
    expect(track1.stop).toHaveBeenCalled();

    // 3. Start recording again and unmount mid-recording -> track must be stopped on unmount
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /voice dictation/i }));
    });
    const track2 = capturedStream!.getTracks()[0];
    expect(track2.stop).not.toHaveBeenCalled();

    unmount();
    expect(track2.stop).toHaveBeenCalled();
  });

  it('negotiates iOS Safari audio/mp4 fallback when webm is unsupported', () => {
    MockMediaRecorder.isTypeSupported.mockImplementation(
      (type: string): boolean => type === 'audio/mp4'
    );
    expect(getSupportedAudioMimeType()).toBe('audio/mp4');

    MockMediaRecorder.isTypeSupported.mockImplementation(
      (type: string): boolean => type === 'audio/webm;codecs=opus' || type === 'audio/webm'
    );
    expect(getSupportedAudioMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('displays accessible error message when mic permission is denied without crashing', async () => {
    (navigator.mediaDevices as any).getUserMedia = vi.fn(async () => {
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    });

    const onTranscript = vi.fn();
    render(<MicDictationButton onTranscript={onTranscript} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /voice dictation/i }));
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Microphone access was denied/i);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe('Phase 10: ExpandableFocusComposer Component', () => {
  it('opens fullscreen modal on [⤢ Expand] click and closes on [✓ Done] with updated text', async () => {
    const onChange = vi.fn();
    render(
      <ExpandableFocusComposer
        title="Story Prompt"
        value="A brave little badger"
        onChange={onChange}
        contextHint="story_prompt"
      />
    );

    // Initial state: trigger button visible, modal not in document
    const expandBtn = screen.getByRole('button', { name: /expand story prompt/i });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Open composer
    fireEvent.click(expandBtn);
    expect(screen.getByRole('dialog', { name: 'Story Prompt' })).toBeInTheDocument();

    // Live word and char counters
    expect(screen.getByText(/4 words · 21 chars/i)).toBeInTheDocument();

    // Edit textarea
    const textarea = screen.getByRole('textbox', { name: 'Story Prompt' });
    fireEvent.change(textarea, { target: { value: 'A brave little badger discovers a lost star.' } });
    expect(screen.getByText(/8 words · 44 chars/i)).toBeInTheDocument();

    // Click [✓ Done]
    const doneBtn = screen.getByRole('button', { name: /save and close focus composer/i });
    fireEvent.click(doneBtn);

    expect(onChange).toHaveBeenCalledWith('A brave little badger discovers a lost star.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes modal and syncs text on Escape key press', async () => {
    const onChange = vi.fn();
    render(
      <ExpandableFocusComposer
        title="Dialogue Editor"
        value="Sleep tight, little train."
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /expand dialogue editor/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith('Sleep tight, little train.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('quick-inserts vocal tag pills at cursor position when enableVocalTagPills is true', async () => {
    const onChange = vi.fn();
    render(
      <ExpandableFocusComposer
        title="Turn #1 Dialogue"
        value="The owl blinked."
        onChange={onChange}
        enableVocalTagPills={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /expand turn #1 dialogue/i }));
    const textarea = screen.getByRole('textbox', { name: 'Turn #1 Dialogue' }) as HTMLTextAreaElement;

    // Verify pills are rendered
    expect(screen.getByRole('button', { name: 'Insert <short pause>' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert <gasp>' })).toBeInTheDocument();

    // Place selection cursor at the end
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    // Click <short pause>
    fireEvent.click(screen.getByRole('button', { name: 'Insert <short pause>' }));
    expect(textarea.value).toBe('The owl blinked. <short pause>');

    // Click [✓ Done]
    fireEvent.click(screen.getByRole('button', { name: /save and close focus composer/i }));
    expect(onChange).toHaveBeenCalledWith('The owl blinked. <short pause>');
  });
});

describe('Phase 10: AudioPlayerBar Fine-Grained Speeds', () => {
  const storyFixture: Story = {
    id: '2026-11-04-sleepy-little-train',
    status: 'published',
    title: 'The Sleepy Little Train',
    summary: 'A cozy little blue train journeys up the misty hillside.',
    tags: ['bedtime'],
    series_context: null,
    characters: [],
    script_turns: [],
    voice_candidates: [],
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
    audio_versions: [
      {
        version_id: 'v1',
        label: 'Owl Solo',
        audio_url: '/audio1.wav',
        duration_sec: 120,
        is_default: true,
        created_at: new Date().toISOString(),
        casting: {
          mode: 'solo',
          narrator_voice_id: 'voice-owl',
          character_voices: {},
        },
      },
    ],
  };

  it('cycles through fine-grained speeds [0.8x, 0.9x, 1.0x, 1.1x, 1.25x] without resetting currentTime', () => {
    const onVersionChange = vi.fn();
    render(
      <AudioPlayerBar
        story={storyFixture}
        activeVersion={storyFixture.audio_versions[0]}
        onVersionChange={onVersionChange}
      />
    );

    const audioElement = document.querySelector('audio') as HTMLAudioElement;
    expect(audioElement).toBeInTheDocument();

    // Scrub timeline to 55 seconds
    const scrubBar = screen.getByLabelText(/audio scrub bar/i);
    fireEvent.change(scrubBar, { target: { value: '55' } });
    expect(audioElement.currentTime).toBe(55);

    // Initial speed is 1.0x
    const speedBtn = screen.getByRole('button', { name: /playback speed/i });
    expect(speedBtn).toHaveTextContent('1.0x');

    // 1st click: 1.0x -> 1.1x (currentTime strictly preserved)
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.1x');
    expect(audioElement.playbackRate).toBe(1.1);
    expect(audioElement.currentTime).toBe(55);

    // 2nd click: 1.1x -> 1.25x
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.25x');
    expect(audioElement.playbackRate).toBe(1.25);
    expect(audioElement.currentTime).toBe(55);

    // 3rd click: 1.25x -> 0.8x
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('0.8x');
    expect(audioElement.playbackRate).toBe(0.8);
    expect(audioElement.currentTime).toBe(55);

    // 4th click: 0.8x -> 0.9x
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('0.9x');
    expect(audioElement.playbackRate).toBe(0.9);
    expect(audioElement.currentTime).toBe(55);

    // 5th click: 0.9x -> 1.0x
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.0x');
    expect(audioElement.playbackRate).toBe(1.0);
    expect(audioElement.currentTime).toBe(55);
  });
});

describe('Phase 10: DirectorStudio Focus Composer & Dictation Integration', () => {
  const mockStoryWithScript: Story = {
    id: 'test-story-id',
    status: 'draft',
    title: 'The Starlight Squirrel',
    summary: 'A squirrel looks for acorn constellations.',
    tags: ['bedtime', 'squirrel'],
    series_context: null,
    characters: [{ name: 'Sammy', traits: 'enthusiastic chatter, high pitch' }],
    script_turns: [
      {
        turn_id: 1,
        speaker: 'Narrator',
        text: 'Night settled softly over the enchanted pine forest.',
        style: 'Warm bedtime cadence',
      },
      {
        turn_id: 2,
        speaker: 'Sammy',
        text: 'Look at that giant acorn in the sky!',
        style: 'High excited chatter',
      },
    ],
    voice_candidates: [],
    audio_versions: [],
    created_at: '2026-11-06T00:00:00.000Z',
    updated_at: '2026-11-06T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([]);
    vi.spyOn(clientApi, 'fetchActiveJobs').mockResolvedValue([]);
    vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue([]);
  });

  it('allows expanding Story Prompt, editing inside Focus Composer, and syncing back to prompt textarea', async () => {
    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    // Locate the expand button for Story Prompt
    const expandPromptBtn = screen.getByRole('button', { name: /expand story prompt in focus editor/i });
    expect(expandPromptBtn).toBeInTheDocument();

    // Click expand -> opens focus composer
    fireEvent.click(expandPromptBtn);
    const dialog = screen.getByRole('dialog', { name: 'Story Prompt' });
    expect(dialog).toBeInTheDocument();

    // Type inside the composer modal
    const modalTextarea = screen.getByRole('textbox', { name: 'Story Prompt' });
    fireEvent.change(modalTextarea, {
      target: { value: 'A brave hedgehog invents a cloud kite.' },
    });

    // Click [✓ Done]
    const doneBtn = screen.getByRole('button', { name: /save and close focus composer/i });
    fireEvent.click(doneBtn);

    // Prompt textarea in DirectorStudio reflects the change
    const promptTextarea = screen.getByPlaceholderText(/e\.g\. A comedic sci-fi adventure/i) as HTMLTextAreaElement;
    expect(promptTextarea.value).toBe('A brave hedgehog invents a cloud kite.');
  });

  it('allows expanding script turn dialogue, inserting vocal tags, and syncing back', async () => {
    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue([
      {
        id: 'test-story-id',
        title: 'The Starlight Squirrel',
        status: 'draft',
        summary: 'A squirrel looks for acorn constellations.',
        tags: ['bedtime'],
        series_id: null,
        episode_number: null,
        default_audio_url: null,
        audio_versions_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(mockStoryWithScript);

    await act(async () => {
      render(
        <DirectorStudio
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={vi.fn()}
          onNavigateHome={vi.fn()}
        />
      );
    });

    // Select the story from sidebar
    const storyItem = await screen.findByText('The Starlight Squirrel');
    await act(async () => {
      fireEvent.click(storyItem);
    });

    // Switch to Script Editor tab
    const editorTab = await screen.findByRole('tab', { name: /Script Editor/i });
    fireEvent.click(editorTab);

    // Locate the expand button for Turn #2 Dialogue
    const expandTurnBtn = await screen.findByRole('button', {
      name: /expand turn #2 dialogue \(sammy\) in focus editor/i,
    });
    expect(expandTurnBtn).toBeInTheDocument();

    // Open Focus Composer for dialogue
    fireEvent.click(expandTurnBtn);
    expect(screen.getByRole('dialog', { name: 'Turn #2 Dialogue (Sammy)' })).toBeInTheDocument();

    const modalTextarea = screen.getByRole('textbox', {
      name: 'Turn #2 Dialogue (Sammy)',
    }) as HTMLTextAreaElement;
    modalTextarea.selectionStart = modalTextarea.value.length;
    modalTextarea.selectionEnd = modalTextarea.value.length;

    // Insert <gasp> vocal tag
    const gaspPill = screen.getByRole('button', { name: 'Insert <gasp>' });
    fireEvent.click(gaspPill);

    // Save and close
    const doneBtn = screen.getByRole('button', { name: /save and close focus composer/i });
    fireEvent.click(doneBtn);

    // Modal closes and turn textarea in DirectorStudio has the inserted tag
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue(/Look at that giant acorn in the sky! <gasp>/i)).toBeInTheDocument();
  });
});
