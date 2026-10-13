import type { ReactNode } from 'react';
export type Section =
  | 'overview'
  | 'events'
  | 'alerts'
  | 'incidents'
  | 'cases'
  | 'rules'
  | 'sources'
  | 'services'
  | 'ingestion'
  | 'quarantine'
  | 'notifications'
  | 'access'
  | 'audit'
  | 'sessions';
export type IconName =
  | 'overview'
  | 'alerts'
  | 'incidents'
  | 'sources'
  | 'services'
  | 'ingestion'
  | 'notifications'
  | 'access'
  | 'audit'
  | 'search'
  | 'refresh'
  | 'close'
  | 'logout'
  | 'arrow'
  | 'clock'
  | 'shield'
  | 'plus'
  | 'external';

const path: Record<IconName, string> = {
  overview: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 14h7v7H3z',
  alerts: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  incidents: 'M12 3 2.8 19h18.4L12 3zM12 9v4m0 3h.01',
  sources: 'M4 5h16v14H4zM8 9h8m-8 4h8m-8 3h5',
  services:
    'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1M9 9h6v6H9z',
  ingestion: 'M12 3v12m0 0 4-4m-4 4-4-4M4 19v2h16v-2',
  notifications: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  access: 'M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-3zm-3 9 2 2 4-4',
  audit: 'M4 5h16M4 10h16M4 15h10M4 20h7',
  search: 'm20 20-4.5-4.5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z',
  refresh: 'M20 7v5h-5M4 17v-5h5m-4.4-3a8 8 0 0 1 13-2L20 12M4 12l2.4 5a8 8 0 0 0 13-2',
  close: 'M18 6 6 18M6 6l12 12',
  logout: 'M10 17l5-5-5-5m5 5H3m9-9h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  clock: 'M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  shield: 'M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-3z',
  plus: 'M12 5v14m-7-7h14',
  external: 'M14 4h6v6m0-6-9 9m5-2v8H4V7h8',
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path[name]} />
    </svg>
  );
}

export function formatDate(value: string | null) {
  if (!value) return 'Sin evidencia';
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function Status({ value }: { value: string }) {
  const known: Record<string, string> = {
    healthy: 'Operativo',
    degraded: 'Degradado',
    blocked: 'Bloqueado',
    unknown: 'Sin verificar',
    collecting: 'Con actividad',
    partial: 'Parcial',
    new: 'Nueva',
    acknowledged: 'Acusada',
    enriching: 'Enriqueciendo',
    triage: 'En triaje',
    confirmed: 'Confirmada',
    false_positive: 'Falso positivo',
    closed: 'Cerrada',
    investigating: 'En investigación',
    resolved: 'Resuelta',
    open: 'Abierto',
    contained: 'Contenido',
    containment: 'Contención',
    eradication: 'Erradicación',
    recovery: 'Recuperación',
    failed: 'Fallida',
    retrying: 'En reintento',
    delivered: 'Entregada',
    pending_second_approver: 'Pendiente · segundo aprobador',
    approved: 'Aprobada',
    rejected: 'Rechazada',
    allowed: 'Permitido',
    denied: 'Denegado',
    pending: 'Pendiente',
  };
  return <span className={`status status-${value}`}>{known[value] ?? value}</span>;
}

export function Severity({ value }: { value: string }) {
  const label: Record<string, string> = {
    INFORMATIONAL: 'Informativa',
    CRITICAL: 'Crítica',
    HIGH: 'Alta',
    MEDIUM: 'Media',
    LOW: 'Baja',
  };
  return (
    <span className={`severity severity-${value.toLowerCase()}`}>
      <span aria-hidden="true" />
      {label[value] ?? value}
    </span>
  );
}

export function Metric({
  label,
  value,
  note,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`metric${emphasis ? ' metric-emphasis' : ''}`}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="metric-note">{note}</span>
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Icon name="search" size={22} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {action && (
        <button type="button" className="text-button" onClick={onAction}>
          {action}
          <Icon name="arrow" size={14} />
        </button>
      )}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  label = 'Buscar',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="search-box">
      <Icon name="search" size={16} />
      <span className="sr-only">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={label} />
    </label>
  );
}
