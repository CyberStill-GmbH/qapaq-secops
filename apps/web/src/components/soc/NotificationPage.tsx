import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type NotificationView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, SocIcon } from './soc-ui.js';
import { NotificationStateCell, PageHeader } from './soc-data-ui.js';

type NotificationTab = 'unacknowledged' | 'progress' | 'failed' | 'acknowledged';
const notificationTabs: readonly { readonly value: NotificationTab; readonly label: string }[] = [
  { value: 'unacknowledged', label: 'Sin acuse' },
  { value: 'progress', label: 'En curso' },
  { value: 'failed', label: 'Fallidas' },
  { value: 'acknowledged', label: 'Acusadas' },
];

export function NotificationPage(): React.JSX.Element {
  const [items, setItems] = useState<readonly NotificationView[]>([]);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<NotificationTab>('unacknowledged');
  const load = useCallback(async () => {
    const result = await api.notifications();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems(result.data.items);
    setError(null);
    setUpdated(new Date().toISOString());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
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
        description="Entrega de avisos críticos y acuse humano."
        updated={updated}
        action={
          <Button onClick={() => void load()}>
            <SocIcon name="refresh" /> Actualizar
          </Button>
        }
      />
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
                  <tr key={item.id}>
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
          <EmptyState>No hay notificaciones en este estado en la página consultada.</EmptyState>
        ) : null}
      </div>
      <p className="soc-page-note">
        Una notificación entregada requiere el acuse de una persona. El servicio no expone reintento
        manual.
      </p>
    </div>
  );
}
