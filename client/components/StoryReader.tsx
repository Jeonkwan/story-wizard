import React, { useState } from 'react';
import type { AudioVersion, Story } from '../../shared/types';
import { cleanTextForReader } from '../../shared/textClean';
import { setDefaultAudioVersion, deleteAudioVersion } from '../api/client';

export interface StoryReaderProps {
  story: Story;
  onBack: () => void;
  isAdmin?: boolean;
  activeAudioVersion?: AudioVersion | null;
  onVersionChange?: (ver: AudioVersion) => void;
  onStoryUpdated?: (updatedStory: Story) => void;
}

export function StoryReader({
  story,
  onBack,
  isAdmin = false,
  activeAudioVersion,
  onVersionChange,
  onStoryUpdated,
}: StoryReaderProps): React.JSX.Element {
  let hasRenderedFirstNarrator = false;

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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
        </section>
      )}

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
