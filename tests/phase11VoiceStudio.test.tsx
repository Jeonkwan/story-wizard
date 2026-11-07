// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoiceDesigner } from '../client/components/VoiceDesigner';
import { VoiceStudioPanel } from '../client/components/VoiceStudioPanel';
import { VoiceLibraryPage } from '../client/components/VoiceLibraryPage';
import { AdminLoginGate } from '../client/components/AdminLoginGate';
import * as clientApi from '../client/api/client';
import type { Story, VoiceEntry, CatalogItem } from '../shared/types';

// Mock Audio and URL in jsdom
if (typeof window !== 'undefined' && window.HTMLMediaElement) {
  window.HTMLMediaElement.prototype.play = async () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
}
if (typeof window !== 'undefined' && window.HTMLElement) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}
if (typeof window !== 'undefined' && window.URL) {
  window.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/test-audio-uuid');
  window.URL.revokeObjectURL = vi.fn();
}

function getMockVoices(): VoiceEntry[] {
  return [
    {
      id: 'prebuilt-kore',
      label: 'Kore (Warm Prebuilt)',
      source: 'prebuilt',
      gemini_voice_name: 'Kore',
      description: 'Warm, soothing, gentle feminine storyteller voice with rich warmth.',
      language_code: 'en-US',
      tags: ['soothing', 'warm', 'bedtime'],
      default_pace: 'natural',
      created_at: '2026-11-01T00:00:00Z',
    },
    {
      id: 'designed-grandpa-owl',
      label: 'Grandpa Owl',
      source: 'designed',
      gemini_voice_name: 'voice_owl_take_1',
      description: 'Wise old horned owl with deep, gravelly warmth and patient pacing.',
      language_code: 'en-US',
      tags: ['wise', 'owl', 'bedtime'],
      default_pace: 'slow',
      preview_audio_url: '/api/voices/designed-grandpa-owl/preview.wav',
      created_at: '2026-11-02T00:00:00Z',
    },
    {
      id: 'designed-speedy-hare',
      label: 'Speedy Hare',
      source: 'designed',
      gemini_voice_name: 'voice_hare_take_2',
      description: 'Energetic, bouncy young rabbit with high-spirited animated banter.',
      language_code: 'en-US',
      tags: ['energetic', 'animal', 'adventure'],
      default_pace: 'lively',
      created_at: '2026-11-03T00:00:00Z',
    },
  ];
}

const mockStories: CatalogItem[] = [
  {
    id: 'story-1',
    status: 'published',
    title: 'The Sleepy Little Train',
    summary: 'A little blue engine chugs across starry hills.',
    tags: ['bedtime', 'trains'],
    series_id: null,
    episode_number: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    default_audio_url: '/api/stories/story-1/audios/v1.wav',
    audio_versions_count: 1,
  },
  {
    id: 'story-2',
    status: 'draft',
    title: 'Detective Bobo and the Lost Acorn',
    summary: 'A clever squirrel investigates the missing acorn treasure.',
    tags: ['mystery', 'animals'],
    series_id: null,
    episode_number: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    default_audio_url: null,
    audio_versions_count: 0,
  },
];

const mockDetailedStory: Story = {
  id: 'story-1',
  status: 'published',
  title: 'The Sleepy Little Train',
  summary: 'A little blue engine chugs across starry hills.',
  tags: ['bedtime', 'trains'],
  series_context: null,
  characters: [{ name: 'Bibi', traits: 'Small brave train bell chime' }],
  script_turns: [
    { turn_id: 1, speaker: 'Narrator', style: 'Soothing bedtime tone', text: 'The sleepy train yawned.' },
    { turn_id: 2, speaker: 'Bibi', style: 'Cheerful chime', text: 'Chugga chugga!' },
  ],
  voice_candidates: [
    {
      label: 'Cozy Grandpa Owl',
      description: 'Wise horned owl with gentle baritone warmth.',
      suggested_for: 'Narrator (Solo)',
    },
  ],
  audio_versions: [
    {
      version_id: 'v1',
      label: 'Solo — Kore',
      casting: { mode: 'solo', narrator_voice_id: 'prebuilt-kore', character_voices: {}, pace: 'natural' },
      is_default: true,
      duration_sec: 120,
      audio_url: '/api/stories/story-1/audios/v1.wav',
      created_at: '2026-11-01T00:00:00Z',
    },
  ],
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

describe('Phase 11: Staged Voice Designer, Voice Library & Narration Workflow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(clientApi, 'fetchAdminSession').mockResolvedValue({
      authenticated: true,
      email: 'curator@storyteller.studio',
      devBypassEnabled: true,
    });
    vi.spyOn(clientApi, 'fetchVoices').mockResolvedValue(getMockVoices());
    vi.spyOn(clientApi, 'fetchAdminStories').mockResolvedValue(mockStories);
    vi.spyOn(clientApi, 'fetchCatalog').mockResolvedValue(mockStories);
    vi.spyOn(clientApi, 'fetchStory').mockResolvedValue(mockDetailedStory);
    vi.spyOn(clientApi, 'fetchActiveJobs').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ---------------------------------------------------------------------------
   * 1. Staged Draft Voice State Machine (VoiceDesigner.tsx)
   * ------------------------------------------------------------------------- */
  describe('Staged Draft Voice State Machine in VoiceDesigner', () => {
    it('initial preview stages take, receives X-Draft-Voice-Name and shows staged badge', async () => {
      const mockWavBlob = new Blob(['RIFF_STAGED_WAV'], { type: 'audio/wav' });
      const previewSpy = vi.spyOn(clientApi, 'previewVoiceAudio').mockResolvedValue({
        blob: mockWavBlob,
        draftGeminiVoiceName: 'voice_take_stage_001',
      });

      render(<VoiceDesigner />);

      const promptInput = screen.getByPlaceholderText(/e\.g\. Warm, elderly grandmother/i);
      fireEvent.change(promptInput, {
        target: { value: 'Deep baritone sea captain with hearty laughter.' },
      });

      const previewBtn = screen.getByRole('button', { name: /🔊 Preview Voice/i });
      fireEvent.click(previewBtn);

      await waitFor(() => {
        expect(previewSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'Deep baritone sea captain with hearty laughter.',
            pace: 'natural',
          })
        );
      });

      // Assert badge is visible
      await waitFor(() => {
        expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
        expect(
          screen.getByText(/Saving will preserve this exact vocal persona/i)
        ).toBeInTheDocument();
      });

      // Assert "🎲 New Voice Take" button is now visible
      expect(screen.getByRole('button', { name: /🎲 New Voice Take/i })).toBeInTheDocument();
    });

    it('changing sample text or preset while prompt is unchanged re-auditions using SAME staged voice ID', async () => {
      const mockWavBlob = new Blob(['RIFF_STAGED_WAV'], { type: 'audio/wav' });
      const previewSpy = vi.spyOn(clientApi, 'previewVoiceAudio').mockResolvedValue({
        blob: mockWavBlob,
        draftGeminiVoiceName: 'voice_take_stage_001',
      });

      render(<VoiceDesigner />);

      const promptInput = screen.getByPlaceholderText(/e\.g\. Warm, elderly grandmother/i);
      fireEvent.change(promptInput, {
        target: { value: 'Cozy bedtime grandma voice.' },
      });

      // 1. Initial preview
      fireEvent.click(screen.getByRole('button', { name: /🔊 Preview Voice/i }));
      await waitFor(() => {
        expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
      });

      // Stop active audition before next preview
      const stopBtn = screen.queryByRole('button', { name: /⏹ Stop Audition/i });
      if (stopBtn) fireEvent.click(stopBtn);

      previewSpy.mockClear();

      // 2. Click a different sample preset ("Magical Wonder")
      const magicalPresetBtn = screen.getByRole('button', { name: /Magical Wonder/i });
      fireEvent.click(magicalPresetBtn);

      // Re-audition
      fireEvent.click(screen.getByRole('button', { name: /🔊 Preview Voice/i }));

      await waitFor(() => {
        expect(previewSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'Cozy bedtime grandma voice.',
            draftGeminiVoiceName: 'voice_take_stage_001',
            regenerateTake: false,
          })
        );
      });

      // Staged badge remains locked
      expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
    });

    it('clicking "🎲 New Voice Take" generates a fresh take with regenerateTake: true and cleans previous draft', async () => {
      const mockWavBlob1 = new Blob(['RIFF_TAKE_1'], { type: 'audio/wav' });
      const mockWavBlob2 = new Blob(['RIFF_TAKE_2'], { type: 'audio/wav' });

      const previewSpy = vi
        .spyOn(clientApi, 'previewVoiceAudio')
        .mockResolvedValueOnce({
          blob: mockWavBlob1,
          draftGeminiVoiceName: 'voice_take_first_111',
        })
        .mockResolvedValueOnce({
          blob: mockWavBlob2,
          draftGeminiVoiceName: 'voice_take_second_222',
        });

      render(<VoiceDesigner />);

      const promptInput = screen.getByPlaceholderText(/e\.g\. Warm, elderly grandmother/i);
      fireEvent.change(promptInput, { target: { value: 'Silly animated goblin.' } });

      // First preview
      fireEvent.click(screen.getByRole('button', { name: /🔊 Preview Voice/i }));
      await waitFor(() => {
        expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
      });

      // Stop active audition so New Voice Take button is enabled
      const stopBtn = screen.queryByRole('button', { name: /⏹ Stop Audition/i });
      if (stopBtn) fireEvent.click(stopBtn);

      // Roll new take
      const newTakeBtn = screen.getByRole('button', { name: /🎲 New Voice Take/i });
      fireEvent.click(newTakeBtn);

      await waitFor(() => {
        expect(previewSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            description: 'Silly animated goblin.',
            regenerateTake: true,
            previousDraftGeminiVoiceName: 'voice_take_first_111',
          })
        );
      });

      expect(screen.getByText(/voice_take_second_222/i)).toBeInTheDocument();
    });

    it('editing prompt description text invalidates staged take', async () => {
      const mockWavBlob = new Blob(['RIFF_STAGED_WAV'], { type: 'audio/wav' });
      vi.spyOn(clientApi, 'previewVoiceAudio').mockResolvedValue({
        blob: mockWavBlob,
        draftGeminiVoiceName: 'voice_take_temp_123',
      });

      render(<VoiceDesigner />);

      const promptInput = screen.getByPlaceholderText(/e\.g\. Warm, elderly grandmother/i);
      fireEvent.change(promptInput, { target: { value: 'Original description.' } });

      fireEvent.click(screen.getByRole('button', { name: /🔊 Preview Voice/i }));
      await waitFor(() => {
        expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
      });

      // Edit description text
      fireEvent.change(promptInput, { target: { value: 'Modified description text.' } });

      // Staged badge and "🎲 New Voice Take" must disappear
      expect(screen.queryByText(/✓ Voice Take Staged/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /🎲 New Voice Take/i })).not.toBeInTheDocument();
    });

    it('saving to voice library when draft is staged sends stagedGeminiVoiceName + previewAudioBase64 + defaultPace', async () => {
      const mockWavBlob = new Blob(['RIFF_EXACT_TAKE'], { type: 'audio/wav' });
      vi.spyOn(clientApi, 'previewVoiceAudio').mockResolvedValue({
        blob: mockWavBlob,
        draftGeminiVoiceName: 'voice_locked_perfect_999',
      });

      const createSpy = vi.spyOn(clientApi, 'createCustomVoice').mockResolvedValue({
        id: 'designed-captain-owl',
        label: 'Captain Owl',
        source: 'designed',
        gemini_voice_name: 'voice_locked_perfect_999',
        description: 'Baritone sea captain owl.',
        language_code: 'en-US',
        tags: ['captain', 'owl'],
        default_pace: 'lively',
        created_at: new Date().toISOString(),
      });

      const onVoiceCreatedMock = vi.fn();

      render(<VoiceDesigner onVoiceCreated={onVoiceCreatedMock} />);

      // Fill form
      fireEvent.change(screen.getByLabelText(/Voice Label \*/i), {
        target: { value: 'Captain Owl' },
      });
      fireEvent.change(screen.getByLabelText(/Tags/i), {
        target: { value: 'captain, owl' },
      });
      fireEvent.click(screen.getByRole('button', { name: /⚡ Lively/i }));
      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Warm, elderly grandmother/i), {
        target: { value: 'Baritone sea captain owl.' },
      });

      // Preview to stage
      fireEvent.click(screen.getByRole('button', { name: /🔊 Preview Voice/i }));
      await waitFor(() => {
        expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
      });

      // Click Save
      fireEvent.click(screen.getByRole('button', { name: /💾 Save to Voice Library/i }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            label: 'Captain Owl',
            description: 'Baritone sea captain owl.',
            defaultPace: 'lively',
            tags: ['captain', 'owl'],
            stagedGeminiVoiceName: 'voice_locked_perfect_999',
            previewAudioBase64: expect.any(String),
          })
        );
      });

      expect(onVoiceCreatedMock).toHaveBeenCalled();
    });

    it('unmounting VoiceDesigner calls discardDraftVoice if staged draft is unsaved', async () => {
      const discardSpy = vi.spyOn(clientApi, 'discardDraftVoice').mockResolvedValue({ ok: true });
      const mockWavBlob = new Blob(['RIFF_DISCARD_TEST'], { type: 'audio/wav' });

      vi.spyOn(clientApi, 'previewVoiceAudio').mockResolvedValue({
        blob: mockWavBlob,
        draftGeminiVoiceName: 'voice_orphan_to_cleanup_777',
      });

      const { unmount } = render(<VoiceDesigner />);

      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Warm, elderly grandmother/i), {
        target: { value: 'Unsaved prompt take.' },
      });

      fireEvent.click(screen.getByRole('button', { name: /🔊 Preview Voice/i }));
      await waitFor(() => {
        expect(screen.getByText(/✓ Voice Take Staged/i)).toBeInTheDocument();
      });

      unmount();

      expect(discardSpy).toHaveBeenCalledWith('voice_orphan_to_cleanup_777');
    });
  });

  /* ---------------------------------------------------------------------------
   * 2. VoiceStudioPanel Upgrades (VoiceStudioPanel.tsx)
   * ------------------------------------------------------------------------- */
  describe('VoiceStudioPanel Step 3 Narration Pace & Voice Inspection', () => {
    it('renders Narration Pace selector and passes casting.pace to synthesizeStoryAudio', async () => {
      const synthSpy = vi.spyOn(clientApi, 'synthesizeStoryAudio').mockResolvedValue(mockDetailedStory);

      render(
        <VoiceStudioPanel
          story={mockDetailedStory}
          onStoryUpdated={() => {}}
        />
      );

      // Wait for voices to finish loading
      await waitFor(() => {
        expect(screen.queryByText(/Loading voices\.\.\./i)).not.toBeInTheDocument();
      });

      // Select Slow pace
      const slowPaceBtn = screen.getByRole('button', { name: /🐢 Slow/i });
      fireEvent.click(slowPaceBtn);

      // Click Synthesize
      const synthBtn = screen.getByRole('button', { name: /🎧 3\. Synthesize & Publish Audio/i });
      fireEvent.click(synthBtn);

      await waitFor(() => {
        expect(synthSpy).toHaveBeenCalledWith(
          'story-1',
          expect.objectContaining({
            casting: expect.objectContaining({
              pace: 'slow',
            }),
          })
        );
      });
    });

    it('displays full description prompt and badges for selected Narrator voice', async () => {
      render(
        <VoiceStudioPanel
          story={mockDetailedStory}
          onStoryUpdated={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Warm, soothing, gentle feminine storyteller voice/i)).toBeInTheDocument();
      });

      // Expand / collapse button exists
      const toggleBtn = screen.getByRole('button', { name: /👁️ Collapse/i });
      fireEvent.click(toggleBtn);
      expect(screen.getByRole('button', { name: /👁️ View Prompt/i })).toBeInTheDocument();
    });

    it('pre-selects initialNarratorVoiceId prop when supplied', async () => {
      render(
        <VoiceStudioPanel
          story={mockDetailedStory}
          initialNarratorVoiceId="designed-grandpa-owl"
          onStoryUpdated={() => {}}
        />
      );

      await waitFor(() => {
        const narratorSelect = screen.getByLabelText(/Narrator Voice:/i) as HTMLSelectElement;
        expect(narratorSelect.value).toBe('designed-grandpa-owl');
      });
    });
  });

  /* ---------------------------------------------------------------------------
   * 3. Standalone Voice Library Page (VoiceLibraryPage.tsx)
   * ------------------------------------------------------------------------- */
  describe('Standalone Voice Library Page', () => {
    it('renders saved voices catalog with full prompt, copy prompt, and filter pills', async () => {
      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={() => {}}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
        expect(screen.getByText('Speedy Hare')).toBeInTheDocument();
        expect(screen.getByText('Kore (Warm Prebuilt)')).toBeInTheDocument();
      });

      // Filter by "Designed"
      const designedFilterBtn = screen.getByRole('button', { name: /Designed \(/i });
      fireEvent.click(designedFilterBtn);

      expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
      expect(screen.getByText('Speedy Hare')).toBeInTheDocument();
      expect(screen.queryByText('Kore (Warm Prebuilt)')).not.toBeInTheDocument();

      // Find Grandpa Owl card and copy prompt
      const owlCard = screen.getByText('Grandpa Owl').closest('.voice-card') as HTMLElement;
      const copyBtn = within(owlCard).getByRole('button', { name: /📋 Copy Prompt/i });
      fireEvent.click(copyBtn);

      await waitFor(() => {
        expect(within(owlCard).getByText(/✓ Copied!/i)).toBeInTheDocument();
      });
    });

    it('clone / remix prompt pre-fills the top VoiceDesigner', async () => {
      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={() => {}}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
      });

      const owlCard = screen.getByText('Grandpa Owl').closest('.voice-card') as HTMLElement;
      const remixBtn = within(owlCard).getByRole('button', { name: /🧬 Remix Prompt/i });
      fireEvent.click(remixBtn);

      // Top designer label should be populated
      const labelInput = screen.getByLabelText(/Voice Label \*/i) as HTMLInputElement;
      expect(labelInput.value).toContain('Grandpa Owl (Remix)');
    });

    it('edit metadata updates voice inline via PATCH /api/admin/voices/:id', async () => {
      const updateSpy = vi.spyOn(clientApi, 'updateVoice').mockResolvedValue({
        ...getMockVoices()[1],
        label: 'Grandpa Owl (Updated)',
        default_pace: 'calm',
      });

      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={() => {}}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
      });

      const owlCard = screen.getByText('Grandpa Owl').closest('.voice-card') as HTMLElement;
      const editBtn = within(owlCard).getByRole('button', { name: /✏️ Edit/i });
      fireEvent.click(editBtn);

      // Inline edit form appears inside owlCard
      expect(within(owlCard).getByText('Edit Voice Metadata')).toBeInTheDocument();

      const saveBtn = within(owlCard).getByRole('button', { name: /^Save$/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith(
          'designed-grandpa-owl',
          expect.objectContaining({
            label: 'Grandpa Owl',
          })
        );
      });
    });

    it('delete voice confirms and calls DELETE /api/admin/voices/:id for designed voice', async () => {
      const deleteSpy = vi.spyOn(clientApi, 'deleteVoice').mockResolvedValue({ ok: true, deletedId: 'designed-grandpa-owl' });

      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={() => {}}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
      });

      const owlCard = screen.getByText('Grandpa Owl').closest('.voice-card') as HTMLElement;
      const deleteBtn = within(owlCard).getByRole('button', { name: /🗑️ Delete/i });
      fireEvent.click(deleteBtn);

      expect(within(owlCard).getByText(/Delete this custom voice\?/i)).toBeInTheDocument();

      const confirmBtn = within(owlCard).getByRole('button', { name: /Confirm Delete/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledWith('designed-grandpa-owl');
      });
    });

    it('prebuilt voice has delete button disabled', async () => {
      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={() => {}}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Kore (Warm Prebuilt)')).toBeInTheDocument();
      });

      const koreCard = screen.getByText('Kore (Warm Prebuilt)').closest('.voice-card') as HTMLElement;
      const prebuiltLockBtn = within(koreCard).getByRole('button', { name: /🔒 Prebuilt/i });
      expect(prebuiltLockBtn).toBeDisabled();
    });

    it('narrate a story workflow: Action 1 generates solo audio and shows reader link', async () => {
      const synthSpy = vi.spyOn(clientApi, 'synthesizeStoryAudio').mockResolvedValue(mockDetailedStory);
      const onNavigateMock = vi.fn();

      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={onNavigateMock}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
      });

      const owlCard = screen.getByText('Grandpa Owl').closest('.voice-card') as HTMLElement;
      const narrateBtn = within(owlCard).getByRole('button', { name: /🎬 Narrate a Story/i });
      fireEvent.click(narrateBtn);

      // Modal appears
      await waitFor(() => {
        expect(screen.getByText(/🎬 Narrate a Story with "Grandpa Owl"/i)).toBeInTheDocument();
      });

      // Wait for stories to load and button to be enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /⚡ Generate Solo Audio Now/i })).toBeEnabled();
      });

      // Click Generate Solo Audio Now
      const genBtn = screen.getByRole('button', { name: /⚡ Generate Solo Audio Now/i });
      fireEvent.click(genBtn);

      await waitFor(() => {
        expect(synthSpy).toHaveBeenCalledWith(
          'story-1',
          expect.objectContaining({
            casting: expect.objectContaining({
              mode: 'solo',
              narrator_voice_id: 'designed-grandpa-owl',
            }),
          })
        );
      });

      // Success view with Listen in Reader button
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /🎧 Listen in Reader/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /🎧 Listen in Reader/i }));
      expect(onNavigateMock).toHaveBeenCalledWith('/stories/story-1');
    });

    it('narrate a story workflow: Action 2 opens story in Step 3 with voice pre-selected', async () => {
      const onNavigateMock = vi.fn();

      render(
        <VoiceLibraryPage
          session={{ authenticated: true, devBypassEnabled: true }}
          onLogout={() => {}}
          onNavigate={onNavigateMock}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grandpa Owl')).toBeInTheDocument();
      });

      const owlCard = screen.getByText('Grandpa Owl').closest('.voice-card') as HTMLElement;
      const narrateBtn = within(owlCard).getByRole('button', { name: /🎬 Narrate a Story/i });
      fireEvent.click(narrateBtn);

      await waitFor(() => {
        expect(screen.getByText(/🎛️ Open in Story Step 3/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /🎛️ Open in Story Step 3/i }));

      expect(onNavigateMock).toHaveBeenCalledWith(
        expect.stringContaining('/admin?storyId=story-1&narratorVoiceId=designed-grandpa-owl&step=3')
      );
    });
  });

  /* ---------------------------------------------------------------------------
   * 4. Navigation & Route Switching (AdminLoginGate.tsx)
   * ------------------------------------------------------------------------- */
  describe('Admin Navigation & Tab Switching', () => {
    it('switches between Stories Workbench (/admin) and Voice Library (/admin/voices)', async () => {
      const onNavigateMock = vi.fn();

      const { rerender } = render(
        <AdminLoginGate
          currentPath="/admin"
          onNavigate={onNavigateMock}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /📖 Stories Workbench/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /🎙️ Voice Library/i })).toBeInTheDocument();
      });

      // Click Voice Library tab
      fireEvent.click(screen.getByRole('button', { name: /🎙️ Voice Library/i }));
      expect(onNavigateMock).toHaveBeenCalledWith('/admin/voices');

      // Re-render at /admin/voices
      rerender(
        <AdminLoginGate
          currentPath="/admin/voices"
          onNavigate={onNavigateMock}
          onNavigateHome={() => {}}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Saved Voice Catalog/i)).toBeInTheDocument();
      });
    });
  });
});
