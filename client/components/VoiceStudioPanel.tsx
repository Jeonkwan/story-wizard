import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Story, VoiceCasting, VoiceEntry } from '../../shared/types';
import {
  fetchVoices,
  previewVoiceAudio,
  createCustomVoice,
  synthesizeStoryAudio,
  setDefaultAudioVersion,
  deleteAudioVersion,
} from '../api/client';

export interface VoiceStudioPanelProps {
  story: Story;
  onStoryUpdated: (updatedStory: Story) => void;
  onBeforeSynthesize?: () => Promise<void>;
}

export function VoiceStudioPanel({
  story,
  onStoryUpdated,
  onBeforeSynthesize,
}: VoiceStudioPanelProps): React.JSX.Element {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loadingVoices, setLoadingVoices] = useState<boolean>(true);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  // Casting state
  const [castingMode, setCastingMode] = useState<'solo' | 'cast'>('solo');
  const [narratorVoiceId, setNarratorVoiceId] = useState<string>('');
  const [characterVoices, setCharacterVoices] = useState<Record<string, string>>({});
  const [versionLabel, setVersionLabel] = useState<string>('');
  const [setAsDefault, setSetAsDefault] = useState<boolean>(true);

  // Synthesis progress state
  const [isSynthesizing, setIsSynthesizing] = useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [synthSuccess, setSynthSuccess] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Audition playback state
  const [auditioningKey, setAuditioningKey] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentBlobUrlRef = useRef<string | null>(null);

  // Custom Voice Designer state
  const [showVoiceDesigner, setShowVoiceDesigner] = useState<boolean>(false);
  const [newVoiceLabel, setNewVoiceLabel] = useState<string>('');
  const [newVoiceDescription, setNewVoiceDescription] = useState<string>('');
  const [isCreatingVoice, setIsCreatingVoice] = useState<boolean>(false);
  const [voiceCreateError, setVoiceCreateError] = useState<string | null>(null);
  const [voiceCreateSuccess, setVoiceCreateSuccess] = useState<string | null>(null);

  // Track saved candidates to show "Saved" state
  const [savedCandidateLabels, setSavedCandidateLabels] = useState<Set<string>>(new Set());

  // Version management actions
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  const [versionActionError, setVersionActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
        const preferredId = story.series_context?.preferred_voice_id;
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
  }, [story.series_context?.preferred_voice_id]);

  useEffect(() => {
    loadVoices();
  }, [loadVoices]);

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
      const preferredId = story.series_context?.preferred_voice_id;
      const hasPreferred = preferredId && voices.some((v) => v.id === preferredId);
      const defaultVoice = hasPreferred
        ? preferredId!
        : voices.find((v) => v.id === 'prebuilt-kore')?.id || voices[0].id;
      setNarratorVoiceId(defaultVoice);
    }
    setVersionLabel(castingMode === 'solo' ? 'Bedtime Solo' : 'Bedtime Cast');
  }, [story.id, stopAudition]);

  // Initialize casting defaults once voices are loaded or characters change
  useEffect(() => {
    if (voices.length === 0) return;

    // Pick preferred voice if matched, or prebuilt-kore, or first voice
    const preferredId = story.series_context?.preferred_voice_id;
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
          // Rotate starter voices across characters
          const candidateVoice =
            voices.find((v) => v.id === (idx % 2 === 0 ? 'prebuilt-puck' : 'prebuilt-aoede'))?.id ||
            voices[idx % voices.length].id;
          updated[char.name] = candidateVoice;
        }
      });
      return updated;
    });

    if (!versionLabel) {
      setVersionLabel(castingMode === 'solo' ? 'Bedtime Solo' : 'Bedtime Cast');
    }
  }, [voices, story.series_context?.preferred_voice_id, story.characters, narratorVoiceId, versionLabel, castingMode]);

  // Play a 5-second audition preview
  const handlePlayAudition = async (
    key: string,
    params: { voiceId?: string; description?: string; sampleText?: string }
  ) => {
    if (auditioningKey === key) {
      stopAudition();
      return;
    }

    stopAudition();
    setAuditioningKey(key);
    setAuditionError(null);

    try {
      const blob = await previewVoiceAudio(params);
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

  // Design custom voice
  const handleCreateCustomVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVoiceLabel.trim() || !newVoiceDescription.trim()) return;

    setIsCreatingVoice(true);
    setVoiceCreateError(null);
    setVoiceCreateSuccess(null);

    try {
      const created = await createCustomVoice({
        label: newVoiceLabel.trim(),
        description: newVoiceDescription.trim(),
      });
      setNewVoiceLabel('');
      setNewVoiceDescription('');
      setShowVoiceDesigner(false);
      await loadVoices();
      setVoiceCreateSuccess(`Created and saved "${created.label}" to Voice Library!`);
    } catch (err) {
      setVoiceCreateError(err instanceof Error ? err.message : 'Failed to create custom voice');
    } finally {
      setIsCreatingVoice(false);
    }
  };

  // Mode toggle with default label sync
  const handleToggleCastingMode = (newMode: 'solo' | 'cast') => {
    setCastingMode(newMode);
    if (newMode === 'cast' && versionLabel === 'Bedtime Solo') {
      setVersionLabel('Bedtime Cast');
    } else if (newMode === 'solo' && versionLabel === 'Bedtime Cast') {
      setVersionLabel('Bedtime Solo');
    }
  };

  // Synthesize Full Story
  const handleSynthesize = async () => {
    const effectiveNarratorVoiceId =
      narratorVoiceId ||
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
      // Save any pending edits before running synthesis
      if (onBeforeSynthesize) {
        await onBeforeSynthesize();
      }

      const casting: VoiceCasting = {
        mode: castingMode,
        narrator_voice_id: effectiveNarratorVoiceId,
        character_voices: castingMode === 'cast' ? characterVoices : {},
      };

      const updatedStory = await synthesizeStoryAudio(story.id, {
        casting,
        label: versionLabel.trim() || (castingMode === 'solo' ? 'Bedtime Solo' : 'Bedtime Cast'),
        makeDefault: setAsDefault,
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

  // Format seconds to mm:ss
  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${mins}m ${rem < 10 ? '0' : ''}${rem}s`;
  };

  return (
    <section className="card-tactile voice-studio-panel" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
      <header style={{ marginBottom: '1.25rem', borderBottom: '1px solid var(--ink-muted)', paddingBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: '1.3rem' }}>
              🎙️ Step 3: Voice Audition, Synthesis &amp; Versions
            </h3>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              Audition voices with Gemini 3.8 Flash-Lite TTS, cast characters, and synthesize full bedtime studio audio.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span className="badge-mono" style={{ fontSize: '0.8rem' }}>
              {story.audio_versions.length} {story.audio_versions.length === 1 ? 'VERSION' : 'VERSIONS'}
            </span>
            <span className="badge-mono" style={{ fontSize: '0.8rem', backgroundColor: story.status === 'published' ? 'var(--accent-root-bg)' : 'var(--accent-state-bg)', color: story.status === 'published' ? 'var(--accent-root)' : 'var(--accent-state)' }}>
              {story.status.toUpperCase()}
            </span>
          </div>
        </div>
      </header>

      {/* Global Notice / Error Banners */}
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
            onClick={() => setShowVoiceDesigner(!showVoiceDesigner)}
          >
            {showVoiceDesigner ? '✕ Cancel Voice Design' : '✨ Design Custom Voice'}
          </button>
        </div>

        {/* Custom Voice Designer Form */}
        {showVoiceDesigner && (
          <form
            onSubmit={handleCreateCustomVoice}
            className="card-tactile"
            style={{ padding: '1rem', marginBottom: '1rem', backgroundColor: 'var(--bg-well)' }}
          >
            <h5 style={{ margin: '0 0 0.5rem 0', fontFamily: 'var(--font-heading)', fontSize: '1rem' }}>
              Design Custom Prompted Voice
            </h5>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', marginBottom: '0.2rem' }}>
                Voice Label
              </label>
              <input
                type="text"
                className="input-tactile"
                style={{ width: '100%', boxSizing: 'border-box' }}
                placeholder="e.g. Grandma Willow"
                value={newVoiceLabel}
                onChange={(e) => setNewVoiceLabel(e.target.value)}
                required
              />
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', marginBottom: '0.2rem' }}>
                Natural-Language Voice Description Prompt
              </label>
              <textarea
                className="input-tactile"
                style={{ width: '100%', minHeight: '60px', boxSizing: 'border-box' }}
                placeholder="e.g. Warm, elderly grandmother with a gentle cadence and soothing bedtime chuckle."
                value={newVoiceDescription}
                onChange={(e) => setNewVoiceDescription(e.target.value)}
                required
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-tactile"
                disabled={!newVoiceDescription.trim()}
                onClick={() =>
                  handlePlayAudition('custom-design-preview', {
                    description: newVoiceDescription.trim(),
                  })
                }
              >
                {auditioningKey === 'custom-design-preview' ? '⏹ Stop' : '🔊 5s Preview'}
              </button>
              <button
                type="submit"
                className="btn-tactile btn-tactile-primary"
                disabled={isCreatingVoice || !newVoiceLabel.trim() || !newVoiceDescription.trim()}
              >
                {isCreatingVoice ? '💾 Creating Voice...' : '💾 Save to Voice Library'}
              </button>
            </div>
          </form>
        )}

        {/* Story Voice Candidates Grid */}
        {story.voice_candidates && story.voice_candidates.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
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
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                      onClick={() => handlePlayAudition(auditionKey, { description: vc.description })}
                    >
                      {auditioningKey === auditionKey ? '⏹ Stop' : '🔊 5s Preview'}
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                      disabled={isSaved}
                      onClick={() => handleSaveCandidate(vc.label, vc.description, vc.suggested_for)}
                    >
                      {isSaved ? '✓ In Library' : '💾 Save to Library'}
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
            onClick={() => handleToggleCastingMode('solo')}
          >
            🎙️ Solo Storyteller
          </button>
          <button
            type="button"
            className={`btn-tactile ${castingMode === 'cast' ? 'btn-tactile-primary' : ''}`}
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
              <label style={{ minWidth: '120px', fontWeight: 600, fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>
                Narrator Voice:
              </label>
              <select
                className="select-tactile"
                style={{ flex: '1', minWidth: '220px' }}
                value={narratorVoiceId}
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
                onClick={() => handlePlayAudition('audition-narrator', { voiceId: narratorVoiceId })}
              >
                {auditioningKey === 'audition-narrator' ? '⏹ Stop' : '🔊 Preview'}
              </button>
            </div>

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
              placeholder="e.g. Bedtime Solo"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '1.25rem' }}>
            <input
              type="checkbox"
              id="set-default-check"
              checked={setAsDefault}
              onChange={(e) => setSetAsDefault(e.target.checked)}
            />
            <label htmlFor="set-default-check" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
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
              No audio versions generated yet. Complete Step 3 above to produce studio bedtime audio.
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

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      {!ver.is_default && (
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
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
                            disabled={isDeleting}
                            onClick={() => handleDeleteVersion(ver.version_id)}
                          >
                            {isDeleting ? 'Deleting...' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            className="btn-tactile"
                            style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
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
                          onClick={() => setConfirmDeleteId(ver.version_id)}
                        >
                          🗑 Delete
                        </button>
                      )}
                    </div>
                  </div>

                  <audio
                    controls
                    preload="metadata"
                    src={ver.audio_url}
                    style={{ width: '100%', height: '36px', marginTop: '0.25rem' }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
