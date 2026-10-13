import { useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Bell,
  Check,
  Clock,
  Copy,
  FileText,
  Key,
  LockKey,
  List,
  MagnifyingGlass,
  ShieldCheck,
  SquaresFour,
  User,
  Warning,
  X,
  CaretDown,
  ArrowsClockwise,
  ClockCounterClockwise,
  Database,
  Gear,
  HardDrives,
  Info,
  PaperPlaneTilt,
  TreeStructure,
} from '@phosphor-icons/react';
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
  | 'key'
  | 'database'
  | 'gear'
  | 'server'
  | 'send'
  | 'flow'
  | 'info';

const icons = {
  grid: SquaresFour,
  bell: Bell,
  shield: ShieldCheck,
  search: MagnifyingGlass,
  history: ClockCounterClockwise,
  user: User,
  chevron: CaretDown,
  close: X,
  copy: Copy,
  check: Check,
  alert: Warning,
  clock: Clock,
  arrow: ArrowRight,
  refresh: ArrowsClockwise,
  menu: List,
  file: FileText,
  lock: LockKey,
  key: Key,
  database: Database,
  gear: Gear,
  server: HardDrives,
  send: PaperPlaneTilt,
  flow: TreeStructure,
  info: Info,
} satisfies Record<IconName, typeof SquaresFour>;

export function SocIcon({
  name,
  size = 18,
}: {
  readonly name: IconName;
  readonly size?: number;
}): React.JSX.Element {
  const Icon = icons[name];
  return <Icon aria-hidden="true" size={size} weight="regular" />;
}

export function Button({
  children,
  variant = 'secondary',
  buttonRef,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
}): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
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
