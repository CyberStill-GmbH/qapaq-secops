/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Puente «Preguntar a Qapaqzito»: cualquier vista abre el panel de Qapaqzito con una pregunta ya escrita.
 *
 * Contrato (evento DOM, sin acoplar las vistas al panel):
 *   window.dispatchEvent(new CustomEvent(QAPAQZITO_ASK_EVENT, { detail, cancelable: true }))
 * El panel, si lo implementa, escucha el evento, abre el panel, rellena el borrador con
 * `detail.prompt` (sin enviarlo) y llama a `event.preventDefault()` para indicar que lo atendió.
 * Si nadie lo atiende, `public/qapaqzito_bridge.ts` abre el panel con su botón y escribe el
 * borrador en el cuadro de texto (la persona revisa y envía).
 */
export const QAPAQZITO_ASK_EVENT = 'qapaq:qapaqzito:ask';

export interface QapaqzitoAskDetail {
  /** Texto propuesto para el borrador; la persona lo revisa antes de enviarlo. */
  readonly prompt: string;
  /**
   * Contexto estructurado opcional. El panel usa `alertId` o `incidentId` como página de contexto
   * de la pregunta (Qapaqzito la ve como «Página actual: /app/qapaq-alerts?id=…»).
   */
  readonly context?: Readonly<Record<string, string>>;
  /** `true` envía la pregunta directamente; por defecto queda como borrador para revisarla. */
  readonly autoSend?: boolean;
}

/** Pregunta inicial sobre una alerta: lo justo para que Qapaqzito busque el resto con sus herramientas. */
export function alertQuestion(alert: {
  id: string;
  title: string;
  priority: string;
  occurredAt: string;
  ruleId?: string | null;
  entities?: ReadonlyArray<{ kind: string; value: string }>;
  mitre?: readonly string[];
}): string {
  const lines = [
    `Ayúdame a investigar esta alerta: «${alert.title}» (${alert.priority}, ${alert.occurredAt}, id ${alert.id}).`,
  ];
  if (alert.ruleId) lines.push(`Regla de Wazuh: ${alert.ruleId}.`);
  if (alert.mitre && alert.mitre.length > 0) lines.push(`MITRE ATT&CK: ${alert.mitre.join(', ')}.`);
  if (alert.entities && alert.entities.length > 0) {
    lines.push(
      `Entidades: ${alert.entities
        .slice(0, 6)
        .map((entity) => `${entity.kind} ${entity.value}`)
        .join('; ')}.`,
    );
  }
  lines.push('¿Qué significa, qué tan grave es, qué más reviso y qué acción recomiendas?');
  return lines.join('\n');
}

export type QapaqzitoReportFormat = 'pdf' | 'xlsx' | 'csv';

export const QAPAQZITO_REPORT_FORMAT_LABEL: Readonly<Record<QapaqzitoReportFormat, string>> = {
  pdf: 'PDF',
  xlsx: 'Excel',
  csv: 'CSV',
};

const QAPAQZITO_REPORT_WINDOW_TEXT: Readonly<Record<string, string>> = {
  '1h': '±1 hora (ventana 1h)',
  '24h': '±24 horas (ventana 24h)',
  '7d': '±7 días (ventana 7d)',
};

/**
 * Pregunta que pide a Qapaqzito el informe profesional de una investigación (herramienta
 * `generate_report`). Sin alerta (investigación por entidad) se describe el sujeto con `subject`.
 */
export function qapaqzitoReportPrompt(options: {
  readonly format: QapaqzitoReportFormat;
  readonly window: string;
  readonly alertId?: string | null;
  readonly subject?: string;
}): string {
  const format = QAPAQZITO_REPORT_FORMAT_LABEL[options.format];
  const windowText = QAPAQZITO_REPORT_WINDOW_TEXT[options.window] ?? `±${options.window}`;
  const target = options.alertId
    ? `la alerta ${options.alertId}`
    : options.subject
      ? `${options.subject}`
      : 'la entidad investigada';
  return `Genera un informe ${format} profesional de la investigación de ${target} con eventos relacionados ${windowText}.`;
}
