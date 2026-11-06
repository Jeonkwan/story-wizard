import React, { useEffect, useState } from 'react';

export interface MastheadProps {
  currentPath?: string;
  onNavigate?: (path: string) => void;
}

export function Masthead({ currentPath = '/', onNavigate }: MastheadProps): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      try {
        const storage = window.localStorage;
        const saved = storage?.getItem('story_theme');
        if (saved === 'dark' || saved === 'light') return saved;
      } catch {
        // ignore storage access error
      }
      return document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }
    return 'light';
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.setAttribute('data-theme', 'dark');
      try {
        window.localStorage?.setItem('story_theme', 'dark');
      } catch {
        // ignore
      }
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.body.removeAttribute('data-theme');
      try {
        window.localStorage?.setItem('story_theme', 'light');
      } catch {
        // ignore
      }
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleNav = (targetPath: string) => {
    if (onNavigate) {
      onNavigate(targetPath);
    } else if (typeof window !== 'undefined') {
      window.history.pushState(null, '', targetPath);
    }
  };

  const isAdmin = currentPath.startsWith('/admin');

  return (
    <header className="masthead" role="banner">
      <div className="masthead-branding">
        <h1 className="masthead-title">
          <span>📖</span> Storyteller Studio
        </h1>
        <p className="masthead-subtitle">
          Expressive Narratives, Character Voices &amp; Tactile Audio
        </p>
      </div>

      <div className="masthead-actions">
        <button
          type="button"
          className="btn-tactile"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode'}
        </button>

        {isAdmin ? (
          <button
            type="button"
            className="btn-tactile btn-tactile-primary"
            onClick={() => handleNav('/')}
            aria-label="Navigate to Storybook Library"
          >
            ← Storybook Library
          </button>
        ) : (
          <button
            type="button"
            className="btn-tactile"
            onClick={() => handleNav('/admin')}
            aria-label="Navigate to Director Studio"
          >
            🎙️ Director Studio
          </button>
        )}
      </div>
    </header>
  );
}
