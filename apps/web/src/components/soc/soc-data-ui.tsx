import { RelativeTime, StatusChip } from './soc-ui.js';

export function PageHeader({
  title,
  description,
  updated,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly updated?: string | null;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="soc-page-heading">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="soc-page-heading__meta">
        {updated ? (
          <span>
            Actualizado <RelativeTime value={updated} />
          </span>
        ) : null}
        {action}
      </div>
    </div>
  );
}

export function statusLabel(status: string): string {
  return (
    {
      new: 'Nueva',
      acknowledged: 'Reconocida',
      triaged: 'Triada',
      escalated: 'Escalada',
      closed: 'Cerrada',
      open: 'Abierto',
      contained: 'Contenido',
      eradicated: 'Erradicado',
      resolved: 'Resuelto',
      pending: 'En cola',
      sending: 'Enviando',
      sent: 'Entregada · sin acuse',
      indeterminate: 'Entrega no confirmada',
      fallback: 'Canal alterno',
      failed: 'Fallida',
    }[status] ?? status
  );
}

function statusState(status: string): 'ok' | 'warn' | 'fail' | 'info' | 'neutral' {
  if (['triaged', 'resolved', 'eradicated', 'closed', 'acknowledged'].includes(status)) return 'ok';
  if (['escalated', 'indeterminate', 'fallback'].includes(status)) return 'warn';
  if (status === 'failed') return 'fail';
  if (['sending', 'contained'].includes(status)) return 'info';
  return 'neutral';
}

export function StateCell({ value }: { readonly value: string }): React.JSX.Element {
  return <StatusChip state={statusState(value)}>{statusLabel(value)}</StatusChip>;
}

export function NotificationStateCell({ value }: { readonly value: string }): React.JSX.Element {
  return (
    <StatusChip state={statusState(value)}>
      {value === 'acknowledged' ? 'Acusada por una persona' : statusLabel(value)}
    </StatusChip>
  );
}

export function Panel({
  title,
  children,
  action,
  className,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section className={`soc-panel${className ? ` ${className}` : ''}`}>
      <header className="soc-panel__header">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
