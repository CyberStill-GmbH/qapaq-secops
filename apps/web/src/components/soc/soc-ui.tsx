import { useState, type ReactNode } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';

export type IconName =
  | 'grid'
  | 'bell'
  | 'shield'
  | 'search'
  | 'history'
  | 'user'
  | 'chevron'
  | 'close'
  | 'copy'
  | 'check'
  | 'alert'
  | 'clock'
  | 'arrow'
  | 'refresh'
  | 'menu'
  | 'file'
  | 'lock'
  | 'key';

const paths: Readonly<Record<IconName, ReactNode>> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  chevron: <path d="m7 10 5 5 5-5" />,
  close: <path d="m18 6-12 12M6 6l12 12" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  alert: (
    <>
      <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4m0 4h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h8" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="5" />
      <path d="m12 11 8-8m-3 3 3 3m-6-1 3 3" />
    </>
  ),
};

export function SocIcon({
  name,
  size = 18,
}: {
  readonly name: IconName;
  readonly size?: number;
}): React.JSX.Element {
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
      {paths[name]}
    </svg>
  );
}

export function Button({
  children,
  variant = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={`soc-button soc-button--${variant}${props.className ? ` ${props.className}` : ''}`}
    >
      {children}
    </button>
  );
}

export function StatusChip({
  children,
  state = 'neutral',
}: {
  readonly children: ReactNode;
  readonly state?: 'ok' | 'warn' | 'fail' | 'info' | 'neutral';
}): React.JSX.Element {
  return (
    <span className={`soc-status soc-status--${state}`}>
      <span className="soc-status__mark" aria-hidden="true">
        {state === 'ok'
          ? '✓'
          : state === 'warn'
            ? '!'
            : state === 'fail'
              ? '×'
              : state === 'info'
                ? 'i'
                : '–'}
      </span>
      {children}
    </span>
  );
}

export function Severity({
  value,
  score,
}: {
  readonly value: string;
  readonly score?: number;
}): React.JSX.Element {
  const label = value.startsWith('P')
    ? value
    : ({ critical: 'P1', high: 'P2', medium: 'P3', low: 'P4' }[value] ?? value);
  const level = label.startsWith('P') ? Number(label.slice(1)) : 4;
  const symbols = ['', '◆', '▲', '■', '●'];
  return (
    <span className={`soc-severity soc-severity--${Math.max(1, Math.min(level, 4))}`}>
      <span aria-hidden="true">{symbols[Math.max(1, Math.min(level, 4))]}</span>
      <strong>{label}</strong>
      {score !== undefined ? <small>{score}</small> : null}
    </span>
  );
}

export function RelativeTime({ value }: { readonly value: string | null }): React.JSX.Element {
  if (!value) return <span className="soc-muted">—</span>;
  const date = new Date(value);
  const elapsed = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const label =
    elapsed < 60
      ? `hace ${elapsed} s`
      : elapsed < 3600
        ? `hace ${Math.floor(elapsed / 60)} min`
        : elapsed < 86400
          ? `hace ${Math.floor(elapsed / 3600)} h`
          : `hace ${Math.floor(elapsed / 86400)} d`;
  return (
    <time
      dateTime={value}
      title={new Intl.DateTimeFormat('es-PE', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'America/Lima',
      }).format(date)}
    >
      {label}
    </time>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  readonly error: ApiErrorBody;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copyReference(): Promise<void> {
    try {
      await navigator.clipboard.writeText(error.correlationId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="soc-error" role="alert">
      <span className="soc-error__mark" aria-hidden="true">
        ×
      </span>
      <div>
        <strong>{error.message}</strong>
        <p>
          Referencia: <code>{error.correlationId}</code>{' '}
          <button
            className="soc-copy-reference"
            type="button"
            onClick={() => void copyReference()}
            aria-label="Copiar referencia de error"
          >
            <SocIcon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copiada' : 'Copiar'}
          </button>
        </p>
        <Button onClick={onRetry}>
          <SocIcon name="refresh" size={15} /> Reintentar
        </Button>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <div className="soc-empty">{children}</div>;
}
