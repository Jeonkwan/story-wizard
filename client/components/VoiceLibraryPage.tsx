import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { CatalogItem, VoiceEntry, VoicePace } from '../../shared/types';
import {
  fetchVoices,
  fetchAdminStories,
  previewVoiceAudio,
  updateVoice,
  deleteVoice,
  synthesizeStoryAudio,
  type AdminSession,
} from '../api/client';
import { VoiceDesigner } from './VoiceDesigner';

export interface VoiceLibraryPageProps {
  session: AdminSession;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onNavigateHome: () => void;
  onCatalogChanged?: () => void;
}

const PACE_BADGES: Record<VoicePace, { label: string; desc: string }> = {
  slow: { label: '🐢 Slow', desc: 'Soothing & unhurried' },
  calm: { label: '🌙 Calm', desc: 'Measured & relaxed' },
  natural: { label: '✨ Natural', desc: 'Balanced rhythm' },
  lively: { label: '⚡ Lively', desc: 'Animated & upbeat' },
};

export function VoiceLibraryPage({
  session: _session,
  onLogout: _onLogout,
  onNavigate,
  onNavigateHome: _onNavigateHome,
  onCatalogChanged,
}: VoiceLibraryPageProps): React.JSX.Element {
  // Voice catalog state
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loadingVoices, setLoadingVoices] = useState<boolean>(true);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'designed' | 'prebuilt'>('all');

  // Top Designer Remix Initial Values & Ref
  const [remixValues, setRemixValues] = useState<{
    label?: string;
    description?: string;
    defaultPace?: VoicePace;
    tags?: string[];
  } | null>(null);
  const topDesignerRef = useRef<HTMLDivElement | null>(null);

  // Audition playback state
  const [auditioningVoiceId, setAuditioningVoiceId] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Inline metadata edit state
  const [editingVoiceId, setEditingVoiceId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState<string>('');
  const [editTags, setEditTags] = useState<string>('');
  const [editPace, setEditPace] = useState<VoicePace>('natural');
  const [isSavingEdit, setIsSavingEdit] = useState<boolean>(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Deletion confirm state
  const [deleteConfirmVoiceId, setDeleteConfirmVoiceId] = useState<string | null>(null);
  const [isDeletingVoice, setIsDeletingVoice] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Copy prompt notification state
  const [copiedVoiceId, setCopiedVoiceId] = useState<string | null>(null);

  // Narrate Story Modal state
  const [narrationTargetVoice, setNarrationTargetVoice] = useState<VoiceEntry | null>(null);
  const [stories, setStories] = useState<CatalogItem[]>([]);
  const [loadingStories, setLoadingStories] = useState<boolean>(false);
  const [selectedStoryId, setSelectedStoryId] = useState<string>('');
  const [narrationLabel, setNarrationLabel] = useState<string>('');
  const [narrationPace, setNarrationPace] = useState<VoicePace>('natural');
  const [narrationMakeDefault, setNarrationMakeDefault] = useState<boolean>(true);
  const [isNarrating, setIsNarrating] = useState<boolean>(false);
  const [narrateElapsedSeconds, setNarrateElapsedSeconds] = useState<number>(0);
  const [narrateError, setNarrateError] = useState<string | null>(null);
  const [narrateSuccessStoryId, setNarrateSuccessStoryId] = useState<string | null>(null);
  const narrateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop audition helper
  const stopAudition = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onerror = null;
      audioRef.current.onended = null;
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setAuditioningVoiceId(null);
  }, []);

  useEffect(() => {
    return () => {
      stopAudition();
      if (narrateTimerRef.current) {
        clearInterval(narrateTimerRef.current);
      }
    };
  }, [stopAudition]);

  // Load voice catalog
  const loadVoices = useCallback(async () => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const list = await fetchVoices();
      setVoices(list);
    } catch (err) {
      setVoicesError(err instanceof Error ? err.message : 'Failed to load voices');
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  // Handle Play Audition for saved voice
  const handleToggleAudition = async (voice: VoiceEntry) => {
    if (auditioningVoiceId === voice.id) {
      stopAudition();
      return;
    }

    stopAudition();
    setAuditioningVoiceId(voice.id);
    setAuditionError(null);

    try {
      // If voice has cached preview audio URL, play it directly
      if (voice.preview_audio_url) {
        const audio = new Audio(voice.preview_audio_url);
        audioRef.current = audio;
        audio.onended = () => stopAudition();
        audio.onerror = async () => {
          // Fall back to live synthesis if cached file fails
          try {
            const { blob } = await previewVoiceAudio({
              voiceId: voice.id,
              pace: voice.default_pace,
            });
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            const fallbackAudio = new Audio(url);
            audioRef.current = fallbackAudio;
            fallbackAudio.onended = () => stopAudition();
            fallbackAudio.onerror = () => {
              setAuditionError(`Audio playback failed for ${voice.label}`);
              stopAudition();
            };
            await fallbackAudio.play();
          } catch {
            setAuditionError(`Audio playback failed for ${voice.label}`);
            stopAudition();
          }
        };
        await audio.play();
      } else {
        // Fall back to live synthesis preview
        const { blob } = await previewVoiceAudio({
          voiceId: voice.id,
          pace: voice.default_pace,
        });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => stopAudition();
        audio.onerror = () => {
          setAuditionError(`Audio preview failed for ${voice.label}`);
          stopAudition();
        };
        await audio.play();
      }
    } catch (err) {
      setAuditionError(err instanceof Error ? err.message : 'Audition preview failed');
      stopAudition();
    }
  };

  // Copy prompt helper
  const handleCopyPrompt = async (voice: VoiceEntry) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(voice.description);
      }
    } catch {
      // Ignore clipboard error in restricted headless environments
    }
    setCopiedVoiceId(voice.id);
    setTimeout(() => {
      setCopiedVoiceId((prev) => (prev === voice.id ? null : prev));
    }, 2000);
  };

  // Clone / Remix Voice to top designer
  const handleRemixVoice = (voice: VoiceEntry) => {
    setRemixValues({
      label: `${voice.label} (Remix)`,
      description: voice.description,
      defaultPace: voice.default_pace || 'natural',
      tags: voice.tags || [],
    });
    // Smooth scroll to top designer
    if (topDesignerRef.current?.scrollIntoView) {
      topDesignerRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Start inline editing
  const handleStartEdit = (voice: VoiceEntry) => {
    setEditingVoiceId(voice.id);
    setEditLabel(voice.label);
    setEditTags(voice.tags.join(', '));
    setEditPace(voice.default_pace || 'natural');
    setEditError(null);
  };

  // Cancel inline editing
  const handleCancelEdit = () => {
    setEditingVoiceId(null);
    setEditError(null);
  };

  // Save inline editing
  const handleSaveEdit = async (voiceId: string) => {
    if (!editLabel.trim()) {
      setEditError('Voice label cannot be empty');
      return;
    }
    setIsSavingEdit(true);
    setEditError(null);
    try {
      const parsedTags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await updateVoice(voiceId, {
        label: editLabel.trim(),
        tags: parsedTags,
        defaultPace: editPace,
      });
      setVoices((prev) => prev.map((v) => (v.id === voiceId ? updated : v)));
      setEditingVoiceId(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update voice');
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Delete Voice
  const handleDeleteVoice = async (voiceId: string) => {
    setIsDeletingVoice(true);
    setDeleteError(null);
    try {
      await deleteVoice(voiceId);
      setVoices((prev) => prev.filter((v) => v.id !== voiceId));
      setDeleteConfirmVoiceId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete voice');
    } finally {
      setIsDeletingVoice(false);
    }
  };

  // Open Narrate Story Modal
  const handleOpenNarrateModal = async (voice: VoiceEntry) => {
    setNarrationTargetVoice(voice);
    setNarrationLabel(`Solo — ${voice.label}`);
    setNarrationPace(voice.default_pace || 'natural');
    setNarrationMakeDefault(true);
    setNarrateError(null);
    setNarrateSuccessStoryId(null);
    setIsNarrating(false);
    setNarrateElapsedSeconds(0);

    setLoadingStories(true);
    try {
      const items = await fetchAdminStories();
      setStories(items);
      if (items.length > 0) {
        setSelectedStoryId(items[0].id);
      }
    } catch (err) {
      setNarrateError(err instanceof Error ? err.message : 'Failed to load stories');
    } finally {
      setLoadingStories(false);
    }
  };

  // Close Narrate Story Modal
  const handleCloseNarrateModal = () => {
    if (narrateTimerRef.current) {
      clearInterval(narrateTimerRef.current);
      narrateTimerRef.current = null;
    }
    setNarrationTargetVoice(null);
    setIsNarrating(false);
  };

  // Action 1: Generate Solo Audio Now
  const handleGenerateSoloNow = async () => {
    if (!narrationTargetVoice || !selectedStoryId) return;

    setIsNarrating(true);
    setNarrateError(null);
    setNarrateSuccessStoryId(null);
    setNarrateElapsedSeconds(0);

    narrateTimerRef.current = setInterval(() => {
      setNarrateElapsedSeconds((sec) => sec + 1);
    }, 1000);

    try {
      await synthesizeStoryAudio(
        selectedStoryId,
        {
          casting: {
            mode: 'solo',
            narrator_voice_id: narrationTargetVoice.id,
            character_voices: {},
            pace: narrationPace,
          },
          label: narrationLabel.trim() || `Solo — ${narrationTargetVoice.label}`,
          makeDefault: narrationMakeDefault,
          async: true,
          onProgress: (job) => setNarrateElapsedSeconds(job.elapsed_seconds),
        }
      );

      if (narrateTimerRef.current) {
        clearInterval(narrateTimerRef.current);
        narrateTimerRef.current = null;
      }
      setIsNarrating(false);
      setNarrateSuccessStoryId(selectedStoryId);
      onCatalogChanged?.();
    } catch (err) {
      if (narrateTimerRef.current) {
        clearInterval(narrateTimerRef.current);
        narrateTimerRef.current = null;
      }
      setIsNarrating(false);
      setNarrateError(err instanceof Error ? err.message : 'Audio narration generation failed');
    }
  };

  // Action 2: Open in Story Step 3
  const handleOpenInStep3 = () => {
    if (!narrationTargetVoice || !selectedStoryId) return;
    const targetUrl = `/admin?storyId=${encodeURIComponent(selectedStoryId)}&narratorVoiceId=${encodeURIComponent(narrationTargetVoice.id)}&step=3`;
    handleCloseNarrateModal();
    onNavigate(targetUrl);
  };

  // Filtered voice list
  const filteredVoices = voices.filter((v) => {
    // Source filter
    if (sourceFilter === 'designed' && v.source !== 'designed') return false;
    if (sourceFilter === 'prebuilt' && v.source !== 'prebuilt') return false;

    // Search query filter (matches label, tags, description)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchLabel = v.label.toLowerCase().includes(q);
      const matchDesc = v.description.toLowerCase().includes(q);
      const matchTag = v.tags.some((t) => t.toLowerCase().includes(q));
      if (!matchLabel && !matchDesc && !matchTag) return false;
    }
    return true;
  });

  return (
    <div className="voice-library-page" style={{ maxWidth: '1200px', margin: '0 auto', paddingBottom: '3rem' }}>
      {/* Top Designer Section */}
      <div ref={topDesignerRef}>
        <VoiceDesigner
          initialValues={remixValues}
          onVoiceCreated={(created) => {
            setVoices((prev) => [created, ...prev.filter((v) => v.id !== created.id)]);
            setRemixValues(null);
          }}
        />
      </div>

      {/* Main Grid Header & Filters */}
      <div
        className="card-tactile"
        style={{
          padding: '1.25rem',
          marginBottom: '1.5rem',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
            flexWrap: 'wrap',
            gap: '0.75rem',
          }}
        >
          <div>
            <h3 style={{ margin: '0 0 0.25rem 0', fontFamily: 'var(--font-heading)', fontSize: '1.25rem' }}>
              🎙️ Saved Voice Catalog ({voices.length})
            </h3>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              Explore saved storyteller personas, inspect natural prompts, audition takes, or generate audio for existing stories.
            </p>
          </div>

          {/* Source Filter Buttons */}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn-tactile ${sourceFilter === 'all' ? 'btn-tactile-primary' : ''}`}
              onClick={() => setSourceFilter('all')}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem', minHeight: '38px' }}
            >
              All Voices ({voices.length})
            </button>
            <button
              type="button"
              className={`btn-tactile ${sourceFilter === 'designed' ? 'btn-tactile-primary' : ''}`}
              onClick={() => setSourceFilter('designed')}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem', minHeight: '38px' }}
            >
              Designed ({voices.filter((v) => v.source === 'designed').length})
            </button>
            <button
              type="button"
              className={`btn-tactile ${sourceFilter === 'prebuilt' ? 'btn-tactile-primary' : ''}`}
              onClick={() => setSourceFilter('prebuilt')}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem', minHeight: '38px' }}
            >
              Prebuilt ({voices.filter((v) => v.source === 'prebuilt').length})
            </button>
          </div>
        </div>

        {/* Search Input */}
        <div>
          <input
            type="search"
            className="input-tactile"
            style={{ width: '100%', boxSizing: 'border-box' }}
            placeholder="🔍 Search voices by label, tag, or prompt text..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Global Error Banner */}
      {voicesError && (
        <div
          className="card-tactile"
          role="alert"
          style={{
            borderColor: 'var(--accent-state)',
            backgroundColor: 'var(--accent-state-bg)',
            color: 'var(--accent-state)',
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
            fontWeight: 600,
          }}
        >
          ⚠️ {voicesError}
        </div>
      )}

      {auditionError && (
        <div
          className="card-tactile"
          role="alert"
          style={{
            borderColor: 'var(--accent-state)',
            backgroundColor: 'var(--accent-state-bg)',
            color: 'var(--accent-state)',
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
          }}
        >
          ⚠️ {auditionError}
        </div>
      )}

      {deleteError && (
        <div
          className="card-tactile"
          role="alert"
          style={{
            borderColor: 'var(--accent-state)',
            backgroundColor: 'var(--accent-state-bg)',
            color: 'var(--accent-state)',
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
          }}
        >
          ⚠️ {deleteError}
        </div>
      )}

      {/* Voices Grid */}
      {loadingVoices ? (
        <div className="card-tactile" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
            Loading voice library...
          </p>
        </div>
      ) : filteredVoices.length === 0 ? (
        <div className="card-tactile" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
            No voices found matching your criteria.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {filteredVoices.map((voice) => {
            const isAuditioning = auditioningVoiceId === voice.id;
            const isEditing = editingVoiceId === voice.id;
            const isConfirmingDelete = deleteConfirmVoiceId === voice.id;
            const paceInfo = PACE_BADGES[voice.default_pace || 'natural'];

            return (
              <div
                key={voice.id}
                className="card-tactile voice-card"
                style={{
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--bg-surface)',
                  borderLeft:
                    voice.source === 'designed'
                      ? '4px solid var(--accent-module)'
                      : '4px solid var(--accent-root)',
                }}
              >
                <div>
                  {/* Card Header Row */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      marginBottom: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <h4
                        style={{
                          margin: '0 0 0.25rem 0',
                          fontFamily: 'var(--font-heading)',
                          fontSize: '1.15rem',
                        }}
                      >
                        {voice.label}
                      </h4>
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span
                          className="badge-mono"
                          style={{
                            fontSize: '0.7rem',
                            backgroundColor:
                              voice.source === 'designed'
                                ? 'var(--accent-module-bg)'
                                : 'var(--accent-root-bg)',
                            color:
                              voice.source === 'designed'
                                ? 'var(--accent-module)'
                                : 'var(--accent-root)',
                            fontWeight: 700,
                          }}
                        >
                          {voice.source === 'designed' ? 'CUSTOM DESIGNED' : 'PREBUILT'}
                        </span>
                        <span
                          className="badge-mono"
                          style={{
                            fontSize: '0.7rem',
                            backgroundColor: 'var(--bg-canvas)',
                          }}
                          title={`Default Pace: ${paceInfo.desc}`}
                        >
                          {paceInfo.label}
                        </span>
                        <span
                          className="badge-mono"
                          style={{ fontSize: '0.7rem', backgroundColor: 'var(--bg-canvas)' }}
                        >
                          {voice.language_code || 'en-US'}
                        </span>
                      </div>
                    </div>

                    {/* Audition Trigger */}
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => handleToggleAudition(voice)}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.3rem 0.65rem',
                        minHeight: '36px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                      }}
                      title={isAuditioning ? 'Stop playback' : 'Audition voice sample'}
                    >
                      <span>{isAuditioning ? '⏹ Stop' : '🔊 Audition'}</span>
                    </button>
                  </div>

                  {/* Tags Row */}
                  {voice.tags && voice.tags.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.3rem',
                        flexWrap: 'wrap',
                        marginBottom: '0.75rem',
                      }}
                    >
                      {voice.tags.map((tag, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: '0.7rem',
                            fontFamily: 'var(--font-mono)',
                            padding: '0.15rem 0.4rem',
                            backgroundColor: 'var(--bg-well)',
                            borderRadius: '3px',
                            color: 'var(--ink-muted)',
                          }}
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Full Prompt Box with Copy Button */}
                  <div
                    style={{
                      backgroundColor: 'var(--bg-canvas)',
                      border: '1px solid var(--bg-well)',
                      borderRadius: '4px',
                      padding: '0.75rem',
                      marginBottom: '1rem',
                      position: 'relative',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.35rem',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--ink-muted)',
                          textTransform: 'uppercase',
                        }}
                      >
                        VOICE PROMPT
                      </span>
                      <button
                        type="button"
                        className="btn-tactile"
                        onClick={() => handleCopyPrompt(voice)}
                        style={{
                          fontSize: '0.7rem',
                          padding: '0.15rem 0.45rem',
                          minHeight: '28px',
                        }}
                        title="Copy prompt text to clipboard"
                      >
                        {copiedVoiceId === voice.id ? '✓ Copied!' : '📋 Copy Prompt'}
                      </button>
                    </div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: '0.85rem',
                        lineHeight: '1.45',
                        color: 'var(--ink-primary)',
                        fontFamily: 'var(--font-prose)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'break-word',
                        wordBreak: 'break-word',
                      }}
                    >
                      {voice.description}
                    </p>
                  </div>

                  {/* Inline Metadata Editor (if editing) */}
                  {isEditing && (
                    <div
                      className="card-tactile"
                      style={{
                        padding: '0.75rem',
                        marginBottom: '1rem',
                        backgroundColor: 'var(--bg-well)',
                      }}
                    >
                      <h5 style={{ margin: '0 0 0.5rem 0', fontSize: '0.85rem' }}>
                        Edit Voice Metadata
                      </h5>
                      {editError && (
                        <p style={{ margin: '0 0 0.5rem 0', color: 'var(--accent-state)', fontSize: '0.75rem' }}>
                          ⚠️ {editError}
                        </p>
                      )}
                      <div style={{ marginBottom: '0.5rem' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                          Label
                        </label>
                        <input
                          type="text"
                          className="input-tactile"
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.8rem' }}
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          disabled={isSavingEdit}
                        />
                      </div>
                      <div style={{ marginBottom: '0.5rem' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                          Tags (comma separated)
                        </label>
                        <input
                          type="text"
                          className="input-tactile"
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.8rem' }}
                          value={editTags}
                          onChange={(e) => setEditTags(e.target.value)}
                          disabled={isSavingEdit}
                        />
                      </div>
                      <div style={{ marginBottom: '0.75rem' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                          Default Pace
                        </label>
                        <select
                          className="select-tactile"
                          style={{ width: '100%', fontSize: '0.8rem' }}
                          value={editPace}
                          onChange={(e) => setEditPace(e.target.value as VoicePace)}
                          disabled={isSavingEdit}
                        >
                          <option value="slow">🐢 Slow (Soothing & unhurried)</option>
                          <option value="calm">🌙 Calm (Measured & relaxed)</option>
                          <option value="natural">✨ Natural (Balanced rhythm)</option>
                          <option value="lively">⚡ Lively (Animated & upbeat)</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button
                          type="button"
                          className="btn-tactile btn-tactile-primary"
                          onClick={() => handleSaveEdit(voice.id)}
                          disabled={isSavingEdit}
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                        >
                          {isSavingEdit ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="btn-tactile"
                          onClick={handleCancelEdit}
                          disabled={isSavingEdit}
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Inline Delete Confirm (if confirming) */}
                  {isConfirmingDelete && (
                    <div
                      className="card-tactile"
                      style={{
                        padding: '0.75rem',
                        marginBottom: '1rem',
                        backgroundColor: 'var(--accent-state-bg)',
                        borderColor: 'var(--accent-state)',
                      }}
                    >
                      <p
                        style={{
                          margin: '0 0 0.5rem 0',
                          fontSize: '0.8rem',
                          color: 'var(--accent-state)',
                          fontWeight: 600,
                        }}
                      >
                        Delete this custom voice?
                      </p>
                      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
                        Existing story audio recordings created with this voice remain untouched.
                      </p>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button
                          type="button"
                          className="btn-tactile"
                          onClick={() => handleDeleteVoice(voice.id)}
                          disabled={isDeletingVoice}
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.25rem 0.5rem',
                            backgroundColor: 'var(--accent-state)',
                            color: '#fff',
                          }}
                        >
                          {isDeletingVoice ? 'Deleting...' : 'Confirm Delete'}
                        </button>
                        <button
                          type="button"
                          className="btn-tactile"
                          onClick={() => setDeleteConfirmVoiceId(null)}
                          disabled={isDeletingVoice}
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Actions Toolbar */}
                <div
                  style={{
                    borderTop: '1px solid var(--ink-muted)',
                    paddingTop: '0.75rem',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.4rem',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <button
                    type="button"
                    className="btn-tactile btn-tactile-primary"
                    onClick={() => handleOpenNarrateModal(voice)}
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.35rem 0.75rem',
                      minHeight: '44px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                    }}
                  >
                    <span>🎬 Narrate a Story</span>
                  </button>

                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => handleRemixVoice(voice)}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.3rem 0.55rem',
                        minHeight: '44px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                      title="Pre-fill top designer with this voice prompt and settings"
                    >
                      <span>🧬 Remix Prompt</span>
                    </button>

                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => handleStartEdit(voice)}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.3rem 0.55rem',
                        minHeight: '44px',
                      }}
                      title="Edit label, pace, and tags"
                    >
                      <span>✏️ Edit</span>
                    </button>

                    {voice.source === 'designed' ? (
                      <button
                        type="button"
                        className="btn-tactile"
                        onClick={() => setDeleteConfirmVoiceId(voice.id)}
                        disabled={isConfirmingDelete}
                        style={{
                          fontSize: '0.75rem',
                          padding: '0.3rem 0.55rem',
                          minHeight: '44px',
                          color: 'var(--accent-state)',
                        }}
                        title="Delete custom voice"
                      >
                        <span>🗑️ Delete</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-tactile"
                        disabled
                        style={{
                          fontSize: '0.75rem',
                          padding: '0.3rem 0.55rem',
                          minHeight: '44px',
                          opacity: 0.4,
                          cursor: 'not-allowed',
                        }}
                        title="Prebuilt system voices cannot be deleted"
                      >
                        <span>🔒 Prebuilt</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Narrate a Story Modal / Drawer */}
      {narrationTargetVoice && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="narrate-modal-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '1rem',
          }}
        >
          <div
            className="card-tactile"
            style={{
              maxWidth: '560px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              backgroundColor: 'var(--bg-surface)',
              padding: '1.5rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '1rem',
              }}
            >
              <div>
                <h3
                  id="narrate-modal-title"
                  style={{
                    margin: '0 0 0.25rem 0',
                    fontFamily: 'var(--font-heading)',
                    fontSize: '1.25rem',
                  }}
                >
                  🎬 Narrate a Story with "{narrationTargetVoice.label}"
                </h3>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                  Produce an expressive solo audio edition or hand off to full cast directing.
                </p>
              </div>
              <button
                type="button"
                className="btn-tactile"
                onClick={handleCloseNarrateModal}
                disabled={isNarrating}
                style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
              >
                ✕
              </button>
            </div>

            {narrateError && (
              <div
                className="card-tactile"
                role="alert"
                style={{
                  borderColor: 'var(--accent-state)',
                  backgroundColor: 'var(--accent-state-bg)',
                  color: 'var(--accent-state)',
                  padding: '0.6rem 0.85rem',
                  marginBottom: '1rem',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                }}
              >
                ⚠️ {narrateError}
              </div>
            )}

            {narrateSuccessStoryId ? (
              <div
                className="card-tactile"
                role="status"
                style={{
                  borderColor: 'var(--accent-root)',
                  backgroundColor: 'var(--accent-root-bg)',
                  color: 'var(--accent-root)',
                  padding: '1.25rem',
                  marginBottom: '1rem',
                  textAlign: 'center',
                }}
              >
                <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>
                  ✓ Narration Generated Successfully!
                </h4>
                <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                  A new audio edition narrated by {narrationTargetVoice.label} is ready.
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="btn-tactile btn-tactile-primary"
                    onClick={() => {
                      handleCloseNarrateModal();
                      onNavigate(`/stories/${encodeURIComponent(narrateSuccessStoryId)}`);
                    }}
                    style={{ minHeight: '44px', padding: '0.5rem 1rem' }}
                  >
                    🎧 Listen in Reader
                  </button>
                  <button
                    type="button"
                    className="btn-tactile"
                    onClick={handleCloseNarrateModal}
                    style={{ minHeight: '44px', padding: '0.5rem 1rem' }}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {/* Target Story Selection */}
                <div style={{ marginBottom: '1rem' }}>
                  <label
                    htmlFor="narrate-target-story"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      marginBottom: '0.35rem',
                    }}
                  >
                    Target Story *
                  </label>
                  {loadingStories ? (
                    <p style={{ margin: 0, fontSize: '0.85rem', fontStyle: 'italic' }}>
                      Loading stories...
                    </p>
                  ) : stories.length === 0 ? (
                    <p style={{ margin: 0, fontSize: '0.85rem', fontStyle: 'italic', color: 'var(--ink-muted)' }}>
                      No stories available. Write a story in the Stories Workbench first.
                    </p>
                  ) : (
                    <select
                      id="narrate-target-story"
                      className="select-tactile"
                      style={{ width: '100%', boxSizing: 'border-box' }}
                      value={selectedStoryId}
                      onChange={(e) => setSelectedStoryId(e.target.value)}
                      disabled={isNarrating}
                    >
                      {stories.map((st) => (
                        <option key={st.id} value={st.id}>
                          [{st.status.toUpperCase()}] {st.title} ({st.audio_versions_count} audio versions)
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Audio Version Label */}
                <div style={{ marginBottom: '1rem' }}>
                  <label
                    htmlFor="narrate-version-label"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      marginBottom: '0.35rem',
                    }}
                  >
                    Audio Version Label
                  </label>
                  <input
                    id="narrate-version-label"
                    type="text"
                    className="input-tactile"
                    style={{ width: '100%', boxSizing: 'border-box' }}
                    value={narrationLabel}
                    onChange={(e) => setNarrationLabel(e.target.value)}
                    disabled={isNarrating}
                    placeholder="e.g. Solo — Grandpa Owl"
                  />
                </div>

                {/* Pace Selection */}
                <div style={{ marginBottom: '1rem' }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      marginBottom: '0.35rem',
                    }}
                  >
                    Narration Pace
                  </label>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {(['slow', 'calm', 'natural', 'lively'] as VoicePace[]).map((p) => {
                      const selected = narrationPace === p;
                      return (
                        <button
                          key={p}
                          type="button"
                          className={`btn-tactile ${selected ? 'btn-tactile-primary' : ''}`}
                          onClick={() => setNarrationPace(p)}
                          disabled={isNarrating}
                          style={{
                            fontSize: '0.8rem',
                            padding: '0.3rem 0.65rem',
                            minHeight: '44px',
                          }}
                        >
                          {PACE_BADGES[p].label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Make Default Checkbox */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                  <input
                    type="checkbox"
                    id="narrate-make-default"
                    checked={narrationMakeDefault}
                    onChange={(e) => setNarrationMakeDefault(e.target.checked)}
                    disabled={isNarrating}
                  />
                  <label
                    htmlFor="narrate-make-default"
                    style={{ fontSize: '0.85rem', cursor: isNarrating ? 'not-allowed' : 'pointer' }}
                  >
                    Set as default audio edition for reader playback
                  </label>
                </div>

                {/* Live Progress Card when narrating */}
                {isNarrating && (
                  <div
                    className="card-tactile tactile-progress-card"
                    role="status"
                    aria-live="polite"
                    style={{
                      marginBottom: '1.25rem',
                      padding: '1.25rem',
                      border: '2px solid var(--accent-module)',
                      backgroundColor: 'var(--accent-module-bg)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                      <span className="spinner-tactile" style={{ fontSize: '1.2rem' }}>🎧</span>
                      <strong style={{ fontSize: '0.95rem', color: 'var(--ink-primary)' }}>
                        Synthesizing solo audio narration... {narrateElapsedSeconds}s
                      </strong>
                    </div>
                    <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                      Producing speech chunks with Gemini 3.8 Flash TTS and assembling studio WAV. Please keep this dialog open.
                    </p>
                    <div className="tactile-progress-bar-container">
                      <div className="tactile-progress-bar-indeterminate" />
                    </div>
                  </div>
                )}

                {/* Modal Action Buttons */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                  }}
                >
                  <button
                    type="button"
                    className="btn-tactile btn-tactile-primary"
                    onClick={handleGenerateSoloNow}
                    disabled={isNarrating || !selectedStoryId}
                    style={{
                      minHeight: '44px',
                      padding: '0.65rem 1.25rem',
                      fontSize: '0.95rem',
                      fontWeight: 600,
                    }}
                  >
                    {isNarrating
                      ? `⚡ Generating Solo Audio... (${narrateElapsedSeconds}s)`
                      : '⚡ Generate Solo Audio Now'}
                  </button>

                  <button
                    type="button"
                    className="btn-tactile"
                    onClick={handleOpenInStep3}
                    disabled={isNarrating || !selectedStoryId}
                    style={{
                      minHeight: '44px',
                      padding: '0.65rem 1.25rem',
                      fontSize: '0.9rem',
                    }}
                    title="Navigate to Director Studio Step 3 with this voice assigned to the Narrator"
                  >
                    🎛️ Open in Story Step 3 (Full Cast / Advanced)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
