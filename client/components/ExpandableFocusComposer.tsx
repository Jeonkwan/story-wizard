import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MicDictationButton, appendWithSmartSpace } from './MicDictationButton';

export interface ExpandableFocusComposerProps {
  title: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  contextHint?: 'story_prompt' | 'voice_prompt' | 'script_dialogue';
  enableVocalTagPills?: boolean;
  disabled?: boolean;
  compactTrigger?: boolean;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
  renderTrigger?: (open: () => void) => React.ReactNode;
}

export const VOCAL_TAG_PILLS = [
  '<short pause>',
  '<long pause>',
  '<sigh>',
  '<laugh>',
  '<chuckle>',
  '<gasp>',
  '<breath>',
  '<yawn>',
] as const;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function ExpandableFocusComposer({
  title,
  value,
  onChange,
  placeholder,
  contextHint,
  enableVocalTagPills = false,
  disabled = false,
  compactTrigger = false,
  triggerLabel,
  triggerClassName = '',
  triggerStyle,
  renderTrigger,
}: ExpandableFocusComposerProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [draftText, setDraftText] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync draftText whenever value prop updates while closed
  useEffect(() => {
    if (!isOpen) {
      setDraftText(value);
    }
  }, [value, isOpen]);

  // Lock body scroll while modal is open & handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDone();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Auto-focus the expanded textarea
    const timer = setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        // Place cursor at the end
        const len = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(len, len);
      }
    }, 50);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isOpen, draftText]);

  const handleOpen = () => {
    if (disabled) return;
    setDraftText(value);
    setIsOpen(true);
  };

  const handleDone = () => {
    onChange(draftText);
    setIsOpen(false);
  };

  const insertVocalTag = (tag: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setDraftText((prev) => appendWithSmartSpace(prev, tag));
      return;
    }

    const start = textarea.selectionStart ?? draftText.length;
    const end = textarea.selectionEnd ?? draftText.length;
    const before = draftText.slice(0, start);
    const after = draftText.slice(end);

    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);

    const formattedTag = `${needsLeadingSpace ? ' ' : ''}${tag}${needsTrailingSpace ? ' ' : ''}`;
    const nextText = before + formattedTag + after;
    setDraftText(nextText);

    // Restore cursor position right after the inserted vocal tag
    requestAnimationFrame(() => {
      textarea.focus();
      const nextPos = start + formattedTag.length;
      textarea.setSelectionRange(nextPos, nextPos);
    });
  };

  const wordCount = countWords(draftText);
  const charCount = draftText.length;

  return (
    <>
      {renderTrigger ? (
        renderTrigger(handleOpen)
      ) : (
        <button
          type="button"
          className={`btn-tactile focus-composer-trigger ${triggerClassName}`.trim()}
          style={triggerStyle}
          onClick={handleOpen}
          disabled={disabled}
          title={triggerLabel || `Expand ${title} in focus editor`}
          aria-label={triggerLabel || `Expand ${title} in focus editor`}
        >
          {compactTrigger ? '⤢' : triggerLabel || '⤢ Expand'}
        </button>
      )}

      {isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="focus-composer-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => {
              // Close if clicking the backdrop overlay directly
              if (e.target === e.currentTarget) {
                handleDone();
              }
            }}
          >
            <div className="focus-composer-sheet card-tactile">
              {/* Header Toolbar */}
              <div className="focus-composer-header">
                <div className="focus-composer-header-left">
                  <h3 className="focus-composer-title">{title}</h3>
                  <span className="focus-composer-counter">
                    {wordCount} {wordCount === 1 ? 'word' : 'words'} · {charCount}{' '}
                    {charCount === 1 ? 'char' : 'chars'}
                  </span>
                </div>

                <div className="focus-composer-header-right">
                  <MicDictationButton
                    contextHint={contextHint}
                    onTranscript={(text) =>
                      setDraftText((prev) => appendWithSmartSpace(prev, text))
                    }
                  />
                  <button
                    type="button"
                    className="btn-tactile btn-tactile-primary focus-composer-done-btn"
                    onClick={handleDone}
                    aria-label="Save and close focus composer"
                  >
                    ✓ Done
                  </button>
                </div>
              </div>

              {/* Quick-insert vocal tag pills row */}
              {enableVocalTagPills && (
                <div className="focus-composer-vocal-tags">
                  <span className="focus-composer-vocal-label">Vocal tags:</span>
                  <div className="focus-composer-vocal-pills">
                    {VOCAL_TAG_PILLS.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="tag-pill focus-composer-vocal-pill"
                        onClick={() => insertVocalTag(tag)}
                        aria-label={`Insert ${tag}`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Spacious Focus Textarea */}
              <div className="focus-composer-body">
                <textarea
                  ref={textareaRef}
                  className="focus-composer-textarea"
                  placeholder={placeholder || 'Type or dictate your text here...'}
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  aria-label={title}
                />
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
