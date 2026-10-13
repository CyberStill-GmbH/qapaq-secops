import { useEffect, useState } from 'react';
import type { PublicConfig } from '../bootstrap/public-config.js';
import { API_ERROR_CODES, apiError, type ApiErrorCode } from '@qapaq/contracts';
import { api } from '../api/client.js';
import HeroArt from '../components/login/HeroArt.js';
import { QapaqSplash } from '../components/login/QapaqSplash.js';
import { SocConsole } from '../components/soc/SocConsole.js';
import { CookieNotice } from '../components/CookieNotice.js';

function MicrosoftMark(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="microsoft-mark" viewBox="0 0 18 18">
      <path fill="#f25022" d="M0 0h8v8H0z" />
      <path fill="#7fba00" d="M10 0h8v8h-8z" />
      <path fill="#00a4ef" d="M0 10h8v8H0z" />
      <path fill="#ffb900" d="M10 10h8v8h-8z" />
    </svg>
  );
}

export default function Application({ config }: { config: PublicConfig }): React.JSX.Element {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const errorCode = params.get('authError');
  const signInError =
    errorCode && (API_ERROR_CODES as readonly string[]).includes(errorCode)
      ? apiError(errorCode as ApiErrorCode, params.get('correlationId') ?? '')
      : null;
  const [redirecting, setRedirecting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [showSplash, setShowSplash] = useState(
    () =>
      typeof window !== 'undefined' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (!showSplash) return;
    const timer = window.setTimeout(() => setShowSplash(false), 1_050);
    return () => window.clearTimeout(timer);
  }, [showSplash]);

  useEffect(() => {
    let active = true;
    void api.session().then((result) => {
      if (!active) return;
      setAuthenticated(result.ok);
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, []);

  function signIn(): void {
    setRedirecting(true);
    const returnTo = `${config.basePath}console.html`;
    window.location.assign(`/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`);
  }

  if (checkingSession || showSplash) return <QapaqSplash waiting={!showSplash} />;
  if (authenticated) return <SocConsole basePath={config.basePath} />;

  return (
    <main className="auth-screen" data-base-path={config.basePath}>
      <header className="auth-topbar" aria-label="Acceso QAPAQ SecOps">
        <div className="login-brand-lockup" aria-hidden="true">
          <span className="login-brand-name">
            QAPAQ <strong>SecOps</strong>
          </span>
          <span className="login-brand-tagline">Bienvenido de nuevo</span>
        </div>
        <span className="sr-only">QAPAQ SecOps. Bienvenido de nuevo.</span>
      </header>
      <section className="login-core" aria-labelledby="login-title">
        <h1 id="login-title">Inicia sesión en tu cuenta</h1>
        <div className="login-action-group">
          <button
            className="entra-button entra-button-enabled"
            type="button"
            onClick={signIn}
            disabled={redirecting}
          >
            <MicrosoftMark />
            <span>
              {redirecting ? 'Conectando con Microsoft Entra…' : 'Continuar con Microsoft Entra'}
            </span>
          </button>
          {redirecting || signInError ? (
            <p className="auth-message" role={signInError && !redirecting ? 'alert' : 'status'}>
              {redirecting ? 'Conectando de forma segura…' : signInError?.message}
            </p>
          ) : null}
        </div>
      </section>
      <footer className="auth-footer">
        <span>© QAPAQ SecOps</span>
      </footer>
      <HeroArt />
      <CookieNotice />
    </main>
  );
}
