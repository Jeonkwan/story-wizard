import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { CharacterProfile, ScriptTurn, Story, CatalogItem } from '../../shared/types';
import {
  fetchAdminStories,
  fetchStory,
  writeStoryDraft,
  directStory,
  saveStoryEdits,
  patchStoryStatus,
  deleteStory,
  type AdminSession,
} from '../api/client';
import { VoiceStudioPanel } from './VoiceStudioPanel';

const APPROVED_TAGS = [
  '<short pause>',
  '<long pause>',
  '<sigh>',
  '<chuckle>',
  '<yawn>',
  '<breath>',
  '<laugh>',
  '<gasp>',
];

interface DirectorStudioProps {
  session: AdminSession;
  onLogout: () => void;
  onCatalogChanged?: () => void;
  onNavigateHome: () => void;
}

export function DirectorStudio({
  session,
  onLogout,
  onCatalogChanged,
  onNavigateHome,
}: DirectorStudioProps): React.JSX.Element {
  const [stories, setStories] = useState<CatalogItem[]>([]);
  const [loadingStories, setLoadingStories] = useState<boolean>(true);
  const [storiesError, setStoriesError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<'create' | 'edit'>('create');
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const [activeStory, setActiveStory] = useState<Story | null>(null);
  const [loadingStory, setLoadingStory] = useState<boolean>(false);
  const [storyLoadError, setStoryLoadError] = useState<string | null>(null);

  // Mode A / B Creation state
  const [createMode, setCreateMode] = useState<'fresh' | 'sequel'>('fresh');
  const [freshPrompt, setFreshPrompt] = useState<string>('');
  const [freshReferenceText, setFreshReferenceText] = useState<string>('');
  const [freshSeriesId, setFreshSeriesId] = useState<string>('');
  const [sequelPreviousStoryId, setSequelPreviousStoryId] = useState<string>('');
  const [sequelPrompt, setSequelPrompt] = useState<string>('');
  const [sequelReferenceText, setSequelReferenceText] = useState<string>('');
  const [isWriting, setIsWriting] = useState<boolean>(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Workbench Edit state
  const [editedTitle, setEditedTitle] = useState<string>('');
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [editedTags, setEditedTags] = useState<string>('');
  const [editedCharacters, setEditedCharacters] = useState<CharacterProfile[]>([]);
  const [editedTurns, setEditedTurns] = useState<ScriptTurn[]>([]);
  const [isDirecting, setIsDirecting] = useState<boolean>(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // References to turn textareas for cursor-precise tag insertion
  const turnTextareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());

  // Load all stories for left rail
  const loadStories = useCallback(async () => {
    setLoadingStories(true);
    setStoriesError(null);
    try {
      const items = await fetchAdminStories();
      setStories(items);
    } catch (err) {
      setStoriesError(err instanceof Error ? err.message : 'Failed to load stories');
    } finally {
      setLoadingStories(false);
    }
  }, []);

  useEffect(() => {
    loadStories();
  }, [loadStories]);

  // Load selected story details into workbench
  const loadStoryIntoWorkbench = useCallback(async (id: string) => {
    setSelectedStoryId(id);
    setViewMode('edit');
    setLoadingStory(true);
    setStoryLoadError(null);
    setSaveSuccess(false);
    setSaveError(null);
    setDirectError(null);
    setPublishError(null);
    setShowDeleteConfirm(false);

    try {
      const story = await fetchStory(id);
      setActiveStory(story);
      setEditedTitle(story.title);
      setEditedSummary(story.summary);
      setEditedTags(story.tags.join(', '));
      setEditedCharacters(JSON.parse(JSON.stringify(story.characters)));
      setEditedTurns(JSON.parse(JSON.stringify(story.script_turns)));
    } catch (err) {
      setStoryLoadError(err instanceof Error ? err.message : 'Failed to load story details');
      setActiveStory(null);
    } finally {
      setLoadingStory(false);
    }
  }, []);

  const handleStartNewStory = () => {
    setViewMode('create');
    setSelectedStoryId(null);
    setActiveStory(null);
    setWriteError(null);
    setFreshPrompt('');
    setFreshReferenceText('');
    setFreshSeriesId('');
    setSequelPrompt('');
    setSequelReferenceText('');
    setSequelPreviousStoryId(stories.length > 0 ? stories[0].id : '');
  };

  const handleStartSequel = (storyId: string) => {
    setViewMode('create');
    setCreateMode('sequel');
    setSelectedStoryId(null);
    setActiveStory(null);
    setWriteError(null);
    setSequelPreviousStoryId(storyId);
    setSequelPrompt('');
    setSequelReferenceText('');
  };

  // Step 1: Write Story Draft
  const handleWriteStory = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsWriting(true);
    setWriteError(null);

    try {
      let created: Story;
      if (createMode === 'fresh') {
        if (!freshPrompt.trim()) {
          setWriteError('Please enter a story prompt.');
          setIsWriting(false);
          return;
        }
        created = await writeStoryDraft({
          mode: 'fresh',
          prompt: freshPrompt.trim(),
          referenceText: freshReferenceText.trim() || undefined,
          seriesId: freshSeriesId.trim() || undefined,
        });
      } else {
        if (!sequelPrompt.trim()) {
          setWriteError('Please enter a sequel episode prompt.');
          setIsWriting(false);
          return;
        }
        if (!sequelPreviousStoryId) {
          setWriteError('Please select a previous episode for the sequel.');
          setIsWriting(false);
          return;
        }
        created = await writeStoryDraft({
          mode: 'sequel',
          previousStoryId: sequelPreviousStoryId,
          prompt: sequelPrompt.trim(),
          referenceText: sequelReferenceText.trim() || undefined,
        });
      }

      await loadStories();
      onCatalogChanged?.();
      await loadStoryIntoWorkbench(created.id);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : 'Draft generation failed');
    } finally {
      setIsWriting(false);
    }
  };

  // Step 2: Auto-Direct Voices & Pacing
  const handleAutoDirect = async () => {
    if (!activeStory) return;
    setIsDirecting(true);
    setDirectError(null);
    try {
      const parsedTags = editedTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      // Persist pending workbench edits first so auto-direct acts on latest user prose/characters
      await saveStoryEdits(activeStory.id, {
        title: editedTitle,
        summary: editedSummary,
        tags: parsedTags,
        characters: editedCharacters,
        script_turns: editedTurns,
        voice_candidates: activeStory.voice_candidates,
      });

      const directed = await directStory(activeStory.id);
      setActiveStory(directed);
      setEditedTitle(directed.title);
      setEditedSummary(directed.summary);
      setEditedTags(directed.tags.join(', '));
      setEditedCharacters(JSON.parse(JSON.stringify(directed.characters)));
      setEditedTurns(JSON.parse(JSON.stringify(directed.script_turns)));
      setSaveSuccess(false);
      await loadStories();
      onCatalogChanged?.();
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : 'Directing failed');
    } finally {
      setIsDirecting(false);
    }
  };

  // Quick Vocal Tag Pill Insertion
  const handleInsertTag = (turnIndex: number, tag: string) => {
    const textarea = turnTextareaRefs.current.get(turnIndex);
    setEditedTurns((prevTurns) => {
      const nextTurns = [...prevTurns];
      const turn = { ...nextTurns[turnIndex] };
      const currentText = turn.text;

      if (textarea && textarea === document.activeElement) {
        const start = textarea.selectionStart ?? currentText.length;
        const end = textarea.selectionEnd ?? currentText.length;
        const before = currentText.slice(0, start);
        const after = currentText.slice(end);
        const spaceBefore = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
        const spaceAfter = after.length > 0 && !after.startsWith(' ') ? ' ' : '';
        const insertion = `${spaceBefore}${tag}${spaceAfter}`;
        turn.text = `${before}${insertion}${after}`;

        setTimeout(() => {
          const newPos = start + insertion.length;
          textarea.focus();
          textarea.setSelectionRange(newPos, newPos);
        }, 0);
      } else {
        const space = currentText.length > 0 && !currentText.endsWith(' ') ? ' ' : '';
        turn.text = `${currentText}${space}${tag}`;
      }

      nextTurns[turnIndex] = turn;
      return nextTurns;
    });
  };

  // Turn modification helpers
  const handleTurnChange = (index: number, field: keyof ScriptTurn, value: string) => {
    setEditedTurns((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setSaveSuccess(false);
  };

  const handleAddTurn = (index: number) => {
    setEditedTurns((prev) => {
      const next = [...prev];
      const newTurn: ScriptTurn = {
        turn_id: index + 2,
        speaker: 'Narrator',
        style: '',
        text: '',
      };
      next.splice(index + 1, 0, newTurn);
      // Renumber contiguous
      return next.map((t, idx) => ({ ...t, turn_id: idx + 1 }));
    });
    setSaveSuccess(false);
  };

  const handleDeleteTurn = (index: number) => {
    if (editedTurns.length <= 2) return;
    setEditedTurns((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      return next.map((t, idx) => ({ ...t, turn_id: idx + 1 }));
    });
    setSaveSuccess(false);
  };

  // Characters Bible helpers
  const handleCharacterChange = (index: number, field: keyof CharacterProfile, value: string) => {
    const prevChar = editedCharacters[index];
    const prevName = prevChar?.name?.trim();

    setEditedCharacters((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });

    if (field === 'name' && prevName && value.trim() !== prevName) {
      const newName = value.trim();
      setEditedTurns((prevTurns) =>
        prevTurns.map((turn) =>
          turn.speaker === prevName ? { ...turn, speaker: newName || 'Narrator' } : turn
        )
      );
    }
    setSaveSuccess(false);
  };

  const handleAddCharacter = () => {
    setEditedCharacters((prev) => [...prev, { name: '', traits: '' }]);
    setSaveSuccess(false);
  };

  const handleDeleteCharacter = (index: number) => {
    const deletedChar = editedCharacters[index];
    const deletedName = deletedChar?.name?.trim();

    setEditedCharacters((prev) => prev.filter((_, idx) => idx !== index));

    if (deletedName) {
      setEditedTurns((prevTurns) =>
        prevTurns.map((turn) =>
          turn.speaker === deletedName ? { ...turn, speaker: 'Narrator' } : turn
        )
      );
    }
    setSaveSuccess(false);
  };

  // Save manual script edits
  const handleSaveScript = async () => {
    if (!activeStory) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const parsedTags = editedTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const updated = await saveStoryEdits(activeStory.id, {
        title: editedTitle,
        summary: editedSummary,
        tags: parsedTags,
        characters: editedCharacters,
        script_turns: editedTurns,
        voice_candidates: activeStory.voice_candidates,
      });

      setActiveStory(updated);
      setEditedTurns(JSON.parse(JSON.stringify(updated.script_turns)));
      setSaveSuccess(true);
      await loadStories();
      onCatalogChanged?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  };

  // Toggle publish / draft status
  const handleToggleStatus = async () => {
    if (!activeStory) return;
    const nextStatus = activeStory.status === 'draft' ? 'published' : 'draft';
    setIsPublishing(true);
    setPublishError(null);

    try {
      const updated = await patchStoryStatus(activeStory.id, nextStatus);
      setActiveStory(updated);
      await loadStories();
      onCatalogChanged?.();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleStoryUpdated = (updated: Story) => {
    setActiveStory(updated);
    setEditedTitle(updated.title);
    setEditedSummary(updated.summary);
    setEditedTags(updated.tags.join(', '));
    setEditedCharacters(JSON.parse(JSON.stringify(updated.characters || [])));
    setEditedTurns(JSON.parse(JSON.stringify(updated.script_turns || [])));
    loadStories();
    onCatalogChanged?.();
  };

  // Delete story
  const handleDeleteStory = async () => {
    if (!activeStory) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      await deleteStory(activeStory.id);
      setActiveStory(null);
      setSelectedStoryId(null);
      setViewMode('create');
      setShowDeleteConfirm(false);
      await loadStories();
      onCatalogChanged?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete story');
    } finally {
      setIsDeleting(false);
    }
  };

  const isPublishDisabled =
    activeStory?.status === 'draft' &&
    (!activeStory.audio_versions || activeStory.audio_versions.length === 0);

  return (
    <div className="studio-layout">
      {/* -------------------------------------------------------------
       * LEFT RAIL: Stories List & Session Controls
       * ------------------------------------------------------------- */}
      <aside className="studio-sidebar card-tactile">
        <div className="studio-sidebar-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
              ADMIN
            </span>
            <button
              type="button"
              className="btn-tactile"
              onClick={onLogout}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
            >
              Logout
            </button>
          </div>
          <p
            style={{
              margin: '0.35rem 0 0.75rem 0',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.85rem',
              fontWeight: 600,
              wordBreak: 'break-all',
            }}
          >
            {session.email}
          </p>

          <button
            type="button"
            className="btn-tactile btn-tactile-primary"
            onClick={handleStartNewStory}
            style={{ width: '100%', marginBottom: '0.75rem' }}
          >
            ➕ New Story
          </button>
          <button
            type="button"
            className="btn-tactile"
            onClick={onNavigateHome}
            style={{ width: '100%', fontSize: '0.8rem' }}
          >
            ← Public Library
          </button>
        </div>

        <div className="studio-stories-list">
          <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--ink-muted)', margin: '1rem 0 0.5rem 0' }}>
            STORIES ({stories.length})
          </h3>

          {loadingStories ? (
            <p style={{ fontStyle: 'italic', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              Loading stories...
            </p>
          ) : storiesError ? (
            <p style={{ color: 'var(--accent-state)', fontSize: '0.85rem' }}>{storiesError}</p>
          ) : stories.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', fontStyle: 'italic' }}>
              No stories created yet.
            </p>
          ) : (
            stories.map((item) => {
              const isSelected = selectedStoryId === item.id;
              return (
                <div
                  key={item.id}
                  className={`studio-story-item card-tactile ${isSelected ? 'studio-story-item-active' : ''}`}
                  onClick={() => loadStoryIntoWorkbench(item.id)}
                  style={{ cursor: 'pointer', marginBottom: '0.6rem', padding: '0.65rem' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span
                      className={`badge-tactile ${item.status === 'published' ? 'badge-tactile-published' : 'badge-tactile-draft'}`}
                      style={{ fontSize: '0.7rem' }}
                    >
                      {item.status.toUpperCase()}
                    </span>
                    {item.series_id && (
                      <span className="badge-tactile" style={{ fontSize: '0.65rem' }}>
                        Ep #{item.episode_number ?? 1}
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                    {item.title}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn-tactile"
                      style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartSequel(item.id);
                      }}
                      title="Create sequel episode from this story"
                    >
                      Sequel →
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* -------------------------------------------------------------
       * MAIN PANEL: Creation Form OR Story Workbench
       * ------------------------------------------------------------- */}
      <main className="studio-main">
        {viewMode === 'create' ? (
          /* =========================================================
           * CREATION WORKFLOW (Mode A / Mode B)
           * ========================================================= */
          <div className="card-tactile" style={{ padding: '2rem' }}>
            <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.75rem', marginTop: 0 }}>
              ✍️ Step 1: Write Bedtime Story
            </h2>

            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn-tactile ${createMode === 'fresh' ? 'btn-tactile-primary' : ''}`}
                onClick={() => setCreateMode('fresh')}
              >
                Mode A: Fresh Story
              </button>
              <button
                type="button"
                className={`btn-tactile ${createMode === 'sequel' ? 'btn-tactile-primary' : ''}`}
                onClick={() => setCreateMode('sequel')}
              >
                Mode B: Episode Sequel
              </button>
            </div>

            {writeError && (
              <div
                className="card-tactile"
                style={{
                  borderColor: 'var(--accent-state)',
                  backgroundColor: 'var(--accent-state-bg)',
                  marginBottom: '1.5rem',
                  padding: '0.75rem 1rem',
                }}
              >
                <p style={{ margin: 0, color: 'var(--accent-state)', fontWeight: 600 }}>
                  ⚠️ {writeError}
                </p>
              </div>
            )}

            <form onSubmit={handleWriteStory}>
              {createMode === 'fresh' ? (
                <>
                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', fontFamily: 'var(--font-mono)' }}>
                      Story Prompt *
                    </label>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '100px', boxSizing: 'border-box' }}
                      placeholder="e.g. A gentle bedtime story about a sleepy little train that helps tired animals along its tranquil mountain route."
                      value={freshPrompt}
                      onChange={(e) => setFreshPrompt(e.target.value)}
                      required
                    />
                  </div>

                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', fontFamily: 'var(--font-mono)' }}>
                      Optional Series Slug
                    </label>
                    <input
                      type="text"
                      className="input-tactile"
                      style={{ width: '100%', boxSizing: 'border-box' }}
                      placeholder="e.g. sleepy-train-adventures"
                      value={freshSeriesId}
                      onChange={(e) => setFreshSeriesId(e.target.value)}
                    />
                    <small style={{ color: 'var(--ink-muted)', display: 'block', marginTop: '0.25rem' }}>
                      If set, this story initiates Episode #1 of an ongoing bedtime series.
                    </small>
                  </div>

                  <div style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', fontFamily: 'var(--font-mono)' }}>
                      Optional Reference Material / Lore
                    </label>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '80px', boxSizing: 'border-box' }}
                      placeholder="Optional world details, poem verses, or character backstory to weave into the story."
                      value={freshReferenceText}
                      onChange={(e) => setFreshReferenceText(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', fontFamily: 'var(--font-mono)' }}>
                      Previous Episode *
                    </label>
                    <select
                      className="select-tactile"
                      style={{ width: '100%', boxSizing: 'border-box' }}
                      value={sequelPreviousStoryId}
                      onChange={(e) => setSequelPreviousStoryId(e.target.value)}
                      required
                    >
                      <option value="">Select a prior story...</option>
                      {stories.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} {s.series_id ? `(${s.series_id} Ep #${s.episode_number ?? 1})` : `(Solo ID: ${s.id})`}
                        </option>
                      ))}
                    </select>
                    <small style={{ color: 'var(--ink-muted)', display: 'block', marginTop: '0.25rem' }}>
                      Sequel advances to Episode #{((stories.find((s) => s.id === sequelPreviousStoryId)?.episode_number ?? 1) + 1)} and inherits the character bible and voice casting.
                    </small>
                  </div>

                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', fontFamily: 'var(--font-mono)' }}>
                      Sequel Episode Prompt *
                    </label>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '100px', boxSizing: 'border-box' }}
                      placeholder="e.g. In tonight's journey, the sleepy train climbs Star Mountain where constellations guide the way to peaceful slumber."
                      value={sequelPrompt}
                      onChange={(e) => setSequelPrompt(e.target.value)}
                      required
                    />
                  </div>

                  <div style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', fontFamily: 'var(--font-mono)' }}>
                      Optional Reference Material / Notes
                    </label>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '80px', boxSizing: 'border-box' }}
                      placeholder="Optional scene notes or specific bedtime motifs."
                      value={sequelReferenceText}
                      onChange={(e) => setSequelReferenceText(e.target.value)}
                    />
                  </div>
                </>
              )}

              <button
                type="submit"
                className="btn-tactile btn-tactile-primary"
                disabled={isWriting}
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
              >
                {isWriting ? '✍️ Writing Draft with Gemini 3.8...' : '✍️ 1. Write Story Draft'}
              </button>
            </form>
          </div>
        ) : loadingStory ? (
          <div className="card-tactile" style={{ textAlign: 'center', padding: '3.5rem' }}>
            <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
              Loading story workbench...
            </p>
          </div>
        ) : storyLoadError ? (
          <div className="card-tactile" style={{ padding: '2rem' }}>
            <p style={{ color: 'var(--accent-state)', fontWeight: 600 }}>⚠️ {storyLoadError}</p>
            <button type="button" className="btn-tactile" onClick={handleStartNewStory}>
              Create New Story
            </button>
          </div>
        ) : activeStory ? (
          /* =========================================================
           * STORY WORKBENCH (Edit Metadata, Direct, Script Turns)
           * ========================================================= */
          <div className="studio-workbench">
            {/* Top Action & Status Bar */}
            <div className="card-tactile" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span className={`badge-tactile ${activeStory.status === 'published' ? 'badge-tactile-published' : 'badge-tactile-draft'}`}>
                    {activeStory.status.toUpperCase()}
                  </span>
                  {activeStory.series_context && (
                    <span className="badge-tactile">
                      Series: {activeStory.series_context.series_id} (Ep #{activeStory.series_context.episode_number})
                    </span>
                  )}
                  <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
                    ID: {activeStory.id}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-tactile"
                    onClick={() => handleStartSequel(activeStory.id)}
                    title="Start next sequel episode"
                  >
                    Start Sequel
                  </button>

                  <button
                    type="button"
                    className={`btn-tactile ${activeStory.status === 'draft' ? 'btn-tactile-published' : ''}`}
                    onClick={handleToggleStatus}
                    disabled={isPublishing || isPublishDisabled}
                    title={isPublishDisabled ? 'Cannot publish story with 0 audio versions' : undefined}
                  >
                    {isPublishing
                      ? 'Updating...'
                      : activeStory.status === 'draft'
                      ? '🚀 Publish Story'
                      : '↩ Revert to Draft'}
                  </button>

                  {!showDeleteConfirm ? (
                    <button
                      type="button"
                      className="btn-tactile"
                      style={{ color: 'var(--accent-state)' }}
                      onClick={() => setShowDeleteConfirm(true)}
                    >
                      🗑 Delete Story
                    </button>
                  ) : (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--accent-state)', fontWeight: 600 }}>
                        Delete permanently?
                      </span>
                      <button
                        type="button"
                        className="btn-tactile"
                        style={{ color: 'var(--accent-state)', borderColor: 'var(--accent-state)' }}
                        onClick={handleDeleteStory}
                        disabled={isDeleting}
                      >
                        {isDeleting ? 'Deleting...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        className="btn-tactile"
                        onClick={() => setShowDeleteConfirm(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {isPublishDisabled && (
                <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                  ℹ️ Publishing requires at least 1 audio version. Add or synthesize audio to publish to the public library.
                </p>
              )}

              {publishError && (
                <p style={{ margin: '0.5rem 0 0 0', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
                  ⚠️ {publishError}
                </p>
              )}
              {deleteError && (
                <p style={{ margin: '0.5rem 0 0 0', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
                  ⚠️ {deleteError}
                </p>
              )}
            </div>

            {/* Step 2 Auto-Direct Banner */}
            <div
              className="card-tactile"
              style={{
                padding: '1.25rem',
                marginBottom: '1.5rem',
                backgroundColor: 'var(--accent-module-bg)',
                borderColor: 'var(--accent-module)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                  <h3 style={{ margin: '0 0 0.25rem 0', fontFamily: 'var(--font-heading)', color: 'var(--ink-primary)' }}>
                    🎬 Step 2: Auto-Direct Voices &amp; Pacing
                  </h3>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                    Instructs Gemini 3.8 Flash to annotate turns with acting styles, insert natural vocal tags, and propose voice designs. Spoken words are preserved verbatim.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-tactile btn-tactile-primary"
                  onClick={handleAutoDirect}
                  disabled={isDirecting}
                >
                  {isDirecting ? '🎬 Directing Script...' : '🎬 2. Auto-Direct Voices & Pacing'}
                </button>
              </div>

              {directError && (
                <p style={{ margin: '0.5rem 0 0 0', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
                  ⚠️ {directError}
                </p>
              )}
            </div>

            {/* Step 3: Voice Audition, Synthesis & Audio Versions */}
            <VoiceStudioPanel
              story={activeStory}
              onStoryUpdated={handleStoryUpdated}
              onBeforeSynthesize={handleSaveScript}
            />

            {/* Metadata Section */}
            <div className="card-tactile" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 1rem 0', fontFamily: 'var(--font-heading)', fontSize: '1.25rem' }}>
                Story Metadata
              </h3>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', fontFamily: 'var(--font-mono)' }}>
                  Title
                </label>
                <input
                  type="text"
                  className="input-tactile"
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  value={editedTitle}
                  onChange={(e) => {
                    setEditedTitle(e.target.value);
                    setSaveSuccess(false);
                  }}
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', fontFamily: 'var(--font-mono)' }}>
                  Summary
                </label>
                <textarea
                  className="input-tactile"
                  style={{ width: '100%', minHeight: '60px', boxSizing: 'border-box' }}
                  value={editedSummary}
                  onChange={(e) => {
                    setEditedSummary(e.target.value);
                    setSaveSuccess(false);
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem', fontFamily: 'var(--font-mono)' }}>
                  Tags (comma-separated)
                </label>
                <input
                  type="text"
                  className="input-tactile"
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  value={editedTags}
                  onChange={(e) => {
                    setEditedTags(e.target.value);
                    setSaveSuccess(false);
                  }}
                />
              </div>
            </div>

            {/* Characters Bible Section */}
            <div className="card-tactile" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: '1.25rem' }}>
                  Characters Bible
                </h3>
                <button
                  type="button"
                  className="btn-tactile"
                  onClick={handleAddCharacter}
                  style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
                >
                  ➕ Add Character
                </button>
              </div>

              {editedCharacters.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', fontStyle: 'italic', margin: 0 }}>
                  No characters defined (Solo Narrator story).
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {editedCharacters.map((char, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        className="input-tactile"
                        style={{ width: '160px' }}
                        placeholder="Character Name"
                        value={char.name}
                        onChange={(e) => handleCharacterChange(idx, 'name', e.target.value)}
                      />
                      <input
                        type="text"
                        className="input-tactile"
                        style={{ flex: 1, minWidth: '200px' }}
                        placeholder="Vocal traits (e.g. gentle bell chime, curious whisper)"
                        value={char.traits}
                        onChange={(e) => handleCharacterChange(idx, 'traits', e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-tactile"
                        style={{ color: 'var(--accent-state)', padding: '0.35rem 0.65rem' }}
                        onClick={() => handleDeleteCharacter(idx)}
                        title="Remove character"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Turn-by-Turn Script Editor */}
            <div className="card-tactile" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: '1.25rem' }}>
                  Turn-by-Turn Script ({editedTurns.length} turns)
                </h3>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {editedTurns.map((turn, idx) => (
                  <div
                    key={turn.turn_id || idx}
                    className="turn-card card-tactile"
                    style={{ padding: '1rem', backgroundColor: 'var(--bg-surface)' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span className="badge-tactile" style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>
                          #{turn.turn_id}
                        </span>

                        {/* Speaker Selector */}
                        <select
                          className="select-tactile"
                          value={turn.speaker}
                          onChange={(e) => handleTurnChange(idx, 'speaker', e.target.value)}
                        >
                          <option value="Narrator">Narrator</option>
                          {editedCharacters.map((c, cIdx) => (
                            <option key={cIdx} value={c.name}>
                              {c.name || `Character ${cIdx + 1}`}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Add Below / Delete Turn */}
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                          onClick={() => handleAddTurn(idx)}
                        >
                          + Turn Below
                        </button>
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', color: 'var(--accent-state)' }}
                          onClick={() => handleDeleteTurn(idx)}
                          disabled={editedTurns.length <= 2}
                          title={editedTurns.length <= 2 ? 'Story must have at least 2 turns' : undefined}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Style Note */}
                    <div style={{ marginBottom: '0.5rem' }}>
                      <input
                        type="text"
                        className="input-tactile"
                        style={{ width: '100%', fontSize: '0.85rem', boxSizing: 'border-box' }}
                        placeholder="Acting style / sustained direction (e.g. Warm bedtime cadence, whisper)"
                        value={turn.style}
                        onChange={(e) => handleTurnChange(idx, 'style', e.target.value)}
                      />
                    </div>

                    {/* Turn Spoken Text */}
                    <div style={{ marginBottom: '0.5rem' }}>
                      <textarea
                        ref={(el) => {
                          if (el) turnTextareaRefs.current.set(idx, el);
                          else turnTextareaRefs.current.delete(idx);
                        }}
                        className="input-tactile"
                        style={{
                          width: '100%',
                          minHeight: '80px',
                          boxSizing: 'border-box',
                          fontFamily: 'var(--font-prose)',
                          fontSize: '0.95rem',
                          lineHeight: '1.5',
                        }}
                        placeholder="Spoken narrative or dialogue text..."
                        value={turn.text}
                        onChange={(e) => handleTurnChange(idx, 'text', e.target.value)}
                      />
                    </div>

                    {/* Quick Vocal Tag Insertion Pills */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
                        Insert tag:
                      </span>
                      {APPROVED_TAGS.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="tag-pill"
                          style={{ fontSize: '0.75rem', padding: '0.15rem 0.45rem', cursor: 'pointer' }}
                          onClick={() => handleInsertTag(idx, tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Sticky Action Bar */}
            <div
              className="card-tactile"
              style={{
                position: 'sticky',
                bottom: '1rem',
                padding: '1rem 1.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.75rem',
                zIndex: 10,
                backgroundColor: 'var(--bg-surface)',
              }}
            >
              <div>
                {saveSuccess && (
                  <span style={{ color: 'var(--accent-root)', fontWeight: 600, fontSize: '0.9rem' }}>
                    ✓ Saved successfully
                  </span>
                )}
                {saveError && (
                  <span style={{ color: 'var(--accent-state)', fontWeight: 600, fontSize: '0.9rem' }}>
                    ⚠️ {saveError}
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn-tactile btn-tactile-primary"
                onClick={handleSaveScript}
                disabled={isSaving}
                style={{ fontSize: '1rem', padding: '0.65rem 1.5rem' }}
              >
                {isSaving ? '💾 Saving...' : '💾 Save Script'}
              </button>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
