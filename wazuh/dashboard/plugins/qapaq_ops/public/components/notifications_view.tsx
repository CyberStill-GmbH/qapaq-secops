/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiLoadingContent,
  EuiSpacer,
  EuiSwitch,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import {
  ACKNOWLEDGEABLE,
  Alert,
  ALERT_STATUS_LABEL,
  alertQuestion,
  CAPABILITIES,
  NOTIFICATION_CHANNEL_LABEL,
  NotificationAttempt,
  Page,
} from '../../common';
import { QapaqApiError } from '../api/client';
import { fetchSource } from '../api/investigation';
import { askQapaqzito } from '../qapaqzito_bridge';
import { QapaqPage, useChanges, useConsole } from './console_context';
import { alertInvestigationHref } from './investigation_links';
import {
  DataZone,
  EmptyLine,
  ErrorCallout,
  HealthMark,
  Mono,
  PriorityMark,
  Timestamp,
  useAsync,
  useIsMobile,
} from './primitives';
import { VendorLogo } from './vendor_logo';
import { ChannelsPanel } from './channels_panel';
import {
  DELIVERY,
  deliveryLines,
  describeGroup,
  groupNotifications,
  latestByChannel,
  NotificationGroup,
} from './notification_groups';

/**
 * Bandeja de notificaciones (doc 04 §6). Agrupa los avisos de la misma alerta o incidente,
 * muestra de qué alerta se trata (título, prioridad, origen, entidad enmascarada y regla) y el
 * estado de entrega por canal e intento: Enviado (aceptado por M365) / Entregado / Fallido /
 * Reconocido. Entregado no es lo mismo que reconocido por una persona.
 */

export function NotificationsView() {
  const { can } = useConsole();
  if (!can(CAPABILITIES.notificationsRead)) {
    return (
      <QapaqPage title="Notificaciones">
        <EmptyLine>Tu rol no incluye la bandeja de notificaciones.</EmptyLine>
      </QapaqPage>
    );
  }
  return <NotificationsContent />;
}

function NotificationsContent() {
  const { api, notifications, basePath } = useConsole();
  const [onlyPending, setOnlyPending] = useState(true);
  const [items, setItems] = useState<readonly NotificationAttempt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Record<string, Alert | null>>({});
  const [tab, setTab] = useState<'inbox' | 'channels'>('inbox');
  // La pestaña permanece visible aunque la API falle: ocultarla hacía parecer que
  // la configuración de Teams no existía. ChannelsPanel presenta el error real.
  const showChannels = true;
  const page = useAsync(
    () => api.get<Page<NotificationAttempt>>('/notifications', { pageSize: 100 }),
    [api],
  );

  useEffect(() => {
    if (page.data) {
      setItems(page.data.items);
      setCursor(page.data.nextCursor);
    }
  }, [page.data]);

  useChanges(['notification'], () => page.reload());

  const groups = useMemo(() => groupNotifications(items), [items]);
  const visible = onlyPending
    ? groups.filter((group) => group.items.some((item) => ACKNOWLEDGEABLE.includes(item.status)))
    : groups;
  const visibleKey = visible.map((group) => group.key).join('|');

  // Título y prioridad de la alerta cuando la API solo trae su id (máx. 50 por carga).
  useEffect(() => {
    const missing = visible
      .filter((group) => group.alertId && !(group.alertId in alerts))
      .slice(0, 50)
      .map((group) => group.alertId as string);
    if (missing.length === 0) return undefined;
    let alive = true;
    Promise.all(
      missing.map((id) =>
        api
          .get<{ alert: Alert }>(`/alerts/${encodeURIComponent(id)}`)
          .then((r): [string, Alert | null] => [id, r.alert])
          .catch((): [string, Alert | null] => [id, null]),
      ),
    ).then((pairs) => {
      if (!alive) return;
      setAlerts((current) => {
        const next = { ...current };
        for (const [id, alert] of pairs) next[id] = alert;
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [api, visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.get<Page<NotificationAttempt>>('/notifications', {
      pageSize: 100,
      cursor,
    });
    setItems((current) => [...current, ...next.items]);
    setCursor(next.nextCursor);
  };

  const acknowledge = async (attempt: NotificationAttempt) => {
    setBusy(attempt.id);
    setError(null);
    try {
      const result = await api.post<{ status: NotificationAttempt['status'] }>(
        `/notifications/${encodeURIComponent(attempt.id)}/acknowledge`,
      );
      setItems((current) =>
        current.map((item) =>
          item.id === attempt.id
            ? { ...item, status: result.status, acknowledgedAt: new Date().toISOString() }
            : item,
        ),
      );
      notifications.toasts.addSuccess({ title: 'Acuse registrado' });
    } catch (failure) {
      setError(failure);
      if (failure instanceof QapaqApiError && failure.code === 'STATE_CONFLICT') page.reload();
    } finally {
      setBusy(null);
    }
  };

  const selected = groups.find((group) => group.key === open) ?? null;

  return (
    <QapaqPage
      title="Notificaciones"
      description="Avisos por Teams, correo o consola, agrupados por alerta, incidente o mensaje. La aceptación del canal no confirma la lectura; el acuse lo registra una persona en QAPAQ."
      actions={
        showChannels && tab === 'channels' ? undefined : (
          <EuiSwitch
            compressed
            label="Solo requieren acuse"
            checked={onlyPending}
            onChange={(event) => setOnlyPending(event.target.checked)}
          />
        )
      }
    >
      {showChannels && (
        <EuiTabs size="s" className="qapaqTabs">
          <EuiTab isSelected={tab === 'inbox'} onClick={() => setTab('inbox')}>
            Bandeja
          </EuiTab>
          <EuiTab isSelected={tab === 'channels'} onClick={() => setTab('channels')}>
            Canales
          </EuiTab>
        </EuiTabs>
      )}
      <EuiSpacer size="m" />
      {showChannels && tab === 'channels' ? (
        <ChannelsPanel />
      ) : (
        <>
          <EuiCallOut
            size="s"
            color="primary"
            iconType="iInCircle"
            title="Tiempos y estado de los avisos"
          >
            <p>
              P1 genera un intento inmediato; P2 recientes también. Las P2 procesadas con más de una
              hora de atraso y los avisos agrupados aparecen en resúmenes; P3 y P4 se consolidan
              cada seis horas. Revisa «Canales» para confirmar la configuración y «Salud de fuentes»
              para ver la última actividad recibida.
            </p>
          </EuiCallOut>
          <EuiSpacer size="m" />
          {error != null && (
            <>
              <ErrorCallout error={error} />
              <EuiSpacer size="m" />
            </>
          )}
          {page.error != null ? (
            <ErrorCallout error={page.error} onRetry={page.reload} />
          ) : page.loading && items.length === 0 ? (
            <EuiLoadingContent lines={6} />
          ) : visible.length === 0 ? (
            <EmptyLine>
              {onlyPending
                ? 'No hay notificaciones pendientes de acuse.'
                : 'Todavía no se ha enviado ninguna notificación.'}
            </EmptyLine>
          ) : (
            <DataZone>
              <ul className="qapaqNotifList" aria-label="Notificaciones agrupadas por alerta">
                {visible.map((group) => {
                  const info = describeGroup(group, group.alertId ? alerts[group.alertId] : null);
                  const pending = group.items.some((item) => ACKNOWLEDGEABLE.includes(item.status));
                  return (
                    <li key={group.key}>
                      <button
                        type="button"
                        className={`qapaqNotif${pending ? ' qapaqNotif--pending' : ''}`}
                        onClick={() => setOpen(group.key)}
                        aria-haspopup="dialog"
                      >
                        <span className="qapaqNotif__lead">
                          <VendorLogo id={info.vendor} basePath={basePath} size="m" />
                          {info.priority && <PriorityMark priority={info.priority} />}
                        </span>
                        <span className="qapaqNotif__body">
                          <span className="qapaqNotif__title">
                            {info.title ??
                              (group.alertId
                                ? 'Cargando la alerta…'
                                : `Aviso ${(group.latest.messageId ?? group.latest.id).slice(0, 12)}`)}
                            {group.items.length > 1 && (
                              <EuiBadge color="hollow" className="qapaqNotif__count">
                                ×{group.items.length}
                              </EuiBadge>
                            )}
                          </span>
                          <span className="qapaqCellMeta">
                            {[
                              info.summary,
                              info.entity,
                              info.ruleId ? `regla ${info.ruleId}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') ||
                              'Aviso recibido; abre el detalle para revisar el contexto disponible.'}
                          </span>
                          <span className="qapaqNotif__deliveries">
                            {latestByChannel(group.items).map((line) => (
                              <span key={line.channel} className="qapaqNotif__delivery">
                                <span className="qapaqMuted">
                                  {NOTIFICATION_CHANNEL_LABEL[line.channel] ?? line.channel}:
                                </span>{' '}
                                <HealthMark
                                  tone={DELIVERY[line.kind].tone}
                                  label={DELIVERY[line.kind].label}
                                />
                              </span>
                            ))}
                          </span>
                        </span>
                        <span className="qapaqNotif__time">
                          <Timestamp
                            iso={
                              group.latest.acknowledgedAt ??
                              group.latest.sentAt ??
                              group.latest.createdAt ??
                              null
                            }
                          />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {cursor && (
                <>
                  <EuiSpacer size="s" />
                  <EuiButtonEmpty size="s" onClick={loadMore}>
                    Cargar más
                  </EuiButtonEmpty>
                </>
              )}
            </DataZone>
          )}
        </>
      )}
      {selected && (
        <NotificationFlyout
          group={selected}
          alert={selected.alertId ? alerts[selected.alertId] : null}
          busy={busy}
          onAcknowledge={acknowledge}
          onClose={() => setOpen(null)}
        />
      )}
    </QapaqPage>
  );
}

function NotificationFlyout({
  group,
  alert,
  busy,
  onAcknowledge,
  onClose,
}: {
  group: NotificationGroup;
  alert: Alert | null | undefined;
  busy: string | null;
  onAcknowledge: (attempt: NotificationAttempt) => void;
  onClose: () => void;
}) {
  const { basePath, notifications } = useConsole();
  const mobile = useIsMobile();
  const info = describeGroup(group, alert);
  const source = useAsync(
    () =>
      alert
        ? fetchSource(basePath, {
            ruleId: info.ruleId,
            at: alert.occurredAt,
            description: alert.title.replace(/\s*\(wazuh \d+\)\s*$/u, ''),
          })
        : Promise.resolve(null),
    [basePath, alert?.id],
  );
  const mitre = source.data?.event?.mitre;
  const incidentId = group.incidentId ?? alert?.incidentId ?? null;
  const acknowledgeable = group.items.filter((item) => ACKNOWLEDGEABLE.includes(item.status));
  const acknowledged = group.items.filter((item) => item.acknowledgedAt);
  const lines = group.items
    .flatMap((item) => deliveryLines(item))
    .sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? 1 : -1));

  return (
    <EuiFlyout
      onClose={onClose}
      size={mobile ? 'l' : 'm'}
      ownFocus
      className="qapaqFlyout"
      aria-labelledby="qapaqNotifTitle"
    >
      <EuiFlyoutHeader hasBorder>
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <VendorLogo id={info.vendor} basePath={basePath} size="m" />
          </EuiFlexItem>
          {info.priority && (
            <EuiFlexItem grow={false}>
              <PriorityMark priority={info.priority} />
            </EuiFlexItem>
          )}
        </EuiFlexGroup>
        <EuiSpacer size="s" />
        <EuiTitle size="s">
          <h2 id="qapaqNotifTitle" data-qapaq-no-translate="">
            {info.title ?? 'Aviso sin alerta vinculada'}
          </h2>
        </EuiTitle>
        <EuiText size="xs" color="subdued">
          <p>
            {group.items.length} {group.items.length === 1 ? 'aviso' : 'avisos agrupados'}
            {info.source ? ` · ${info.source}` : ''}
            {info.entity ? ` · ${info.entity}` : ''}
            {info.ruleId ? ` · regla ${info.ruleId}` : ''}
          </p>
        </EuiText>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        <DataZone>
          <EuiTitle size="xxs">
            <h3>{group.incidentId ? 'Contexto del aviso' : 'Resumen de la alerta'}</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          {(info.summary || info.whyItMatters || info.nextStep || info.occurredAt) && (
            <dl className="qapaqKeyValues">
              {info.summary && (
                <>
                  <dt>Qué ocurrió</dt>
                  <dd>{info.summary}</dd>
                </>
              )}
              {info.whyItMatters && (
                <>
                  <dt>Por qué importa</dt>
                  <dd>{info.whyItMatters}</dd>
                </>
              )}
              {info.nextStep && (
                <>
                  <dt>Siguiente paso</dt>
                  <dd>{info.nextStep}</dd>
                </>
              )}
              {info.occurredAt && (
                <>
                  <dt>Ocurrió</dt>
                  <dd>
                    <Timestamp iso={info.occurredAt} />
                  </dd>
                </>
              )}
            </dl>
          )}
          {!group.alertId && group.latest.kind === 'digest' ? (
            <EuiCallOut size="s" color="primary" title="Resumen de varias alertas">
              <p>
                Este aviso agrupa alertas que no se enviaron una por una (baja prioridad, atraso
                tras una caída o ráfagas de la misma regla). No corresponde a una sola alerta: la
                revisión se hace en la cola, ordenada por prioridad.
              </p>
              <EuiButton size="s" href={`${basePath}/app/qapaq-alerts`}>
                Abrir la cola de alertas
              </EuiButton>
            </EuiCallOut>
          ) : !group.alertId ? (
            <>
              <EuiCallOut
                size="s"
                color={group.incidentId ? 'primary' : 'warning'}
                title={group.incidentId ? 'Aviso ligado a un incidente' : 'Alerta no vinculada'}
              >
                {group.incidentId ? (
                  <p>
                    El aviso pertenece al incidente <Mono>{group.incidentId}</Mono>. No tiene un
                    alertId individual para abrir una ficha de alerta.
                  </p>
                ) : (
                  <p>
                    El API no incluyó alertId en este aviso, por lo que no se puede abrir una ficha
                    ni iniciar una investigación desde aquí. Se muestra el contexto que sí entregó
                    el aviso; el identificador lógico es{' '}
                    <Mono>{group.latest.messageId ?? group.latest.id}</Mono>.
                  </p>
                )}
              </EuiCallOut>
              {!group.incidentId && !info.summary && (
                <EmptyLine>
                  El aviso no incluye título ni resumen. Consulta Canales y los registros de
                  notificaciones para rastrear el intento.
                </EmptyLine>
              )}
            </>
          ) : alert === undefined ? (
            <EuiLoadingContent lines={2} />
          ) : alert === null ? (
            <EmptyLine>No se pudo leer la alerta (sin permiso o ya no existe).</EmptyLine>
          ) : (
            <dl className="qapaqKeyValues">
              <dt>Estado</dt>
              <dd>{ALERT_STATUS_LABEL[alert.status]}</dd>
              <dt>Ocurrió</dt>
              <dd>
                <Timestamp iso={alert.occurredAt} />
              </dd>
              <dt>Puntuación</dt>
              <dd className="qapaqTabular">{alert.score}</dd>
              {incidentId && (
                <>
                  <dt>Incidente</dt>
                  <dd>
                    <Mono>{incidentId}</Mono>
                  </dd>
                </>
              )}
            </dl>
          )}
          {alert && (
            <>
              <EuiSpacer size="l" />
              <EuiTitle size="xxs">
                <h3>Por qué importa</h3>
              </EuiTitle>
              <EuiSpacer size="s" />
              {mitre && mitre.ids.length > 0 && (
                <p className="qapaqChips">
                  {mitre.ids.map((id, index) => (
                    <span key={id} className="qapaqMitre">
                      {id}
                      {mitre.techniques[index] ? ` · ${mitre.techniques[index]}` : ''}
                    </span>
                  ))}
                </p>
              )}
              {alert.reasons.length === 0 ? (
                <EmptyLine>El motor de priorización no registró motivos.</EmptyLine>
              ) : (
                <ul className="qapaqList">
                  {alert.reasons.map((reason) => (
                    <li key={reason.code}>
                      <Mono>{reason.code}</Mono> {reason.detail}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <EuiSpacer size="l" />
          <EuiTitle size="xxs">
            <h3>Entrega por canal e intento</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <ol className="qapaqDeliveryList">
            {lines.map((line) => (
              <li key={line.key} className="qapaqDeliveryList__item">
                <span className="qapaqDeliveryList__channel">
                  {NOTIFICATION_CHANNEL_LABEL[line.channel] ?? line.channel}
                </span>
                <HealthMark tone={DELIVERY[line.kind].tone} label={DELIVERY[line.kind].label} />
                <span className="qapaqCellMeta">
                  {line.attempt !== null ? `Intento ${line.attempt} · ` : null}
                  <Timestamp iso={line.at} />
                  {line.kind === 'acknowledged' && line.actor ? (
                    <>
                      {' '}
                      · por <Mono>{line.actor.slice(0, 24)}</Mono>
                    </>
                  ) : null}
                  {line.reason ? ` · ${line.reason}` : ''}
                </span>
                {line.link && (
                  <a href={line.link} target="_blank" rel="noopener noreferrer">
                    Ver en Teams
                  </a>
                )}
              </li>
            ))}
          </ol>
          <EuiSpacer size="l" />
          <EuiTitle size="xxs">
            <h3>Acuse humano</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          {acknowledged.length > 0 ? (
            <ul className="qapaqList">
              {acknowledged.map((item) => (
                <li key={item.id}>
                  Acuse registrado <Timestamp iso={item.acknowledgedAt} />
                  {item.acknowledgedBy ? (
                    <>
                      {' '}
                      por <Mono>{item.acknowledgedBy.slice(0, 24)}</Mono>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyLine>
              Sin acuse humano. La aceptación del canal no confirma que el equipo SOC haya visto el
              aviso.
            </EmptyLine>
          )}
        </DataZone>
      </EuiFlyoutBody>
      <EuiFlyoutFooter>
        <EuiFlexGroup gutterSize="s" justifyContent="flexEnd" wrap responsive={false}>
          {acknowledgeable.length > 0 && (
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                size="s"
                iconType="check"
                isLoading={busy === acknowledgeable[0].id}
                onClick={() => onAcknowledge(acknowledgeable[0])}
              >
                Acusar recibo del último intento
              </EuiButton>
            </EuiFlexItem>
          )}
          {incidentId && (
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                href={`${basePath}/app/qapaq-incidents?id=${encodeURIComponent(incidentId)}`}
              >
                Ver incidente
              </EuiButtonEmpty>
            </EuiFlexItem>
          )}
          {alert && (
            <EuiFlexItem grow={false}>
              <EuiButton
                iconType="discuss"
                onClick={() => {
                  const opened = askQapaqzito({
                    prompt: alertQuestion({
                      id: alert.id,
                      title: alert.title,
                      priority: alert.priority,
                      occurredAt: alert.occurredAt,
                      ruleId: info.ruleId,
                      mitre: mitre?.ids,
                    }),
                    context: { alertId: alert.id },
                  });
                  if (!opened)
                    notifications.toasts.addWarning({ title: 'Qapaqzito no está disponible' });
                }}
              >
                Preguntar a Qapaqzito
              </EuiButton>
            </EuiFlexItem>
          )}
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              iconType="inspect"
              isDisabled={!group.alertId}
              href={group.alertId ? alertInvestigationHref(basePath, group.alertId) : undefined}
            >
              Abrir en investigación
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutFooter>
    </EuiFlyout>
  );
}
