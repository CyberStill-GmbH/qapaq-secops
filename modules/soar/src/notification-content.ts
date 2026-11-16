/**
 * Contenido de los avisos QAPAQ: tarjeta adaptativa de Teams y correo HTML/texto, en español.
 *
 * Cada aviso responde, en este orden: qué pasó, por qué importa, evidencia, siguiente paso y un
 * botón PRIMARIO que abre la investigación de esa alerta en la consola. Los enlaces solo
 * navegan: abrir la consola exige sesión QAPAQ (el proxy lleva a `/qapaq/login?nextUrl=…` y vuelve a
 * la misma vista). El acuse no viaja como enlace con token (los escáneres de enlaces de Teams y
 * Outlook abren las URL y lo consumirían): «Acusar recibo» abre el aviso en la consola, donde la
 * sesión y el CSRF de QAPAQ registran el acuse con auditoría.
 *
 * Redacción: todo el texto sale de `NotificationContext`, ya enmascarado. Nunca crudo, tokens ni
 * IPs/correos completos.
 */

import {
  ENTITY_LABELS,
  type NotificationContext,
  type NotificationPriority,
} from './notification-context.js';
import type { NotificationRecipient } from './notification-routing.js';

export const NOTIFICATION_CONTENT_VERSION = '2.0.0' as const;

export const PRIORITY_STYLE: Readonly<
  Record<
    NotificationPriority,
    { readonly label: string; readonly color: string; readonly cardStyle: string }
  >
> = Object.freeze({
  P1: { label: 'Crítica', color: '#C62828', cardStyle: 'attention' },
  P2: { label: 'Alta', color: '#E8590C', cardStyle: 'warning' },
  P3: { label: 'Media', color: '#119CFF', cardStyle: 'accent' },
  P4: { label: 'Baja', color: '#546E7A', cardStyle: 'default' },
});

const BRAND = Object.freeze({ dark: '#080808', accent: '#C49A5A', muted: '#6B6B72' });

export interface NotificationLinks {
  readonly primary: { readonly title: string; readonly url: string };
  readonly incident: string | null;
  readonly playbook: string;
  readonly qapaqzito: string;
  /** Abre el aviso en la consola para registrar el acuse con sesión y CSRF. */
  readonly acknowledge: string | null;
}

function base(consoleBaseUrl: string): string {
  return consoleBaseUrl.replace(/\/+$/u, '');
}

/** Enlace profundo a la vista de investigación de una alerta (`qapaq_ops`). */
export function investigationLink(consoleBaseUrl: string, alertId: string): string {
  return `${base(consoleBaseUrl)}/app/qapaq-alerts?id=${encodeURIComponent(alertId)}&investigate=1`;
}

export function incidentLink(consoleBaseUrl: string, incidentId: string): string {
  return `${base(consoleBaseUrl)}/app/qapaq-incidents?id=${encodeURIComponent(incidentId)}`;
}

export function notificationLink(consoleBaseUrl: string, attemptId: string): string {
  return `${base(consoleBaseUrl)}/app/qapaq-notifications?id=${encodeURIComponent(attemptId)}`;
}

export function linksFor(
  consoleBaseUrl: string,
  context: Pick<NotificationContext, 'kind' | 'alertId' | 'incidentId'>,
  attemptId: string | null,
): NotificationLinks {
  const root = base(consoleBaseUrl);
  const incident = context.incidentId ? incidentLink(root, context.incidentId) : null;
  const primary =
    context.kind === 'alert' && context.alertId
      ? { title: 'Abrir investigación', url: investigationLink(root, context.alertId) }
      : incident
        ? { title: 'Abrir incidente', url: incident }
        : { title: 'Abrir cola de alertas', url: `${root}/app/qapaq-alerts` };
  return {
    primary,
    incident: context.kind === 'alert' ? incident : null,
    playbook: `${root}/app/ankay`,
    qapaqzito: `${primary.url}${primary.url.includes('?') ? '&' : '?'}qapaqzito=1`,
    acknowledge: attemptId ? notificationLink(root, attemptId) : null,
  };
}

/** «10/11/2026 04:09 (hora de Lima)»; ISO si la zona no existe. */
export function formatLocal(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    const text = new Intl.DateTimeFormat('es-PE', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
    const city = timeZone.split('/').pop()?.replace(/_/gu, ' ') ?? timeZone;
    return `${text} (hora de ${city})`;
  } catch {
    return date.toISOString();
  }
}

function clean(value: string | null | undefined, maximum: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export interface AlertNotificationInput {
  readonly context: NotificationContext;
  readonly links: NotificationLinks;
  readonly timeZone: string;
  /** Ocurrencias del grupo desde el último aviso (≥ 1). */
  readonly occurrences: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Re-aviso de un grupo que persiste. */
  readonly reminder: boolean;
  /** El evento ocurrió hace tiempo (atraso tras una caída). */
  readonly late: boolean;
  readonly mentions?: readonly NotificationRecipient[];
  /** Identificador del aviso, para la trazabilidad en la consola. */
  readonly attemptId: string;
}

/** Líneas comunes a tarjeta y correo, en orden de lectura. */
export function notificationSections(input: AlertNotificationInput): {
  readonly heading: string;
  readonly badges: readonly string[];
  readonly facts: readonly { readonly title: string; readonly value: string }[];
  readonly happened: string;
  readonly why: string | null;
  readonly correlation: readonly string[];
  readonly evidence: string;
  readonly nextStep: string;
} {
  const { context } = input;
  const priority = context.priority ?? (context.kind === 'incident' ? 'P1' : null);
  const style = priority ? PRIORITY_STYLE[priority] : null;
  const heading = `${priority ?? 'Aviso'}${style ? ` · ${style.label}` : ''} · ${
    context.kind === 'incident' ? 'Incidente' : 'Alerta'
  }`;
  const badges = [
    ...(context.test ? ['PRUEBA'] : []),
    ...(input.reminder ? ['Persiste'] : []),
    ...(input.late ? ['Aviso tardío'] : []),
    ...(context.correlation ? ['Correlacionada'] : []),
  ];
  const facts = [
    ...(context.source ? [{ title: 'Fuente', value: context.source.vendor }] : []),
    ...(context.entity
      ? [{ title: ENTITY_LABELS[context.entity.kind], value: context.entity.display }]
      : []),
    ...(context.ruleId ? [{ title: 'Regla', value: clean(context.ruleId, 80) }] : []),
    ...(context.score === null ? [] : [{ title: 'Puntaje', value: `${context.score}/100` }]),
    { title: 'Detectada', value: formatLocal(context.occurredAt, input.timeZone) },
  ];
  const mitre = context.mitre
    .slice(0, 3)
    .map((technique) => (technique.name ? `${technique.id} ${technique.name}` : technique.id))
    .join('; ');
  const whyParts = [
    context.whyItMatters ? clean(context.whyItMatters, 400) : null,
    mitre ? `MITRE ATT&CK: ${mitre}.` : null,
  ].filter((part): part is string => Boolean(part));
  const correlation = context.correlation
    ? [
        `Patrón ${clean(context.correlation.patternId, 80)}${
          context.correlation.narrative ? `: ${clean(context.correlation.narrative, 400)}` : ''
        }`,
        ...context.correlation.stages.slice(0, 6).map((stage) => clean(stage, 200)),
        ...(context.correlation.entities.length > 0
          ? [`Entidades: ${context.correlation.entities.slice(0, 6).join(', ')}`]
          : []),
      ]
    : [];
  const occurrences =
    input.occurrences > 1
      ? `${input.occurrences} ocurrencias desde ${formatLocal(input.firstSeen, input.timeZone)} hasta ${formatLocal(input.lastSeen, input.timeZone)}`
      : `1 ocurrencia (${formatLocal(input.lastSeen, input.timeZone)})`;
  const related =
    context.relatedAlertCount > 0
      ? ` · ${context.relatedAlertCount} alerta(s) relacionada(s) de la misma entidad`
      : '';
  const nextStep = context.nextStep
    ? `${clean(context.nextStep, 400)}${context.runbook ? ` (runbook: ${context.runbook.title})` : ''}`
    : context.runbook
      ? `Sigue el triage de 10 minutos del runbook «${context.runbook.title}».`
      : 'Abre la investigación, confirma si es legítimo con el responsable y registra el triaje en QAPAQ.';
  return {
    heading,
    badges,
    facts,
    happened: clean(context.summary, 400),
    why: whyParts.length > 0 ? whyParts.join(' ') : null,
    correlation,
    evidence: `${occurrences}${related}.`,
    nextStep,
  };
}

/** Texto de mención de Teams: el nombre visible, sin caracteres que rompan el marcado. */
function mentionText(recipient: NotificationRecipient): string {
  const name = recipient.displayName.replace(/[<>]/gu, '').trim() || recipient.upn;
  return `<at>${name}</at>`;
}

export interface TeamsCardMessage {
  readonly type: 'message';
  readonly attachments: readonly [
    {
      readonly contentType: 'application/vnd.microsoft.card.adaptive';
      readonly contentUrl: null;
      readonly content: Readonly<Record<string, unknown>>;
    },
  ];
  readonly qapaq: {
    readonly version: string;
    readonly clientRequestId: string;
    readonly aggregateId: string;
  };
}

function section(title: string, text: string, separator = true): Record<string, unknown> {
  return {
    type: 'Container',
    spacing: 'Medium',
    separator,
    items: [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Small', isSubtle: true, wrap: true },
      { type: 'TextBlock', text, wrap: true, spacing: 'Small' },
    ],
  };
}

function escapeMarkdown(text: string): string {
  // Teams interpreta Markdown en TextBlock: un título con `*` o `_` no debe cambiar el formato.
  return text.replace(/([\\*_`[\]~>#])/gu, '\\$1');
}

export function buildAlertCard(
  input: AlertNotificationInput & { readonly clientRequestId: string; readonly aggregateId: string },
): TeamsCardMessage {
  const parts = notificationSections(input);
  const { context, links } = input;
  const priority = context.priority ?? (context.kind === 'incident' ? 'P1' : 'P4');
  const style = PRIORITY_STYLE[priority];
  const mentions = input.mentions ?? [];
  const body: Record<string, unknown>[] = [
    {
      type: 'Container',
      style: style.cardStyle,
      bleed: true,
      items: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'stretch',
              items: [
                { type: 'TextBlock', text: 'QAPAQ SecOps', weight: 'Bolder', size: 'Small', isSubtle: true },
                {
                  type: 'TextBlock',
                  text: parts.heading,
                  weight: 'Bolder',
                  size: 'Medium',
                  spacing: 'None',
                  wrap: true,
                },
              ],
            },
            ...(parts.badges.length > 0
              ? [
                  {
                    type: 'Column',
                    width: 'auto',
                    verticalContentAlignment: 'Center',
                    items: [
                      {
                        type: 'TextBlock',
                        text: parts.badges.join(' · ').toUpperCase(),
                        weight: 'Bolder',
                        color: context.test ? 'Accent' : 'Attention',
                        wrap: true,
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      ],
    },
    {
      type: 'TextBlock',
      text: escapeMarkdown(clean(context.title, 300)),
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
      spacing: 'Medium',
    },
    { type: 'FactSet', facts: parts.facts.map((fact) => ({ title: fact.title, value: escapeMarkdown(fact.value) })) },
    section('Qué pasó', escapeMarkdown(parts.happened)),
    ...(parts.why ? [section('Por qué importa', escapeMarkdown(parts.why))] : []),
    ...(parts.correlation.length > 0
      ? [section('Correlación', parts.correlation.map((line) => `- ${escapeMarkdown(line)}`).join('\n'))]
      : []),
    section('Evidencia', escapeMarkdown(parts.evidence)),
    section('Siguiente paso recomendado', escapeMarkdown(parts.nextStep)),
    ...(mentions.length > 0
      ? [
          {
            type: 'TextBlock',
            wrap: true,
            spacing: 'Medium',
            text: `Para: ${mentions.map(mentionText).join(', ')}`,
          },
        ]
      : []),
    {
      type: 'TextBlock',
      text: `Aviso ${input.attemptId.slice(0, 8)} · Abrir la consola requiere sesión QAPAQ. Enviado no es reconocido: acusa recibo en QAPAQ.`,
      size: 'Small',
      isSubtle: true,
      wrap: true,
      spacing: 'Medium',
    },
  ];
  const actions: Record<string, unknown>[] = [
    { type: 'Action.OpenUrl', title: links.primary.title, url: links.primary.url, style: 'positive' },
    ...(links.incident ? [{ type: 'Action.OpenUrl', title: 'Ver incidente', url: links.incident }] : []),
    { type: 'Action.OpenUrl', title: 'Playbook en Ankay', url: links.playbook },
    { type: 'Action.OpenUrl', title: 'Preguntar a Qapaqzito', url: links.qapaqzito },
    ...(links.acknowledge
      ? [{ type: 'Action.OpenUrl', title: 'Acusar recibo', url: links.acknowledge }]
      : []),
  ];
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          msteams: {
            width: 'Full',
            ...(mentions.length > 0
              ? {
                  entities: mentions.map((recipient) => ({
                    type: 'mention',
                    text: mentionText(recipient),
                    mentioned: { id: recipient.upn, name: recipient.displayName },
                  })),
                }
              : {}),
          },
          body,
          actions,
        },
      },
    ],
    qapaq: {
      version: NOTIFICATION_CONTENT_VERSION,
      clientRequestId: input.clientRequestId,
      aggregateId: input.aggregateId,
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function button(url: string, label: string, primary: boolean): string {
  const colors = primary
    ? `background:${BRAND.accent};color:${BRAND.dark};border:1px solid ${BRAND.accent}`
    : `background:#ffffff;color:${BRAND.dark};border:1px solid #D1D5DB`;
  return `<a href="${escapeHtml(url)}" style="display:inline-block;${colors};padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
}

export function buildAlertEmail(input: AlertNotificationInput): RenderedEmail {
  const parts = notificationSections(input);
  const { context, links } = input;
  const priority = context.priority ?? (context.kind === 'incident' ? 'P1' : 'P4');
  const style = PRIORITY_STYLE[priority];
  const prefix = context.test ? '[PRUEBA] ' : '';
  const subject = `${prefix}QAPAQ SecOps · ${priority} ${style.label} · ${clean(context.title, 180)}`.slice(0, 255);
  const factRows = parts.facts
    .map(
      (fact) =>
        `<tr><td style="padding:4px 12px 4px 0;color:${BRAND.muted};white-space:nowrap;vertical-align:top">${escapeHtml(fact.title)}</td><td style="padding:4px 0">${escapeHtml(fact.value)}</td></tr>`,
    )
    .join('');
  const block = (title: string, inner: string) =>
    `<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:${BRAND.muted}">${escapeHtml(title)}</h3>${inner}`;
  const paragraph = (text: string) => `<p style="margin:0;line-height:1.5">${escapeHtml(text)}</p>`;
  const html = [
    '<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#F3F4F6">',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;color:${BRAND.dark};max-width:680px;margin:0 auto;padding:16px">`,
    `<div style="background:${BRAND.dark};color:#ffffff;padding:14px 20px;border-radius:8px 8px 0 0;border-top:4px solid ${BRAND.accent}">`,
    `<div style="font-size:12px;opacity:.75">QAPAQ SecOps</div>`,
    `<div style="font-size:18px;font-weight:700">${escapeHtml(parts.heading)}</div></div>`,
    `<div style="background:#ffffff;border:1px solid #E5E7EB;border-top:0;padding:20px;border-radius:0 0 8px 8px">`,
    `<div style="border-left:4px solid ${style.color};padding-left:12px;margin-bottom:12px">`,
    parts.badges.length > 0
      ? `<div style="font-size:12px;font-weight:700;color:${context.test ? '#8C6A38' : style.color}">${escapeHtml(parts.badges.join(' · ').toUpperCase())}</div>`
      : '',
    `<div style="font-size:18px;font-weight:700;line-height:1.35">${escapeHtml(clean(context.title, 300))}</div></div>`,
    `<table style="border-collapse:collapse;font-size:14px">${factRows}</table>`,
    block('Qué pasó', paragraph(parts.happened)),
    parts.why ? block('Por qué importa', paragraph(parts.why)) : '',
    parts.correlation.length > 0
      ? block(
          'Correlación',
          `<ul style="margin:0;padding-left:18px">${parts.correlation.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
        )
      : '',
    block('Evidencia', paragraph(parts.evidence)),
    block('Siguiente paso recomendado', paragraph(parts.nextStep)),
    '<div style="margin-top:20px">',
    button(links.primary.url, links.primary.title, true),
    links.incident ? button(links.incident, 'Ver incidente', false) : '',
    button(links.playbook, 'Playbook en Ankay', false),
    button(links.qapaqzito, 'Preguntar a Qapaqzito', false),
    links.acknowledge ? button(links.acknowledge, 'Acusar recibo', false) : '',
    '</div>',
    `<p style="margin-top:16px;font-size:12px;color:${BRAND.muted}">Aviso ${escapeHtml(input.attemptId.slice(0, 8))}. Los enlaces abren la consola QAPAQ y requieren iniciar sesión. Enviado no es reconocido: el acuse se registra en QAPAQ. Mensaje automático; no respondas a este correo.</p>`,
    '</div></div></body></html>',
  ].join('');
  const text = [
    `QAPAQ SecOps · ${parts.heading}${parts.badges.length > 0 ? ` [${parts.badges.join(', ')}]` : ''}`,
    clean(context.title, 300),
    '',
    ...parts.facts.map((fact) => `${fact.title}: ${fact.value}`),
    '',
    `Qué pasó: ${parts.happened}`,
    ...(parts.why ? [`Por qué importa: ${parts.why}`] : []),
    ...(parts.correlation.length > 0 ? ['Correlación:', ...parts.correlation.map((line) => `  - ${line}`)] : []),
    `Evidencia: ${parts.evidence}`,
    `Siguiente paso: ${parts.nextStep}`,
    '',
    `${links.primary.title}: ${links.primary.url}`,
    ...(links.incident ? [`Ver incidente: ${links.incident}`] : []),
    `Playbook en Ankay: ${links.playbook}`,
    `Preguntar a Qapaqzito: ${links.qapaqzito}`,
    ...(links.acknowledge ? [`Acusar recibo: ${links.acknowledge}`] : []),
    '',
    `Aviso ${input.attemptId.slice(0, 8)}. Los enlaces requieren sesión QAPAQ. Mensaje automático.`,
  ].join('\n');
  return { subject, html, text };
}

/* ------------------------------------------------------------------ Resumen (digest) */

export interface DigestLine {
  readonly title: string;
  readonly priority: NotificationPriority | null;
  readonly source: string | null;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Enlace a la investigación de la ocurrencia más reciente. */
  readonly url: string;
  readonly reason: string;
}

export interface DigestInput {
  readonly digestId: string;
  readonly kind: 'suppressed' | 'low_priority' | 'ai_analyst';
  readonly from: string;
  readonly to: string;
  readonly lines: readonly DigestLine[];
  /** Total de alertas resumidas (puede superar lo listado). */
  readonly total: number;
  readonly consoleBaseUrl: string;
  readonly timeZone: string;
}

export const DIGEST_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  grouped: 'agrupadas en un aviso previo',
  stale_backlog: 'atrasadas (procesadas tras una interrupción)',
  rate_limited: 'por encima del tope de avisos por hora',
  digest: 'prioridad P3/P4 o revisión diferida del Analista IA',
});

function digestHeading(input: DigestInput): string {
  if (input.kind === 'ai_analyst') {
    return `Analista IA · resumen diario · ${input.total} caso(s) por revisar`;
  }
  return input.kind === 'low_priority'
    ? `Resumen P3/P4 · ${input.total} alerta(s)`
    : `Resumen de alertas agrupadas · ${input.total} ocurrencia(s)`;
}

export function buildDigestCard(input: DigestInput, clientRequestId: string): TeamsCardMessage {
  const root = base(input.consoleBaseUrl);
  const lines = input.lines.slice(0, 10);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          msteams: { width: 'Full' },
          body: [
            {
              type: 'Container',
              style: 'emphasis',
              bleed: true,
              items: [
                { type: 'TextBlock', text: 'QAPAQ SecOps', weight: 'Bolder', size: 'Small', isSubtle: true },
                { type: 'TextBlock', text: digestHeading(input), weight: 'Bolder', size: 'Medium', wrap: true, spacing: 'None' },
                {
                  type: 'TextBlock',
                  text: `Del ${formatLocal(input.from, input.timeZone)} al ${formatLocal(input.to, input.timeZone)}. No generaron aviso inmediato para no inundar el canal.`,
                  wrap: true,
                  size: 'Small',
                },
              ],
            },
            ...lines.map((line) => ({
              type: 'Container',
              separator: true,
              selectAction: { type: 'Action.OpenUrl', url: line.url },
              items: [
                {
                  type: 'TextBlock',
                  text: `${line.priority ?? ''} · ${escapeMarkdown(clean(line.title, 160))}`,
                  weight: 'Bolder',
                  wrap: true,
                },
                {
                  type: 'TextBlock',
                  text: escapeMarkdown(
                    `${line.count} ocurrencia(s)${line.source ? ` · ${line.source}` : ''} · última ${formatLocal(line.lastSeen, input.timeZone)} · ${line.reason}`,
                  ),
                  isSubtle: true,
                  size: 'Small',
                  wrap: true,
                  spacing: 'None',
                },
              ],
            })),
            ...(input.lines.length > lines.length
              ? [{ type: 'TextBlock', text: `… y ${input.lines.length - lines.length} grupo(s) más en la consola.`, wrap: true, isSubtle: true }]
              : []),
          ],
          actions: [
            { type: 'Action.OpenUrl', title: 'Abrir cola de alertas', url: `${root}/app/qapaq-alerts`, style: 'positive' },
            { type: 'Action.OpenUrl', title: 'Ver notificaciones', url: `${root}/app/qapaq-notifications` },
          ],
        },
      },
    ],
    qapaq: { version: NOTIFICATION_CONTENT_VERSION, clientRequestId, aggregateId: input.digestId },
  };
}

export function buildDigestEmail(input: DigestInput): RenderedEmail {
  const root = base(input.consoleBaseUrl);
  const heading = digestHeading(input);
  const rows = input.lines
    .slice(0, 25)
    .map(
      (line) =>
        `<tr><td style="padding:6px 8px;border-top:1px solid #E5E7EB;white-space:nowrap;font-weight:700;color:${line.priority ? PRIORITY_STYLE[line.priority].color : BRAND.dark}">${escapeHtml(line.priority ?? '')}</td><td style="padding:6px 8px;border-top:1px solid #E5E7EB"><a href="${escapeHtml(line.url)}" style="color:${BRAND.dark}">${escapeHtml(clean(line.title, 160))}</a><div style="font-size:12px;color:${BRAND.muted}">${escapeHtml(`${line.source ?? ''} · ${line.reason}`)}</div></td><td style="padding:6px 8px;border-top:1px solid #E5E7EB;text-align:right">${line.count}</td><td style="padding:6px 8px;border-top:1px solid #E5E7EB;white-space:nowrap">${escapeHtml(formatLocal(line.lastSeen, input.timeZone))}</td></tr>`,
    )
    .join('');
  const html = [
    '<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#F3F4F6">',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;color:${BRAND.dark};max-width:760px;margin:0 auto;padding:16px">`,
    `<div style="background:${BRAND.dark};color:#ffffff;padding:14px 20px;border-radius:8px 8px 0 0;border-top:4px solid ${BRAND.accent}"><div style="font-size:12px;opacity:.75">QAPAQ SecOps</div><div style="font-size:18px;font-weight:700">${escapeHtml(heading)}</div></div>`,
    `<div style="background:#ffffff;border:1px solid #E5E7EB;border-top:0;padding:20px;border-radius:0 0 8px 8px">`,
    `<p style="margin-top:0">Del ${escapeHtml(formatLocal(input.from, input.timeZone))} al ${escapeHtml(formatLocal(input.to, input.timeZone))}. Estas alertas no generaron aviso inmediato para no inundar el canal.</p>`,
    `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="text-align:left;color:${BRAND.muted};font-size:12px"><th style="padding:6px 8px">Prioridad</th><th style="padding:6px 8px">Alerta</th><th style="padding:6px 8px;text-align:right">Veces</th><th style="padding:6px 8px">Última</th></tr>${rows}</table>`,
    `<div style="margin-top:20px">${button(`${root}/app/qapaq-alerts`, 'Abrir cola de alertas', true)}${button(`${root}/app/qapaq-notifications`, 'Ver notificaciones', false)}</div>`,
    `<p style="font-size:12px;color:${BRAND.muted}">Resumen ${escapeHtml(input.digestId.slice(0, 8))}. Los enlaces requieren sesión QAPAQ. Mensaje automático.</p>`,
    '</div></div></body></html>',
  ].join('');
  const text = [
    `QAPAQ SecOps · ${heading}`,
    `Del ${formatLocal(input.from, input.timeZone)} al ${formatLocal(input.to, input.timeZone)}.`,
    '',
    ...input.lines
      .slice(0, 25)
      .map(
        (line) =>
          `- ${line.priority ?? ''} ${clean(line.title, 160)} · ${line.count} vez/veces · ${line.reason} · ${line.url}`,
      ),
    '',
    `Abrir cola de alertas: ${root}/app/qapaq-alerts`,
  ].join('\n');
  return { subject: `QAPAQ SecOps · ${heading}`.slice(0, 255), html, text };
}
