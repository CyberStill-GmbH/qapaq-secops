import { useEffect, useState } from 'react';
import type { PublicConfig } from '../bootstrap/public-config.js';
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
      <header className="auth-topbar">
        <span className="brand-destination">Estás iniciando sesión en QAPAQ</span>
      </header>
      <section className="login-core" aria-labelledby="login-title">
        <h1 id="login-title">Inicia sesión en tu cuenta</h1>
        <p className="login-subtitle">Acceso institucional</p>
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
          <p className="auth-message" role="status">
            {redirecting
              ? 'Conectando de forma segura…'
              : 'Usa tu cuenta institucional para continuar.'}
          </p>
        </div>
      </section>
      <footer className="auth-footer">
        <span>El acceso requiere una identidad corporativa autorizada.</span>
      </footer>
      <HeroArt />
      <CookieNotice />
    </main>
  );
}
