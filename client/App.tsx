import React, { useEffect, useState } from 'react';
import type { AudioVersion, CatalogItem, Story } from '../shared/types';
import { fetchCatalog, fetchStory } from './api/client';
import { Masthead } from './components/Masthead';
import { StoryCatalog } from './components/StoryCatalog';
import { StoryReader } from './components/StoryReader';
import { AudioPlayerBar } from './components/AudioPlayerBar';

export function App(): React.JSX.Element {
  const [currentPath, setCurrentPath] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );

  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [activeStory, setActiveStory] = useState<Story | null>(null);
  const [loadingStory, setLoadingStory] = useState(false);
  const [storyError, setStoryError] = useState<string | null>(null);

  const [activeAudioVersion, setActiveAudioVersion] = useState<AudioVersion | null>(null);

  // Sync route with window.location on mount and popstate
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Fetch catalog on mount
  useEffect(() => {
    let mounted = true;
    setLoadingCatalog(true);
    setCatalogError(null);

    fetchCatalog()
      .then((items) => {
        if (mounted) {
          setCatalog(items);
          setLoadingCatalog(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setCatalogError(err instanceof Error ? err.message : 'Failed to load catalog');
          setLoadingCatalog(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleSelectStory = async (storyId: string) => {
    setLoadingStory(true);
    setStoryError(null);

    try {
      const story = await fetchStory(storyId);
      setActiveStory(story);

      // Determine default audio version
      const defaultVer =
        story.audio_versions.find((v) => v.is_default) || story.audio_versions[0] || null;
      setActiveAudioVersion(defaultVer);
    } catch (err) {
      setStoryError(err instanceof Error ? err.message : 'Failed to load story details');
    } finally {
      setLoadingStory(false);
    }
  };

  const handleBackToLibrary = () => {
    setActiveStory(null);
    setActiveAudioVersion(null);
    setStoryError(null);
  };

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
    if (!path.startsWith('/admin')) {
      setActiveStory(null);
      setActiveAudioVersion(null);
    }
  };

  const isAdmin = currentPath.startsWith('/admin');

  return (
    <div className="app-container">
      <Masthead currentPath={currentPath} onNavigate={handleNavigate} />

      <main role="main">
        {isAdmin ? (
          <section className="card-tactile" style={{ textAlign: 'center', padding: '3.5rem 1.5rem' }}>
            <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '2rem', marginTop: 0 }}>
              🎙️ Director Studio
            </h2>
            <p
              style={{
                fontFamily: 'var(--font-prose)',
                fontSize: '1.1rem',
                color: 'var(--ink-muted)',
                maxWidth: '600px',
                margin: '1rem auto 2rem auto',
              }}
            >
              The admin workflow (Google OAuth, Gemini 3.8 Writer &amp; Director pipeline, and Custom
              Voice Studio) arrives in Phase 3 &amp; 4.
            </p>
            <button
              type="button"
              className="btn-tactile btn-tactile-primary"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.history.pushState(null, '', '/');
                }
                handleNavigate('/');
              }}
            >
              ← Return to Storybook Library
            </button>
          </section>
        ) : activeStory ? (
          <div>
            <StoryReader story={activeStory} onBack={handleBackToLibrary} />
            {activeAudioVersion && activeStory.audio_versions.length > 0 && (
              <AudioPlayerBar
                story={activeStory}
                activeVersion={activeAudioVersion}
                onVersionChange={(ver) => setActiveAudioVersion(ver)}
              />
            )}
          </div>
        ) : (
          <div>
            {catalogError && (
              <div
                className="card-tactile"
                style={{
                  borderColor: 'var(--accent-state)',
                  backgroundColor: 'var(--accent-state-bg)',
                  marginBottom: '1.5rem',
                }}
              >
                <p style={{ margin: 0, color: 'var(--accent-state)', fontWeight: 600 }}>
                  ⚠️ Error: {catalogError}
                </p>
              </div>
            )}

            {storyError && (
              <div
                className="card-tactile"
                style={{
                  borderColor: 'var(--accent-state)',
                  backgroundColor: 'var(--accent-state-bg)',
                  marginBottom: '1.5rem',
                }}
              >
                <p style={{ margin: 0, color: 'var(--accent-state)', fontWeight: 600 }}>
                  ⚠️ Error: {storyError}
                </p>
              </div>
            )}

            {loadingStory ? (
              <div className="card-tactile" style={{ textAlign: 'center', padding: '3rem' }}>
                <p style={{ margin: 0, fontStyle: 'italic' }}>Loading storybook...</p>
              </div>
            ) : (
              <StoryCatalog
                catalog={catalog}
                onSelectStory={handleSelectStory}
                loading={loadingCatalog}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
