import React, { useEffect, useState } from 'react';
import {
  fetchAdminSession,
  loginWithGoogle,
  loginWithDevBypass,
  logoutAdmin,
  type AdminSession,
} from '../api/client';
import { DirectorStudio } from './DirectorStudio';
import { VoiceLibraryPage } from './VoiceLibraryPage';

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: { theme?: string; size?: string; width?: number; text?: string }
          ) => void;
          prompt: () => void;
        };
      };
    };
  }
}

export interface AdminLoginGateProps {
  onNavigateHome: () => void;
  onCatalogChanged?: () => void;
  currentPath?: string;
  onNavigate?: (path: string) => void;
}

export function AdminLoginGate({
  onNavigateHome,
  onCatalogChanged,
  currentPath,
  onNavigate,
}: AdminLoginGateProps): React.JSX.Element {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    fetchAdminSession()
      .then((sess) => {
        if (mounted) {
          setSession(sess);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setLoginError(err instanceof Error ? err.message : 'Failed to check session');
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Initialize Google Sign-In button if unauthenticated and client ID is provided
  useEffect(() => {
    if (!session || session.authenticated || !session.googleClientId) {
      return;
    }

    const renderGoogleBtn = () => {
      const btnContainer = document.getElementById('google-signin-btn');
      if (btnContainer && window.google?.accounts?.id) {
        window.google.accounts.id.initialize({
          client_id: session.googleClientId!,
          callback: async (resp: { credential: string }) => {
            if (!resp.credential) return;
            setLoggingIn(true);
            setLoginError(null);
            try {
              await loginWithGoogle(resp.credential);
              const updated = await fetchAdminSession();
              setSession(updated);
              onCatalogChanged?.();
            } catch (err) {
              setLoginError(err instanceof Error ? err.message : 'Google sign-in failed');
            } finally {
              setLoggingIn(false);
            }
          },
        });

        window.google.accounts.id.renderButton(btnContainer, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
        });
      }
    };

    if (window.google?.accounts?.id) {
      renderGoogleBtn();
    } else {
      const scriptEl = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
      if (scriptEl) {
        scriptEl.addEventListener('load', renderGoogleBtn);
        return () => {
          scriptEl.removeEventListener('load', renderGoogleBtn);
        };
      }
    }
  }, [session, onCatalogChanged]);

  const handleDevBypass = async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      await loginWithDevBypass();
      const updated = await fetchAdminSession();
      setSession(updated);
      onCatalogChanged?.();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Dev bypass failed');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await logoutAdmin();
      setSession({
        authenticated: false,
        devBypassEnabled: session?.devBypassEnabled ?? false,
        googleClientId: session?.googleClientId,
      });
      onCatalogChanged?.();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="card-tactile" style={{ textAlign: 'center', padding: '3.5rem 1.5rem' }}>
        <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
          Checking admin authorization...
        </p>
      </div>
    );
  }

  if (session?.authenticated) {
    const effectivePath =
      currentPath || (typeof window !== 'undefined' ? window.location.pathname : '/admin');
    const isVoiceLibrary = effectivePath.startsWith('/admin/voices');

    return (
      <div className="admin-studio-wrapper">
        {/* Admin Navigation Tabs */}
        <nav
          className="admin-nav-tabs"
          aria-label="Admin Navigation Tabs"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.75rem',
            marginBottom: '1.5rem',
            paddingBottom: '0.75rem',
            borderBottom: '2px solid var(--ink-primary)',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn-tactile ${!isVoiceLibrary ? 'btn-tactile-primary' : ''}`}
              onClick={() => onNavigate?.('/admin')}
              aria-current={!isVoiceLibrary ? 'page' : undefined}
              style={{ minHeight: '44px', padding: '0.5rem 1rem' }}
            >
              📖 Stories Workbench
            </button>
            <button
              type="button"
              className={`btn-tactile ${isVoiceLibrary ? 'btn-tactile-primary' : ''}`}
              onClick={() => onNavigate?.('/admin/voices')}
              aria-current={isVoiceLibrary ? 'page' : undefined}
              style={{ minHeight: '44px', padding: '0.5rem 1rem' }}
            >
              🎙️ Voice Library
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}>
              {session.email || 'Admin'}
            </span>
            <button
              type="button"
              className="btn-tactile"
              onClick={handleLogout}
              style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem', minHeight: '38px' }}
            >
              Logout
            </button>
          </div>
        </nav>

        {isVoiceLibrary ? (
          <VoiceLibraryPage
            session={session}
            onLogout={handleLogout}
            onNavigate={
              onNavigate ||
              ((path: string) => {
                if (typeof window !== 'undefined') window.history.pushState(null, '', path);
              })
            }
            onNavigateHome={onNavigateHome}
            onCatalogChanged={onCatalogChanged}
          />
        ) : (
          <DirectorStudio
            session={session}
            onLogout={handleLogout}
            onCatalogChanged={onCatalogChanged}
            onNavigateHome={onNavigateHome}
            currentPath={currentPath}
            onNavigate={onNavigate}
          />
        )}
      </div>
    );
  }

  return (
    <div className="card-tactile" style={{ maxWidth: '480px', margin: '2rem auto', padding: '2rem' }}>
      <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.75rem', margin: '0 0 0.5rem 0' }}>
          🎙️ Director Studio
        </h2>
        <p style={{ fontFamily: 'var(--font-prose)', color: 'var(--ink-muted)', fontSize: '0.95rem', margin: 0 }}>
          Admin portal for AI script generation, voice directing, and library management.
        </p>
      </div>

      {loginError && (
        <div
          className="card-tactile"
          style={{
            borderColor: 'var(--accent-state)',
            backgroundColor: 'var(--accent-state-bg)',
            marginBottom: '1.5rem',
            padding: '0.75rem 1rem',
          }}
        >
          <p style={{ margin: 0, color: 'var(--accent-state)', fontSize: '0.875rem', fontWeight: 600 }}>
            ⚠️ {loginError}
          </p>
        </div>
      )}

      {session?.googleClientId ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
          <div id="google-signin-btn" />
        </div>
      ) : (
        <p
          style={{
            fontSize: '0.85rem',
            color: 'var(--ink-muted)',
            fontFamily: 'var(--font-mono)',
            textAlign: 'center',
            marginBottom: '1.25rem',
          }}
        >
          Google Client ID is not configured for local OAuth.
        </p>
      )}

      {session?.devBypassEnabled && (
        <div style={{ marginTop: '1rem', borderTop: '1px dashed var(--ink-muted)', paddingTop: '1.25rem', textAlign: 'center' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', marginBottom: '0.75rem' }}>
            Local development mode active:
          </p>
          <button
            type="button"
            className="btn-tactile btn-tactile-primary"
            onClick={handleDevBypass}
            disabled={loggingIn}
            style={{ width: '100%' }}
          >
            {loggingIn ? 'Authenticating...' : '⚡ Dev Sandbox Login'}
          </button>
        </div>
      )}

      <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
        <button
          type="button"
          className="btn-tactile"
          onClick={onNavigateHome}
          style={{ fontSize: '0.85rem' }}
        >
          ← Return to Library
        </button>
      </div>
    </div>
  );
}
