import React, { useEffect, useRef, useState, useCallback } from 'react';
import type {
  CharacterProfile,
  ScriptTurn,
  Story,
  CatalogItem,
  StoryAgeRange,
  StoryVocabularyLevel,
} from '../../shared/types';
import { cleanTextForReader } from '../../shared/textClean';
import {
  fetchAdminStories,
  fetchStory,
  writeStoryDraft,
  directStory,
  saveStoryEdits,
  patchStoryStatus,
  deleteStory,
  fetchActiveJobs,
  fetchJobStatus,
  type AdminSession,
} from '../api/client';
import { VoiceStudioPanel } from './VoiceStudioPanel';
import { MicDictationButton, appendWithSmartSpace } from './MicDictationButton';
import { ExpandableFocusComposer } from './ExpandableFocusComposer';

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

export interface GenrePreset {
  id: string;
  label: string;
  promptPrefix: string;
}

export const GENRE_PRESETS: GenrePreset[] = [
  { id: 'any', label: '✨ Any / Custom', promptPrefix: '' },
  { id: 'humor', label: '😂 Fun & Humorous', promptPrefix: 'A funny, comedic adventure with witty banter and playful chaos: ' },
  { id: 'scifi', label: '🚀 Adventure & Sci-Fi', promptPrefix: 'An exciting, fast-paced sci-fi adventure exploring unknown worlds: ' },
  { id: 'mystery', label: '🔍 Mystery & Intrigue', promptPrefix: 'A suspenseful, clever mystery with clues, suspects, and surprising twists: ' },
  { id: 'bedtime', label: '🌙 Bedtime & Soothing', promptPrefix: 'A gentle, soothing bedtime story with calming imagery and peaceful reflections: ' },
  { id: 'fable', label: '🧚 Whimsical Fable', promptPrefix: 'A charming, magical fairy tale fable with enchanted creatures and heart: ' },
];

export interface AgeRangePreset {
  id: StoryAgeRange;
  label: string;
  defaultVocab: StoryVocabularyLevel;
}

export const AGE_RANGE_PRESETS: AgeRangePreset[] = [
  { id: 'toddler', label: '🐣 Ages 2–4 · Toddler', defaultVocab: 'simple' },
  { id: 'early-reader', label: '🎈 Ages 5–7 · Early Reader', defaultVocab: 'standard' },
  { id: 'elementary', label: '🚀 Ages 8–10 · Elementary', defaultVocab: 'enriched' },
  { id: 'young-reader', label: '📚 Ages 11+ · Young Reader', defaultVocab: 'advanced' },
];

export interface VocabularyLevelPreset {
  id: StoryVocabularyLevel;
  label: string;
}

export const VOCABULARY_LEVEL_PRESETS: VocabularyLevelPreset[] = [
  { id: 'simple', label: '🌱 Simple' },
  { id: 'standard', label: '🌟 Standard' },
  { id: 'enriched', label: '💎 Enriched (Word Power)' },
  { id: 'advanced', label: '🎓 Advanced' },
];

export interface DirectorStudioProps {
  session: AdminSession;
  onLogout: () => void;
  onCatalogChanged?: () => void;
  onNavigateHome: () => void;
  currentPath?: string;
  onNavigate?: (path: string) => void;
}

export function DirectorStudio({
  session,
  onLogout,
  onCatalogChanged,
  onNavigateHome,
  currentPath,
  onNavigate,
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
  const [selectedGenrePreset, setSelectedGenrePreset] = useState<string>('any');
  const [selectedAgeRange, setSelectedAgeRange] = useState<StoryAgeRange>('early-reader');
  const [selectedVocabularyLevel, setSelectedVocabularyLevel] = useState<StoryVocabularyLevel>('standard');
  const [showCustomVocabulary, setShowCustomVocabulary] = useState<boolean>(false);
  const [freshPrompt, setFreshPrompt] = useState<string>('');
  const [freshReferenceText, setFreshReferenceText] = useState<string>('');
  const [freshSeriesId, setFreshSeriesId] = useState<string>('');
  const [sequelPreviousStoryId, setSequelPreviousStoryId] = useState<string>('');
  const [sequelPreviousStory, setSequelPreviousStory] = useState<Story | null>(null);
  const [sequelPrompt, setSequelPrompt] = useState<string>('');
  const [sequelReferenceText, setSequelReferenceText] = useState<string>('');
  const [isWriting, setIsWriting] = useState<boolean>(false);
  const [writingElapsedSeconds, setWritingElapsedSeconds] = useState<number>(0);
  const [writeError, setWriteError] = useState<string | null>(null);
  const writingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const draftPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Workbench Edit state
  const [workbenchTab, setWorkbenchTab] = useState<'preview' | 'editor'>('preview');
  const [copiedWorkbenchPrompt, setCopiedWorkbenchPrompt] = useState<boolean>(false);
  const [editedTitle, setEditedTitle] = useState<string>('');
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [editedTags, setEditedTags] = useState<string>('');
  const [editedCharacters, setEditedCharacters] = useState<CharacterProfile[]>([]);
  const [editedTurns, setEditedTurns] = useState<ScriptTurn[]>([]);
  const [isDirecting, setIsDirecting] = useState<boolean>(false);
  const [directingElapsedSeconds, setDirectingElapsedSeconds] = useState<number>(0);
  const [directError, setDirectError] = useState<string | null>(null);
  const directingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const directPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [initialNarratorVoiceId, setInitialNarratorVoiceId] = useState<string | undefined>(undefined);

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

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (writingTimerRef.current) clearInterval(writingTimerRef.current);
      if (directingTimerRef.current) clearInterval(directingTimerRef.current);
      if (draftPollTimerRef.current) clearInterval(draftPollTimerRef.current);
      if (directPollTimerRef.current) clearInterval(directPollTimerRef.current);
    };
  }, []);

  // Prevent accidental navigation or tab closure while generation is active
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isWriting || isDirecting) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isWriting, isDirecting]);

  // Load selected story details into workbench
  const loadStoryIntoWorkbench = useCallback(async (id: string) => {
    setSelectedStoryId(id);
    setViewMode('edit');
    setWorkbenchTab('preview');
    setCopiedWorkbenchPrompt(false);
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

  // Inspect URL query params on mount or when currentPath changes (e.g. handoff from Voice Library or Remix prompt)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const search = currentPath && currentPath.includes('?')
      ? currentPath.slice(currentPath.indexOf('?'))
      : window.location.search;
    const params = new URLSearchParams(search);
    const storyId = params.get('storyId');
    const narratorVoice = params.get('narratorVoiceId');
    const step = params.get('step');
    const remixStoryId = params.get('remixStoryId');

    if (remixStoryId) {
      fetchStory(remixStoryId)
        .then((story) => {
          setFreshPrompt(story.prompt_metadata?.original_prompt || story.summary || '');
          setSelectedAgeRange(story.prompt_metadata?.age_range || 'early-reader');
          setSelectedVocabularyLevel(story.prompt_metadata?.vocabulary_level || 'standard');
          setFreshReferenceText(story.prompt_metadata?.reference_text || '');
          setSelectedGenrePreset(story.prompt_metadata?.genre_preset || 'any');
          setViewMode('create');
          setCreateMode('fresh');
        })
        .catch(() => {
          // ignore error if story not found
        });
      return;
    }

    if (storyId) {
      loadStoryIntoWorkbench(storyId);
      if (narratorVoice) {
        setInitialNarratorVoiceId(narratorVoice);
      }
      if (step === '3' || narratorVoice) {
        setTimeout(() => {
          document.getElementById('step-3-voice-studio')?.scrollIntoView?.({ behavior: 'smooth' });
        }, 300);
      }
    }
  }, [currentPath, loadStoryIntoWorkbench]);

  const startPollingDraftJob = useCallback((jobId: string) => {
    if (draftPollTimerRef.current) clearInterval(draftPollTimerRef.current);
    draftPollTimerRef.current = setInterval(async () => {
      try {
        const job = await fetchJobStatus(jobId);
        if (job.status === 'running') {
          setWritingElapsedSeconds(job.elapsed_seconds);
        } else if (job.status === 'completed') {
          if (draftPollTimerRef.current) {
            clearInterval(draftPollTimerRef.current);
            draftPollTimerRef.current = null;
          }
          if (writingTimerRef.current) {
            clearInterval(writingTimerRef.current);
            writingTimerRef.current = null;
          }
          setIsWriting(false);
          await loadStories();
          onCatalogChanged?.();
          if (job.result_story_id) {
            await loadStoryIntoWorkbench(job.result_story_id);
          }
        } else if (job.status === 'failed') {
          if (draftPollTimerRef.current) {
            clearInterval(draftPollTimerRef.current);
            draftPollTimerRef.current = null;
          }
          if (writingTimerRef.current) {
            clearInterval(writingTimerRef.current);
            writingTimerRef.current = null;
          }
          setIsWriting(false);
          setWriteError(job.error || 'Draft generation failed');
        }
      } catch {
        // Keep polling on transient errors
      }
    }, 1500);
  }, [loadStories, onCatalogChanged, loadStoryIntoWorkbench]);

  const startPollingDirectJob = useCallback((jobId: string, storyId: string) => {
    if (directPollTimerRef.current) clearInterval(directPollTimerRef.current);
    directPollTimerRef.current = setInterval(async () => {
      try {
        const job = await fetchJobStatus(jobId);
        if (job.status === 'running') {
          setDirectingElapsedSeconds(job.elapsed_seconds);
        } else if (job.status === 'completed') {
          if (directPollTimerRef.current) {
            clearInterval(directPollTimerRef.current);
            directPollTimerRef.current = null;
          }
          if (directingTimerRef.current) {
            clearInterval(directingTimerRef.current);
            directingTimerRef.current = null;
          }
          setIsDirecting(false);
          const directed = await fetchStory(storyId);
          setActiveStory(directed);
          setEditedTitle(directed.title);
          setEditedSummary(directed.summary);
          setEditedTags(directed.tags.join(', '));
          setEditedCharacters(JSON.parse(JSON.stringify(directed.characters)));
          setEditedTurns(JSON.parse(JSON.stringify(directed.script_turns)));
          await loadStories();
          onCatalogChanged?.();
        } else if (job.status === 'failed') {
          if (directPollTimerRef.current) {
            clearInterval(directPollTimerRef.current);
            directPollTimerRef.current = null;
          }
          if (directingTimerRef.current) {
            clearInterval(directingTimerRef.current);
            directingTimerRef.current = null;
          }
          setIsDirecting(false);
          setDirectError(job.error || 'Directing failed');
        }
      } catch {
        // Keep polling
      }
    }, 1500);
  }, [loadStories, onCatalogChanged]);

  // Check and restore active jobs upon mount or story change
  const checkActiveJobs = useCallback(async () => {
    try {
      const activeJobs = await fetchActiveJobs();
      if (!Array.isArray(activeJobs) || activeJobs.length === 0) return;

      // 1. Check for running draft job
      const draftJob = activeJobs.find((j) => j.type === 'draft' && j.status === 'running');
      if (draftJob) {
        setViewMode('create');
        setIsWriting(true);
        setWriteError(null);
        setWritingElapsedSeconds(draftJob.elapsed_seconds || 0);

        if (!writingTimerRef.current) {
          writingTimerRef.current = setInterval(() => {
            setWritingElapsedSeconds((sec) => sec + 1);
          }, 1000);
        }
        startPollingDraftJob(draftJob.job_id);
        return;
      }

      // 2. Check for running direct job
      if (activeStory) {
        const directJob = activeJobs.find(
          (j) =>
            j.type === 'direct' &&
            j.status === 'running' &&
            (j.story_id === activeStory.id || j.result_story_id === activeStory.id)
        );
        if (directJob) {
          setIsDirecting(true);
          setDirectError(null);
          setDirectingElapsedSeconds(directJob.elapsed_seconds || 0);

          if (!directingTimerRef.current) {
            directingTimerRef.current = setInterval(() => {
              setDirectingElapsedSeconds((sec) => sec + 1);
            }, 1000);
          }
          startPollingDirectJob(directJob.job_id, activeStory.id);
        }
      }
    } catch {
      // Graceful fallback
    }
  }, [activeStory, startPollingDraftJob, startPollingDirectJob]);

  useEffect(() => {
    checkActiveJobs();
  }, [checkActiveJobs]);

  useEffect(() => {
    if (createMode === 'sequel' && sequelPreviousStoryId) {
      fetchStory(sequelPreviousStoryId)
        .then((s) => setSequelPreviousStory(s))
        .catch(() => setSequelPreviousStory(null));
    } else {
      setSequelPreviousStory(null);
    }
  }, [createMode, sequelPreviousStoryId]);

  const handleSelectGenrePreset = (preset: GenrePreset) => {
    setSelectedGenrePreset(preset.id);
    if (preset.id === 'any') return;
    setFreshPrompt((current) => {
      for (const p of GENRE_PRESETS) {
        if (p.promptPrefix && current.startsWith(p.promptPrefix)) {
          return preset.promptPrefix + current.slice(p.promptPrefix.length);
        }
      }
      if (!current.trim()) {
        return preset.promptPrefix;
      }
      return `${preset.promptPrefix}${current}`;
    });
  };

  const handleSelectAgeRange = (preset: AgeRangePreset) => {
    setSelectedAgeRange(preset.id);
    setSelectedVocabularyLevel(preset.defaultVocab);
  };

  const handleSelectVocabularyLevel = (level: StoryVocabularyLevel) => {
    setSelectedVocabularyLevel(level);
  };

  const handleClonePrompt = () => {
    if (!activeStory?.prompt_metadata) return;
    const meta = activeStory.prompt_metadata;
    setFreshPrompt(meta.original_prompt || '');
    setSelectedAgeRange(meta.age_range || 'early-reader');
    setSelectedVocabularyLevel(meta.vocabulary_level || 'standard');
    setFreshReferenceText(meta.reference_text || '');
    setSelectedGenrePreset(meta.genre_preset || 'any');
    setViewMode('create');
    setCreateMode('fresh');
  };

  const handleCopyWorkbenchPrompt = async () => {
    const prompt = activeStory?.prompt_metadata?.original_prompt;
    if (!prompt) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      }
      setCopiedWorkbenchPrompt(true);
      setTimeout(() => setCopiedWorkbenchPrompt(false), 2500);
    } catch {
      setCopiedWorkbenchPrompt(true);
      setTimeout(() => setCopiedWorkbenchPrompt(false), 2500);
    }
  };

  const handleStartNewStory = () => {
    setViewMode('create');
    setSelectedStoryId(null);
    setActiveStory(null);
    setWriteError(null);
    setSelectedGenrePreset('any');
    setSelectedAgeRange('early-reader');
    setSelectedVocabularyLevel('standard');
    setShowCustomVocabulary(false);
    setFreshPrompt('');
    setFreshReferenceText('');
    setFreshSeriesId('');
    setSequelPrompt('');
    setSequelReferenceText('');
    setSequelPreviousStoryId(stories.length > 0 ? stories[0].id : '');
    setSequelPreviousStory(null);
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
    setWritingElapsedSeconds(0);
    writingTimerRef.current = setInterval(() => {
      setWritingElapsedSeconds((sec) => sec + 1);
    }, 1000);

    try {
      let created: Story;
      if (createMode === 'fresh') {
        if (!freshPrompt.trim()) {
          setWriteError('Please enter a story prompt.');
          setIsWriting(false);
          return;
        }
        created = await writeStoryDraft(
          {
            mode: 'fresh',
            prompt: freshPrompt.trim(),
            referenceText: freshReferenceText.trim() || undefined,
            seriesId: freshSeriesId.trim() || undefined,
            ageRange: selectedAgeRange,
            vocabularyLevel: selectedVocabularyLevel,
            genrePreset: selectedGenrePreset !== 'any' ? selectedGenrePreset : undefined,
          },
          {
            async: true,
            onProgress: (job) => setWritingElapsedSeconds(job.elapsed_seconds),
          }
        );
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
        created = await writeStoryDraft(
          {
            mode: 'sequel',
            previousStoryId: sequelPreviousStoryId,
            prompt: sequelPrompt.trim(),
            referenceText: sequelReferenceText.trim() || undefined,
            ageRange: selectedAgeRange,
            vocabularyLevel: selectedVocabularyLevel,
            genrePreset: selectedGenrePreset !== 'any' ? selectedGenrePreset : undefined,
          },
          {
            async: true,
            onProgress: (job) => setWritingElapsedSeconds(job.elapsed_seconds),
          }
        );
      }

      await loadStories();
      onCatalogChanged?.();
      setWorkbenchTab('preview');
      await loadStoryIntoWorkbench(created.id);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : 'Draft generation failed');
    } finally {
      if (writingTimerRef.current) {
        clearInterval(writingTimerRef.current);
        writingTimerRef.current = null;
      }
      setIsWriting(false);
    }
  };

  // Helper to persist pending workbench edits, syncing state and rethrowing on failure
  const persistWorkbenchEdits = async (): Promise<Story> => {
    if (!activeStory) {
      throw new Error('No active story to save');
    }
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
    await loadStories();
    onCatalogChanged?.();
    return updated;
  };

  // Step 2: Auto-Direct Voices & Pacing
  const handleAutoDirect = async () => {
    if (!activeStory) return;
    setIsDirecting(true);
    setDirectError(null);
    setDirectingElapsedSeconds(0);
    directingTimerRef.current = setInterval(() => {
      setDirectingElapsedSeconds((sec) => sec + 1);
    }, 1000);
    try {
      // Persist pending workbench edits first so auto-direct acts on latest user prose/characters
      await persistWorkbenchEdits();

      const directed = await directStory(activeStory.id, {
        async: true,
        onProgress: (job) => setDirectingElapsedSeconds(job.elapsed_seconds),
      });
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
      if (directingTimerRef.current) {
        clearInterval(directingTimerRef.current);
        directingTimerRef.current = null;
      }
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
      await persistWorkbenchEdits();
      setSaveSuccess(true);
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
            disabled={isWriting || isDirecting}
            style={{ width: '100%', marginBottom: '0.75rem' }}
          >
            ➕ New Story
          </button>
          <button
            type="button"
            className="btn-tactile"
            onClick={onNavigateHome}
            disabled={isWriting || isDirecting}
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
              const isBusy = isWriting || isDirecting;
              return (
                <div
                  key={item.id}
                  className={`studio-story-item card-tactile ${isSelected ? 'studio-story-item-active' : ''}`}
                  onClick={() => {
                    if (!isBusy) loadStoryIntoWorkbench(item.id);
                  }}
                  style={{
                    cursor: isBusy ? 'not-allowed' : 'pointer',
                    opacity: isBusy ? 0.7 : 1,
                    marginBottom: '0.6rem',
                    padding: '0.65rem',
                  }}
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
                      disabled={isBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isBusy) handleStartSequel(item.id);
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
              ✍️ Step 1: Write Story Draft
            </h2>

            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn-tactile ${createMode === 'fresh' ? 'btn-tactile-primary' : ''}`}
                disabled={isWriting}
                onClick={() => setCreateMode('fresh')}
              >
                Mode A: Fresh Story
              </button>
              <button
                type="button"
                className={`btn-tactile ${createMode === 'sequel' ? 'btn-tactile-primary' : ''}`}
                disabled={isWriting}
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
                    {/* Age Range & Vocabulary Presets */}
                    <div style={{ marginBottom: '0.85rem' }}>
                      <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)', marginBottom: '0.35rem' }}>
                        TARGET AGE RANGE
                      </span>
                      <div className="age-preset-pills">
                        {AGE_RANGE_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className={`age-preset-pill ${selectedAgeRange === preset.id ? 'active' : ''}`}
                            disabled={isWriting}
                            onClick={() => handleSelectAgeRange(preset)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ marginBottom: '0.85rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
                          VOCABULARY COMPLEXITY: <span style={{ color: 'var(--accent-module)', textTransform: 'capitalize' }}>{selectedVocabularyLevel}</span>
                        </span>
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.15rem 0.45rem' }}
                          disabled={isWriting}
                          onClick={() => setShowCustomVocabulary((prev) => !prev)}
                        >
                          {showCustomVocabulary ? 'Hide Custom Vocab' : '⚙️ Custom Vocabulary'}
                        </button>
                      </div>

                      {showCustomVocabulary && (
                        <div className="vocab-pills" style={{ marginTop: '0.4rem' }}>
                          {VOCABULARY_LEVEL_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              className={`vocab-pill ${selectedVocabularyLevel === preset.id ? 'active' : ''}`}
                              disabled={isWriting}
                              onClick={() => handleSelectVocabularyLevel(preset.id)}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ marginBottom: '0.65rem' }}>
                      <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)', marginBottom: '0.35rem' }}>
                        GENRE &amp; MOOD PRESETS
                      </span>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {GENRE_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className={`btn-tactile ${selectedGenrePreset === preset.id ? 'btn-tactile-primary' : ''}`}
                            style={{ fontSize: '0.8rem', padding: '0.25rem 0.55rem' }}
                            disabled={isWriting}
                            onClick={() => handleSelectGenrePreset(preset)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                      <label style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        Story Prompt *
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <MicDictationButton
                          contextHint="story_prompt"
                          onTranscript={(text) => setFreshPrompt((prev) => appendWithSmartSpace(prev, text))}
                          disabled={isWriting}
                        />
                        <ExpandableFocusComposer
                          title="Story Prompt"
                          value={freshPrompt}
                          onChange={setFreshPrompt}
                          contextHint="story_prompt"
                          placeholder="e.g. A comedic sci-fi adventure about two quirky space mechanics trying to fix a hiccuping robot on a distant asteroid."
                          disabled={isWriting}
                        />
                      </div>
                    </div>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '100px', boxSizing: 'border-box' }}
                      placeholder="e.g. A comedic sci-fi adventure about two quirky space mechanics trying to fix a hiccuping robot on a distant asteroid."
                      value={freshPrompt}
                      onChange={(e) => setFreshPrompt(e.target.value)}
                      disabled={isWriting}
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
                      placeholder="e.g. space-mechanics-adventures"
                      value={freshSeriesId}
                      onChange={(e) => setFreshSeriesId(e.target.value)}
                      disabled={isWriting}
                    />
                    <small style={{ color: 'var(--ink-muted)', display: 'block', marginTop: '0.25rem' }}>
                      If set, this story initiates Episode #1 of an ongoing series.
                    </small>
                  </div>

                  <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                      <label style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        Optional Reference Material / Lore
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <MicDictationButton
                          contextHint="story_prompt"
                          onTranscript={(text) => setFreshReferenceText((prev) => appendWithSmartSpace(prev, text))}
                          disabled={isWriting}
                        />
                        <ExpandableFocusComposer
                          title="Reference Material / Lore"
                          value={freshReferenceText}
                          onChange={setFreshReferenceText}
                          contextHint="story_prompt"
                          placeholder="Optional world details, poem verses, or character backstory to weave into the story."
                          disabled={isWriting}
                        />
                      </div>
                    </div>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '80px', boxSizing: 'border-box' }}
                      placeholder="Optional world details, poem verses, or character backstory to weave into the story."
                      value={freshReferenceText}
                      onChange={(e) => setFreshReferenceText(e.target.value)}
                      disabled={isWriting}
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
                      disabled={isWriting}
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

                  {/* Previous Episode Prompt Reference if available */}
                  {sequelPreviousStory?.prompt_metadata?.original_prompt && (
                    <div
                      className="card-tactile"
                      style={{
                        marginBottom: '1.25rem',
                        padding: '0.75rem 1rem',
                        backgroundColor: 'var(--bg-well)',
                        borderLeft: '4px solid var(--accent-module)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem', flexWrap: 'wrap', gap: '0.3rem' }}>
                        <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ink-muted)' }}>
                          💡 Previous Episode Inspiration Prompt
                        </span>
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                          {sequelPreviousStory.prompt_metadata.age_range && (
                            <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                              Ages: {sequelPreviousStory.prompt_metadata.age_range}
                            </span>
                          )}
                          {sequelPreviousStory.prompt_metadata.vocabulary_level && (
                            <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                              Vocab: {sequelPreviousStory.prompt_metadata.vocabulary_level}
                            </span>
                          )}
                        </div>
                      </div>
                      <p style={{ margin: 0, fontSize: '0.85rem', fontStyle: 'italic', color: 'var(--ink-prose)' }}>
                        &ldquo;{sequelPreviousStory.prompt_metadata.original_prompt}&rdquo;
                      </p>
                    </div>
                  )}

                  {/* Age Range & Vocabulary Presets for Sequel */}
                  <div style={{ marginBottom: '1.25rem' }}>
                    <div style={{ marginBottom: '0.85rem' }}>
                      <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)', marginBottom: '0.35rem' }}>
                        TARGET AGE RANGE
                      </span>
                      <div className="age-preset-pills">
                        {AGE_RANGE_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className={`age-preset-pill ${selectedAgeRange === preset.id ? 'active' : ''}`}
                            disabled={isWriting}
                            onClick={() => handleSelectAgeRange(preset)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ marginBottom: '0.85rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
                          VOCABULARY COMPLEXITY: <span style={{ color: 'var(--accent-module)', textTransform: 'capitalize' }}>{selectedVocabularyLevel}</span>
                        </span>
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ fontSize: '0.75rem', padding: '0.15rem 0.45rem' }}
                          disabled={isWriting}
                          onClick={() => setShowCustomVocabulary((prev) => !prev)}
                        >
                          {showCustomVocabulary ? 'Hide Custom Vocab' : '⚙️ Custom Vocabulary'}
                        </button>
                      </div>

                      {showCustomVocabulary && (
                        <div className="vocab-pills" style={{ marginTop: '0.4rem' }}>
                          {VOCABULARY_LEVEL_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              className={`vocab-pill ${selectedVocabularyLevel === preset.id ? 'active' : ''}`}
                              disabled={isWriting}
                              onClick={() => handleSelectVocabularyLevel(preset.id)}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ marginBottom: '1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                      <label style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        Sequel Episode Prompt *
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <MicDictationButton
                          contextHint="story_prompt"
                          onTranscript={(text) => setSequelPrompt((prev) => appendWithSmartSpace(prev, text))}
                          disabled={isWriting}
                        />
                        <ExpandableFocusComposer
                          title="Sequel Episode Prompt"
                          value={sequelPrompt}
                          onChange={setSequelPrompt}
                          contextHint="story_prompt"
                          placeholder="e.g. In tonight's journey, the space mechanics arrive at Nebula Station, only to discover the robot's hiccups are transmitting an alien disco beat across the sector."
                          disabled={isWriting}
                        />
                      </div>
                    </div>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '100px', boxSizing: 'border-box' }}
                      placeholder="e.g. In tonight's journey, the space mechanics arrive at Nebula Station, only to discover the robot's hiccups are transmitting an alien disco beat across the sector."
                      value={sequelPrompt}
                      onChange={(e) => setSequelPrompt(e.target.value)}
                      disabled={isWriting}
                      required
                    />
                  </div>

                  <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                      <label style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        Optional Reference Material / Notes
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <MicDictationButton
                          contextHint="story_prompt"
                          onTranscript={(text) => setSequelReferenceText((prev) => appendWithSmartSpace(prev, text))}
                          disabled={isWriting}
                        />
                        <ExpandableFocusComposer
                          title="Sequel Reference Material / Notes"
                          value={sequelReferenceText}
                          onChange={setSequelReferenceText}
                          contextHint="story_prompt"
                          placeholder="Optional scene notes, character dynamics, or specific narrative motifs."
                          disabled={isWriting}
                        />
                      </div>
                    </div>
                    <textarea
                      className="input-tactile"
                      style={{ width: '100%', minHeight: '80px', boxSizing: 'border-box' }}
                      placeholder="Optional scene notes, character dynamics, or specific narrative motifs."
                      value={sequelReferenceText}
                      onChange={(e) => setSequelReferenceText(e.target.value)}
                      disabled={isWriting}
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
                {isWriting
                  ? `✍️ Writing Draft... (${writingElapsedSeconds}s)`
                  : '✍️ 1. Write Story Draft'}
              </button>

              {isWriting && (
                <div
                  className="card-tactile tactile-progress-card"
                  role="status"
                  aria-live="polite"
                  style={{
                    marginTop: '1.25rem',
                    padding: '1.25rem',
                    border: '2px solid var(--accent-module)',
                    backgroundColor: 'var(--accent-module-bg)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <span className="spinner-tactile" style={{ fontSize: '1.2rem' }}>✍️</span>
                    <strong style={{ fontSize: '1rem', color: 'var(--ink-primary)' }}>
                      Drafting story with Gemini 3.8 Flash... {writingElapsedSeconds}s
                    </strong>
                  </div>
                  <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                    ✍️ Drafting story with Gemini 3.8 Flash... {writingElapsedSeconds}s (typically 8–15s). Creating characters and script turns. Please keep this tab open.
                  </p>
                  <div className="tactile-progress-bar-container">
                    <div className="tactile-progress-bar-indeterminate" />
                  </div>
                </div>
              )}
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
                    disabled={isDirecting}
                    title="Start next sequel episode"
                  >
                    Start Sequel
                  </button>

                  <button
                    type="button"
                    className={`btn-tactile ${activeStory.status === 'draft' ? 'btn-tactile-published' : ''}`}
                    onClick={handleToggleStatus}
                    disabled={isPublishing || isPublishDisabled || isDirecting}
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
                      disabled={isDirecting}
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
                        disabled={isDeleting || isDirecting}
                      >
                        {isDeleting ? 'Deleting...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        className="btn-tactile"
                        disabled={isDirecting}
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

            {/* Original Prompt Card & 1-Click Remix in Workbench */}
            {activeStory.prompt_metadata && (
              <div
                className="card-tactile workbench-prompt-card"
                style={{
                  padding: '1rem 1.25rem',
                  marginBottom: '1.25rem',
                  backgroundColor: 'var(--bg-surface)',
                  borderLeft: '4px solid var(--accent-root)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-primary)' }}>
                    💡 Story Inspiration Prompt
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                    {activeStory.prompt_metadata.age_range && (
                      <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                        🎯 Ages: {activeStory.prompt_metadata.age_range}
                      </span>
                    )}
                    {activeStory.prompt_metadata.vocabulary_level && (
                      <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                        📖 Vocab: {activeStory.prompt_metadata.vocabulary_level}
                      </span>
                    )}
                    {activeStory.prompt_metadata.genre_preset && activeStory.prompt_metadata.genre_preset !== 'any' && (
                      <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                        ✨ Genre: {activeStory.prompt_metadata.genre_preset}
                      </span>
                    )}
                  </div>
                </div>

                <p style={{ margin: '0 0 0.65rem 0', fontSize: '0.9rem', fontStyle: 'italic', color: 'var(--ink-prose)', lineHeight: 1.5 }}>
                  &ldquo;{activeStory.prompt_metadata.original_prompt}&rdquo;
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-tactile"
                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.55rem' }}
                    onClick={handleCopyWorkbenchPrompt}
                  >
                    {copiedWorkbenchPrompt ? '✓ Copied!' : '📋 Copy Prompt'}
                  </button>
                  <button
                    type="button"
                    className="btn-tactile btn-tactile-primary"
                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.55rem' }}
                    onClick={handleClonePrompt}
                  >
                    🧬 Clone / Tweak Prompt
                  </button>
                </div>
              </div>
            )}

            {/* Dual-Tab Segmented Tab Row */}
            <div className="workbench-tab-row" role="tablist" aria-label="Workbench View Mode">
              <button
                type="button"
                role="tab"
                className={`workbench-tab-btn ${workbenchTab === 'preview' ? 'active' : ''}`}
                aria-selected={workbenchTab === 'preview'}
                onClick={() => setWorkbenchTab('preview')}
              >
                📖 Storybook Preview
              </button>
              <button
                type="button"
                role="tab"
                className={`workbench-tab-btn ${workbenchTab === 'editor' ? 'active' : ''}`}
                aria-selected={workbenchTab === 'editor'}
                onClick={() => setWorkbenchTab('editor')}
              >
                🎛️ Script Editor
              </button>
            </div>

            {workbenchTab === 'preview' ? (
              <div className="workbench-preview-view">
                {/* Action banner */}
                <div className="storybook-preview-actions-banner">
                  <div>
                    <strong style={{ display: 'block', fontSize: '0.95rem', color: 'var(--accent-root)' }}>
                      🎉 Story drafted! Preview your storybook below before directing voices.
                    </strong>
                    <span style={{ fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                      Read through the narrative flow, character dialogue, and tone before synthesizing audio.
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn-tactile btn-tactile-primary"
                      onClick={handleAutoDirect}
                      disabled={isDirecting}
                    >
                      {isDirecting
                        ? `🎬 Directing Script... (${directingElapsedSeconds}s)`
                        : '🎬 Step 2: Auto-Direct Voices & Pacing'}
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => setWorkbenchTab('editor')}
                    >
                      ✏️ Switch to Script Editor
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => {
                        if (onNavigate) {
                          onNavigate(`/stories/${encodeURIComponent(activeStory.id)}`);
                        } else if (typeof window !== 'undefined') {
                          window.location.assign(`/stories/${encodeURIComponent(activeStory.id)}`);
                        }
                      }}
                    >
                      📖 View in Public Reader
                    </button>
                  </div>
                </div>

                {isDirecting && (
                  <div
                    className="card-tactile tactile-progress-card"
                    role="status"
                    aria-live="polite"
                    style={{
                      marginBottom: '1.5rem',
                      padding: '1.25rem',
                      border: '2px solid var(--accent-module)',
                      backgroundColor: 'var(--accent-module-bg)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                      <span className="spinner-tactile" style={{ fontSize: '1.2rem' }}>🎬</span>
                      <strong style={{ fontSize: '1rem', color: 'var(--ink-primary)' }}>
                        Directing vocal expressions and pacing with Gemini 3.8 Flash... {directingElapsedSeconds}s
                      </strong>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                      Adding emotional cues and vocal tags. Spoken words are preserved verbatim.
                    </p>
                  </div>
                )}

                {/* Formatted Storybook Reader Layout */}
                <div className="storybook-preview-pane">
                  <div style={{ textAlign: 'center', marginBottom: '2rem', borderBottom: '1px solid var(--ink-primary)', paddingBottom: '1.25rem' }}>
                    {activeStory.series_context?.series_id && (
                      <span className="badge-mono series-badge" style={{ marginBottom: '0.5rem', display: 'inline-block' }}>
                        {activeStory.series_context.series_id} · Episode {activeStory.series_context.episode_number}
                      </span>
                    )}
                    <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '2rem', margin: '0 0 0.5rem 0', color: 'var(--ink-primary)' }}>
                      {editedTitle || activeStory.title}
                    </h2>
                    <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)', fontSize: '0.95rem' }}>
                      {editedSummary || activeStory.summary}
                    </p>
                  </div>

                  <section className="reader-prose-body">
                    {(() => {
                      let previewHasFirstNarrator = false;
                      return editedTurns.map((turn) => {
                        const cleanedText = cleanTextForReader(turn.text);
                        if (!cleanedText) return null;
                        const isNarrator = turn.speaker.toLowerCase() === 'narrator';

                        if (isNarrator) {
                          const isFirst = !previewHasFirstNarrator;
                          previewHasFirstNarrator = true;
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
                      });
                    })()}
                  </section>
                </div>
              </div>
            ) : (
              <div className="workbench-editor-view">
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
                    Instructs Gemini 3.8 Flash to annotate turns with emotional acting styles, insert natural vocal tags, and propose voice designs matching the story&apos;s genre. Spoken words are preserved verbatim.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-tactile btn-tactile-primary"
                  onClick={handleAutoDirect}
                  disabled={isDirecting}
                >
                  {isDirecting
                    ? `🎬 Directing Script... (${directingElapsedSeconds}s)`
                    : '🎬 2. Auto-Direct Voices & Pacing'}
                </button>
              </div>

              {directError && (
                <p style={{ margin: '0.5rem 0 0 0', color: 'var(--accent-state)', fontSize: '0.85rem' }}>
                  ⚠️ {directError}
                </p>
              )}

              {isDirecting && (
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
                    <span className="spinner-tactile" style={{ fontSize: '1.2rem' }}>🎬</span>
                    <strong style={{ fontSize: '1rem', color: 'var(--ink-primary)' }}>
                      Directing vocal expressions and pacing with Gemini 3.8 Flash... {directingElapsedSeconds}s
                    </strong>
                  </div>
                  <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                    🎬 Directing vocal expressions and pacing with Gemini 3.8 Flash... {directingElapsedSeconds}s (typically 5–12s). Adding emotional cues and audio tags.
                  </p>
                  <div className="tactile-progress-bar-container">
                    <div className="tactile-progress-bar-indeterminate" />
                  </div>
                </div>
              )}
            </div>

            {/* Step 3: Voice Audition, Synthesis & Audio Versions */}
            <VoiceStudioPanel
              story={{ ...activeStory, characters: editedCharacters }}
              onStoryUpdated={handleStoryUpdated}
              initialNarratorVoiceId={initialNarratorVoiceId}
              onNavigateToVoiceLibrary={onNavigate ? () => onNavigate('/admin/voices') : undefined}
              onBeforeSynthesize={async () => {
                await persistWorkbenchEdits();
              }}
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
                    <div key={idx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        className="input-tactile"
                        style={{ width: '150px' }}
                        placeholder="Character Name"
                        value={char.name}
                        onChange={(e) => handleCharacterChange(idx, 'name', e.target.value)}
                      />
                      <div style={{ flex: 1, minWidth: '220px', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                        <input
                          type="text"
                          className="input-tactile"
                          style={{ flex: 1 }}
                          placeholder="Vocal traits (e.g. gentle bell chime, curious whisper)"
                          value={char.traits}
                          onChange={(e) => handleCharacterChange(idx, 'traits', e.target.value)}
                        />
                        <MicDictationButton
                          compact={true}
                          contextHint="voice_prompt"
                          title={`Dictate traits for ${char.name || 'character'}`}
                          onTranscript={(text) =>
                            handleCharacterChange(idx, 'traits', appendWithSmartSpace(char.traits, text))
                          }
                        />
                        <ExpandableFocusComposer
                          compactTrigger={true}
                          title={`${char.name || 'Character'} Vocal Traits`}
                          value={char.traits}
                          onChange={(val) => handleCharacterChange(idx, 'traits', val)}
                          contextHint="voice_prompt"
                          placeholder="Vocal traits (e.g. gentle bell chime, curious whisper)"
                        />
                      </div>
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
                    <div style={{ marginBottom: '0.65rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
                          Acting Style Note
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          <MicDictationButton
                            compact={true}
                            contextHint="voice_prompt"
                            title={`Dictate style note for Turn #${turn.turn_id}`}
                            onTranscript={(text) =>
                              handleTurnChange(idx, 'style', appendWithSmartSpace(turn.style, text))
                            }
                          />
                          <ExpandableFocusComposer
                            compactTrigger={true}
                            title={`Turn #${turn.turn_id} Acting Style (${turn.speaker})`}
                            value={turn.style}
                            onChange={(val) => handleTurnChange(idx, 'style', val)}
                            contextHint="voice_prompt"
                            placeholder="Acting style / sustained direction (e.g. Warm bedtime cadence, whisper)"
                          />
                        </div>
                      </div>
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
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
                          Spoken Text
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          <MicDictationButton
                            contextHint="script_dialogue"
                            title={`Dictate spoken text for Turn #${turn.turn_id}`}
                            onTranscript={(text) =>
                              handleTurnChange(idx, 'text', appendWithSmartSpace(turn.text, text))
                            }
                          />
                          <ExpandableFocusComposer
                            title={`Turn #${turn.turn_id} Dialogue (${turn.speaker})`}
                            value={turn.text}
                            onChange={(val) => handleTurnChange(idx, 'text', val)}
                            enableVocalTagPills={true}
                            contextHint="script_dialogue"
                            placeholder="Spoken narrative or dialogue text..."
                          />
                        </div>
                      </div>
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
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
