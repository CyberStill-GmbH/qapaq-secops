/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiLoadingContent,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import { AssistantMessageResponse, AssistantStatus, CAPABILITIES } from '../../common';
import { QapaqApiError } from '../api/client';
import { useConsole } from './console_context';
import { DataZone, ErrorCallout, Mono, useAsync, useIsMobile } from './primitives';
import { QapaqzitoAvatar } from './qapaqzito_avatar';

/**
 * Panel de Qapaqzito, el asistente Claude del SOC, acoplado al borde izquierdo (al estilo de
 * Amazon Q): la cola y el detalle de la alerta siguen visibles a la derecha mientras se conversa.
 *
 * La consola solo envía el mensaje nuevo, el `conversationId` y, si hay, la alerta abierta como
 * contexto. El backend seudonimiza todo lo que sale hacia el modelo y devuelve la respuesta ya
 * re-resuelta; el historial completo vive en el servidor. La autorización (`assistant.use`) la
 * decide el backend: aquí solo se elige qué estado mostrar.
 */

const TOOL_LABEL: Record<string, string> = {
  list_alerts: 'cola de alertas',
  get_alert: 'detalle de alerta',
  related_alerts_by_entity: 'alertas por entidad',
  soc_summary: 'resumen del SOC',
  incident_log: 'bitácora de incidente',
};

export interface AssistantTurn {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly toolsUsed?: readonly string[];
  readonly truncated?: boolean;
  readonly declined?: boolean;
}

/** Estado de una conversación; vive en la vista para sobrevivir a cerrar y abrir el panel. */
export interface AssistantSession {
  readonly open: boolean;
  readonly alertId: string | null;
  readonly turns: readonly AssistantTurn[];
  readonly conversationId: string | null;
  readonly sending: boolean;
  readonly error: unknown;
  readonly notice: string | null;
  openWith(alertId: string | null): void;
  close(): void;
  clearContext(): void;
  reset(): void;
  send(text: string): Promise<void>;
  retry(): void;
}

export function useAssistantSession(): AssistantSession {
  const { api } = useConsole();
  const [open, setOpen] = useState(false);
  const [alertId, setAlertId] = useState<string | null>(null);
  const [turns, setTurns] = useState<readonly AssistantTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const lastMessage = useRef<string | null>(null);

  const reset = useCallback(() => {
    setTurns([]);
    setConversationId(null);
    setError(null);
    setNotice(null);
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      lastMessage.current = text;
      setSending(true);
      setError(null);
      setNotice(null);
      setTurns((current) => [...current, { id: ++sequence.current, role: 'user', text }]);
      try {
        const response = await api.post<AssistantMessageResponse>('/assistant/messages', {
          message: text,
          ...(conversationId ? { conversationId } : {}),
          ...(alertId ? { context: { alertId } } : {}),
        });
        setConversationId(response.conversationId);
        setTurns((current) => [
          ...current,
          {
            id: ++sequence.current,
            role: 'assistant',
            text: response.reply.text,
            toolsUsed: response.toolsUsed,
            truncated: response.reply.truncated,
            declined: response.reply.declined,
          },
        ]);
      } catch (failure) {
        // La conversación venció en el servidor (reinicio o 30 min sin uso): se empieza otra.
        if (
          failure instanceof QapaqApiError &&
          failure.code === 'RESOURCE_UNAVAILABLE' &&
          conversationId
        ) {
          setConversationId(null);
          setNotice(
            'La conversación anterior venció. Vuelve a enviar tu pregunta para empezar una nueva.',
          );
        } else if (
          failure instanceof QapaqApiError &&
          failure.code === 'VALIDATION_FAILED' &&
          failure.fields.includes('conversationId')
        ) {
          setNotice(
            'Esta conversación llegó a su límite de mensajes. Empieza una nueva para seguir.',
          );
        } else {
          setError(failure);
        }
        // El mensaje no llegó al historial del servidor: se retira para no confundir.
        setTurns((current) => current.slice(0, -1));
      } finally {
        setSending(false);
      }
    },
    [api, alertId, conversationId, sending],
  );

  return {
    open,
    alertId,
    turns,
    conversationId,
    sending,
    error,
    notice,
    openWith: (id) => {
      setAlertId(id);
      setOpen(true);
    },
    close: () => setOpen(false),
    clearContext: () => setAlertId(null),
    reset,
    send,
    retry: () => {
      if (lastMessage.current) void send(lastMessage.current);
    },
  };
}

/** Botón que abre el panel; con `alertId`, la conversación arranca con esa alerta de contexto. */
export function AssistantLauncher({
  session,
  alertId = null,
  label = 'Qapaqzito',
  size = 's',
}: {
  session: AssistantSession;
  alertId?: string | null;
  label?: string;
  size?: 's' | 'm';
}) {
  return (
    <EuiButton
      size={size}
      color="text"
      className="qapaqAssistantLauncher"
      onClick={() => session.openWith(alertId)}
      data-test-subj={alertId ? 'qapaqAssistantAskAlert' : 'qapaqAssistantOpen'}
    >
      <span className="qapaqAssistantLauncher__content">
        <QapaqzitoAvatar size={20} />
        <span>{label}</span>
      </span>
    </EuiButton>
  );
}

function suggestionsFor(alertId: string | null): readonly string[] {
  return alertId
    ? [
        'Explícame esta alerta y por qué tiene esta prioridad.',
        '¿Hay otras alertas de las mismas entidades?',
        '¿Qué debería revisar primero para triarla?',
      ]
    : [
        'Resume el estado del SOC.',
        '¿Qué alertas P1 siguen abiertas?',
        '¿Qué entidades se repiten en la cola abierta?',
      ];
}

function Turn({ turn }: { turn: AssistantTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="qapaqAssistantTurn qapaqAssistantTurn--user">
        <DataZone className="qapaqAssistantBubble qapaqAssistantBubble--user">{turn.text}</DataZone>
      </div>
    );
  }
  return (
    <div className="qapaqAssistantTurn qapaqAssistantTurn--assistant">
      <QapaqzitoAvatar size={28} />
      <div className="qapaqAssistantTurn__body">
        <DataZone
          className={`qapaqAssistantBubble qapaqAssistantBubble--assistant${
            turn.declined ? ' qapaqAssistantBubble--declined' : ''
          }`}
        >
          {turn.text}
        </DataZone>
        {((turn.toolsUsed?.length ?? 0) > 0 || turn.truncated === true) && (
          <div className="qapaqAssistantTurn__meta">
            {turn.toolsUsed && turn.toolsUsed.length > 0 && (
              <EuiText size="xs" color="subdued">
                <span>
                  Consultó: {turn.toolsUsed.map((tool) => TOOL_LABEL[tool] ?? tool).join(' · ')}
                </span>
              </EuiText>
            )}
            {turn.truncated && (
              <EuiBadge color="warning">Respuesta acotada por los límites de la consulta</EuiBadge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="qapaqAssistantTurn qapaqAssistantTurn--assistant" aria-live="polite">
      <QapaqzitoAvatar size={28} thinking />
      <div className="qapaqAssistantBubble qapaqAssistantBubble--assistant qapaqAssistantThinking">
        <span>Qapaqzito está revisando</span>
        <span className="qapaqAssistantThinking__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

/** Estado sin conversación: presentación y preguntas sugeridas. */
function Welcome({
  alertId,
  onPick,
  disabled,
}: {
  alertId: string | null;
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="qapaqAssistantWelcome">
      <QapaqzitoAvatar size={72} />
      <EuiSpacer size="s" />
      <EuiTitle size="xs">
        <h3>Hola, soy Qapaqzito</h3>
      </EuiTitle>
      <EuiText size="s" color="subdued">
        <p>
          Reviso la cola, explico alertas, busco alertas relacionadas por entidad y resumo la
          bitácora de un incidente. Solo leo lo que tu cuenta ya puede ver; no cambio nada.
        </p>
      </EuiText>
      <EuiSpacer size="m" />
      <div className="qapaqAssistantSuggestions">
        {suggestionsFor(alertId).map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="qapaqAssistantSuggestion"
            onClick={() => onPick(suggestion)}
            disabled={disabled}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Estado que no admite conversación (sin permiso o sin configurar): explica y no ofrece entrada. */
function Blocked({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="qapaqAssistantWelcome">
      <QapaqzitoAvatar size={64} />
      <EuiSpacer size="m" />
      <EuiCallOut size="s" color="warning" iconType="iInCircle" title={title}>
        <p>{children}</p>
      </EuiCallOut>
    </div>
  );
}

export function AssistantPanel({ session }: { session: AssistantSession }) {
  const { api, can } = useConsole();
  const mobile = useIsMobile();
  const allowed = can(CAPABILITIES.assistantUse);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const status = useAsync<AssistantStatus | null>(
    () =>
      allowed && session.open
        ? api.get<AssistantStatus>('/assistant/status')
        : Promise.resolve(null),
    [api, allowed, session.open],
  );

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session.turns.length, session.sending]);

  if (!session.open) return null;

  const notConfigured =
    status.data?.configured === false ||
    (session.error instanceof QapaqApiError && session.error.code === 'FEATURE_NOT_CONFIGURED');
  const maxLength = status.data?.limits.messageMaxLength ?? 4000;
  const ready = allowed && !!status.data && !notConfigured;

  const submit = () => {
    if (!ready || session.sending || !draft.trim()) return;
    const text = draft;
    setDraft('');
    void session.send(text);
  };

  let body: React.ReactNode;
  if (!allowed) {
    body = (
      <Blocked title="Tu rol no incluye a Qapaqzito">
        El asistente está disponible para analistas SOC y administradores de plataforma (capacidad{' '}
        <Mono>assistant.use</Mono>). Si lo necesitas, solicita el rol desde «Usuarios y sesiones».
      </Blocked>
    );
  } else if (status.loading && !status.data) {
    body = <EuiLoadingContent lines={4} />;
  } else if (status.error) {
    body = <ErrorCallout error={status.error} onRetry={status.reload} />;
  } else if (notConfigured) {
    body = (
      <Blocked title="Qapaqzito aún no está habilitado">
        Este despliegue no tiene la API key del asistente. Operación debe cargar el secreto{' '}
        <Mono>qapaq-anthropic-api-key</Mono> en Key Vault y conceder su lectura al núcleo.
      </Blocked>
    );
  } else {
    body = (
      <>
        {session.turns.length === 0 && !session.sending ? (
          <Welcome
            alertId={session.alertId}
            onPick={(text) => void session.send(text)}
            disabled={session.sending}
          />
        ) : (
          session.turns.map((turn) => <Turn key={turn.id} turn={turn} />)
        )}
        {session.sending && <Thinking />}
        {session.notice && (
          <>
            <EuiSpacer size="s" />
            <EuiCallOut size="s" iconType="iInCircle" title={session.notice} />
          </>
        )}
        {session.error && !notConfigured && (
          <>
            <EuiSpacer size="s" />
            <ErrorCallout error={session.error} onRetry={session.retry} />
          </>
        )}
      </>
    );
  }

  return (
    <EuiFlyout
      side="left"
      type={mobile ? 'overlay' : 'push'}
      size="s"
      ownFocus={mobile}
      onClose={session.close}
      className="qapaqAssistant"
      aria-labelledby="qapaqAssistantTitle"
      hideCloseButton
    >
      <EuiFlyoutHeader hasBorder className="qapaqAssistant__header">
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <QapaqzitoAvatar size={36} thinking={session.sending} />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiTitle size="xs">
              <h2 id="qapaqAssistantTitle">Qapaqzito</h2>
            </EuiTitle>
            <EuiText size="xs" color="subdued">
              <span>Asistente del SOC · datos seudonimizados</span>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiToolTip content="Nueva conversación">
              <EuiButtonIcon
                iconType="refresh"
                aria-label="Nueva conversación"
                onClick={session.reset}
                isDisabled={session.sending || (session.turns.length === 0 && !session.notice)}
              />
            </EuiToolTip>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButtonIcon iconType="cross" aria-label="Cerrar Qapaqzito" onClick={session.close} />
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutHeader>
      <EuiFlyoutBody className="qapaqAssistant__body">
        <div className="qapaqAssistant__scroller" ref={scroller}>
          {body}
        </div>
      </EuiFlyoutBody>
      {ready && (
        <EuiFlyoutFooter className="qapaqAssistant__footer">
          {session.alertId && (
            <div className="qapaqAssistant__context">
              <EuiBadge
                color="hollow"
                iconType="cross"
                iconSide="right"
                iconOnClick={session.clearContext}
                iconOnClickAriaLabel="Quitar la alerta del contexto"
              >
                Contexto: alerta {session.alertId.slice(0, 12)}
              </EuiBadge>
            </div>
          )}
          <EuiTextArea
            fullWidth
            compressed
            rows={3}
            resize="none"
            className="qapaqAssistant__input"
            placeholder="Pregunta sobre alertas, entidades o incidentes…"
            aria-label="Mensaje para Qapaqzito"
            value={draft}
            maxLength={maxLength}
            disabled={session.sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter envía; Mayús+Enter agrega una línea.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
            <EuiFlexItem>
              <EuiText size="xs" color="subdued">
                <span>
                  Puede equivocarse: verifica antes de actuar. Usuarios, IP y equipos salen
                  seudonimizados.
                </span>
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                fill
                iconType="returnKey"
                iconSide="right"
                onClick={submit}
                isLoading={session.sending}
                isDisabled={!draft.trim()}
              >
                Enviar
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlyoutFooter>
      )}
      {!ready && (
        <EuiFlyoutFooter>
          <EuiButtonEmpty size="s" onClick={session.close} flush="left">
            Cerrar
          </EuiButtonEmpty>
        </EuiFlyoutFooter>
      )}
    </EuiFlyout>
  );
}
