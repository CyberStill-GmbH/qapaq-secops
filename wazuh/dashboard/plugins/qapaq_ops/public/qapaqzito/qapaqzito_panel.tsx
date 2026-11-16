/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { CoreStart } from '../../../../src/core/public';
import type { QapaqzitoAskDetail } from '../../common';
import { BRAND_ASSETS_PATH, QAPAQZITO_ASK_EVENT, CAPABILITIES } from '../../common';
import { QapaqApiError } from '../api/client';
import type { QapaqApiClient } from '../api/client';
import type {
  ArtifactRef,
  QapaqzitoCitation,
  QapaqzitoConfig,
  QapaqzitoConfigState,
  QapaqzitoFeedback,
  QapaqzitoProgressEvent,
  QapaqzitoStep,
  QapaqzitoUsage,
  QapaqzitoTurn,
  ConversationSummary,
} from './chat_client';
import {
  askQapaqzitoStream,
  citationPath,
  deleteAllConversations,
  deleteConversation,
  fetchQapaqzitoUsage,
  formatWhen,
  getConversation,
  listArtifacts,
  loadQapaqzitoConfigState,
  listConversations,
  mergeArtifacts,
  rateMessage,
  suggestionsFor,
} from './chat_client';
import { QapaqzitoArtifactCard, QapaqzitoArtifactList } from './qapaqzito_artifact_card';
import { autoDownloadOnce } from './qapaqzito_artifacts';
import { QapaqzitoComposer } from './qapaqzito_composer_view';
import { Icon } from './qapaqzito_icons';
import type { IconName } from './qapaqzito_icons';
import {
  applyDock,
  clampPanelWidth,
  dockWidthFor,
  effectivePanelWidth,
  layoutMode,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  readStoredWidth,
  toggleWideWidth,
  widthFromKey,
  widthFromPointer,
  writeStoredWidth,
  PANEL_WIDE_WIDTH,
} from './qapaqzito_layout';
import { renderMarkdown } from './markdown';
import { QapaqzitoReportActions } from './qapaqzito_report_actions';
import { QapaqzitoActivity, QapaqzitoThinking } from './qapaqzito_thinking';

/**
 * Qapaqzito, el asistente de IA de QAPAQ SOC. Panel lateral derecho al estilo de ChatGPT/Codex: en
 * pantallas anchas EMPUJA la consola a la izquierda (acoplado, con ancho ajustable); en las
 * estrechas es un cajón con fondo. Saluda con ejemplos de la página, muestra la actividad como una
 * línea plegable, cita lo que afirma con enlaces a la consola, entrega informes (PDF/Excel/CSV)
 * como tarjetas de archivo y guarda las conversaciones en un historial. Es de solo lectura y
 * responde con los permisos de la persona.
 */

const MAX_CHARS = 4000;
const NAME = 'Qapaqzito';
const LAUNCHER = '[data-test-subj="qapaqQapaqzitoLauncher"]';

interface Message {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly steps?: readonly QapaqzitoStep[];
  readonly citations?: readonly QapaqzitoCitation[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly tone?: 'error' | 'notice';
  /** Id del mensaje guardado en el historial (necesario para la valoración). */
  readonly serverId?: string;
  readonly feedback?: QapaqzitoFeedback;
  /** Segundos que tardó Qapaqzito (solo respuestas de esta sesión). */
  readonly seconds?: number;
}

/** Página de contexto para una pregunta abierta desde una vista («Preguntar a Qapaqzito»). */
export function contextPage(context: QapaqzitoAskDetail['context']): string | null {
  const alertId = context?.['alertId'];
  if (alertId && /^[A-Za-z0-9_-]{1,64}$/u.test(alertId)) {
    return `/app/qapaq-alerts?id=${encodeURIComponent(alertId)}`;
  }
  const incidentId = context?.['incidentId'];
  if (incidentId && /^[A-Za-z0-9_-]{1,64}$/u.test(incidentId)) {
    return `/app/qapaq-incidents?id=${encodeURIComponent(incidentId)}`;
  }
  return null;
}

/** Valoración 👍/👎 de una respuesta guardada; se persiste con la conversación. */
function Feedback({
  value,
  disabled,
  onRate,
}: {
  value?: QapaqzitoFeedback;
  disabled: boolean;
  onRate: (rating: QapaqzitoFeedback | null) => void;
}) {
  return (
    <span className="qapaqQapaqzito__feedback" role="group" aria-label="Valora esta respuesta">
      <button
        type="button"
        className={`qapaqQapaqzito__action${value === 'up' ? ' is-active' : ''}`}
        aria-pressed={value === 'up'}
        aria-label="Respuesta útil"
        title="Respuesta útil"
        disabled={disabled}
        onClick={() => onRate(value === 'up' ? null : 'up')}
      >
        <Icon name="up" size={15} />
      </button>
      <button
        type="button"
        className={`qapaqQapaqzito__action${value === 'down' ? ' is-active' : ''}`}
        aria-pressed={value === 'down'}
        aria-label="Respuesta incorrecta o poco útil"
        title="Respuesta incorrecta o poco útil"
        disabled={disabled}
        onClick={() => onRate(value === 'down' ? null : 'down')}
      >
        <Icon name="down" size={15} />
      </button>
    </span>
  );
}

type View = 'chat' | 'history' | 'usage' | 'files';

/** Estado compartido entre el botón de la cabecera y el panel (ambos montan por separado). */
export class QapaqzitoState {
  private open = false;
  private readonly listeners = new Set<() => void>();
  public isOpen(): boolean {
    return this.open;
  }
  public set(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.listeners.forEach((listener) => listener());
  }
  public toggle(): void {
    this.set(!this.open);
  }
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function useQapaqzitoOpen(state: QapaqzitoState): boolean {
  const [open, setOpen] = useState(state.isOpen());
  useEffect(() => state.subscribe(() => setOpen(state.isOpen())), [state]);
  return open;
}

function errorText(error: unknown): string {
  if (error instanceof QapaqApiError) {
    if (error.code === 'RATE_LIMITED') {
      return 'Hiciste muchas preguntas seguidas. Espera unos minutos y vuelve a intentarlo.';
    }
    if (error.code === 'DEPENDENCY_DEGRADED') {
      return 'Qapaqzito no pudo conectar con el modelo de IA ahora mismo. Inténtalo de nuevo en un momento.';
    }
    if (error.code === 'VALIDATION_FAILED') {
      return 'Esa pregunta no es válida (¿está vacía o es muy larga?).';
    }
    if (error.code === 'RESOURCE_UNAVAILABLE') return 'Qapaqzito no está disponible con tu rol.';
  }
  return 'No pude responder. Inténtalo de nuevo.';
}

function reportNoteBody(message: Message): string {
  const citations = (message.citations ?? [])
    .map((citation) => `- ${citation.kind}: ${citation.label} (ID ${citation.id})`)
    .join('\n');
  const body = [
    'BORRADOR PRELIMINAR ASISTIDO POR IA. Requiere revisión humana antes de compartir o decidir.',
    `Generado: ${new Date().toISOString()}`,
    '',
    message.text,
    '',
    'Fuentes citadas',
    citations || 'Sin fuentes citadas; verificar antes de utilizar.',
  ].join('\n');
  return body.length <= 10000
    ? body
    : `${body.slice(0, 9950)}\n[Truncado al límite de notas del incidente]`;
}

export function QapaqzitoLauncher({ state, imageUrl }: { state: QapaqzitoState; imageUrl: string }) {
  const open = useQapaqzitoOpen(state);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    // React 16 delegates clicks at document. OUI can stop bubbling in the chrome,
    // so bind at the button itself and keep a single toggle handler.
    const toggle = () => state.toggle();
    button.addEventListener('click', toggle);
    return () => button.removeEventListener('click', toggle);
  }, [state]);
  return (
    <button
      type="button"
      className={`qapaqQapaqzito__launcher${open ? ' qapaqQapaqzito__launcher--open' : ''}`}
      aria-label={`${NAME}, asistente de IA. ${open ? 'Cerrar' : 'Abrir'} el panel`}
      aria-expanded={open}
      aria-controls="qapaq-qapaqzito-panel"
      title={`${NAME}, asistente de IA`}
      data-test-subj="qapaqQapaqzitoLauncher"
      ref={buttonRef}
    >
      <img src={imageUrl} alt="" width={30} height={30} />
    </button>
  );
}

/** Fuentes citadas como chips pequeños. */
function Sources({
  citations,
  open,
}: {
  citations: readonly QapaqzitoCitation[];
  open: (path: string) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <div className="qapaqQapaqzito__sources" aria-label="Fuentes">
      <span>Fuentes</span>
      {citations.slice(0, 8).map((citation) => {
        const path = citationPath(citation);
        const label = `${citation.kind === 'alert' ? 'Alerta' : citation.kind === 'incident' ? 'Incidente' : 'SOC'} ${citation.id}`;
        return path ? (
          <button
            type="button"
            key={`${citation.kind}:${citation.id}`}
            title={citation.label}
            onClick={() => open(path)}
          >
            {label}
          </button>
        ) : (
          <em key={`${citation.kind}:${citation.id}`}>{label}</em>
        );
      })}
    </div>
  );
}

/** «Archivos»: informes vigentes (24 h) del usuario, desde GET /assistant/artifacts. */
function FilesView({ api, onBack }: { api: QapaqApiClient; onBack: () => void }) {
  const [items, setItems] = useState<readonly ArtifactRef[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    listArtifacts(api).then(setItems, () => setFailed(true));
  }, [api]);
  useEffect(() => load(), [load]);
  return (
    <section className="qapaqQapaqzito__history qapaqQapaqzito__filesView" aria-label="Archivos generados">
      <div className="qapaqQapaqzito__historyHead">
        <h3>Archivos</h3>
        <button type="button" onClick={onBack}>
          Volver al chat
        </button>
      </div>
      <p className="qapaqQapaqzito__historyNote">
        Los informes que genera {NAME} se guardan 24 horas y solo los ves tú.
      </p>
      {failed && (
        <p className="qapaqQapaqzito__historyNote" role="alert">
          No pude cargar los archivos.{' '}
          <button type="button" className="qapaqQapaqzito__more" onClick={load}>
            Reintentar
          </button>
        </p>
      )}
      {items === null && !failed && <p className="qapaqQapaqzito__historyNote">Cargando…</p>}
      {items !== null && items.length === 0 && !failed && (
        <p className="qapaqQapaqzito__historyNote">
          Aún no hay archivos vigentes. Pídele a {NAME} un informe en PDF, Excel o CSV.
        </p>
      )}
      <div className="qapaqQapaqzito__files qapaqQapaqzito__files--list">
        {(items ?? []).map((artifact) => (
          <QapaqzitoArtifactCard key={artifact.id} artifact={artifact} apiPrefix={api.apiPrefix} />
        ))}
      </div>
    </section>
  );
}

function HistoryView({
  api,
  currentId,
  onOpen,
  onNew,
  onDeleted,
}: {
  api: QapaqApiClient;
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string | null) => void;
}) {
  const [items, setItems] = useState<readonly ConversationSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<string | 'all' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (next?: string) => {
      listConversations(api, next).then(
        (page) => {
          setItems((current) => (next && current ? [...current, ...page.items] : page.items));
          setCursor(page.nextCursor);
          setFailed(false);
        },
        () => setFailed(true),
      );
    },
    [api],
  );
  useEffect(() => load(), [load]);

  const remove = async (target: string | 'all') => {
    setBusy(true);
    try {
      if (target === 'all') await deleteAllConversations(api);
      else await deleteConversation(api, target);
      setItems((current) =>
        target === 'all' ? [] : (current ?? []).filter((item) => item.id !== target),
      );
      onDeleted(target === 'all' ? null : target);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <div className="qapaqQapaqzito__history">
      <div className="qapaqQapaqzito__historyHead">
        <h3>Historial</h3>
        <button type="button" onClick={onNew}>
          + Nueva conversación
        </button>
      </div>
      {failed && (
        <p className="qapaqQapaqzito__historyNote" role="alert">
          No pude cargar el historial. Inténtalo de nuevo.
        </p>
      )}
      {items === null && !failed && <p className="qapaqQapaqzito__historyNote">Cargando…</p>}
      {items !== null && items.length === 0 && !failed && (
        <p className="qapaqQapaqzito__historyNote">
          Aún no tienes conversaciones guardadas. Lo que le preguntes a {NAME} aparecerá aquí.
        </p>
      )}
      <ul>
        {(items ?? []).map((item) => (
          <li key={item.id} className={item.id === currentId ? 'is-current' : ''}>
            <button type="button" className="qapaqQapaqzito__historyOpen" onClick={() => onOpen(item.id)}>
              <strong>{item.title || 'Conversación sin título'}</strong>
              <span>
                {formatWhen(item.updatedAt)} · {item.messageCount}{' '}
                {item.messageCount === 1 ? 'mensaje' : 'mensajes'}
              </span>
            </button>
            {confirming === item.id ? (
              <span className="qapaqQapaqzito__confirm">
                ¿Borrar?
                <button type="button" disabled={busy} onClick={() => remove(item.id)}>
                  Sí
                </button>
                <button type="button" onClick={() => setConfirming(null)}>
                  No
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="qapaqQapaqzito__iconButton"
                title="Borrar conversación"
                aria-label={`Borrar la conversación ${item.title}`}
                onClick={() => setConfirming(item.id)}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" className="qapaqQapaqzito__more" onClick={() => load(cursor)}>
          Cargar más
        </button>
      )}
      {items !== null && items.length > 0 && (
        <div className="qapaqQapaqzito__historyFoot">
          {confirming === 'all' ? (
            <span className="qapaqQapaqzito__confirm">
              ¿Borrar todo el historial? No se puede deshacer.
              <button type="button" disabled={busy} onClick={() => remove('all')}>
                Sí, borrar
              </button>
              <button type="button" onClick={() => setConfirming(null)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming('all')}>
              Borrar todo el historial
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function QapaqzitoUsageView({
  api,
  configState,
  onRetryConfig,
}: {
  api: QapaqApiClient;
  configState: QapaqzitoConfigState;
  onRetryConfig: () => void;
}) {
  const [usage, setUsage] = useState<QapaqzitoUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const initialized = useRef(false);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const page = await fetchQapaqzitoUsage(api, {
          ...(usage?.period ? { from: usage.period.from, to: usage.period.to } : {}),
          ...(cursor ? { cursor } : {}),
        });
        setUsage((current) => {
          if (!cursor || !current) return page;
          return {
            ...page,
            totals: {
              requests: current.totals.requests + page.totals.requests,
              succeeded: current.totals.succeeded + page.totals.succeeded,
              failed: current.totals.failed + page.totals.failed,
              measured: current.totals.measured + page.totals.measured,
              inputTokens: current.totals.inputTokens + page.totals.inputTokens,
              outputTokens: current.totals.outputTokens + page.totals.outputTokens,
              cacheReadTokens: current.totals.cacheReadTokens + page.totals.cacheReadTokens,
              cacheWriteTokens: current.totals.cacheWriteTokens + page.totals.cacheWriteTokens,
            },
          };
        });
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [api, usage?.period.from, usage?.period.to],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void load();
  }, [load]);

  return (
    <section className="qapaqQapaqzito__usage" aria-label="Uso y configuración de Qapaqzito">
      <h3>Uso y configuración</h3>
      <p className="qapaqQapaqzito__usageIntro">
        Vista administrativa de solo lectura. No muestra prompts, respuestas ni claves.
      </p>
      {configState.status === 'ready' ? (
        <dl>
          <div>
            <dt>Estado</dt>
            <dd>{configState.config.enabled ? 'Habilitado' : 'Deshabilitado'}</dd>
          </div>
          <div>
            <dt>Proveedor</dt>
            <dd>{configState.config.provider ?? 'Sin dato'}</dd>
          </div>
          <div>
            <dt>Modelo</dt>
            <dd>{configState.config.model ?? 'Sin dato'}</dd>
          </div>
          <div>
            <dt>Esfuerzo</dt>
            <dd>{configState.config.effort ?? 'Sin dato'}</dd>
          </div>
          <div>
            <dt>Límite por persona</dt>
            <dd>{configState.config.rateLimit ?? 'Sin dato'} preguntas / 10 min</dd>
          </div>
          <div>
            <dt>Datos personales</dt>
            <dd>
              {configState.config.redactsPersonalData ? 'Seudonimizados' : 'Redacción desactivada'}
            </dd>
          </div>
        </dl>
      ) : configState.status === 'loading' ? (
        <p role="status">Consultando configuración del servicio…</p>
      ) : (
        <div role="alert">
          <p>No se pudo comprobar la configuración. El estado del asistente es desconocido.</p>
          <button type="button" onClick={onRetryConfig}>
            Reintentar configuración
          </button>
        </div>
      )}
      <h4>Consumo · últimos 30 días</h4>
      {loading && !usage && <p role="status">Consultando auditoría…</p>}
      {failed && <p role="alert">No se pudieron cargar todas las métricas.</p>}
      {failed && !usage && (
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? 'Cargando…' : 'Reintentar'}
        </button>
      )}
      {usage && (
        <>
          <dl>
            <div>
              <dt>Solicitudes</dt>
              <dd>{usage.totals.requests}</dd>
            </div>
            <div>
              <dt>Completadas / fallidas</dt>
              <dd>
                {usage.totals.succeeded} / {usage.totals.failed}
              </dd>
            </div>
            <div>
              <dt>Tokens de entrada</dt>
              <dd>{usage.totals.inputTokens.toLocaleString('es-PE')}</dd>
            </div>
            <div>
              <dt>Tokens de salida</dt>
              <dd>{usage.totals.outputTokens.toLocaleString('es-PE')}</dd>
            </div>
            <div>
              <dt>Lecturas de caché</dt>
              <dd>{usage.totals.cacheReadTokens.toLocaleString('es-PE')}</dd>
            </div>
            <div>
              <dt>Solicitudes medidas</dt>
              <dd>
                {usage.totals.measured} / {usage.totals.requests}
              </dd>
            </div>
          </dl>
          <div className="qapaqQapaqzito__usageTableWrap">
            <table>
              <thead>
                <tr>
                  <th>Proveedor / modelo</th>
                  <th>Solicitudes</th>
                  <th>Tokens entrada/salida</th>
                </tr>
              </thead>
              <tbody>
                {usage.models.map((item) => (
                  <tr key={`${item.provider}:${item.model}`}>
                    <td>
                      {item.provider}
                      <small>{item.model}</small>
                    </td>
                    <td>{item.requests}</td>
                    <td>
                      {item.inputTokens.toLocaleString('es-PE')} /{' '}
                      {item.outputTokens.toLocaleString('es-PE')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="qapaqQapaqzito__usageNote">
            El costo facturado no está conectado a este panel. Los datos provienen de eventos de
            auditoría; usa «Cargar más» para recorrer el periodo completo.
          </p>
          {usage.nextCursor && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(usage.nextCursor ?? undefined)}
            >
              {loading ? 'Cargando…' : 'Cargar más uso'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

interface MenuEntry {
  readonly key: string;
  readonly icon: IconName;
  readonly label: string;
  readonly onSelect: () => void;
}

/** Menú «⋯» de la cabecera (Archivos, Uso y configuración). */
function HeaderMenu({ entries }: { entries: readonly MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);
  if (entries.length === 0) return null;
  return (
    <div
      className="qapaqQapaqzito__menuRoot"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          (rootRef.current?.querySelector('button') as HTMLButtonElement | null)?.focus();
        }
      }}
    >
      <button
        type="button"
        className="qapaqQapaqzito__iconButton"
        title="Más opciones"
        aria-label="Más opciones"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className="qapaqQapaqzito__menu" role="menu">
          {entries.map((entry) => (
            <button
              type="button"
              role="menuitem"
              key={entry.key}
              onClick={() => {
                setOpen(false);
                entry.onSelect();
              }}
            >
              <Icon name={entry.icon} size={15} /> {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mensaje de la persona: píldora sutil alineada a la derecha. */
function UserMessage({ message }: { message: Message }) {
  return (
    <article
      className={`qapaqQapaqzito__message qapaqQapaqzito__message--user${message.tone ? ` is-${message.tone}` : ''}`}
    >
      <p className="qapaqQapaqzito__pill">{message.text}</p>
    </article>
  );
}

export function QapaqzitoPanel({
  core,
  api,
  state,
  imageUrl,
}: {
  core: CoreStart;
  api: QapaqApiClient;
  state: QapaqzitoState;
  imageUrl: string;
}) {
  const open = useQapaqzitoOpen(state);
  const [configState, setConfigState] = useState<QapaqzitoConfigState>({ status: 'loading' });
  const [canSeeUsage, setCanSeeUsage] = useState(false);
  const [canWriteNotes, setCanWriteNotes] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [progressEvents, setProgressEvents] = useState<QapaqzitoProgressEvent[]>([]);
  const [streamText, setStreamText] = useState('');
  const [liveArtifacts, setLiveArtifacts] = useState<readonly ArtifactRef[]>([]);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [copied, setCopied] = useState<number | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<{
    messageId: number;
    incidentId: string;
  } | null>(null);
  const [savingNoteId, setSavingNoteId] = useState<number | null>(null);
  const [noteStatus, setNoteStatus] = useState<{ id: number; text: string } | null>(null);
  /** Contexto recibido de «Preguntar a Qapaqzito» (alerta/incidente) para la siguiente pregunta. */
  const [askContext, setAskContext] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => readStoredWidth());
  const [resizing, setResizing] = useState(false);
  const viewport = useViewportWidth();
  const nextId = useRef(1);
  const activeChatRun = useRef<AbortController | null>(null);
  const configRequest = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragging = useRef(false);
  const stickToBottom = useRef(true);
  const wasOpen = useRef(false);
  /** Archivos ya descargados automáticamente en esta sesión (evento SSE + respuesta final). */
  const downloaded = useRef<Set<string>>(new Set());

  const mode = layoutMode(viewport);
  const renderWidth = effectivePanelWidth(panelWidth, viewport);
  const dockWidth = dockWidthFor(open, viewport, panelWidth);

  // La consola se acopla (se encoge) mientras el panel está abierto y en pantalla ancha; al cerrar
  // `<html>` queda exactamente como estaba (sin clase ni variable). Ver `qapaqzito.scss`.
  useLayoutEffect(() => {
    applyDock(document.documentElement, dockWidth);
  }, [dockWidth]);
  useLayoutEffect(() => () => applyDock(document.documentElement, null), []);

  const loadConfig = useCallback(async () => {
    const requestId = ++configRequest.current;
    setConfigState({ status: 'loading' });
    const result = await loadQapaqzitoConfigState(api);
    if (requestId === configRequest.current) setConfigState(result);
  }, [api]);

  useEffect(() => {
    if (!pending || thinkingStartedAt === null) return undefined;
    const updateElapsed = () =>
      setElapsedSeconds(Math.floor((Date.now() - thinkingStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [pending, thinkingStartedAt]);

  useEffect(() => {
    void loadConfig();
    api.session().then(
      (session) => {
        setCanSeeUsage(session.capabilities.includes('observability.read_platform'));
        setCanWriteNotes(session.capabilities.includes(CAPABILITIES.notesWrite));
      },
      () => {
        setCanSeeUsage(false);
        setCanWriteNotes(false);
      },
    );
    return () => {
      configRequest.current += 1;
    };
  }, [api, loadConfig]);

  useEffect(() => {
    if (open && view === 'chat') inputRef.current?.focus();
  }, [open, view]);

  // Al cerrar, el foco vuelve al botón de la cabecera (lo que abrió el panel).
  useEffect(() => {
    if (wasOpen.current && !open) document.querySelector<HTMLElement>(LAUNCHER)?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, view, streamText, progressEvents, liveArtifacts]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        state.toggle();
      } else if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        state.isOpen() &&
        // Un modal o flyout de OSD abierto atiende primero su propio Esc.
        !document.querySelector('.euiOverlayMask')
      ) {
        state.set(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  const page = window.location.pathname;
  const append = useCallback((message: Omit<Message, 'id'>) => {
    setMessages((current) => [...current, { ...message, id: nextId.current++ }]);
  }, []);

  const newConversation = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setNotSaved(false);
    setView('chat');
    stickToBottom.current = true;
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      try {
        const stored = await getConversation(api, id);
        nextId.current = 1;
        setMessages(
          stored.messages.map((message) => ({
            id: nextId.current++,
            role: message.role,
            text: message.text,
            ...(message.steps ? { steps: message.steps } : {}),
            ...(message.citations ? { citations: message.citations } : {}),
            ...(message.artifacts ? { artifacts: message.artifacts } : {}),
            ...(message.tone ? { tone: message.tone } : {}),
            ...(message.role === 'assistant' ? { serverId: String(message.id) } : {}),
            ...(message.feedback ? { feedback: message.feedback } : {}),
          })),
        );
        setConversationId(stored.id);
        setNotSaved(false);
        setView('chat');
        stickToBottom.current = true;
      } catch {
        append({ role: 'assistant', text: 'No pude abrir esa conversación.', tone: 'error' });
        setView('chat');
      }
    },
    [api, append],
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || pending) return;
      const history: QapaqzitoTurn[] = messages
        .filter((message) => !message.tone)
        .map(({ role, text: content }) => ({ role, content }));
      setDraft('');
      const userMessageId = nextId.current;
      append({ role: 'user', text });
      stickToBottom.current = true;
      const startedAt = Date.now();
      setPending(true);
      setThinkingStartedAt(startedAt);
      setElapsedSeconds(0);
      setProgressEvents([]);
      setStreamText('');
      setLiveArtifacts([]);
      const received: ArtifactRef[] = [];
      const controller = new AbortController();
      activeChatRun.current = controller;
      try {
        const reply = await askQapaqzitoStream(
          api,
          text,
          history,
          askContext ?? `${window.location.pathname}${window.location.search}`,
          (event) => setProgressEvents((current) => [...current, event]),
          conversationId ?? undefined,
          controller.signal,
          {
            onArtifact: (artifact) => {
              received.push(artifact);
              setLiveArtifacts((current) => mergeArtifacts(current, [artifact]));
              // El archivo ya está guardado: se descarga una sola vez, en cuanto llega.
              autoDownloadOnce(downloaded.current, artifact, api.apiPrefix);
            },
            onDelta: (chunk) => setStreamText((current) => current + chunk),
          },
        );
        setAskContext(null);
        if (reply.conversationId) setConversationId(reply.conversationId);
        setNotSaved(reply.saved === false);
        // Camino JSON (sin SSE): los archivos llegan solo en la respuesta final.
        (reply.artifacts ?? []).forEach((artifact) =>
          autoDownloadOnce(downloaded.current, artifact, api.apiPrefix),
        );
        append({
          role: 'assistant',
          text: reply.reply,
          steps: reply.steps,
          citations: reply.citations,
          seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
          ...(reply.artifacts && reply.artifacts.length > 0 ? { artifacts: reply.artifacts } : {}),
          ...(reply.messageId ? { serverId: reply.messageId } : {}),
          ...(reply.outcome === 'refused' || reply.outcome === 'unverified'
            ? { tone: 'notice' as const }
            : {}),
        });
      } catch (error) {
        const files = received.length > 0 ? { artifacts: received } : {};
        if (controller.signal.aborted) {
          setDraft(text);
          setMessages((current) =>
            current.map((message) =>
              message.id === userMessageId ? { ...message, tone: 'notice' } : message,
            ),
          );
          append({
            role: 'assistant',
            text: 'Consulta cancelada. No se reintentó automáticamente; revisa la actividad antes de volver a enviarla.',
            tone: 'notice',
            ...files,
          });
        } else {
          append({ role: 'assistant', text: errorText(error), tone: 'error', ...files });
        }
      } finally {
        if (activeChatRun.current === controller) activeChatRun.current = null;
        setPending(false);
        setStreamText('');
        setLiveArtifacts([]);
        inputRef.current?.focus();
      }
    },
    [api, append, askContext, conversationId, messages, pending],
  );

  // API pública del panel: `window.dispatchEvent(new CustomEvent(QAPAQZITO_ASK_EVENT, …))` (ver
  // `common/qapaqzito_bridge.ts` y `public/qapaqzito_bridge.ts#askQapaqzito`). Abre el panel en el chat, deja
  // la pregunta como borrador (o la envía con `autoSend`) y usa `context` como página de contexto.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<QapaqzitoAskDetail>).detail;
      if (!detail || typeof detail.prompt !== 'string' || detail.prompt.trim() === '') return;
      event.preventDefault();
      state.set(true);
      setView('chat');
      setAskContext(contextPage(detail.context));
      const prompt = detail.prompt.slice(0, MAX_CHARS);
      if (detail.autoSend) {
        // El contexto se aplica en el siguiente render; se envía después.
        window.setTimeout(() => void sendRef.current(prompt), 0);
      } else {
        setDraft(prompt);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    window.addEventListener(QAPAQZITO_ASK_EVENT, onAsk);
    return () => window.removeEventListener(QAPAQZITO_ASK_EVENT, onAsk);
  }, [state]);

  const rate = useCallback(
    async (message: Message, rating: QapaqzitoFeedback | null) => {
      if (!conversationId || !message.serverId) return;
      const previous = message.feedback;
      const patch = (feedback: QapaqzitoFeedback | undefined) =>
        setMessages((current) =>
          current.map((item) => {
            if (item.id !== message.id) return item;
            const { feedback: _old, ...rest } = item;
            return feedback ? { ...rest, feedback } : rest;
          }),
        );
      patch(rating ?? undefined);
      try {
        await rateMessage(api, conversationId, message.serverId, rating);
      } catch {
        patch(previous);
      }
    },
    [api, conversationId],
  );

  const navigate = useCallback(
    (path: string) => core.application.navigateToUrl(core.http.basePath.prepend(path)),
    [core],
  );

  const commitWidth = (next: number) => {
    const clamped = clampPanelWidth(next, window.innerWidth);
    setPanelWidth(clamped);
    writeStoredWidth(clamped);
  };

  if (!open) return null;

  const suggestions = suggestionsFor(page);
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')?.id;
  const isWide = renderWidth >= PANEL_WIDE_WIDTH;
  const menuEntries: MenuEntry[] = [
    { key: 'files', icon: 'file', label: 'Archivos', onSelect: () => setView('files') },
    ...(canSeeUsage
      ? [
          {
            key: 'usage',
            icon: 'info' as IconName,
            label: 'Uso y configuración',
            onSelect: () => setView('usage'),
          },
        ]
      : []),
  ];
  const contextChip = askContext
    ? {
        label: `${askContext.includes('incidents') ? 'Incidente' : 'Alerta'} ${decodeURIComponent(askContext.split('id=')[1] ?? '')}`,
        onRemove: () => setAskContext(null),
      }
    : null;

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // Cajón superpuesto: el foco no sale del panel mientras está abierto.
    if (mode !== 'overlay' || event.key !== 'Tab' || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {mode === 'overlay' && (
        <div className="qapaqQapaqzito__backdrop" aria-hidden="true" onClick={() => state.set(false)} />
      )}
      <aside
        id="qapaq-qapaqzito-panel"
        ref={panelRef}
        className={`qapaqQapaqzito__panel qapaqQapaqzito__panel--${mode}${resizing ? ' is-resizing' : ''}`}
        style={{ width: renderWidth }}
        role="dialog"
        aria-modal={mode === 'overlay' ? true : undefined}
        aria-label={`${NAME}, asistente de IA de QAPAQ SOC`}
        data-test-subj="qapaqQapaqzitoPanel"
        onKeyDown={onPanelKeyDown}
      >
        <div
          className="qapaqQapaqzito__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Cambiar el ancho del panel (flechas izquierda y derecha)"
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={PANEL_MAX_WIDTH}
          aria-valuenow={renderWidth}
          tabIndex={0}
          title="Arrastra para cambiar el ancho"
          onPointerDown={(event) => {
            event.preventDefault();
            dragging.current = true;
            setResizing(true);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragging.current) setPanelWidth(widthFromPointer(event.clientX, window.innerWidth));
          }}
          onPointerUp={(event) => {
            if (!dragging.current) return;
            dragging.current = false;
            setResizing(false);
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            commitWidth(widthFromPointer(event.clientX, window.innerWidth));
          }}
          onPointerCancel={() => {
            dragging.current = false;
            setResizing(false);
          }}
          onDoubleClick={() => commitWidth(toggleWideWidth(renderWidth, window.innerWidth))}
          onKeyDown={(event) => {
            const next = widthFromKey(renderWidth, event.key, window.innerWidth);
            if (next === null) return;
            event.preventDefault();
            commitWidth(next);
          }}
        />
        <header className="qapaqQapaqzito__header">
          <img src={imageUrl} alt="" width={28} height={28} />
          <h2>{NAME}</h2>
          <span className="qapaqQapaqzito__spacer" />
          <button
            type="button"
            className="qapaqQapaqzito__iconButton"
            title="Nueva conversación"
            aria-label="Nueva conversación"
            disabled={pending || (messages.length === 0 && view === 'chat')}
            onClick={newConversation}
          >
            <Icon name="plus" size={18} />
          </button>
          <button
            type="button"
            className={`qapaqQapaqzito__iconButton${view === 'history' ? ' is-active' : ''}`}
            title="Historial de conversaciones"
            aria-label="Historial de conversaciones"
            aria-pressed={view === 'history'}
            onClick={() => setView(view === 'history' ? 'chat' : 'history')}
          >
            <Icon name="history" size={18} />
          </button>
          <HeaderMenu entries={menuEntries} />
          <button
            type="button"
            className="qapaqQapaqzito__iconButton"
            title={isWide ? 'Reducir el panel' : 'Ensanchar el panel'}
            aria-label={isWide ? 'Reducir el panel' : 'Ensanchar el panel'}
            onClick={() => commitWidth(toggleWideWidth(renderWidth, window.innerWidth))}
          >
            <Icon name={isWide ? 'shrink' : 'expand'} size={17} />
          </button>
          <button
            type="button"
            className="qapaqQapaqzito__iconButton"
            title="Cerrar (Esc)"
            aria-label="Cerrar el panel"
            onClick={() => state.set(false)}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {view === 'usage' && canSeeUsage ? (
          <QapaqzitoUsageView
            api={api}
            configState={configState}
            onRetryConfig={() => void loadConfig()}
          />
        ) : configState.status === 'loading' ? (
          <div className="qapaqQapaqzito__unavailable" role="status">
            Comprobando disponibilidad del asistente...
          </div>
        ) : configState.status === 'unavailable' ? (
          <section className="qapaqQapaqzito__unavailable" role="alert">
            <h3>No se pudo comprobar la disponibilidad</h3>
            <p>El servicio de configuración no respondió. El estado de Qapaqzito es desconocido.</p>
            <button type="button" onClick={() => void loadConfig()}>
              Reintentar
            </button>
          </section>
        ) : configState.status === 'ready' && !configState.config.enabled ? (
          <section className="qapaqQapaqzito__unavailable" role="status">
            <h3>Qapaqzito está instalado</h3>
            <p>
              La interfaz del asistente está lista. Para activar las respuestas, un administrador
              debe habilitar y configurar el proveedor de IA en el servicio QAPAQ. Con Bedrock, la API
              usa el rol de AWS.
            </p>
            <p>
              El envío de mensajes está deshabilitado hasta que el servicio confirme la conexión.
            </p>
          </section>
        ) : view === 'history' ? (
          <HistoryView
            api={api}
            currentId={conversationId}
            onOpen={openConversation}
            onNew={newConversation}
            onDeleted={(id) => {
              if (id === null || id === conversationId) newConversation();
              setView('history');
            }}
          />
        ) : view === 'files' ? (
          <FilesView api={api} onBack={() => setView('chat')} />
        ) : (
          <>
            <div
              className="qapaqQapaqzito__list"
              ref={listRef}
              role="log"
              aria-live="polite"
              onScroll={() => {
                const el = listRef.current;
                if (el) {
                  stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
                }
              }}
            >
              <div className="qapaqQapaqzito__thread">
                {messages.length === 0 && !pending && (
                  <section className="qapaqQapaqzito__welcome">
                    <img src={imageUrl} alt="" width={72} height={72} />
                    <h3>Hola, soy {NAME}</h3>
                    <p>
                      ¿En qué te ayudo hoy? Veo lo mismo que tú: lo que tu rol no puede ver, yo
                      tampoco.
                    </p>
                    <ul className="qapaqQapaqzito__suggestions">
                      {suggestions.slice(0, 4).map((suggestion) => (
                        <li key={suggestion.title}>
                          <button type="button" onClick={() => send(suggestion.prompt)}>
                            <strong>{suggestion.title}</strong>
                            <span>{suggestion.prompt}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {messages.map((message) =>
                  message.role === 'user' ? (
                    <UserMessage key={message.id} message={message} />
                  ) : (
                    <article
                      key={message.id}
                      className={`qapaqQapaqzito__message qapaqQapaqzito__message--assistant${message.tone ? ` is-${message.tone}` : ''}${message.id === lastAssistantId ? ' is-last' : ''}`}
                    >
                      <QapaqzitoActivity steps={message.steps} seconds={message.seconds} />
                      <div className="qapaqQapaqzito__answer">
                        {renderMarkdown(message.text, {
                          citations: message.citations ?? [],
                          onOpen: navigate,
                        })}
                      </div>
                      {message.artifacts && (
                        <QapaqzitoArtifactList
                          artifacts={message.artifacts}
                          apiPrefix={api.apiPrefix}
                        />
                      )}
                      {message.citations && (
                        <Sources citations={message.citations} open={navigate} />
                      )}
                      {!message.tone && (
                        <div className="qapaqQapaqzito__actions">
                          <button
                            type="button"
                            className={`qapaqQapaqzito__action${copied === message.id ? ' is-active' : ''}`}
                            title={copied === message.id ? 'Copiado' : 'Copiar respuesta'}
                            aria-label={copied === message.id ? 'Copiado' : 'Copiar respuesta'}
                            onClick={() => {
                              navigator.clipboard?.writeText(message.text).then(
                                () => {
                                  setCopied(message.id);
                                  window.setTimeout(() => setCopied(null), 1500);
                                },
                                () => undefined,
                              );
                            }}
                          >
                            <Icon name={copied === message.id ? 'check' : 'copy'} size={15} />
                          </button>
                          {conversationId && message.serverId && (
                            <Feedback
                              value={message.feedback}
                              disabled={pending}
                              onRate={(rating) => void rate(message, rating)}
                            />
                          )}
                          <QapaqzitoReportActions
                            api={api}
                            basePath={core.http.basePath.get()}
                            messageId={message.id}
                            text={message.text}
                            citations={message.citations ?? []}
                          />
                          {canWriteNotes &&
                            message.citations?.some((citation) => citation.kind === 'incident') && (
                              <>
                                <select
                                  aria-label="Incidente donde guardar el borrador"
                                  value={
                                    (selectedIncident?.messageId === message.id
                                      ? selectedIncident.incidentId
                                      : '') ||
                                    message.citations?.find(
                                      (citation) => citation.kind === 'incident',
                                    )?.id ||
                                    ''
                                  }
                                  onChange={(event) =>
                                    setSelectedIncident({
                                      messageId: message.id,
                                      incidentId: event.target.value,
                                    })
                                  }
                                >
                                  {(message.citations ?? [])
                                    .filter((citation) => citation.kind === 'incident')
                                    .map((citation) => (
                                      <option key={citation.id} value={citation.id}>
                                        {citation.label}
                                      </option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={savingNoteId === message.id}
                                  onClick={async () => {
                                    const incidentId =
                                      (selectedIncident?.messageId === message.id
                                        ? selectedIncident.incidentId
                                        : '') ||
                                      message.citations?.find(
                                        (citation) => citation.kind === 'incident',
                                      )?.id;
                                    if (!incidentId) return;
                                    setSavingNoteId(message.id);
                                    setNoteStatus(null);
                                    try {
                                      await api.post(
                                        `/incidents/${encodeURIComponent(incidentId)}/notes`,
                                        { body: reportNoteBody(message) },
                                      );
                                      setNoteStatus({
                                        id: message.id,
                                        text: 'Borrador guardado en las notas del incidente.',
                                      });
                                    } catch {
                                      setNoteStatus({
                                        id: message.id,
                                        text: 'No se pudo guardar. Verifica tu acceso al incidente.',
                                      });
                                    } finally {
                                      setSavingNoteId(null);
                                    }
                                  }}
                                >
                                  {savingNoteId === message.id
                                    ? 'Guardando…'
                                    : 'Guardar en incidente'}
                                </button>
                              </>
                            )}
                          <button type="button" onClick={() => navigate('/app/ankay')}>
                            Abrir Ankay
                          </button>
                        </div>
                      )}
                      {noteStatus?.id === message.id && (
                        <p className="qapaqQapaqzito__notice" role="status">
                          {noteStatus.text}
                        </p>
                      )}
                    </article>
                  ),
                )}
                {pending && (
                  <article
                    className="qapaqQapaqzito__message qapaqQapaqzito__message--assistant is-live"
                    aria-busy="true"
                  >
                    <QapaqzitoThinking events={progressEvents} elapsedSeconds={elapsedSeconds} />
                    {streamText && (
                      <div className="qapaqQapaqzito__answer is-streaming">
                        {renderMarkdown(streamText, {
                          citations: [],
                          onOpen: navigate,
                        })}
                      </div>
                    )}
                    <QapaqzitoArtifactList artifacts={liveArtifacts} apiPrefix={api.apiPrefix} />
                  </article>
                )}
              </div>
            </div>

            {notSaved && (
              <p className="qapaqQapaqzito__notice" role="status">
                Esta conversación no se guardó en el historial.
              </p>
            )}
            <QapaqzitoComposer
              draft={draft}
              pending={pending}
              maxChars={MAX_CHARS}
              name={NAME}
              context={contextChip}
              inputRef={inputRef}
              onDraft={setDraft}
              onSend={() => void send(draft)}
              onStop={() => activeChatRun.current?.abort()}
            />
          </>
        )}
        <p className="qapaqQapaqzito__disclaimer">
          IA: verifica antes de actuar. Solo lectura, con tus permisos.
        </p>
      </aside>
    </>
  );
}

/** Monta el panel en el `body` (el botón vive en la cabecera) y devuelve el desmontaje. */
export function mountQapaqzitoPanel(core: CoreStart, api: QapaqApiClient, state: QapaqzitoState): () => void {
  const container = document.createElement('div');
  container.dataset.qapaqQapaqzito = 'panel';
  // OSD vuelve a renderizar <body> después del `start` de los plugins y elimina los nodos
  // añadidos antes: el contenedor se (re)inserta cada vez que el panel se abre.
  const attach = () => {
    if (!container.isConnected) document.body.appendChild(container);
  };
  attach();
  const imageUrl = core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/qapaq-qapaqzito.webp`);
  ReactDOM.render(
    <QapaqzitoPanel core={core} api={api} state={state} imageUrl={imageUrl} />,
    container,
  );
  const unsubscribe = state.subscribe(() => {
    if (state.isOpen()) attach();
  });
  return () => {
    unsubscribe();
    ReactDOM.unmountComponentAtNode(container);
    applyDock(document.documentElement, null);
    container.remove();
  };
}

/** Registra Qapaqzito a la derecha del navbar; el panel se monta fuera de la cabecera. */
export function registerQapaqzitoLauncher(core: CoreStart, state: QapaqzitoState): () => void {
  const targets = new Set<HTMLElement>();
  let stopped = false;
  const imageUrl = core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/qapaq-qapaqzito.webp`);
  core.chrome.navControls.registerRight({
    order: 900,
    mount: (target: HTMLElement) => {
      if (stopped) return () => undefined;
      targets.add(target);
      ReactDOM.render(<QapaqzitoLauncher state={state} imageUrl={imageUrl} />, target);
      return () => {
        ReactDOM.unmountComponentAtNode(target);
        targets.delete(target);
      };
    },
  });
  return () => {
    stopped = true;
    targets.forEach((target) => ReactDOM.unmountComponentAtNode(target));
    targets.clear();
  };
}
