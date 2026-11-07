import React, { useMemo, useState } from 'react';
import type { CatalogItem } from '../../shared/types';

export interface StoryCatalogProps {
  catalog: CatalogItem[];
  onSelectStory: (storyId: string) => void;
  loading?: boolean;
  isAdmin?: boolean;
  onDeleteStory?: (storyId: string) => Promise<void>;
}

export function StoryCatalog({
  catalog,
  onSelectStory,
  loading = false,
  isAdmin = false,
  onDeleteStory,
}: StoryCatalogProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('All');
  const [selectedSeries, setSelectedSeries] = useState('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Extract unique tags and series
  const uniqueTags = useMemo(() => {
    const set = new Set<string>();
    catalog.forEach((item) => {
      item.tags?.forEach((tag) => set.add(tag));
    });
    return ['All', ...Array.from(set).sort()];
  }, [catalog]);

  const seriesList = useMemo(() => {
    const set = new Set<string>();
    catalog.forEach((item) => {
      if (item.series_id) {
        set.add(item.series_id);
      }
    });
    return Array.from(set).sort();
  }, [catalog]);

  // Filter and sort catalog
  const filteredStories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const filtered = catalog.filter((item) => {
      // 1. Search filter: title, summary, tags
      if (q) {
        const titleMatch = item.title?.toLowerCase().includes(q);
        const summaryMatch = item.summary?.toLowerCase().includes(q);
        const tagMatch = item.tags?.some((t) => t.toLowerCase().includes(q));
        if (!titleMatch && !summaryMatch && !tagMatch) {
          return false;
        }
      }

      // 2. Tag filter
      if (selectedTag !== 'All') {
        if (!item.tags?.includes(selectedTag)) {
          return false;
        }
      }

      // 3. Series filter
      if (selectedSeries !== 'all') {
        if (item.series_id !== selectedSeries) {
          return false;
        }
      }

      return true;
    });

    // Sorting:
    // If specific series selected -> episode_number ascending
    // Otherwise -> created_at descending (newest first)
    if (selectedSeries !== 'all') {
      return [...filtered].sort((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0));
    } else {
      return [...filtered].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
  }, [catalog, searchQuery, selectedTag, selectedSeries]);

  return (
    <section className="catalog-section" aria-label="Storybook Library">
      <div className="catalog-controls">
        <div className="search-and-series">
          <input
            type="search"
            className="input-tactile catalog-search-input"
            placeholder="Search stories, summaries, tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search stories"
          />

          <select
            className="select-tactile series-filter-select"
            value={selectedSeries}
            onChange={(e) => setSelectedSeries(e.target.value)}
            aria-label="Filter by series"
          >
            <option value="all">All Stories</option>
            {seriesList.map((series) => (
              <option key={series} value={series}>
                Series: {series}
              </option>
            ))}
          </select>
        </div>

        {uniqueTags.length > 1 && (
          <div className="tag-pills-row" role="group" aria-label="Tag filter pills">
            {uniqueTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-pill ${selectedTag === tag ? 'active' : ''}`}
                onClick={() => setSelectedTag(tag)}
                aria-pressed={selectedTag === tag}
              >
                {tag === 'All' ? '🌟 All' : `#${tag}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="card-tactile" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ margin: 0, fontStyle: 'italic' }}>Loading story library...</p>
        </div>
      ) : filteredStories.length === 0 ? (
        <div className="card-tactile" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
            No stories found matching your filter criteria.
          </p>
        </div>
      ) : (
        <div className="stories-grid">
          {filteredStories.map((story) => (
            <article key={story.id} className="card-tactile story-card" data-story-id={story.id}>
              <div className="story-card-header">
                {story.series_id && (
                  <div>
                    <span className="badge-mono series-badge">
                      {story.series_id} · Ep {story.episode_number ?? 1}
                    </span>
                  </div>
                )}
                <h2 className="story-card-title">{story.title}</h2>
              </div>

              <p className="story-card-summary">{story.summary}</p>

              {story.tags && story.tags.length > 0 && (
                <div className="story-card-tags">
                  {story.tags.map((tag) => (
                    <span key={tag} className="badge-mono" style={{ opacity: 0.85 }}>
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="story-card-footer">
                <span className="story-versions-info">
                  🎧 {story.audio_versions_count}{' '}
                  {story.audio_versions_count === 1 ? 'audio version' : 'audio versions'}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {isAdmin && (
                    confirmDeleteId === story.id ? (
                      <div style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
                        <span>Delete permanently?</span>
                        <button
                          type="button"
                          className="btn-tactile"
                          style={{ color: 'var(--accent-state)' }}
                          disabled={deletingId === story.id}
                          onClick={async () => {
                            if (!onDeleteStory) return;
                            setDeletingId(story.id);
                            try {
                              await onDeleteStory(story.id);
                            } finally {
                              setDeletingId(null);
                              setConfirmDeleteId(null);
                            }
                          }}
                        >
                          {deletingId === story.id ? 'Deleting...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          className="btn-tactile"
                          disabled={deletingId === story.id}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn-tactile"
                        onClick={() => setConfirmDeleteId(story.id)}
                      >
                        🗑 Delete
                      </button>
                    )
                  )}
                  <button
                    type="button"
                    className="btn-tactile btn-tactile-primary"
                    onClick={() => onSelectStory(story.id)}
                  >
                    Read &amp; Listen
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
