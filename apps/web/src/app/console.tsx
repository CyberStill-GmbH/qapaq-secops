/**
 * C-21 — consola operativa: consulta, detalle, triaje y estados degradados.
 *
 * La vista no decide permisos: pinta lo que la API entrega. Si un campo no vino —el
 * crudo, por ejemplo— simplemente no existe en la respuesta, y ocultarlo no es una
 * decisión de la UI sino el resultado de la autorización del backend (C-18).
 *
 * Los estados degradados son de primera clase: cargando, sin sesión, servicio degradado
 * y conflicto de edición tienen presentación propia, porque son lo que una persona de
 * turno ve en la práctica.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';

import { api, type AlertView, type SessionView } from '../api/client.js';
import { ErrorBanner } from './error-banner.js';

type Phase = 'loading' | 'anonymous' | 'ready' | 'degraded';

const VERDICTS = ['true_positive', 'false_positive', 'benign', 'duplicate'] as const;

export function Console(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<SessionView | null>(null);
  const [alerts, setAlerts] = useState<readonly AlertView[]>([]);
  const [selected, setSelected] = useState<AlertView | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [note, setNote] = useState('');
  const [verdict, setVerdict] = useState<(typeof VERDICTS)[number]>('true_positive');

  const loadAlerts = useCallback(async () => {
    const result = await api.alerts();
    if (result.ok) {
      setAlerts(result.data.items);
      setError(null);
      return;
    }
    setError(result.error);
    if (result.error.code === 'DEPENDENCY_DEGRADED') setPhase('degraded');
  }, []);

  const refresh = useCallback(async () => {
    const result = await api.session();
    if (!result.ok) {
      setError(result.error);
      setPhase(result.error.code === 'DEPENDENCY_DEGRADED' ? 'degraded' : 'anonymous');
      return;
    }
    setSession(result.data);
    setPhase('ready');
    await loadAlerts();
  }, [loadAlerts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runCommand = useCallback(
    async (alert: AlertView, body: Record<string, unknown>) => {
      const result = await api.command(alert.id, { ...body, expectedRevision: alert.revision });
      if (!result.ok) {
        setError(result.error);
        // Un conflicto se resuelve releyendo: la consola no reintenta por su cuenta.
        if (result.error.code === 'STATE_CONFLICT') await loadAlerts();
        return;
      }
      setSelected(result.data.alert);
      setError(null);
      await loadAlerts();
    },
    [loadAlerts],
  );

  if (phase === 'loading') {
    return (
      <p data-testid="console-state" aria-live="polite">
        Cargando el panel…
      </p>
    );
  }

  if (phase === 'degraded') {
    return (
      <section>
        <p data-testid="console-state" aria-live="polite">
          Servicio degradado
        </p>
        {error ? <ErrorBanner error={error} onAction={() => void refresh()} /> : null}
      </section>
    );
  }

  if (phase === 'anonymous' || !session) {
    return (
      <section>
        <p data-testid="console-state" aria-live="polite">
          Sesión no iniciada
        </p>
        {error ? <ErrorBanner error={error} /> : null}
        <a className="qapaq-signin" href="/api/auth/start">
          Iniciar sesión con Microsoft Entra
        </a>
      </section>
    );
  }

  return (
    <section>
      <p data-testid="console-state" aria-live="polite">
        Sesión activa
      </p>
      <p data-testid="session-subject">
        {session.subjectId} · {session.roles.join(', ') || 'sin rol'}
      </p>
      {error ? <ErrorBanner error={error} onAction={() => void loadAlerts()} /> : null}

      <h2>Alertas</h2>
      {alerts.length === 0 ? (
        <p data-testid="alerts-empty">No hay alertas para mostrar.</p>
      ) : (
        <ul data-testid="alert-list">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <button type="button" onClick={() => setSelected(alert)} data-alert-id={alert.id}>
                {alert.priority} · {alert.title} · {alert.status}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <article data-testid="alert-detail">
          <h3>{selected.title}</h3>
          <dl>
            <dt>Estado</dt>
            <dd data-testid="alert-status">{selected.status}</dd>
            <dt>Prioridad</dt>
            <dd>{selected.priority}</dd>
            <dt>Veredicto</dt>
            <dd data-testid="alert-verdict">{selected.verdict ?? 'sin triar'}</dd>
            <dt>Referencia al crudo</dt>
            <dd data-testid="alert-raw">{selected.rawRef ?? 'no disponible para su rol'}</dd>
          </dl>
          <h4>Por qué está priorizada</h4>
          <ul data-testid="alert-reasons">
            {selected.reasons.map((reason) => (
              <li key={reason.code}>
                {reason.code}: {reason.detail}
              </li>
            ))}
          </ul>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runCommand(
                selected,
                selected.status === 'new'
                  ? { name: 'acknowledge' }
                  : { name: 'triage', verdict, note },
              );
            }}
          >
            {selected.status === 'new' ? (
              <button type="submit">Tomar la alerta</button>
            ) : (
              <>
                <label htmlFor="verdict">Veredicto</label>
                <select
                  id="verdict"
                  value={verdict}
                  onChange={(event) => setVerdict(event.target.value as (typeof VERDICTS)[number])}
                >
                  {VERDICTS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <label htmlFor="note">Sustento</label>
                <textarea
                  id="note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  required
                  minLength={10}
                />
                <button type="submit">Registrar triaje</button>
              </>
            )}
          </form>
        </article>
      ) : null}
    </section>
  );
}
