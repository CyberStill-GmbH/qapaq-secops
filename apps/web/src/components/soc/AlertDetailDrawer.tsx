import { useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import type { AlertView, SessionView, TriageVerdict } from '../../api/client.js';
import { Button, ErrorState, RelativeTime, Severity, SocIcon, StatusChip } from './soc-ui.js';

const verdicts: readonly { readonly value: TriageVerdict; readonly label: string }[] = [
  { value: 'true_positive', label: 'Verdadero positivo' },
  { value: 'false_positive', label: 'Falso positivo' },
  { value: 'benign', label: 'Benigno' },
  { value: 'duplicate', label: 'Duplicado' },
];
const alertStatus: Readonly<Record<string, string>> = {
  new: 'Nueva',
  acknowledged: 'Reconocida',
  triaged: 'Triada',
  escalated: 'Escalada',
  closed: 'Cerrada',
};
const stateTone = (value: string): 'ok' | 'warn' | 'fail' | 'info' | 'neutral' =>
  value === 'triaged'
    ? 'ok'
    : value === 'escalated'
      ? 'warn'
      : value === 'acknowledged'
        ? 'info'
        : 'neutral';
const signalLabels: Readonly<Record<string, string>> = {
  credential_access: 'Acceso a credenciales',
  initial_access: 'Acceso inicial',
  persistence: 'Persistencia',
  privilege_escalation: 'Escalamiento de privilegios',
  defense_evasion: 'Evasión de defensas',
  collection: 'Recolección',
  exfiltration: 'Exfiltración',
  other: 'Otra actividad',
};
const reasonLabels: Readonly<Record<string, string>> = {
  BREAK_GLASS_IDENTITY: 'Identidad de emergencia',
  CORRELATED_ENTITY: 'Entidad vinculada',
  ATTACK_CHAIN: 'Cadena de ataque',
};

function entityLabel(entity: NonNullable<AlertView['entities']>[number]): string {
  const kind = entity.kind === 'user' ? 'Usuario' : 'IP';
  return `${kind} · ${entity.label}`;
}

interface AlertDetailDrawerProps {
  readonly selected: AlertView;
  readonly session: SessionView;
  readonly error: ApiErrorBody | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onCommand: (name: string, extra?: Record<string, unknown>) => Promise<void>;
  readonly onOpenIncident: (title: string, summary: string) => Promise<void>;
  readonly onNavigate: (path: string) => void;
  readonly onEntityPivot: (entityRef: string) => void;
}

export function AlertDetailDrawer({
  selected,
  session,
  error,
  busy,
  onClose,
  onRetry,
  onCommand,
  onOpenIncident,
  onNavigate,
  onEntityPivot,
}: AlertDetailDrawerProps): React.JSX.Element {
  const [verdict, setVerdict] = useState<TriageVerdict>('true_positive');
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState(session.subjectId);
  const [closeNote, setCloseNote] = useState('');
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentSummary, setIncidentSummary] = useState('');
  const isMine = selected.assigneeId === session.subjectId;
  const canTriage = session.capabilities.includes('alerts.triage');
  const canAssign = session.capabilities.includes('alerts.assign');
  const canOpenIncident = session.capabilities.includes('incidents.write');
  const canTake = selected.status === 'new' && canTriage;
  async function openIncident(): Promise<void> {
    await onOpenIncident(incidentTitle || selected.title, incidentSummary);
  }

  return (
    <aside className="soc-drawer" aria-label={`Detalle de alerta: ${selected.title}`}>
      <header>
        <div>
          <span className="soc-drawer__eyebrow">
            Alerta · <code>{selected.id.slice(0, 8)}…</code>
          </span>
          <h2>{selected.title}</h2>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
          }}
          aria-label="Cerrar detalle"
        >
          <SocIcon name="close" />
        </Button>
      </header>
      <div className="soc-drawer__body">
        <div className="soc-drawer__status">
          <Severity value={selected.priority} score={selected.score} />
          <StatusChip state={stateTone(selected.status)}>
            {alertStatus[selected.status] ?? selected.status}
          </StatusChip>
        </div>
        {selected.signal ? (
          <p className="soc-signal-label">
            Táctica inferida ·{' '}
            {signalLabels[selected.signal] ?? selected.signal.replaceAll('_', ' ')}
          </p>
        ) : null}
        {selected.entities && selected.entities.length > 0 ? (
          <section aria-labelledby="alert-entities-title">
            <h3 id="alert-entities-title">Entidades relacionadas</h3>
            <div className="soc-entity-list">
              {selected.entities.map((entity) =>
                entity.ref ? (
                  <button
                    key={entity.ref}
                    type="button"
                    className="soc-entity-chip"
                    aria-label={`Filtrar alertas por ${entityLabel(entity)}`}
                    title="Filtrar alertas relacionadas"
                    onClick={() => onEntityPivot(entity.ref!)}
                  >
                    {entityLabel(entity)}
                  </button>
                ) : (
                  <span
                    key={`${entity.kind}:${entity.label}`}
                    className="soc-entity-chip is-static"
                  >
                    {entityLabel(entity)}
                  </span>
                ),
              )}
            </div>
            {selected.entities.some((entity) => !entity.ref) ? (
              <p className="soc-entity-unavailable" role="status">
                El pivote por entidad no está disponible para todas las referencias de esta alerta.
              </p>
            ) : null}
          </section>
        ) : null}
        {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        <dl className="soc-description-list">
          <dt>Ocurrida</dt>
          <dd>
            <RelativeTime value={selected.occurredAt} />
          </dd>
          <dt>Asignada a</dt>
          <dd>{selected.assigneeId ? <code>{selected.assigneeId}</code> : 'Sin asignar'}</dd>
          <dt>Veredicto</dt>
          <dd>
            {selected.verdict
              ? (verdicts.find((item) => item.value === selected.verdict)?.label ??
                selected.verdict)
              : 'Sin triaje'}
          </dd>
          {selected.incidentId ? (
            <>
              <dt>Incidente</dt>
              <dd>
                <button
                  className="soc-inline-link"
                  onClick={() =>
                    onNavigate(`/incidents/${encodeURIComponent(selected.incidentId ?? '')}`)
                  }
                >
                  <code>{selected.incidentId}</code>
                </button>
              </dd>
            </>
          ) : null}
          {selected.rawRef ? (
            <>
              <dt>Evento original</dt>
              <dd>
                <code>{selected.rawRef}</code>
              </dd>
            </>
          ) : null}
        </dl>
        <section>
          <h3>Por qué esta prioridad</h3>
          <ul className="soc-reasons">
            {selected.reasons.map((reason) => (
              <li key={reason.code}>
                <strong>
                  {reasonLabels[reason.code] ?? reason.code.replaceAll('_', ' ').toLowerCase()}
                </strong>
                <span>{reason.detail}</span>
              </li>
            ))}
          </ul>
        </section>
        {selected.relatedAlertIds && selected.relatedAlertIds.length > 0 ? (
          <section aria-labelledby="related-alerts-title">
            <h3 id="related-alerts-title">Alertas relacionadas</h3>
            <ul className="soc-related-alerts">
              {selected.relatedAlertIds.map((alertId) => (
                <li key={alertId}>
                  <button
                    type="button"
                    className="soc-inline-link"
                    onClick={() => onNavigate(`/alerts/${encodeURIComponent(alertId)}`)}
                  >
                    <code>{alertId}</code>
                    <span>Ver alerta</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {canTriage || canAssign || canOpenIncident ? (
          <section className="soc-actions">
            <h3>Acciones</h3>
            {canTake ? (
              <Button
                variant="primary"
                onClick={() => void onCommand('acknowledge')}
                disabled={busy}
              >
                Reconocer y asignarme
              </Button>
            ) : null}
            {selected.status === 'acknowledged' && !isMine && canAssign ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onCommand('assign', { assigneeId: assignee.trim() });
                }}
              >
                <label htmlFor="alert-assignee">Asignar a</label>
                <input
                  id="alert-assignee"
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  required
                />
                <Button type="submit" disabled={busy || !assignee.trim()}>
                  Asignar alerta
                </Button>
              </form>
            ) : null}
            {selected.status === 'acknowledged' && isMine && canTriage ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onCommand('triage', { verdict, note: note.trim() });
                }}
              >
                <label htmlFor="alert-verdict">Veredicto</label>
                <select
                  id="alert-verdict"
                  value={verdict}
                  onChange={(event) => setVerdict(event.target.value as TriageVerdict)}
                >
                  {verdicts.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <label htmlFor="alert-note">Sustento del triaje</label>
                <textarea
                  id="alert-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  minLength={10}
                  maxLength={2000}
                />
                <small>{note.trim().length} / 2000 caracteres · mínimo 10</small>
                <Button variant="primary" type="submit" disabled={busy || note.trim().length < 10}>
                  Registrar triaje
                </Button>
              </form>
            ) : null}
            {selected.status === 'triaged' && canTriage && selected.verdict === 'true_positive' ? (
              <Button variant="primary" onClick={() => void onCommand('escalate')} disabled={busy}>
                Escalar alerta
              </Button>
            ) : null}
            {selected.status === 'escalated' && canOpenIncident && !selected.incidentId ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void openIncident();
                }}
              >
                <h4>Abrir incidente</h4>
                <label htmlFor="incident-title">Título</label>
                <input
                  id="incident-title"
                  minLength={4}
                  maxLength={160}
                  value={incidentTitle || selected.title}
                  onChange={(event) => setIncidentTitle(event.target.value)}
                  required
                />
                <label htmlFor="incident-summary">Resumen</label>
                <textarea
                  id="incident-summary"
                  value={incidentSummary}
                  onChange={(event) => setIncidentSummary(event.target.value)}
                  minLength={10}
                  maxLength={2000}
                  required
                />
                <small>La severidad se deriva de la prioridad {selected.priority}.</small>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy || incidentSummary.trim().length < 10}
                >
                  Abrir incidente
                </Button>
              </form>
            ) : null}
            {['acknowledged', 'triaged', 'escalated'].includes(selected.status) && canTriage ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onCommand('close', { note: closeNote.trim() });
                }}
              >
                <label htmlFor="alert-close-note">
                  {selected.status === 'triaged' ? 'Nota de cierre (opcional)' : 'Motivo de cierre'}
                </label>
                <textarea
                  id="alert-close-note"
                  value={closeNote}
                  onChange={(event) => setCloseNote(event.target.value)}
                  minLength={selected.status === 'triaged' ? undefined : 10}
                  maxLength={2000}
                />
                <Button
                  variant="danger"
                  type="submit"
                  disabled={busy || (selected.status !== 'triaged' && closeNote.trim().length < 10)}
                >
                  Cerrar alerta
                </Button>
              </form>
            ) : null}
            {selected.status === 'closed' && canTriage ? (
              <Button onClick={() => void onCommand('reopen')} disabled={busy}>
                Reabrir alerta
              </Button>
            ) : null}
            {selected.status === 'new' && canAssign && !canTake ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onCommand('assign', { assigneeId: assignee.trim() });
                }}
              >
                <label htmlFor="alert-assignee-new">Asignar a</label>
                <input
                  id="alert-assignee-new"
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  required
                />
                <Button type="submit" disabled={busy || !assignee.trim()}>
                  Asignar alerta
                </Button>
              </form>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
