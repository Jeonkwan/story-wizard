import React from 'react';
import type { Story } from '../../shared/types';
import { cleanTextForReader } from '../../shared/textClean';

export interface StoryReaderProps {
  story: Story;
  onBack: () => void;
}

export function StoryReader({ story, onBack }: StoryReaderProps): React.JSX.Element {
  let hasRenderedFirstNarrator = false;

  return (
    <article className="reader-wrapper" style={{ paddingBottom: '110px' }}>
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

      <section className="reader-prose-body">
        {story.script_turns.map((turn) => {
          const isNarrator = turn.speaker.toLowerCase() === 'narrator';
          const cleanedText = cleanTextForReader(turn.text);

          if (isNarrator) {
            const isFirst = !hasRenderedFirstNarrator;
            hasRenderedFirstNarrator = true;

            return (
              <p
                key={turn.turn_id}
                className={isFirst ? 'opening-narration' : 'prose-narration'}
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
