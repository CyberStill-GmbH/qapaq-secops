import type { SourceHealthView } from '../../api/client.js';
import type { ApiErrorBody } from '@qapaq/contracts';
import { Panel } from './soc-data-ui.js';
import { ErrorState, StatusChip } from './soc-ui.js';

const stateMap: Readonly<
  Record<SourceHealthView['state'], { label: string; state: 'ok' | 'warn' | 'fail' | 'neutral' }>
> = {
  healthy: { label: 'Saludable', state: 'ok' },
  degraded: { label: 'Degradada', state: 'warn' },
  failed: { label: 'Fallida', state: 'fail' },
  disabled: { label: 'Deshabilitada', state: 'neutral' },
  unknown: { label: 'Sin datos', state: 'neutral' },
};

export function SocSourceConfidence({
  sources,
  loading,
  error,
  onRetry,
  onNavigate,
}: {
  readonly sources: readonly SourceHealthView[];
  readonly loading: boolean;
  readonly error: ApiErrorBody | undefined;
  readonly onRetry: () => void;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  return (
    <Panel
      className="soc-panel--wide"
      title="Confianza de fuentes"
      action={
        <button className="soc-text-link" onClick={() => onNavigate('/sources')}>
          Ver fuentes <span aria-hidden="true">→</span>
        </button>
      }
    >
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading && !sources.length ? (
        <div className="soc-source-confidence__empty">Consultando fuentes…</div>
      ) : sources.length ? (
        <div className="soc-source-confidence">
          {sources.map((source) => {
            const status = stateMap[source.state];
            return (
              <div key={`${source.sourceId}:${source.dataset}`}>
                <StatusChip state={status.state}>{status.label}</StatusChip>
                <strong>{source.displayName}</strong>
                <small>{source.dataset}</small>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="soc-source-confidence__empty">No hay fuentes configuradas.</div>
      )}
    </Panel>
  );
}
