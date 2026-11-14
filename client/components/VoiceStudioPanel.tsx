import React, { useEffect, useRef, useState, useCallback } from 'react';
import type {
  AudioVersion,
  PodcastConfig,
  Story,
  VoiceCasting,
  VoiceEntry,
  VoicePace,
} from '../../shared/types';
import { getLosslessWavUrl } from '../../shared/types';
import {
  fetchVoices,
  fetchAdminPodcasts,
  releaseStoryToPodcast,
  unreleaseStoryFromPodcast,
  previewVoiceAudio,
  createCustomVoice,
  synthesizeStoryAudio,
  setDefaultAudioVersion,
  deleteAudioVersion,
  fetchActiveJobs,
  fetchJobStatus,
  fetchStory,
  ApiError,
} from '../api/client';
import { VoiceDesigner } from './VoiceDesigner';

export interface VoiceStudioPanelProps {
  story: Story;
  onStoryUpdated: (updatedStory: Story) => void;
  onBeforeSynthesize?: () => Promise<void>;
  initialNarratorVoiceId?: string;
  onNavigateToVoiceLibrary?: () => void;
}

const PACE_BADGES: Record<VoicePace, { label: string; desc: string }> = {
  slow: { label: '🐢 Slow', desc: 'Soothing & unhurried' },
  calm: { label: '🌙 Calm', desc: 'Measured & relaxed' },
  natural: { label: '✨ Natural', desc: 'Balanced rhythm' },
  lively: { label: '⚡ Lively', desc: 'Animated & upbeat' },
};

export function VoiceStudioPanel({
  story,
  onStoryUpdated,
  onBeforeSynthesize,
  initialNarratorVoiceId,
  onNavigateToVoiceLibrary,
}: VoiceStudioPanelProps): React.JSX.Element {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loadingVoices, setLoadingVoices] = useState<boolean>(true);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  // Casting state
  const [castingMode, setCastingMode] = useState<'solo' | 'cast'>('solo');
  const [narratorVoiceId, setNarratorVoiceId] = useState<string>(initialNarratorVoiceId || '');
  const [characterVoices, setCharacterVoices] = useState<Record<string, string>>({});
  const [versionLabel, setVersionLabel] = useState<string>('');
  const [setAsDefault, setSetAsDefault] = useState<boolean>(true);
  const [narrationPace, setNarrationPace] = useState<VoicePace | 'inherit'>('inherit');

  // Synthesis progress state
  const [isSynthesizing, setIsSynthesizing] = useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [synthSuccess, setSynthSuccess] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const synthPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Audition playback state
  const [auditioningKey, setAuditioningKey] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentBlobUrlRef = useRef<string | null>(null);

  // Custom Voice Designer state
  const [showVoiceDesigner, setShowVoiceDesigner] = useState<boolean>(false);
  const [designerInitialValues, setDesignerInitialValues] = useState<{
    label?: string;
    description?: string;
    tags?: string[];
  } | null>(null);
  const [voiceCreateError, setVoiceCreateError] = useState<string | null>(null);
  const [voiceCreateSuccess, setVoiceCreateSuccess] = useState<string | null>(null);

  // Track saved candidates to show "Saved" state
  const [savedCandidateLabels, setSavedCandidateLabels] = useState<Set<string>>(new Set());

  // Version management actions
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  const [versionActionError, setVersionActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Prompt expansion toggle on selected narrator voice
  const [showFullNarratorPrompt, setShowFullNarratorPrompt] = useState<boolean>(true);
  const [copiedPrompt, setCopiedPrompt] = useState<boolean>(false);

  // Dynamic bucket-driven podcast release state
  const [podcasts, setPodcasts] = useState<PodcastConfig[]>([]);
  const [selectedPodcastVersions, setSelectedPodcastVersions] = useState<Record<string, string>>({});
  const [podcastBusyId, setPodcastBusyId] = useState<string | null>(null);
  const [podcastError, setPodcastError] = useState<string | null>(null);

  // Stop any active audition preview and clean up object URLs
  const stopAudition = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.onerror = null;
      currentAudioRef.current.onended = null;
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }
    if (currentBlobUrlRef.current) {
      URL.revokeObjectURL(currentBlobUrlRef.current);
      currentBlobUrlRef.current = null;
    }
    setAuditioningKey(null);
  }, []);

  useEffect(() => {
    return () => {
      stopAudition();
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (synthPollTimerRef.current) {
        clearInterval(synthPollTimerRef.current);
      }
    };
  }, [stopAudition]);

  // Load available voices from API
  const loadVoices = useCallback(async () => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const list = await fetchVoices();
      setVoices(list);
      if (list.length > 0) {
        const preferredId = initialNarratorVoiceId || story.series_context?.preferred_voice_id;
        const hasPreferred = preferredId && list.some((v) => v.id === preferredId);
        const defaultVoice = hasPreferred
          ? preferredId!
          : list.find((v) => v.id === 'prebuilt-kore')?.id || list[0].id;
        setNarratorVoiceId((prev) => (prev && list.some((v) => v.id === prev) ? prev : defaultVoice));
      }
    } catch (err) {
      setVoicesError(err instanceof Error ? err.message : 'Failed to load voices');
    } finally {
      setLoadingVoices(false);
    }
  }, [story.series_context?.preferred_voice_id, initialNarratorVoiceId]);

  useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  // Dynamically discover bucket-configured podcasts so release controls stay hidden when 0 exist
  useEffect(() => {
    let mounted = true;
    fetchAdminPodcasts()
      .then((list) => {
        if (mounted) {
          setPodcasts(list);
        }
      })
      .catch(() => {
        // Ignore errors when podcast endpoint is unavailable in isolated unit tests
      });
    return () => {
      mounted = false;
    };
  }, [story.id]);

  const getWavDownloadHref = (ver: AudioVersion): string =>
    `${getLosslessWavUrl(ver)}?download=1`;

  const handleReleaseToPodcast = async (podcastId: string, versionId: string) => {
    setPodcastBusyId(podcastId);
    setPodcastError(null);
    try {
      const updatedPodcast = await releaseStoryToPodcast(podcastId, {
        storyId: story.id,
        versionId,
      });
      setPodcasts((prev) => prev.map((p) => (p.id === updatedPodcast.id ? updatedPodcast : p)));
      if (story.status !== 'published') {
        try {
          const refreshedStory = await fetchStory(story.id);
          onStoryUpdated(refreshedStory);
        } catch {
          // Non-fatal
        }
      }
    } catch (err) {
      setPodcastError(err instanceof Error ? err.message : 'Failed to release story to podcast');
    } finally {
      setPodcastBusyId(null);
    }
  };

  const handleUnreleaseFromPodcast = async (podcastId: string) => {
    setPodcastBusyId(podcastId);
    setPodcastError(null);
    try {
      const updatedPodcast = await unreleaseStoryFromPodcast(podcastId, story.id);
      setPodcasts((prev) => prev.map((p) => (p.id === updatedPodcast.id ? updatedPodcast : p)));
    } catch (err) {
      setPodcastError(err instanceof Error ? err.message : 'Failed to unrelease story from podcast');
    } finally {
      setPodcastBusyId(null);
    }
  };

  // Handle external initialNarratorVoiceId updates
  useEffect(() => {
    if (initialNarratorVoiceId && voices.some((v) => v.id === initialNarratorVoiceId)) {
      setNarratorVoiceId(initialNarratorVoiceId);
    }
  }, [initialNarratorVoiceId, voices]);

  // Reset transient banners and casting defaults when switching stories
  useEffect(() => {
    stopAudition();
    setSynthSuccess(false);
    setSynthError(null);
    setVoiceCreateSuccess(null);
    setVoiceCreateError(null);
    setAuditionError(null);
    setVersionActionError(null);
    setConfirmDeleteId(null);

    if (voices.length > 0) {
      const preferredId = initialNarratorVoiceId || story.series_context?.preferred_voice_id;
      const hasPreferred = preferredId && voices.some((v) => v.id === preferredId);
      const defaultVoice = hasPreferred
        ? preferredId!
        : voices.find((v) => v.id === 'prebuilt-kore')?.id || voices[0].id;
      setNarratorVoiceId(defaultVoice);
    }
    setVersionLabel(castingMode === 'solo' ? 'Solo Narration' : 'Full Cast Audio');
  }, [story.id, stopAudition, initialNarratorVoiceId]);

  // Check and restore active synthesis job for this story
  const checkActiveSynthesisJob = useCallback(async () => {
    try {
      let activeJobs: any[] = [];
      try {
        activeJobs = await fetchActiveJobs(story.id);
      } catch {
        // activeJobs fetch failed or offline
      }
      const synthJob =
        (Array.isArray(activeJobs) && activeJobs.find(
          (j) =>
            j.type === 'synthesize' &&
            j.status === 'running' &&
            (j.story_id === story.id || j.result_story_id === story.id)
        )) ||
        (story.active_job?.type === 'synthesize'
          ? {
              job_id: story.active_job.job_id,
              story_id: story.id,
              type: 'synthesize' as const,
              status: 'running' as const,
              started_at: story.active_job.started_at,
              elapsed_seconds: Math.max(
                0,
                Math.floor(
                  (Date.now() - new Date(story.active_job.started_at).getTime()) / 1000
                )
              ),
            }
          : null);

      if (synthJob) {
        setIsSynthesizing(true);
        setSynthError(null);
        setSynthSuccess(false);
        setElapsedSeconds(synthJob.elapsed_seconds || 0);

        if (!timerRef.current) {
          timerRef.current = setInterval(() => {
            setElapsedSeconds((sec) => sec + 1);
          }, 1000);
        }

        if (synthPollTimerRef.current) {
          clearInterval(synthPollTimerRef.current);
        }

        const pollOnce = async () => {
          try {
            const job = await fetchJobStatus(synthJob.job_id);
            if (job.status === 'running') {
              setElapsedSeconds(job.elapsed_seconds);
            } else if (job.status === 'completed') {
              if (synthPollTimerRef.current) {
                clearInterval(synthPollTimerRef.current);
                synthPollTimerRef.current = null;
              }
              if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
              }
              setIsSynthesizing(false);
              const updated = await fetchStory(story.id);
              onStoryUpdated(updated);
              setSynthSuccess(true);
            } else if (job.status === 'failed') {
              if (synthPollTimerRef.current) {
                clearInterval(synthPollTimerRef.current);
                synthPollTimerRef.current = null;
              }
              if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
              }
              setIsSynthesizing(false);
              setSynthError(job.error || 'Audio synthesis failed');
            }
          } catch (err) {
            const status = (err as any)?.status;
            if (status === 404 || status === '404' || (err instanceof ApiError && err.status === 404)) {
              if (synthPollTimerRef.current) {
                clearInterval(synthPollTimerRef.current);
                synthPollTimerRef.current = null;
              }
              if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
              }
              setIsSynthesizing(false);
              setSynthError(
                'Previous synthesis job is no longer active (server may have restarted). You can safely start a new synthesis.'
              );
            }
            // Keep polling for network blips
          }
        };

        pollOnce();
        synthPollTimerRef.current = setInterval(pollOnce, 1500);
      }
    } catch {
      // Graceful fallback
    }
  }, [story.id, story.active_job, onStoryUpdated]);

  useEffect(() => {
    checkActiveSynthesisJob();
  }, [checkActiveSynthesisJob]);

  // Initialize casting defaults once voices are loaded or characters change
  useEffect(() => {
    if (voices.length === 0) return;

    const preferredId = initialNarratorVoiceId || story.series_context?.preferred_voice_id;
    const hasPreferred = preferredId && voices.some((v) => v.id === preferredId);
    const defaultVoice = hasPreferred
      ? preferredId!
      : voices.find((v) => v.id === 'prebuilt-kore')?.id || voices[0].id;

    if (!narratorVoiceId || !voices.some((v) => v.id === narratorVoiceId)) {
      setNarratorVoiceId(defaultVoice);
    }

    // Default character voices
    setCharacterVoices((prev) => {
      const updated = { ...prev };
      story.characters.forEach((char, idx) => {
        if (!updated[char.name] || !voices.some((v) => v.id === updated[char.name])) {
          const candidateVoice =
            voices.find((v) => v.id === (idx % 2 === 0 ? 'prebuilt-puck' : 'prebuilt-aoede'))?.id ||
            voices[idx % voices.length].id;
          updated[char.name] = candidateVoice;
        }
      });
      return updated;
    });

    if (!versionLabel) {
      setVersionLabel(castingMode === 'solo' ? 'Solo Narration' : 'Full Cast Audio');
    }
  }, [voices, story.series_context?.preferred_voice_id, story.characters, narratorVoiceId, versionLabel, castingMode, initialNarratorVoiceId]);

  // Play a 5-second audition preview
  const handlePlayAudition = async (
    key: string,
    params: { voiceId?: string; description?: string; sampleText?: string; pace?: VoicePace }
  ) => {
    if (auditioningKey === key) {
      stopAudition();
      return;
    }

    stopAudition();
    setAuditioningKey(key);
    setAuditionError(null);

    try {
      const { blob } = await previewVoiceAudio(params);
      const blobUrl = URL.createObjectURL(blob);
      currentBlobUrlRef.current = blobUrl;

      const audio = new Audio(blobUrl);
      currentAudioRef.current = audio;

      audio.onended = () => {
        stopAudition();
      };
      audio.onerror = () => {
        setAuditionError('Audio playback failed');
        stopAudition();
      };

      await audio.play();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setAuditionError(err instanceof Error ? err.message : 'Audition preview failed');
      stopAudition();
    }
  };

  // Save proposed candidate to Voice Library
  const handleSaveCandidate = async (label: string, description: string, suggestedFor: string) => {
    setVoiceCreateError(null);
    setVoiceCreateSuccess(null);

    try {
      const created = await createCustomVoice({
        label,
        description,
        tags: [suggestedFor],
      });
      setSavedCandidateLabels((prev) => new Set([...prev, label]));
      await loadVoices();
      setVoiceCreateSuccess(`Saved "${created.label}" to Voice Library!`);
    } catch (err) {
      setVoiceCreateError(err instanceof Error ? err.message : 'Failed to save voice candidate');
    }
  };

  // Customize candidate in VoiceDesigner
  const handleCustomizeCandidate = (label: string, description: string, suggestedFor: string) => {
    setDesignerInitialValues({
      label,
      description,
      tags: [suggestedFor],
    });
    setShowVoiceDesigner(true);
  };

  // Mode toggle with default label sync
  const handleToggleCastingMode = (newMode: 'solo' | 'cast') => {
    setCastingMode(newMode);
    if (newMode === 'cast' && (versionLabel === 'Solo Narration' || versionLabel === 'Bedtime Solo' || !versionLabel)) {
      setVersionLabel('Full Cast Audio');
    } else if (newMode === 'solo' && (versionLabel === 'Full Cast Audio' || versionLabel === 'Bedtime Cast' || !versionLabel)) {
      setVersionLabel('Solo Narration');
    }
  };

  // Synthesize Full Story
  const handleSynthesize = async () => {
    const effectiveNarratorVoiceId =
      narratorVoiceId ||
      initialNarratorVoiceId ||
      story.series_context?.preferred_voice_id ||
      voices.find((v) => v.id === 'prebuilt-kore')?.id ||
      voices[0]?.id;

    if (!effectiveNarratorVoiceId) {
      setSynthError('Please select a Narrator voice');
      return;
    }

    if (!narratorVoiceId) {
      setNarratorVoiceId(effectiveNarratorVoiceId);
    }

    setIsSynthesizing(true);
    setSynthError(null);
    setSynthSuccess(false);
    setElapsedSeconds(0);

    timerRef.current = setInterval(() => {
      setElapsedSeconds((sec) => sec + 1);
    }, 1000);

    try {
      if (onBeforeSynthesize) {
        await onBeforeSynthesize();
      }

      const casting: VoiceCasting = {
        mode: castingMode,
        narrator_voice_id: effectiveNarratorVoiceId,
        character_voices: castingMode === 'cast' ? characterVoices : {},
        ...(narrationPace !== 'inherit' && { pace: narrationPace as VoicePace }),
      };

      const updatedStory = await synthesizeStoryAudio(story.id, {
        casting,
        label: versionLabel.trim() || (castingMode === 'solo' ? 'Solo Narration' : 'Full Cast Audio'),
        makeDefault: setAsDefault,
        async: true,
        onProgress: (job) => setElapsedSeconds(job.elapsed_seconds),
      });

      onStoryUpdated(updatedStory);
      setSynthSuccess(true);
    } catch (err) {
      setSynthError(err instanceof Error ? err.message : 'Audio synthesis failed');
    } finally {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setIsSynthesizing(false);
    }
  };

  // Set version as default
  const handleSetDefault = async (versionId: string) => {
    setVersionActionError(null);
    try {
      const updated = await setDefaultAudioVersion(story.id, versionId);
      onStoryUpdated(updated);
    } catch (err) {
      setVersionActionError(err instanceof Error ? err.message : 'Failed to set default version');
    }
  };

  // Delete version
  const handleDeleteVersion = async (versionId: string) => {
    setVersionActionError(null);
    setDeletingVersionId(versionId);
    try {
      const updated = await deleteAudioVersion(story.id, versionId);
      setConfirmDeleteId(null);
      onStoryUpdated(updated);
    } catch (err) {
      setVersionActionError(err instanceof Error ? err.message : 'Failed to delete audio version');
    } finally {
      setDeletingVersionId(null);
    }
  };

  const selectedNarratorVoice = voices.find((v) => v.id === narratorVoiceId);

  return (
    <div id="step-3-panel">
      <section id="step-3-voice-studio" className="card-tactile voice-studio-panel" style={{ padding: '1.25rem', marginBottom: '1.5rem', marginTop: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: '1.35rem' }}>
          Step 3: Voice Audition, Synthesis &amp; Versions
        </h3>
        {onNavigateToVoiceLibrary && (
          <button
            type="button"
            className="btn-tactile"
            onClick={onNavigateToVoiceLibrary}
            style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', minHeight: '38px' }}
          >
            🎙️ Open Voice Library →
          </button>
        )}
      </div>

      {voicesError && (
        <div className="card-tactile" style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', backgroundColor: 'var(--accent-state-bg)', borderColor: 'var(--accent-state)', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
          ⚠️ Voices error: {voicesError}
        </div>
      )}
      {auditionError && (
        <div className="card-tactile" style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', backgroundColor: 'var(--accent-state-bg)', borderColor: 'var(--accent-state)', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
          ⚠️ Audition error: {auditionError}
        </div>
      )}
      {voiceCreateError && (
        <div className="card-tactile" style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', backgroundColor: 'var(--accent-state-bg)', borderColor: 'var(--accent-state)', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
          ⚠️ Voice designer error: {voiceCreateError}
        </div>
      )}
      {voiceCreateSuccess && (
        <div className="card-tactile" style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', backgroundColor: 'var(--accent-root-bg)', borderColor: 'var(--accent-root)', color: 'var(--accent-root)', fontSize: '0.85rem' }}>
          ✓ {voiceCreateSuccess}
        </div>
      )}
      {versionActionError && (
        <div className="card-tactile" style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', backgroundColor: 'var(--accent-state-bg)', borderColor: 'var(--accent-state)', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
          ⚠️ Version error: {versionActionError}
        </div>
      )}

      {/* SECTION 1: Voice Audition & Proposed Voice Candidates */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <h4 style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
            PROPOSED VOICE DESIGNS &amp; AUDITIONS ({story.voice_candidates?.length || 0})
          </h4>
          <button
            type="button"
            className="btn-tactile"
            style={{ fontSize: '0.8rem', padding: '0.25rem 0.65rem' }}
            disabled={isSynthesizing}
            onClick={() => {
              if (showVoiceDesigner) {
                setShowVoiceDesigner(false);
                setDesignerInitialValues(null);
              } else {
                setDesignerInitialValues(null);
                setShowVoiceDesigner(true);
              }
            }}
          >
            {showVoiceDesigner ? '✕ Cancel Voice Design' : '✨ Design Custom Voice'}
          </button>
        </div>

        {/* Upgraded Staged Voice Designer */}
        {showVoiceDesigner && (
          <VoiceDesigner
            compact
            initialValues={designerInitialValues}
            onVoiceCreated={async (newVoice) => {
              await loadVoices();
              setNarratorVoiceId(newVoice.id);
              setShowVoiceDesigner(false);
              setDesignerInitialValues(null);
              setVoiceCreateSuccess(`Created and saved "${newVoice.label}" to Voice Library!`);
            }}
            onCancel={() => {
              setShowVoiceDesigner(false);
              setDesignerInitialValues(null);
            }}
          />
        )}

        {/* Story Voice Candidates Grid */}
        {story.voice_candidates && story.voice_candidates.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
            {story.voice_candidates.map((vc, idx) => {
              const auditionKey = `candidate-${idx}`;
              const isSaved = savedCandidateLabels.has(vc.label) || voices.some((v) => v.label.toLowerCase() === vc.label.toLowerCase());

              return (
                <div key={idx} className="card-tactile" style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{vc.label}</span>
                      <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                        {vc.suggested_for}
                      </span>
                    </div>
                    <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8rem', color: 'var(--ink-muted)', lineHeight: '1.4' }}>
                      {vc.description}
                    </p>
                  </div>

                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', borderTop: '1px dashed var(--ink-muted)', paddingTop: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn-tactile"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', minHeight: '34px' }}
                      disabled={isSynthesizing}
                      onClick={() => handlePlayAudition(auditionKey, { description: vc.description })}
                    >
                      {auditioningKey === auditionKey ? '⏹ Stop' : '🔊 5s Preview'}
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', minHeight: '34px' }}
                      disabled={isSynthesizing || isSaved}
                      onClick={() => handleSaveCandidate(vc.label, vc.description, vc.suggested_for)}
                    >
                      {isSaved ? '✓ In Library' : '💾 Save to Library'}
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', minHeight: '34px' }}
                      disabled={isSynthesizing}
                      onClick={() => handleCustomizeCandidate(vc.label, vc.description, vc.suggested_for)}
                      title="Open in Custom Voice Designer to tweak prompt or pace"
                    >
                      ✨ Customize
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: '0.85rem', fontStyle: 'italic', color: 'var(--ink-muted)' }}>
            No voice candidates proposed yet. Click &ldquo;🎬 2. Auto-Direct Voices &amp; Pacing&rdquo; above to generate candidate designs.
          </p>
        )}
      </div>

      {/* SECTION 2: Casting & Synthesis Workbench */}
      <div className="card-tactile" style={{ padding: '1rem', marginBottom: '1.5rem', backgroundColor: 'var(--bg-well)' }}>
        <h4 style={{ margin: '0 0 0.75rem 0', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
          CASTING &amp; TTS SYNTHESIS
        </h4>

        {/* Mode Toggle */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn-tactile ${castingMode === 'solo' ? 'btn-tactile-primary' : ''}`}
            disabled={isSynthesizing}
            onClick={() => handleToggleCastingMode('solo')}
          >
            🎙️ Solo Storyteller
          </button>
          <button
            type="button"
            className={`btn-tactile ${castingMode === 'cast' ? 'btn-tactile-primary' : ''}`}
            disabled={isSynthesizing}
            onClick={() => handleToggleCastingMode('cast')}
          >
            🎭 Multi-Speaker Cast ({story.characters.length + 1} Speakers)
          </button>
        </div>

        {/* Casting Pickers */}
        {loadingVoices ? (
          <p style={{ margin: 0, fontSize: '0.85rem', fontStyle: 'italic' }}>Loading voices...</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
            {/* Narrator Voice Picker */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <label
                htmlFor="narrator-voice-select"
                style={{ minWidth: '120px', fontWeight: 600, fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}
              >
                Narrator Voice:
              </label>
              <select
                id="narrator-voice-select"
                className="select-tactile"
                style={{ flex: '1', minWidth: '220px' }}
                value={narratorVoiceId}
                disabled={isSynthesizing}
                onChange={(e) => setNarratorVoiceId(e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} ({v.source}) — {v.description.slice(0, 45)}...
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-tactile"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}
                disabled={isSynthesizing}
                onClick={() => handlePlayAudition('audition-narrator', { voiceId: narratorVoiceId })}
              >
                {auditioningKey === 'audition-narrator' ? '⏹ Stop' : '🔊 Preview'}
              </button>
            </div>

            {/* Full Prompt & Details of Selected Narrator Voice */}
            {selectedNarratorVoice && (
              <div
                className="card-tactile"
                style={{
                  padding: '0.75rem',
                  backgroundColor: 'var(--bg-canvas)',
                  borderLeft:
                    selectedNarratorVoice.source === 'designed'
                      ? '3px solid var(--accent-module)'
                      : '3px solid var(--accent-root)',
                  marginBottom: '0.5rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.4rem',
                    marginBottom: '0.35rem',
                  }}
                >
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      className="badge-mono"
                      style={{
                        fontSize: '0.7rem',
                        backgroundColor:
                          selectedNarratorVoice.source === 'designed'
                            ? 'var(--accent-module-bg)'
                            : 'var(--accent-root-bg)',
                        color:
                          selectedNarratorVoice.source === 'designed'
                            ? 'var(--accent-module)'
                            : 'var(--accent-root)',
                        fontWeight: 700,
                      }}
                    >
                      {selectedNarratorVoice.source === 'designed' ? 'CUSTOM DESIGNED' : 'PREBUILT'}
                    </span>
                    <span
                      className="badge-mono"
                      style={{ fontSize: '0.7rem', backgroundColor: 'var(--bg-well)' }}
                    >
                      {PACE_BADGES[selectedNarratorVoice.default_pace || 'natural'].label}
                    </span>
                    {selectedNarratorVoice.tags?.map((t, idx) => (
                      <span key={idx} style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}>
                        #{t}
                      </span>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={async () => {
                        try {
                          if (navigator.clipboard?.writeText) {
                            await navigator.clipboard.writeText(selectedNarratorVoice.description);
                          }
                        } catch {
                          // ignore
                        }
                        setCopiedPrompt(true);
                        setTimeout(() => setCopiedPrompt(false), 2000);
                      }}
                      style={{ fontSize: '0.7rem', padding: '0.15rem 0.45rem', minHeight: '28px' }}
                    >
                      {copiedPrompt ? '✓ Copied' : '📋 Copy Prompt'}
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => setShowFullNarratorPrompt(!showFullNarratorPrompt)}
                      style={{ fontSize: '0.7rem', padding: '0.15rem 0.45rem', minHeight: '28px' }}
                    >
                      {showFullNarratorPrompt ? '👁️ Collapse' : '👁️ View Prompt'}
                    </button>
                  </div>
                </div>

                {showFullNarratorPrompt && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: '0.8rem',
                      color: 'var(--ink-primary)',
                      lineHeight: '1.45',
                      fontFamily: 'var(--font-prose)',
                    }}
                  >
                    {selectedNarratorVoice.description}
                  </p>
                )}
              </div>
            )}

            {/* Character Pickers (in Cast Mode) */}
            {castingMode === 'cast' && (
              <div style={{ borderLeft: '3px solid var(--accent-module)', paddingLeft: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--accent-module)', fontWeight: 600 }}>
                  CHARACTER VOICE ASSIGNMENTS
                </span>
                {story.characters.length === 0 ? (
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                    No characters defined. Add characters in the script editor above or use Solo mode.
                  </p>
                ) : (
                  story.characters.map((char) => {
                    const charVoiceId = characterVoices[char.name] || voices[0]?.id || '';
                    const auditionKey = `char-${char.name}`;

                    return (
                      <div key={char.name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <div style={{ minWidth: '120px' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>
                            {char.name}
                          </span>
                          {char.traits && (
                            <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--ink-muted)' }}>
                              {char.traits.slice(0, 25)}
                            </span>
                          )}
                        </div>
                        <select
                          className="select-tactile"
                          style={{ flex: '1', minWidth: '220px' }}
                          value={charVoiceId}
                          disabled={isSynthesizing}
                          onChange={(e) =>
                            setCharacterVoices({
                              ...characterVoices,
                              [char.name]: e.target.value,
                            })
                          }
                        >
                          {voices.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label} ({v.source})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}
                          disabled={isSynthesizing}
                          onClick={() => handlePlayAudition(auditionKey, { voiceId: charVoiceId })}
                        >
                          {auditioningKey === auditionKey ? '⏹ Stop' : '🔊 Preview'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* Narration Pace Selector */}
        <div style={{ marginBottom: '1rem', borderTop: '1px dashed var(--ink-muted)', paddingTop: '0.75rem' }}>
          <label style={{ display: 'block', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: '0.35rem' }}>
            Narration Pace (Story Step 3):
          </label>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn-tactile ${narrationPace === 'inherit' ? 'btn-tactile-primary' : ''}`}
              onClick={() => setNarrationPace('inherit')}
              disabled={isSynthesizing}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem', minHeight: '38px' }}
            >
              Inherit Voice Default ({selectedNarratorVoice ? PACE_BADGES[selectedNarratorVoice.default_pace || 'natural'].label : '✨ Natural'})
            </button>
            {(['slow', 'calm', 'natural', 'lively'] as VoicePace[]).map((p) => {
              const isSelected = narrationPace === p;
              return (
                <button
                  key={p}
                  type="button"
                  className={`btn-tactile ${isSelected ? 'btn-tactile-primary' : ''}`}
                  onClick={() => setNarrationPace(p)}
                  disabled={isSynthesizing}
                  style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem', minHeight: '38px' }}
                >
                  {PACE_BADGES[p].label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Synthesis Options & Action */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', borderTop: '1px solid var(--ink-muted)', paddingTop: '0.75rem' }}>
          <div style={{ flex: '1', minWidth: '200px' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', marginBottom: '0.2rem' }}>
              Version Label
            </label>
            <input
              type="text"
              className="input-tactile"
              style={{ width: '100%', boxSizing: 'border-box' }}
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              disabled={isSynthesizing}
              placeholder="e.g. Solo Narration"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '1.25rem' }}>
            <input
              type="checkbox"
              id="set-default-check"
              checked={setAsDefault}
              disabled={isSynthesizing}
              onChange={(e) => setSetAsDefault(e.target.checked)}
            />
            <label htmlFor="set-default-check" style={{ fontSize: '0.85rem', cursor: isSynthesizing ? 'not-allowed' : 'pointer' }}>
              Set as default version
            </label>
          </div>

          <button
            type="button"
            className="btn-tactile btn-tactile-primary"
            style={{ marginTop: '1.25rem', padding: '0.65rem 1.25rem', fontSize: '0.95rem' }}
            disabled={isSynthesizing || loadingVoices}
            onClick={handleSynthesize}
          >
            {isSynthesizing
              ? `🎧 Synthesizing... (${elapsedSeconds}s)`
              : '🎧 3. Synthesize & Publish Audio'}
          </button>
        </div>

        {isSynthesizing && (
          <div
            className="card-tactile tactile-progress-card"
            role="status"
            aria-live="polite"
            style={{
              marginTop: '1rem',
              padding: '1.25rem',
              border: '2px solid var(--accent-module)',
              backgroundColor: 'var(--accent-module-bg)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <span className="spinner-tactile" style={{ fontSize: '1.2rem' }}>🎧</span>
              <strong style={{ fontSize: '1rem', color: 'var(--ink-primary)' }}>
                Synthesizing audio turns with Gemini 3.8 Flash TTS... {elapsedSeconds}s
              </strong>
            </div>
            <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              🎧 Synthesizing audio turns with Gemini 3.8 Flash TTS... {elapsedSeconds}s. Producing speech chunks and assembling 24kHz studio WAV. Running in the background — you can safely switch stories or close this tab.
            </p>
            <div className="tactile-progress-bar-container">
              <div className="tactile-progress-bar-indeterminate" />
            </div>
          </div>
        )}

        {synthError && (
          <p style={{ margin: '0.75rem 0 0 0', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
            ⚠️ {synthError}
          </p>
        )}
        {synthSuccess && (
          <p style={{ margin: '0.75rem 0 0 0', color: 'var(--accent-root)', fontSize: '0.85rem', fontWeight: 600 }}>
            ✓ Audio synthesized and published successfully!
          </p>
        )}
      </div>

      {/* SECTION 3: Audio Versions Manager */}
      <div>
        <h4 style={{ margin: '0 0 0.75rem 0', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
          AUDIO VERSIONS ({story.audio_versions.length})
        </h4>

        {story.audio_versions.length === 0 ? (
          <div className="card-tactile" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--ink-muted)' }}>
            <p style={{ margin: 0, fontStyle: 'italic' }}>
              No audio versions generated yet. Complete Step 3 above to produce studio audio.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {story.audio_versions.map((ver) => {
              const isDeleting = deletingVersionId === ver.version_id;
              const isConfirming = confirmDeleteId === ver.version_id;

              return (
                <div
                  key={ver.version_id}
                  className="card-tactile"
                  style={{
                    padding: '0.85rem',
                    backgroundColor: ver.is_default ? 'var(--bg-surface)' : 'var(--bg-canvas)',
                    borderLeft: ver.is_default ? '4px solid var(--accent-root)' : '2px solid var(--ink-primary)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{ver.label}</span>
                      <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                        {ver.casting.mode.toUpperCase()}
                      </span>
                      {ver.casting.pace && (
                        <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                          {PACE_BADGES[ver.casting.pace].label}
                        </span>
                      )}
                      <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                        {formatDuration(ver.duration_sec)}
                      </span>
                      {ver.is_default && (
                        <span
                          className="badge-mono"
                          style={{
                            fontSize: '0.7rem',
                            backgroundColor: 'var(--accent-root-bg)',
                            color: 'var(--accent-root)',
                            fontWeight: 700,
                          }}
                        >
                          ★ DEFAULT
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <a
                        href={getWavDownloadHref(ver)}
                        download
                        className="btn-tactile"
                        data-testid={`download-wav-${ver.version_id}`}
                        style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', textDecoration: 'none' }}
                      >
                        ⬇ WAV
                      </a>

                      {!ver.is_default && (
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                          disabled={isSynthesizing}
                          onClick={() => handleSetDefault(ver.version_id)}
                        >
                          ★ Set Default
                        </button>
                      )}

                      {isConfirming ? (
                        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-state)' }}>Delete?</span>
                          <button
                            type="button"
                            className="btn-tactile"
                            style={{
                              fontSize: '0.75rem',
                              padding: '0.2rem 0.5rem',
                              backgroundColor: 'var(--accent-state-bg)',
                              color: 'var(--accent-state)',
                            }}
                            disabled={isDeleting || isSynthesizing}
                            onClick={() => handleDeleteVersion(ver.version_id)}
                          >
                            {isDeleting ? 'Deleting...' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            className="btn-tactile"
                            style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                            disabled={isSynthesizing}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                          disabled={isDeleting || isSynthesizing}
                          onClick={() => setConfirmDeleteId(ver.version_id)}
                        >
                          🗑 Delete
                        </button>
                      )}
                    </div>
                  </div>

                  <audio
                    controls
                    src={ver.audio_url}
                    style={{ width: '100%', height: '36px', marginTop: '0.25rem' }}
                    preload="none"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>

    {/* Dynamic Bucket-Driven Podcast Release Section (shown only when >= 1 podcast exists & story has audio) */}
    {podcasts.length > 0 && story.audio_versions.length > 0 && (
      <section
        className="card-tactile"
        data-testid="story-podcast-release-panel"
        style={{
          padding: '1.1rem',
          backgroundColor: 'var(--bg-surface)',
          borderLeft: '4px solid var(--accent-primary)',
          marginTop: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <h4
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.85rem',
              fontWeight: 700,
              color: 'var(--ink-primary)',
            }}
          >
            📻 PODCAST RELEASE
          </h4>
          <span style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>
            Release this story directly to private Apple Podcasts feeds
          </span>
        </div>

        {podcastError && (
          <p style={{ margin: '0 0 0.6rem 0', color: 'var(--accent-state)', fontSize: '0.8rem', fontWeight: 600 }}>
            ⚠️ {podcastError}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {podcasts.map((podcast) => {
            const existingEp = (podcast.episodes || []).find((ep) => ep.story_id === story.id);
            const defaultVerId =
              story.audio_versions.find((v) => v.is_default)?.version_id ||
              story.audio_versions[0].version_id;
            const selectedVerId =
              selectedPodcastVersions[podcast.id] ||
              existingEp?.version_id ||
              defaultVerId;
            const isBusy = podcastBusyId === podcast.id;
            const versionChanged = Boolean(existingEp && selectedVerId !== existingEp.version_id);

            return (
              <div
                key={podcast.id}
                className="card-tactile"
                data-testid={`story-podcast-row-${podcast.id}`}
                style={{
                  padding: '0.7rem 0.85rem',
                  backgroundColor: 'var(--bg-canvas)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.6rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--ink-primary)' }}>
                    {podcast.title}
                  </span>
                  <span
                    className="badge-mono"
                    style={{
                      fontSize: '0.7rem',
                      backgroundColor: existingEp ? 'var(--accent-root-bg)' : 'var(--bg-well)',
                      color: existingEp ? 'var(--accent-root)' : 'var(--ink-muted)',
                      fontWeight: existingEp ? 700 : 500,
                    }}
                  >
                    {existingEp ? '✓ Released' : 'Not Released'}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                  {story.audio_versions.length > 1 && (
                    <select
                      aria-label={`Select audio version for ${podcast.title}`}
                      data-testid={`podcast-release-version-${podcast.id}`}
                      className="input-tactile"
                      value={selectedVerId}
                      disabled={isBusy}
                      onChange={(e) =>
                        setSelectedPodcastVersions((prev) => ({
                          ...prev,
                          [podcast.id]: e.target.value,
                        }))
                      }
                      style={{ fontSize: '0.8rem', padding: '0.25rem 0.45rem' }}
                    >
                      {story.audio_versions.map((ver) => (
                        <option key={ver.version_id} value={ver.version_id}>
                          {ver.label}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    className={`btn-tactile ${!existingEp || versionChanged ? 'btn-tactile-primary' : ''}`}
                    data-testid={`podcast-release-btn-${podcast.id}`}
                    disabled={isBusy}
                    onClick={() => handleReleaseToPodcast(podcast.id, selectedVerId)}
                    style={{ fontSize: '0.78rem', padding: '0.3rem 0.65rem' }}
                  >
                    {existingEp
                      ? versionChanged
                        ? '🔄 Update Version'
                        : '✓ Released'
                      : '📻 Release to Podcast'}
                  </button>

                  {existingEp && (
                    <button
                      type="button"
                      className="btn-tactile"
                      data-testid={`podcast-unrelease-btn-${podcast.id}`}
                      disabled={isBusy}
                      onClick={() => handleUnreleaseFromPodcast(podcast.id)}
                      style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem', color: 'var(--accent-state)' }}
                    >
                      ✕ Unrelease
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    )}
  </div>
);
}

function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
