import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { VoiceEntry, VoicePace } from '../../shared/types';
import {
  VOICE_SAMPLE_PRESETS,
  DEFAULT_VOICE_SAMPLE,
  MAX_VOICE_PREVIEW_CHARS,
} from '../../shared/voiceSamples';
import {
  previewVoiceAudio,
  createCustomVoice,
  discardDraftVoice,
  blobToBase64,
} from '../api/client';
import { MicDictationButton, appendWithSmartSpace } from './MicDictationButton';
import { ExpandableFocusComposer } from './ExpandableFocusComposer';

export interface StagedVoiceDraft {
  geminiVoiceName: string;
  promptSnapshot: string;
  paceSnapshot: VoicePace;
  previewBlob: Blob;
}

export interface VoiceDesignerProps {
  onVoiceCreated?: (voice: VoiceEntry) => void;
  onCancel?: () => void;
  initialValues?: {
    label?: string;
    description?: string;
    defaultPace?: VoicePace;
    tags?: string[];
  } | null;
  compact?: boolean;
}

const PACE_OPTIONS: { value: VoicePace; label: string; desc: string }[] = [
  { value: 'slow', label: '🐢 Slow', desc: 'Soothing & unhurried' },
  { value: 'calm', label: '🌙 Calm', desc: 'Measured & relaxed' },
  { value: 'natural', label: '✨ Natural', desc: 'Balanced rhythm' },
  { value: 'lively', label: '⚡ Lively', desc: 'Animated & upbeat' },
];

export function VoiceDesigner({
  onVoiceCreated,
  onCancel,
  initialValues,
  compact = false,
}: VoiceDesignerProps): React.JSX.Element {
  // Form fields
  const [label, setLabel] = useState<string>(initialValues?.label || '');
  const [description, setDescription] = useState<string>(initialValues?.description || '');
  const [tags, setTags] = useState<string>(initialValues?.tags?.join(', ') || '');
  const [pace, setPace] = useState<VoicePace>(initialValues?.defaultPace || 'natural');

  // Sample picker state
  const [selectedPresetId, setSelectedPresetId] = useState<string>('playful-dialogue');
  const [sampleText, setSampleText] = useState<string>(DEFAULT_VOICE_SAMPLE);

  // Staged draft state machine
  const [stagedDraft, setStagedDraft] = useState<StagedVoiceDraft | null>(null);
  const stagedDraftRef = useRef<StagedVoiceDraft | null>(null);
  stagedDraftRef.current = stagedDraft;

  // Track previous draft name for cleanup on invalidation or regeneration
  const previousDraftNameRef = useRef<string | null>(null);

  // Audio audition state
  const [isAuditioning, setIsAuditioning] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Audio element & blob URL refs
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentBlobUrlRef = useRef<string | null>(null);

  // Update form fields when initialValues prop changes (e.g. on Remix)
  useEffect(() => {
    if (initialValues) {
      setLabel(initialValues.label || '');
      setDescription(initialValues.description || '');
      setTags(initialValues.tags?.join(', ') || '');
      setPace(initialValues.defaultPace || 'natural');
      // Invalidate staged draft when initial values are applied
      if (stagedDraftRef.current) {
        previousDraftNameRef.current = stagedDraftRef.current.geminiVoiceName;
        setStagedDraft(null);
      }
    }
  }, [initialValues]);

  // Audio cleanup helper
  const stopAudio = useCallback(() => {
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
    setIsAuditioning(false);
  }, []);

  // Play audio from WAV Blob
  const playBlob = useCallback(
    (blob: Blob) => {
      stopAudio();
      try {
        const url = URL.createObjectURL(blob);
        currentBlobUrlRef.current = url;
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        setIsAuditioning(true);

        audio.onended = () => {
          stopAudio();
        };
        audio.onerror = () => {
          stopAudio();
          setErrorMessage('Audio preview playback failed');
        };

        audio.play().catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          stopAudio();
        });
      } catch {
        stopAudio();
      }
    },
    [stopAudio]
  );

  // Cleanup audio & discard unsaved draft voice on unmount
  useEffect(() => {
    return () => {
      stopAudio();
      const draftToDiscard =
        stagedDraftRef.current?.geminiVoiceName || previousDraftNameRef.current;
      if (draftToDiscard) {
        discardDraftVoice(draftToDiscard).catch(() => {});
      }
    };
  }, [stopAudio]);

  // Handle prompt description changes (invalidates staged draft if changed)
  const handleDescriptionChange = (newDesc: string) => {
    setDescription(newDesc);
    setErrorMessage(null);
    setSuccessMessage(null);
    if (stagedDraftRef.current && stagedDraftRef.current.promptSnapshot !== newDesc) {
      previousDraftNameRef.current = stagedDraftRef.current.geminiVoiceName;
      setStagedDraft(null);
    }
  };

  // Handle pace changes (invalidates staged draft if changed)
  const handlePaceChange = (newPace: VoicePace) => {
    setPace(newPace);
    setErrorMessage(null);
    if (stagedDraftRef.current && stagedDraftRef.current.paceSnapshot !== newPace) {
      previousDraftNameRef.current = stagedDraftRef.current.geminiVoiceName;
      setStagedDraft(null);
    }
  };

  // Handle sample preset selection
  const handleSelectPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (presetId === 'custom') {
      return;
    }
    const found = VOICE_SAMPLE_PRESETS.find((p) => p.id === presetId);
    if (found) {
      setSampleText(found.text);
    }
  };

  // Handle custom sample text editing (does NOT invalidate staged draft!)
  const handleSampleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value.slice(0, MAX_VOICE_PREVIEW_CHARS);
    setSampleText(text);
    if (selectedPresetId !== 'custom') {
      setSelectedPresetId('custom');
    }
  };

  // Preview Voice Action
  const handlePreviewVoice = async () => {
    if (!description.trim()) {
      setErrorMessage('Please enter a voice description prompt to preview');
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsAuditioning(true);

    try {
      if (
        stagedDraft &&
        stagedDraft.promptSnapshot === description.trim() &&
        stagedDraft.paceSnapshot === pace
      ) {
        // Re-audition using the SAME staged voice ID
        const result = await previewVoiceAudio({
          description: description.trim(),
          pace,
          sampleText: sampleText.trim() || undefined,
          draftGeminiVoiceName: stagedDraft.geminiVoiceName,
          regenerateTake: false,
        });
        playBlob(result.blob);
      } else {
        // Generate a new staged voice take
        const result = await previewVoiceAudio({
          description: description.trim(),
          pace,
          sampleText: sampleText.trim() || undefined,
          previousDraftGeminiVoiceName: previousDraftNameRef.current || undefined,
        });

        if (result.draftGeminiVoiceName) {
          const draft: StagedVoiceDraft = {
            geminiVoiceName: result.draftGeminiVoiceName,
            promptSnapshot: description.trim(),
            paceSnapshot: pace,
            previewBlob: result.blob,
          };
          setStagedDraft(draft);
          previousDraftNameRef.current = null;
        }

        playBlob(result.blob);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Audition preview failed');
      stopAudio();
    }
  };

  // New Voice Take Action (regenerate take for same prompt)
  const handleNewVoiceTake = async () => {
    if (!description.trim() || !stagedDraft) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsAuditioning(true);

    try {
      const result = await previewVoiceAudio({
        description: description.trim(),
        pace,
        sampleText: sampleText.trim() || undefined,
        regenerateTake: true,
        previousDraftGeminiVoiceName: stagedDraft.geminiVoiceName,
      });

      if (result.draftGeminiVoiceName) {
        const updatedDraft: StagedVoiceDraft = {
          geminiVoiceName: result.draftGeminiVoiceName,
          promptSnapshot: description.trim(),
          paceSnapshot: pace,
          previewBlob: result.blob,
        };
        setStagedDraft(updatedDraft);
        previousDraftNameRef.current = null;
      }

      playBlob(result.blob);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to roll new voice take');
      stopAudio();
    }
  };

  // Save to Voice Library Action
  const handleSaveVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setErrorMessage('Please provide a Voice Label');
      return;
    }
    if (!description.trim()) {
      setErrorMessage('Please provide a Voice Description Prompt');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      let previewAudioBase64: string | undefined;
      let stagedId: string | undefined;

      if (
        stagedDraft &&
        stagedDraft.promptSnapshot === description.trim() &&
        stagedDraft.paceSnapshot === pace
      ) {
        stagedId = stagedDraft.geminiVoiceName;
        try {
          previewAudioBase64 = await blobToBase64(stagedDraft.previewBlob);
        } catch {
          // Fall back gracefully if base64 conversion fails
        }
      }

      const created = await createCustomVoice({
        label: label.trim(),
        description: description.trim(),
        defaultPace: pace,
        tags: parsedTags.length > 0 ? parsedTags : undefined,
        stagedGeminiVoiceName: stagedId,
        previewAudioBase64,
      });

      // Clear staged draft so unmount won't delete it
      setStagedDraft(null);
      previousDraftNameRef.current = null;

      setSuccessMessage(`✓ Voice "${created.label}" saved successfully to Voice Library!`);
      onVoiceCreated?.(created);

      // Reset form if not compact modal
      if (!compact) {
        setLabel('');
        setDescription('');
        setTags('');
        setPace('natural');
        setSelectedPresetId('playful-dialogue');
        setSampleText(DEFAULT_VOICE_SAMPLE);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save voice to library');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="card-tactile voice-designer-container"
      style={{
        padding: compact ? '1rem' : '1.5rem',
        backgroundColor: 'var(--bg-well)',
        marginBottom: '1.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <div>
          <h3
            style={{
              margin: '0 0 0.25rem 0',
              fontFamily: 'var(--font-heading)',
              fontSize: compact ? '1.1rem' : '1.3rem',
            }}
          >
            🎙️ Custom Voice Designer
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: '0.85rem',
              color: 'var(--ink-muted)',
              fontFamily: 'var(--font-prose)',
            }}
          >
            Design a custom prompted voice, audition realistic sample takes, and save with 100% vocal parity.
          </p>
        </div>

        {onCancel && (
          <button
            type="button"
            className="btn-tactile"
            onClick={() => {
              stopAudio();
              onCancel();
            }}
            style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
          >
            ✕ Close
          </button>
        )}
      </div>

      {errorMessage && (
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
          ⚠️ {errorMessage}
        </div>
      )}

      {successMessage && (
        <div
          className="card-tactile"
          role="status"
          style={{
            borderColor: 'var(--accent-root)',
            backgroundColor: 'var(--accent-root-bg)',
            color: 'var(--accent-root)',
            padding: '0.6rem 0.85rem',
            marginBottom: '1rem',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}
        >
          {successMessage}
        </div>
      )}

      <form onSubmit={handleSaveVoice}>
        {/* Label & Tags Row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
            marginBottom: '1rem',
          }}
        >
          <div>
            <label
              htmlFor="voice-designer-label"
              style={{
                display: 'block',
                fontSize: '0.8rem',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                marginBottom: '0.3rem',
              }}
            >
              Voice Label *
            </label>
            <input
              id="voice-designer-label"
              type="text"
              className="input-tactile"
              style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="e.g. Grandma Willow, Captain Bobo"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setErrorMessage(null);
              }}
              disabled={isSaving}
              required
            />
          </div>

          <div>
            <label
              htmlFor="voice-designer-tags"
              style={{
                display: 'block',
                fontSize: '0.8rem',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                marginBottom: '0.3rem',
              }}
            >
              Tags (comma separated)
            </label>
            <input
              id="voice-designer-tags"
              type="text"
              className="input-tactile"
              style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="e.g. cozy, bedtime, storyteller, funny"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              disabled={isSaving}
            />
          </div>
        </div>

        {/* Default Voice Pace Selector */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            style={{
              display: 'block',
              fontSize: '0.8rem',
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              marginBottom: '0.4rem',
            }}
          >
            Default Voice Pace
          </label>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            {PACE_OPTIONS.map((opt) => {
              const isSelected = pace === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`btn-tactile ${isSelected ? 'btn-tactile-primary' : ''}`}
                  onClick={() => handlePaceChange(opt.value)}
                  disabled={isSaving}
                  style={{
                    fontSize: '0.825rem',
                    padding: '0.35rem 0.75rem',
                    minHeight: '44px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                  title={opt.desc}
                >
                  <span>{opt.label}</span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      opacity: isSelected ? 0.9 : 0.65,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    ({opt.desc})
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Voice Prompt Textarea with Dictate & Expand */}
        <div style={{ marginBottom: '1rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.35rem',
              flexWrap: 'wrap',
              gap: '0.4rem',
            }}
          >
            <label
              htmlFor="voice-designer-prompt"
              style={{
                fontSize: '0.8rem',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
              }}
            >
              Voice Description Prompt *
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <MicDictationButton
                contextHint="voice_prompt"
                onTranscript={(transcribed) =>
                  handleDescriptionChange(appendWithSmartSpace(description, transcribed))
                }
                disabled={isSaving || isAuditioning}
                title="Dictate voice description prompt via microphone"
              />
              <ExpandableFocusComposer
                title="Voice Description Prompt"
                value={description}
                onChange={handleDescriptionChange}
                contextHint="voice_prompt"
                disabled={isSaving || isAuditioning}
                placeholder="Describe vocal timbre, age, personality, storytelling rhythm..."
              />
            </div>
          </div>
          <textarea
            id="voice-designer-prompt"
            className="input-tactile"
            style={{
              width: '100%',
              minHeight: '80px',
              boxSizing: 'border-box',
              lineHeight: '1.5',
              fontSize: '0.9rem',
            }}
            placeholder="e.g. Warm, elderly grandmother who speaks in a gentle, reassuring tone with expressive storytelling cadence and cozy warmth."
            value={description}
            onChange={(e) => handleDescriptionChange(e.target.value)}
            disabled={isSaving}
            required
          />
        </div>

        {/* Expressive Sample Audition Picker */}
        <div
          className="card-tactile"
          style={{
            padding: '0.85rem',
            marginBottom: '1.25rem',
            backgroundColor: 'var(--bg-canvas)',
            border: '1px dashed var(--ink-primary)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.5rem',
              flexWrap: 'wrap',
              gap: '0.3rem',
            }}
          >
            <span
              style={{
                fontSize: '0.8rem',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: 'var(--ink-muted)',
              }}
            >
              EXPRESSIVE AUDITION SAMPLE
            </span>
            <span
              style={{
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                color: sampleText.length >= 300 ? 'var(--accent-state)' : 'var(--ink-muted)',
              }}
            >
              {sampleText.length} / {MAX_VOICE_PREVIEW_CHARS} chars
            </span>
          </div>

          {/* Sample Preset Pills */}
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              flexWrap: 'wrap',
              marginBottom: '0.65rem',
            }}
          >
            {VOICE_SAMPLE_PRESETS.map((p) => {
              const active = selectedPresetId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`btn-tactile ${active ? 'btn-tactile-primary' : ''}`}
                  onClick={() => handleSelectPreset(p.id)}
                  disabled={isSaving}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.25rem 0.55rem',
                    minHeight: '36px',
                  }}
                  title={p.styleHint}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              type="button"
              className={`btn-tactile ${selectedPresetId === 'custom' ? 'btn-tactile-primary' : ''}`}
              onClick={() => handleSelectPreset('custom')}
              disabled={isSaving}
              style={{
                fontSize: '0.75rem',
                padding: '0.25rem 0.55rem',
                minHeight: '36px',
              }}
            >
              ✏️ Custom Sample Text
            </button>
          </div>

          {/* Sample Text Input */}
          <textarea
            className="input-tactile"
            style={{
              width: '100%',
              minHeight: '52px',
              boxSizing: 'border-box',
              fontSize: '0.825rem',
              lineHeight: '1.4',
              color: 'var(--ink-primary)',
            }}
            value={sampleText}
            onChange={handleSampleTextChange}
            placeholder="Enter custom sample text for voice audition (up to 320 characters)..."
            disabled={isSaving}
            maxLength={MAX_VOICE_PREVIEW_CHARS}
          />
        </div>

        {/* Staged Draft Status Badge */}
        {stagedDraft && (
          <div
            className="card-tactile"
            role="status"
            style={{
              padding: '0.5rem 0.75rem',
              marginBottom: '1rem',
              backgroundColor: 'var(--accent-root-bg)',
              borderColor: 'var(--accent-root)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'var(--accent-root)', fontWeight: 700, fontSize: '0.85rem' }}>
                ✓ Voice Take Staged
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                Saving will preserve this exact vocal persona ({stagedDraft.geminiVoiceName})
              </span>
            </div>
            <span
              className="badge-mono"
              style={{
                fontSize: '0.7rem',
                backgroundColor: 'var(--bg-canvas)',
              }}
            >
              Take locked
            </span>
          </div>
        )}

        {/* Action Controls */}
        <div
          style={{
            display: 'flex',
            gap: '0.65rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {/* Preview / Stop Button */}
          {isAuditioning ? (
            <button
              type="button"
              className="btn-tactile"
              onClick={stopAudio}
              style={{
                minHeight: '44px',
                padding: '0.5rem 1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <span>⏹ Stop Audition</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn-tactile"
              onClick={handlePreviewVoice}
              disabled={isSaving || !description.trim()}
              style={{
                minHeight: '44px',
                padding: '0.5rem 1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <span>🔊 Preview Voice</span>
            </button>
          )}

          {/* New Voice Take (visible only once draft is staged) */}
          {stagedDraft && (
            <button
              type="button"
              className="btn-tactile"
              onClick={handleNewVoiceTake}
              disabled={isSaving || isAuditioning}
              style={{
                minHeight: '44px',
                padding: '0.5rem 0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
              title="Roll another vocal take using the same prompt"
            >
              <span>🎲 New Voice Take</span>
            </button>
          )}

          {/* Save to Voice Library Button */}
          <button
            type="submit"
            className="btn-tactile btn-tactile-primary"
            disabled={isSaving || !label.trim() || !description.trim()}
            style={{
              minHeight: '44px',
              padding: '0.5rem 1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              marginLeft: 'auto',
            }}
          >
            {isSaving ? (
              <span>💾 Saving to Library...</span>
            ) : (
              <span>💾 Save to Voice Library</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
