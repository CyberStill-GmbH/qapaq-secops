import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicConfig } from '../bootstrap/public-config.js';
import { checkApiHealth, type ApiHealth } from '../api/health.js';
import { MockAdminApi } from '../api/mock-admin.js';
import type { AdminSession } from '../api/admin.js';
import HeroArt from '../components/login/HeroArt.js';
import SuperAdminConsole from '../components/admin/SuperAdminConsole.js';
import qapaqQMask from '../assets/qapaq-q-mask.png';

type CheckState = ApiHealth | 'checking';
const apiStateText: Record<CheckState, string> = {
  checking: 'Consultando…',
  healthy: 'API disponible',
  degraded: 'Disponibilidad parcial',
  failed: 'Sin respuesta',
  unavailable: 'No verificado',
};

function HealthMark({ status }: { status: CheckState }) {
  const symbol =
    status === 'checking' ? '' : status === 'healthy' ? '✓' : status === 'degraded' ? '!' : '×';
  return (
    <span className={`health-mark health-mark-${status}`} aria-hidden="true">
      {symbol}
    </span>
  );
}

function MicrosoftMark() {
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
  const api = useMemo(() => new MockAdminApi(), []);
  const [apiHealth, setApiHealth] = useState<CheckState>('checking');
  const [checking, setChecking] = useState(false);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [signInState, setSignInState] = useState<'ready' | 'redirecting' | 'error'>('ready');
  const [showSplash, setShowSplash] = useState(
    // El render estático no tiene `window`: sin animación de entrada, que es además el
    // comportamiento correcto para quien pide movimiento reducido.
    () =>
      typeof window !== 'undefined' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!showSplash) return;
    const splashTimer = window.setTimeout(() => setShowSplash(false), 1_050);
    return () => window.clearTimeout(splashTimer);
  }, [showSplash]);

  const refreshHealth = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    setChecking(true);
    setApiHealth('checking');
    const result = await checkApiHealth(controller.signal);
    window.clearTimeout(timeout);
    if (activeRequest.current === controller) {
      setApiHealth(result);
      setChecking(false);
      activeRequest.current = null;
    }
  }, []);

  useEffect(() => {
    if (session) return;
    void refreshHealth();
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [refreshHealth, session]);

  async function simulateEntraLogin() {
    setSignInState('redirecting');
    try {
      const demoSession = await api.getSession();
      setSession(demoSession);
      setSignInState('ready');
    } catch {
      setSignInState('error');
    }
  }

  async function logout() {
    await api.logout();
    setSession(null);
  }

  if (session)
    return (
      <SuperAdminConsole
        api={api}
        session={session}
        onSessionChange={setSession}
        onLogout={() => void logout()}
        basePath={config.basePath}
      />
    );

  const healthDescription =
    apiHealth === 'healthy'
      ? 'Liveness y readiness responden. No verifica PostgreSQL, Redis ni OpenSearch.'
      : apiHealth === 'degraded'
        ? 'El proceso responde, pero la comprobación de readiness falló.'
        : apiHealth === 'failed'
          ? 'No se pudo establecer conexión con el API.'
          : 'Comprobación pública de liveness y readiness.';

  return (
    <main className="auth-screen grid min-h-svh" data-base-path={config.basePath}>
      {showSplash && (
        <div className="auth-splash" aria-hidden="true">
          <span
            className="auth-splash-mark"
            style={{ maskImage: `url(${qapaqQMask})`, WebkitMaskImage: `url(${qapaqQMask})` }}
          />
        </div>
      )}
      <header className="auth-topbar flex items-center">
        <a className="q-symbol" href={config.basePath} aria-label="QAPAQ SecOps">
          <img src={`${config.basePath}qapaq-mark-source.png`} alt="" />
        </a>
        <span className="brand-destination">Estás iniciando sesión en QAPAQ</span>
      </header>
      <section className="login-core flex flex-col items-center" aria-labelledby="login-title">
        <h1 id="login-title">Inicia sesión en tu cuenta</h1>
        <p className="login-subtitle">Acceso institucional</p>
        <div className="login-action-group">
          <button
            className="entra-button entra-button-enabled"
            type="button"
            onClick={() => void simulateEntraLogin()}
            disabled={signInState === 'redirecting'}
            aria-describedby="auth-message"
          >
            <MicrosoftMark />
            <span>
              {signInState === 'redirecting'
                ? 'Conectando con Microsoft Entra…'
                : 'Continuar con Microsoft Entra'}
            </span>
          </button>
          <p
            className={`auth-message${signInState === 'error' ? ' auth-message-error' : ''}`}
            id="auth-message"
            role="status"
          >
            {signInState === 'error'
              ? 'No se pudo abrir la vista de demostración. Intenta otra vez.'
              : 'Demo de interfaz · no inicia una sesión corporativa real'}
          </p>
        </div>
        <div className="auth-contract">
          <span className="auth-contract-mark">
            <HealthMark status="healthy" />
          </span>
          <span>
            <strong>Microsoft Entra ID</strong>
            <small>OIDC · Authorization Code + PKCE · sesión BFF</small>
          </span>
          <span className="contract-demo">MOCK</span>
        </div>
        <div className="api-check-row">
          <button
            className="api-check-button"
            type="button"
            onClick={() => void refreshHealth()}
            disabled={checking}
          >
            <HealthMark status={apiHealth} />
            <span>{checking ? 'Verificando API…' : 'Verificar estado del API'}</span>
          </button>
          <span className={`api-check-result result-${apiHealth}`} role="status" aria-live="polite">
            {apiStateText[apiHealth]}
          </span>
        </div>
        <p className="api-explanation" aria-live="polite">
          {healthDescription}
        </p>
      </section>
      <footer className="auth-footer">
        <span>
          Acceso de demostración. La autenticación federada real aún requiere configuración.
        </span>
      </footer>
      <HeroArt />
    </main>
  );
}
