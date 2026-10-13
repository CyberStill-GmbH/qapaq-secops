import { useCallback, useEffect, useState } from 'react';
import { apiError, type ApiErrorBody } from '@qapaq/contracts';
import { api, type NotificationView, type SessionView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, SocIcon } from './soc-ui.js';
import { NotificationStateCell, PageHeader } from './soc-data-ui.js';
import { useChanges } from './use-changes.js';

type NotificationTab = 'unacknowledged' | 'progress' | 'failed' | 'acknowledged';
const notificationTabs: readonly { readonly value: NotificationTab; readonly label: string }[] = [
  { value: 'unacknowledged', label: 'Sin acuse' },
  { value: 'progress', label: 'En curso' },
  { value: 'failed', label: 'Fallidas' },
  { value: 'acknowledged', label: 'Acusadas' },
];

export function NotificationPage({
  session,
}: {
  readonly session: SessionView;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly NotificationView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<string | null>(null);
  const [tab, setTab] = useState<NotificationTab>('unacknowledged');
  const load = useCallback(async (cursor?: string, append = false) => {
    setLoading(true);
    try {
      const result = await api.notifications(cursor);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.nextCursor);
      setError(null);
      setUpdated(new Date().toISOString());
    } catch {
      setError({
        ...apiError(
          'DEPENDENCY_DEGRADED',
          globalThis.crypto?.randomUUID?.() ?? `fallback-${Date.now().toString(16)}`,
        ),
      });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({ resourceTypes: ['notification'], onChange: () => void load() });
  async function acknowledge(id: string): Promise<void> {
    if (confirmId !== id) {
      setConfirmId(id);
      window.setTimeout(() => setConfirmId((current) => (current === id ? null : current)), 4_000);
      return;
    }
    setBusyId(id);
    const result = await api.acknowledgeNotification(id);
    setBusyId(null);
    setConfirmId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
  }
  async function dispatchNow(): Promise<void> {
    setDispatching(true);
    setDispatchResult(null);
    try {
      const result = await api.dispatchNotifications();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDispatchResult(
        result.data.results.length
          ? `Pasada inmediata: ${result.data.results.length} elementos procesados.`
          : 'No hay elementos pendientes de despacho.',
      );
      await load();
    } catch {
      setError({
        ...apiError(
          'DEPENDENCY_DEGRADED',
          globalThis.crypto?.randomUUID?.() ?? `fallback-${Date.now().toString(16)}`,
        ),
      });
    } finally {
      setDispatching(false);
    }
  }
  const notificationGroups: Readonly<Record<typeof tab, readonly string[]>> = {
    unacknowledged: ['sent', 'indeterminate', 'fallback'],
    progress: ['pending', 'sending'],
    failed: ['failed'],
    acknowledged: ['acknowledged'],
  };
  const visible = items.filter((item) => notificationGroups[tab].includes(item.status));
  return (
    <div className="soc-page">
      <PageHeader
        title="Notificaciones"
        description="El servicio despacha automáticamente. Revisa la entrega y registra el acuse humano."
        updated={updated}
        action={
          <>
            {session.capabilities.includes('notifications.dispatch') ? (
              <Button onClick={() => void dispatchNow()} disabled={dispatching || loading}>
                <SocIcon name="arrow" />
                {dispatching ? 'Despachando…' : 'Despachar ahora'}
              </Button>
            ) : null}
            <Button onClick={() => void load()} disabled={loading || dispatching}>
              <SocIcon name="refresh" /> Actualizar
            </Button>
          </>
        }
      />
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Dato nuevo entrando
        </p>
      ) : null}
      <div className="soc-tabs" role="tablist" aria-label="Estado de notificaciones">
        {notificationTabs.map((entry) => (
          <button
            type="button"
            role="tab"
            key={entry.value}
            aria-selected={tab === entry.value}
            className={tab === entry.value ? 'is-active' : ''}
            onClick={() => setTab(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {loading && items.length > 0 ? (
        <p className="soc-page-note" role="status">
          Actualizando notificaciones…
        </p>
      ) : null}
      {dispatchResult ? (
        <p className="soc-page-note" role="status">
          {dispatchResult}
        </p>
      ) : null}
      <div className="soc-table-panel">
        <div className="soc-table-scroll">
          <table className="soc-table">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Canal</th>
                <th>Intentos</th>
                <th>Entregada</th>
                <th>Acuse</th>
                <th>Último fallo</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const overdue =
                  item.sentAt &&
                  Date.now() - new Date(item.sentAt).getTime() > 15 * 60_000 &&
                  item.status === 'sent';
                return (
                  <tr
                    key={item.id}
                    className={
                      liveChanges.some((change) => change.resource.id === item.id)
                        ? 'soc-live-change'
                        : ''
                    }
                  >
                    <td>
                      <NotificationStateCell value={item.status} />
                      {overdue ? (
                        <small className="soc-overdue">! 15 min sin acuse humano</small>
                      ) : null}
                    </td>
                    <td>
                      {item.channel === 'teams'
                        ? 'Microsoft Teams'
                        : item.channel === 'fallback_email'
                          ? 'Correo alterno'
                          : 'Consola'}
                    </td>
                    <td className="is-numeric">{item.attemptCount} de 5</td>
                    <td>
                      <RelativeTime value={item.sentAt} />
                    </td>
                    <td>
                      {item.acknowledgedAt ? (
                        <span>
                          {item.acknowledgedBy ?? 'Acusada'} ·{' '}
                          <RelativeTime value={item.acknowledgedAt} />
                        </span>
                      ) : (
                        <span className="soc-muted">Sin acuse</span>
                      )}
                    </td>
                    <td>{item.lastFailureClass ?? '—'}</td>
                    <td>
                      {['sent', 'indeterminate', 'fallback'].includes(item.status) ? (
                        <Button
                          onClick={() => void acknowledge(item.id)}
                          disabled={busyId === item.id}
                        >
                          {busyId === item.id
                            ? 'Acusando…'
                            : confirmId === item.id
                              ? 'Confirmar acuse'
                              : 'Acusar'}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && !error ? (
          <EmptyState>
            {nextCursor
              ? 'No hay notificaciones de este estado entre las páginas cargadas.'
              : 'No hay notificaciones de este estado en la consulta.'}
          </EmptyState>
        ) : null}
        {nextCursor ? (
          <div className="soc-table-footer">
            <Button onClick={() => void load(nextCursor, true)} disabled={loading}>
              {loading ? 'Cargando…' : 'Cargar más notificaciones'}
            </Button>
            <span>{items.length} cargadas · la consulta tiene más resultados</span>
          </div>
        ) : null}
      </div>
      <p className="soc-page-note">
        Una notificación entregada requiere el acuse de una persona. El servicio no expone reintento
        manual.
      </p>
    </div>
  );
}
