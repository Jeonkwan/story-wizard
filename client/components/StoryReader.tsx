import React, { useState } from 'react';
import type { AudioVersion, Story } from '../../shared/types';
import { cleanTextForReader } from '../../shared/textClean';
import { setDefaultAudioVersion, deleteAudioVersion, deleteStory } from '../api/client';

export interface StoryReaderProps {
  story: Story;
  onBack: () => void;
  isAdmin?: boolean;
  activeAudioVersion?: AudioVersion | null;
  onVersionChange?: (ver: AudioVersion) => void;
  onStoryUpdated?: (updatedStory: Story) => void;
  onDeleteStory?: (storyId: string) => Promise<void>;
  onRemixStory?: (story: Story) => void;
}

export function StoryReader({
  story,
  onBack,
  isAdmin = false,
  activeAudioVersion,
  onVersionChange,
  onStoryUpdated,
  onDeleteStory,
  onRemixStory,
}: StoryReaderProps): React.JSX.Element {
  let hasRenderedFirstNarrator = false;

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteStory, setConfirmDeleteStory] = useState<boolean>(false);
  const [isDeletingStory, setIsDeletingStory] = useState<boolean>(false);
  const [copiedPrompt, setCopiedPrompt] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${mins}m ${rem < 10 ? '0' : ''}${rem}s`;
  };

  const handleSetDefault = async (versionId: string) => {
    setActionError(null);
    setIsProcessing(true);
    try {
      const updated = await setDefaultAudioVersion(story.id, versionId);
      onStoryUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to set default version');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDelete = async (versionId: string) => {
    setActionError(null);
    setIsProcessing(true);
    try {
      const updated = await deleteAudioVersion(story.id, versionId);
      setConfirmDeleteId(null);
      onStoryUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete audio version');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteStory = async () => {
    setActionError(null);
    setIsDeletingStory(true);
    try {
      if (onDeleteStory) {
        await onDeleteStory(story.id);
      } else {
        await deleteStory(story.id);
        onBack();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete story');
      setIsDeletingStory(false);
    }
  };

  const originalPrompt = story.prompt_metadata?.original_prompt;

  const handleCopyPrompt = async () => {
    if (!originalPrompt) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(originalPrompt);
      }
      setCopiedPrompt(true);
      setTimeout(() => {
        setCopiedPrompt(false);
      }, 2500);
    } catch {
      setCopiedPrompt(true);
      setTimeout(() => {
        setCopiedPrompt(false);
      }, 2500);
    }
  };

  const handleRemix = () => {
    if (onRemixStory) {
      onRemixStory(story);
    } else if (typeof window !== 'undefined') {
      window.location.assign(`/admin?remixStoryId=${encodeURIComponent(story.id)}`);
    }
  };

  return (
    <article className="reader-wrapper">
      <header className="reader-header">
        <button
          type="button"
          className="btn-tactile reader-back-btn"
          onClick={onBack}
          aria-label="Back to library"
        >
          ← Back to Library
        </button>

        <div className="reader-title-area">
          {story.series_context?.series_id && (
            <div>
              <span className="badge-mono series-badge">
                {story.series_context.series_id} · Episode {story.series_context.episode_number}
              </span>
            </div>
          )}
          <h1 className="reader-title">{story.title}</h1>

          {story.tags && story.tags.length > 0 && (
            <div className="reader-meta-row">
              {story.tags.map((tag) => (
                <span key={tag} className="badge-mono" style={{ opacity: 0.85 }}>
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* Inline Admin Version Controls Panel (Visible ONLY to authenticated Admins) */}
      {isAdmin && (
        <section
          className="card-tactile reader-admin-panel"
          style={{
            margin: '0 auto 1.5rem auto',
            maxWidth: '48rem',
            padding: '1rem',
            backgroundColor: 'var(--bg-well)',
            borderLeft: '4px solid var(--accent-module)',
          }}
          aria-label="Admin Audio Versions"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-primary)' }}>
              ⚙️ Admin Audio Versions ({story.audio_versions.length})
            </span>
            <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
              Story Status: {story.status.toUpperCase()}
            </span>
          </div>

          {actionError && (
            <p style={{ margin: '0 0 0.5rem 0', color: 'var(--accent-state)', fontSize: '0.8rem' }}>
              ⚠️ {actionError}
            </p>
          )}

          {story.audio_versions.length === 0 ? (
            <p style={{ margin: 0, fontSize: '0.8rem', fontStyle: 'italic', color: 'var(--ink-muted)' }}>
              No audio versions exist. This story has reverted to draft status.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {story.audio_versions.map((ver) => {
                const isActive = activeAudioVersion?.version_id === ver.version_id;
                const isConfirming = confirmDeleteId === ver.version_id;

                return (
                  <div
                    key={ver.version_id}
                    className="card-tactile"
                    style={{
                      padding: '0.6rem 0.75rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '0.5rem',
                      backgroundColor: 'var(--bg-surface)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{ver.label}</span>
                      <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                        {formatDuration(ver.duration_sec)}
                      </span>
                      {ver.is_default && (
                        <span
                          className="badge-mono"
                          style={{
                            fontSize: '0.65rem',
                            backgroundColor: 'var(--accent-root-bg)',
                            color: 'var(--accent-root)',
                            fontWeight: 700,
                          }}
                        >
                          ★ DEFAULT
                        </span>
                      )}
                      {isActive && (
                        <span className="badge-mono" style={{ fontSize: '0.65rem', color: 'var(--accent-module)' }}>
                          ▶ PLAYING
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      {onVersionChange && !isActive && (
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.15rem 0.45rem' }}
                          onClick={() => onVersionChange(ver)}
                        >
                          ▶ Listen
                        </button>
                      )}

                      {!ver.is_default && (
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.15rem 0.45rem' }}
                          disabled={isProcessing}
                          onClick={() => handleSetDefault(ver.version_id)}
                        >
                          ★ Set Default
                        </button>
                      )}

                      {isConfirming ? (
                        <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--accent-state)' }}>Delete?</span>
                          <button
                            type="button"
                            className="btn-tactile"
                            style={{
                              fontSize: '0.7rem',
                              padding: '0.15rem 0.45rem',
                              backgroundColor: 'var(--accent-state-bg)',
                              color: 'var(--accent-state)',
                            }}
                            disabled={isProcessing}
                            onClick={() => handleDelete(ver.version_id)}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="btn-tactile"
                            style={{ fontSize: '0.7rem', padding: '0.15rem 0.45rem' }}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.15rem 0.45rem' }}
                          onClick={() => setConfirmDeleteId(ver.version_id)}
                        >
                          🗑 Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              marginTop: '1rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--border-tactile, #ccc)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            {confirmDeleteStory ? (
              <div style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--accent-state)', fontWeight: 600 }}>
                  Delete story and all audio permanently?
                </span>
                <button
                  type="button"
                  className="btn-tactile"
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.2rem 0.5rem',
                    backgroundColor: 'var(--accent-state-bg)',
                    color: 'var(--accent-state)',
                  }}
                  disabled={isDeletingStory || isProcessing}
                  onClick={handleDeleteStory}
                >
                  {isDeletingStory ? 'Deleting...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="btn-tactile"
                  style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                  disabled={isDeletingStory}
                  onClick={() => setConfirmDeleteStory(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-tactile"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', color: 'var(--accent-state)' }}
                disabled={isDeletingStory || isProcessing}
                onClick={() => setConfirmDeleteStory(true)}
              >
                🗑 Delete Entire Story
              </button>
            )}
          </div>
        </section>
      )}

      {/* Story Prompt & Inspiration Card (Accessible to both readers and admins) */}
      <section
        className="card-tactile reader-prompt-card"
        style={{
          margin: '0 auto 1.5rem auto',
          maxWidth: '48rem',
          padding: '1rem',
          backgroundColor: 'var(--bg-surface)',
          borderLeft: '4px solid var(--accent-root)',
        }}
        aria-label="Story Prompt and Inspiration"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '0.5rem',
            flexWrap: 'wrap',
            gap: '0.5rem',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.85rem',
              fontWeight: 600,
              color: 'var(--ink-primary)',
            }}
          >
            💡 Story Prompt &amp; Inspiration
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
            {story.prompt_metadata?.age_range && (
              <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                🎯 Ages: {story.prompt_metadata.age_range}
              </span>
            )}
            {story.prompt_metadata?.vocabulary_level && (
              <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                📖 Vocab: {story.prompt_metadata.vocabulary_level}
              </span>
            )}
            {story.prompt_metadata?.genre_preset && story.prompt_metadata.genre_preset !== 'any' && (
              <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                ✨ Genre: {story.prompt_metadata.genre_preset}
              </span>
            )}
          </div>
        </div>

        {originalPrompt ? (
          <p
            style={{
              margin: '0 0 0.75rem 0',
              fontSize: '0.9rem',
              fontStyle: 'italic',
              color: 'var(--ink-prose)',
              lineHeight: 1.5,
            }}
          >
            &ldquo;{originalPrompt}&rdquo;
          </p>
        ) : (
          <p
            style={{
              margin: '0 0 0.75rem 0',
              fontSize: '0.85rem',
              fontStyle: 'italic',
              color: 'var(--ink-muted)',
            }}
          >
            Legacy story without saved prompt metadata.
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {originalPrompt && (
            <button
              type="button"
              className="btn-tactile"
              style={{ fontSize: '0.75rem', padding: '0.2rem 0.55rem' }}
              onClick={handleCopyPrompt}
            >
              {copiedPrompt ? '✓ Copied!' : '📋 Copy Prompt'}
            </button>
          )}
          <button
            type="button"
            className="btn-tactile btn-tactile-primary"
            style={{ fontSize: '0.75rem', padding: '0.2rem 0.55rem' }}
            onClick={handleRemix}
          >
            ✨ Remix in Studio
          </button>
        </div>
      </section>

      <section className="reader-prose-body">
        {story.script_turns.map((turn) => {
          const cleanedText = cleanTextForReader(turn.text);
          if (!cleanedText) {
            return null;
          }

          const isNarrator = turn.speaker.toLowerCase() === 'narrator';

          if (isNarrator) {
            const isFirst = !hasRenderedFirstNarrator;
            hasRenderedFirstNarrator = true;

            return (
              <p
                key={turn.turn_id}
                className={isFirst ? 'opening-narration first-letter-dropcap' : 'prose-narration'}
                data-turn-id={turn.turn_id}
              >
                {cleanedText}
              </p>
            );
          }

          // Character Dialogue Turn
          return (
            <div
              key={turn.turn_id}
              className="dialogue-turn"
              data-turn-id={turn.turn_id}
              data-speaker={turn.speaker}
            >
              <div className="dialogue-header">
                <span className="speaker-badge">{turn.speaker}</span>
              </div>
              <p className="dialogue-text">
                &ldquo;{cleanedText}&rdquo;
              </p>
            </div>
          );
        })}
      </section>
    </article>
  );
}
