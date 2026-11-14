import React, { useCallback, useEffect, useState } from 'react';
import type { AudioVersion, CatalogItem, PodcastConfig, Story } from '../../shared/types';
import {
  createPodcast,
  deletePodcast,
  fetchAdminPodcasts,
  fetchCatalog,
  fetchStory,
  releaseStoryToPodcast,
  unreleaseStoryFromPodcast,
  updatePodcast,
  type AdminSession,
} from '../api/client';

export interface PodcastLibraryPageProps {
  session: AdminSession;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onNavigateHome: () => void;
  onCatalogChanged?: () => void;
}

/**
 * Admin management tab (`/admin/podcasts`) for dynamic bucket-driven Podcast RSS feeds,
 * private token management, and episode release / audio version curation.
 */
export function PodcastLibraryPage({
  session: _session,
  onLogout: _onLogout,
  onNavigate: _onNavigate,
  onNavigateHome: _onNavigateHome,
  onCatalogChanged,
}: PodcastLibraryPageProps): React.JSX.Element {
  const [podcasts, setPodcasts] = useState<PodcastConfig[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [storyDetailsMap, setStoryDetailsMap] = useState<Record<string, Story>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Create / Edit modal/card state
  const [showForm, setShowForm] = useState<boolean>(false);
  const [editingPodcastId, setEditingPodcastId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState<string>('');
  const [formAuthor, setFormAuthor] = useState<string>('Storyteller Studio');
  const [formDescription, setFormDescription] = useState<string>('');
  const [formLanguage, setFormLanguage] = useState<string>('en-us');
  const [formToken, setFormToken] = useState<string>('');
  const [savingForm, setSavingForm] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Per-podcast interactive states
  const [copiedPodcastId, setCopiedPodcastId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [quickReleaseStoryId, setQuickReleaseStoryId] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedPodcasts, loadedCatalog] = await Promise.all([
        fetchAdminPodcasts(),
        fetchCatalog(true),
      ]);
      setPodcasts(loadedPodcasts);
      setCatalog(loadedCatalog);

      // Fetch full story details for all referenced episode story IDs so we can render
      // version labels, durations, and multi-version <select> switchers
      const episodeStoryIds = Array.from(
        new Set(
          loadedPodcasts.flatMap((p) => (p.episodes || []).map((ep) => ep.story_id))
        )
      );
      if (episodeStoryIds.length > 0) {
        const entries = await Promise.all(
          episodeStoryIds.map(async (sid) => {
            try {
              const s = await fetchStory(sid);
              return [sid, s] as const;
            } catch {
              return null;
            }
          })
        );
        const nextMap: Record<string, Story> = {};
        for (const entry of entries) {
          if (entry) {
            nextMap[entry[0]] = entry[1];
          }
        }
        setStoryDetailsMap(nextMap);
      } else {
        setStoryDetailsMap({});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load podcasts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openCreateForm = () => {
    setEditingPodcastId(null);
    setFormTitle('');
    setFormAuthor('Storyteller Studio');
    setFormDescription('');
    setFormLanguage('en-us');
    setFormToken('');
    setFormError(null);
    setShowForm(true);
  };

  const openEditForm = (podcast: PodcastConfig) => {
    setEditingPodcastId(podcast.id);
    setFormTitle(podcast.title);
    setFormAuthor(podcast.author || 'Storyteller Studio');
    setFormDescription(podcast.description || '');
    setFormLanguage(podcast.language || 'en-us');
    setFormToken(podcast.token || '');
    setFormError(null);
    setShowForm(true);
  };

  const handleSavePodcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim()) {
      setFormError('Podcast title is required.');
      return;
    }
    setSavingForm(true);
    setFormError(null);
    try {
      if (editingPodcastId) {
        const updated = await updatePodcast(editingPodcastId, {
          title: formTitle.trim(),
          author: formAuthor.trim() || 'Storyteller Studio',
          description: formDescription.trim(),
          language: formLanguage.trim() || 'en-us',
          token: formToken.trim(),
        });
        setPodcasts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      } else {
        const created = await createPodcast({
          title: formTitle.trim(),
          author: formAuthor.trim() || 'Storyteller Studio',
          description: formDescription.trim() || formTitle.trim(),
          language: formLanguage.trim() || 'en-us',
          token: formToken.trim() || undefined,
        });
        setPodcasts((prev) => [created, ...prev]);
      }
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save podcast');
    } finally {
      setSavingForm(false);
    }
  };

  const handleDeletePodcast = async (podcastId: string) => {
    setBusyKey(`delete:${podcastId}`);
    setError(null);
    try {
      await deletePodcast(podcastId);
      setPodcasts((prev) => prev.filter((p) => p.id !== podcastId));
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete podcast');
    } finally {
      setBusyKey(null);
    }
  };

  const getPrivateRssUrl = (podcast: PodcastConfig): string => {
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost:8080';
    const tokenParam = podcast.token ? `?token=${encodeURIComponent(podcast.token)}` : '';
    return `${origin}/api/podcasts/${encodeURIComponent(podcast.id)}/feed.xml${tokenParam}`;
  };

  const handleCopyRssLink = async (podcast: PodcastConfig) => {
    const url = getPrivateRssUrl(podcast);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      }
    } catch {
      // Clipboard API may be unavailable in headless test environments
    }
    setCopiedPodcastId(podcast.id);
    setTimeout(() => {
      setCopiedPodcastId((prev) => (prev === podcast.id ? null : prev));
    }, 2500);
  };

  const handleRotateToken = async (podcast: PodcastConfig) => {
    setBusyKey(`rotate:${podcast.id}`);
    setError(null);
    try {
      const updated = await updatePodcast(podcast.id, { regenerateToken: true });
      setPodcasts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate feed token');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSwitchEpisodeVersion = async (
    podcastId: string,
    storyId: string,
    versionId: string
  ) => {
    setBusyKey(`ep:${podcastId}:${storyId}`);
    setError(null);
    try {
      const updated = await releaseStoryToPodcast(podcastId, { storyId, versionId });
      setPodcasts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      onCatalogChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update episode version');
    } finally {
      setBusyKey(null);
    }
  };

  const handleUnreleaseEpisode = async (podcastId: string, storyId: string) => {
    setBusyKey(`unrelease:${podcastId}:${storyId}`);
    setError(null);
    try {
      const updated = await unreleaseStoryFromPodcast(podcastId, storyId);
      setPodcasts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unrelease episode');
    } finally {
      setBusyKey(null);
    }
  };

  const handleQuickRelease = async (podcast: PodcastConfig) => {
    const storyId = quickReleaseStoryId[podcast.id];
    if (!storyId) return;
    setBusyKey(`quick:${podcast.id}`);
    setError(null);
    try {
      const updated = await releaseStoryToPodcast(podcast.id, { storyId });
      setPodcasts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setQuickReleaseStoryId((prev) => ({ ...prev, [podcast.id]: '' }));
      // Fetch full story details for the newly released episode
      try {
        const story = await fetchStory(storyId);
        setStoryDetailsMap((prev) => ({ ...prev, [storyId]: story }));
      } catch {
        // Non-fatal
      }
      onCatalogChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release story to podcast');
    } finally {
      setBusyKey(null);
    }
  };

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const rem = Math.round(sec % 60);
    return `${mins}m ${rem < 10 ? '0' : ''}${rem}s`;
  };

  const storiesWithAudio = catalog.filter((item) => item.audio_versions_count > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
      {/* Header Row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: '1.5rem',
              margin: '0 0 0.25rem 0',
              color: 'var(--ink-primary)',
            }}
          >
            📻 Podcast Feeds
          </h2>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ink-muted)' }}>
            Dynamic bucket-driven private RSS feeds for Apple Podcasts &amp; family listening.
          </p>
        </div>

        <button
          type="button"
          className="btn-tactile btn-tactile-primary"
          data-testid="new-podcast-btn"
          onClick={openCreateForm}
          style={{ minHeight: '44px', padding: '0.5rem 1rem' }}
        >
          ➕ New Podcast
        </button>
      </div>

      {error && (
        <div
          className="card-tactile"
          style={{
            padding: '0.75rem 1rem',
            borderColor: 'var(--accent-state)',
            backgroundColor: 'var(--accent-state-bg)',
            color: 'var(--accent-state)',
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Create / Edit Podcast Form Card */}
      {showForm && (
        <form
          className="card-tactile"
          data-testid="podcast-form"
          onSubmit={handleSavePodcast}
          style={{
            padding: '1.25rem',
            backgroundColor: 'var(--bg-surface)',
            borderLeft: '4px solid var(--accent-primary)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: '1.15rem', color: 'var(--ink-primary)' }}>
              {editingPodcastId ? `Edit Podcast: ${editingPodcastId}` : 'Create New Private Podcast'}
            </h3>
            <button
              type="button"
              className="btn-tactile"
              onClick={() => setShowForm(false)}
              style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}
            >
              ✕ Cancel
            </button>
          </div>

          {formError && (
            <p style={{ margin: 0, color: 'var(--accent-state)', fontSize: '0.85rem', fontWeight: 600 }}>
              ⚠️ {formError}
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem', fontWeight: 600 }}>
              Title *
              <input
                type="text"
                className="input-tactile"
                data-testid="podcast-title-input"
                placeholder="e.g. Leo's Bedtime Stories"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                required
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem', fontWeight: 600 }}>
              Author
              <input
                type="text"
                className="input-tactile"
                data-testid="podcast-author-input"
                placeholder="Storyteller Studio"
                value={formAuthor}
                onChange={(e) => setFormAuthor(e.target.value)}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem', fontWeight: 600 }}>
              Language
              <input
                type="text"
                className="input-tactile"
                data-testid="podcast-language-input"
                placeholder="en-us"
                value={formLanguage}
                onChange={(e) => setFormLanguage(e.target.value)}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem', fontWeight: 600 }}>
              Private Token (auto-generated if blank)
              <input
                type="text"
                className="input-tactile"
                data-testid="podcast-token-input"
                placeholder="Leave blank for random 24-char secret"
                value={formToken}
                onChange={(e) => setFormToken(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem', fontWeight: 600 }}>
            Description
            <textarea
              className="input-tactile"
              data-testid="podcast-description-input"
              rows={2}
              placeholder="Short description shown in Apple Podcasts..."
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button
              type="submit"
              className="btn-tactile btn-tactile-primary"
              data-testid="save-podcast-btn"
              disabled={savingForm}
              style={{ minHeight: '42px', padding: '0.45rem 1.1rem' }}
            >
              {savingForm ? 'Saving...' : 'Save Podcast'}
            </button>
          </div>
        </form>
      )}

      {/* Podcast Cards */}
      {loading ? (
        <div className="card-tactile" style={{ padding: '2rem', textAlign: 'center', color: 'var(--ink-muted)' }}>
          Scanning storage for podcast feeds...
        </div>
      ) : podcasts.length === 0 ? (
        <div className="card-tactile" style={{ padding: '2.5rem 1.5rem', textAlign: 'center' }}>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '1rem', color: 'var(--ink-primary)', fontWeight: 600 }}>
            No podcast feeds configured yet.
          </p>
          <p style={{ margin: '0 0 1.25rem 0', fontSize: '0.875rem', color: 'var(--ink-muted)' }}>
            Create a private podcast feed to generate an Apple Podcasts RSS link and release narrated stories.
          </p>
          <button
            type="button"
            className="btn-tactile btn-tactile-primary"
            onClick={openCreateForm}
          >
            ➕ Create Your First Podcast
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {podcasts.map((podcast) => {
            const rssUrl = getPrivateRssUrl(podcast);
            const episodes = podcast.episodes || [];
            const releasedStoryIds = new Set(episodes.map((ep) => ep.story_id));
            const availableToRelease = storiesWithAudio.filter((s) => !releasedStoryIds.has(s.id));
            const isConfirmingDelete = confirmDeleteId === podcast.id;

            return (
              <section
                key={podcast.id}
                className="card-tactile"
                data-testid={`podcast-card-${podcast.id}`}
                style={{
                  padding: '1.25rem',
                  backgroundColor: 'var(--bg-surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                  minWidth: 0,
                }}
              >
                {/* Card Header */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <h3
                        style={{
                          margin: 0,
                          fontFamily: 'var(--font-heading)',
                          fontSize: '1.25rem',
                          color: 'var(--ink-primary)',
                        }}
                      >
                        {podcast.title}
                      </h3>
                      <span className="badge-mono" style={{ fontSize: '0.75rem' }}>
                        {episodes.length} {episodes.length === 1 ? 'episode' : 'episodes'}
                      </span>
                      <span className="badge-mono" style={{ fontSize: '0.7rem', color: 'var(--ink-muted)' }}>
                        {podcast.id}
                      </span>
                    </div>
                    <p style={{ margin: '0.35rem 0 0 0', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
                      By {podcast.author} · {podcast.language}
                      {podcast.description ? ` — ${podcast.description}` : ''}
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn-tactile"
                      onClick={() => openEditForm(podcast)}
                      style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem' }}
                    >
                      ✏️ Edit
                    </button>

                    {isConfirmingDelete ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-state)', fontWeight: 600 }}>
                          Delete?
                        </span>
                        <button
                          type="button"
                          className="btn-tactile"
                          disabled={busyKey === `delete:${podcast.id}`}
                          onClick={() => handleDeletePodcast(podcast.id)}
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.25rem 0.55rem',
                            backgroundColor: 'var(--accent-state-bg)',
                            color: 'var(--accent-state)',
                          }}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="btn-tactile"
                          onClick={() => setConfirmDeleteId(null)}
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.55rem' }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn-tactile"
                        onClick={() => setConfirmDeleteId(podcast.id)}
                        style={{ fontSize: '0.8rem', padding: '0.3rem 0.65rem', color: 'var(--accent-state)' }}
                      >
                        🗑 Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* Private RSS Feed URL Bar */}
                <div
                  style={{
                    padding: '0.75rem',
                    backgroundColor: 'var(--bg-well)',
                    borderRadius: 'var(--radius-tactile)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 600, color: 'var(--ink-muted)' }}>
                    PRIVATE RSS FEED LINK (APPLE PODCASTS → FOLLOW A SHOW BY URL)
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <input
                      type="text"
                      readOnly
                      aria-label={`Private RSS link for ${podcast.title}`}
                      data-testid={`rss-link-input-${podcast.id}`}
                      value={rssUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="input-tactile"
                      style={{
                        flex: '1 1 220px',
                        minWidth: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8rem',
                      }}
                    />
                    <button
                      type="button"
                      className="btn-tactile btn-tactile-primary"
                      data-testid={`copy-rss-link-${podcast.id}`}
                      onClick={() => handleCopyRssLink(podcast)}
                      style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', minHeight: '38px' }}
                    >
                      {copiedPodcastId === podcast.id ? '✓ Copied!' : '📋 Copy RSS Link'}
                    </button>
                    <button
                      type="button"
                      className="btn-tactile"
                      data-testid={`rotate-token-${podcast.id}`}
                      disabled={busyKey === `rotate:${podcast.id}`}
                      onClick={() => handleRotateToken(podcast)}
                      style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', minHeight: '38px' }}
                    >
                      🔄 Rotate Token
                    </button>
                  </div>
                </div>

                {/* Published Episodes List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4
                    style={{
                      margin: 0,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.8rem',
                      color: 'var(--ink-muted)',
                      textTransform: 'uppercase',
                    }}
                  >
                    Published Episodes ({episodes.length})
                  </h4>

                  {episodes.length === 0 ? (
                    <p style={{ margin: 0, fontSize: '0.85rem', fontStyle: 'italic', color: 'var(--ink-muted)' }}>
                      No episodes released to this podcast yet.
                    </p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {episodes.map((ep) => {
                        const story = storyDetailsMap[ep.story_id];
                        const catalogEntry = catalog.find((c) => c.id === ep.story_id);
                        const title = story?.title || catalogEntry?.title || ep.story_id;
                        const versions: AudioVersion[] = story?.audio_versions || [];
                        const activeVer =
                          versions.find((v) => v.version_id === ep.version_id) ||
                          versions.find((v) => v.is_default) ||
                          versions[0];

                        return (
                          <div
                            key={ep.story_id}
                            className="card-tactile"
                            data-testid={`podcast-episode-${podcast.id}-${ep.story_id}`}
                            style={{
                              padding: '0.65rem 0.85rem',
                              backgroundColor: 'var(--bg-canvas)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              flexWrap: 'wrap',
                              gap: '0.5rem',
                            }}
                          >
                            <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                              <div style={{ fontWeight: 600, fontSize: '0.92rem', color: 'var(--ink-primary)' }}>
                                {title}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
                                {activeVer && (
                                  <span className="badge-mono" style={{ fontSize: '0.7rem' }}>
                                    {activeVer.label} · {formatDuration(activeVer.duration_sec)}
                                  </span>
                                )}
                                <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
                                  Released {new Date(ep.published_at).toLocaleDateString()}
                                </span>
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                              {versions.length > 0 && (
                                <select
                                  aria-label={`Audio version for ${title}`}
                                  data-testid={`episode-version-select-${podcast.id}-${ep.story_id}`}
                                  className="input-tactile"
                                  value={activeVer?.version_id || ep.version_id}
                                  disabled={busyKey === `ep:${podcast.id}:${ep.story_id}`}
                                  onChange={(e) =>
                                    handleSwitchEpisodeVersion(podcast.id, ep.story_id, e.target.value)
                                  }
                                  style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem', maxWidth: '100%' }}
                                >
                                  {versions.map((ver) => (
                                    <option key={ver.version_id} value={ver.version_id}>
                                      {ver.label} ({formatDuration(ver.duration_sec)})
                                    </option>
                                  ))}
                                </select>
                              )}

                              <button
                                type="button"
                                className="btn-tactile"
                                data-testid={`unrelease-episode-${podcast.id}-${ep.story_id}`}
                                disabled={busyKey === `unrelease:${podcast.id}:${ep.story_id}`}
                                onClick={() => handleUnreleaseEpisode(podcast.id, ep.story_id)}
                                style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', color: 'var(--accent-state)' }}
                              >
                                ✕ Unrelease
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Quick Release Picker */}
                {availableToRelease.length > 0 && (
                  <div
                    style={{
                      paddingTop: '0.75rem',
                      borderTop: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '0.5rem',
                    }}
                  >
                    <select
                      aria-label={`Release a story to ${podcast.title}`}
                      data-testid={`quick-release-select-${podcast.id}`}
                      className="input-tactile"
                      value={quickReleaseStoryId[podcast.id] || ''}
                      onChange={(e) =>
                        setQuickReleaseStoryId((prev) => ({
                          ...prev,
                          [podcast.id]: e.target.value,
                        }))
                      }
                      style={{ flex: '1 1 200px', minWidth: 0, fontSize: '0.85rem' }}
                    >
                      <option value="">➕ Release a Story to This Podcast...</option>
                      {availableToRelease.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} ({s.status})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn-tactile btn-tactile-primary"
                      data-testid={`quick-release-btn-${podcast.id}`}
                      disabled={!quickReleaseStoryId[podcast.id] || busyKey === `quick:${podcast.id}`}
                      onClick={() => handleQuickRelease(podcast)}
                      style={{ fontSize: '0.82rem', padding: '0.4rem 0.85rem', minHeight: '38px' }}
                    >
                      📻 Release Episode
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
