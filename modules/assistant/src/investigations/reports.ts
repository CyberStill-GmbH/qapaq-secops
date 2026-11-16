/**
 * Analista IA — informes deterministas (cero tokens de modelo).
 *
 * Se arman solo con el expediente validado, la bitácora, el libro de invocaciones y el de
 * acciones: nunca con la respuesta cruda del modelo ni con evidencia cruda. Todo texto de
 * terceros (títulos, resumen) se neutraliza contra inyección de Markdown y de fórmulas. Los
 * importes son estimaciones con tarifa versionada, no facturación.
 */

import type { InvestigationAction } from './actions.js';
import type {
  CitedStatement,
  InvestigationEvent,
  InvestigationEvidenceSummary,
  InvestigationInvocation,
  InvestigationJob,
  InvestigationPriority,
} from './types.js';

/** Texto de terceros seguro para Markdown y para celdas de hoja de cálculo. */
export function escapeReportText(value: string, max = 400): string {
  const flat = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  const escaped = cut.replace(/[\\`*_[\](){}<>|#~!]/gu, (char) => `\\${char}`);
  // Una celda que empieza con = + - @ se interpreta como fórmula al exportar.
  return /^[=+\-@]/u.test(escaped) ? `'${escaped}` : escaped;
}

const code = (value: string): string => `\`${value.replace(/[`\p{Cc}]/gu, '').slice(0, 128)}\``;
const iso = (at: Date | null): string => (at ? at.toISOString() : '—');

/** Micro-USD estimados como texto; siempre con la palabra «estimado». */
export function formatEstimatedUsd(microUsd: number): string {
  return `USD ${(microUsd / 1_000_000).toFixed(4)} (estimado)`;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: 'En cola',
  running: 'En curso',
  completed: 'Completo',
  requires_review: 'Requiere revisión',
  partial: 'Evidencia parcial',
  budget_exhausted: 'Presupuesto agotado',
  usage_unreconciled: 'Uso por conciliar',
  cancelled: 'Cancelado',
  failed: 'Fallido',
};
const VERDICT_LABEL: Readonly<Record<string, string>> = {
  likely_true_positive: 'Probable verdadero positivo',
  likely_false_positive: 'Probable falso positivo',
  inconclusive: 'No concluyente',
};
const ACTION_LABEL: Readonly<Record<string, string>> = {
  escalate: 'Escalar',
  close_benign: 'Cerrar como benigno conocido',
  acknowledge: 'Acusar recibo',
  report: 'Adjuntar informe',
  request_review: 'Pedir revisión humana',
};

function statements(title: string, entries: readonly CitedStatement[]): string[] {
  if (entries.length === 0) return [`### ${title}`, '', '_Ninguno._', ''];
  return [
    `### ${title}`,
    '',
    ...entries.map(
      (entry) =>
        `- ${escapeReportText(entry.text)}${
          entry.citations.length > 0
            ? ` — citas: ${entry.citations.map(code).join(', ')}`
            : ' — **sin cita**'
        }`,
    ),
    '',
  ];
}

export interface RunReport {
  readonly filename: string;
  readonly markdown: string;
}

/** Expediente de un run como documento Markdown. */
export function buildRunReport(
  job: InvestigationJob,
  events: readonly InvestigationEvent[],
  invocations: readonly InvestigationInvocation[],
  actions: readonly InvestigationAction[],
  evidenceSummary: InvestigationEvidenceSummary | null = job.evidence,
): RunReport {
  const result = job.result;
  const status = job.plannedStatus ?? job.status;
  const lines: string[] = [
    `# Expediente del Analista IA — ${escapeReportText(job.subject.title, 160)}`,
    '',
    `- Expediente: ${code(job.id)}`,
    `- Sujeto: ${job.subject.kind === 'alert' ? 'alerta' : 'candidato'} ${code(job.subject.id)}`,
    `- Prioridad: ${job.priority}`,
    `- Estado: ${STATUS_LABEL[status] ?? status}`,
    `- Origen: ${job.trigger === 'user' ? 'pedido por una persona' : job.source === 'backlog' ? 'barrido del atraso' : 'alerta nueva'}`,
    `- Creado: ${iso(job.createdAt)} · Iniciado: ${iso(job.startedAt)} · Terminado: ${iso(job.finishedAt)}`,
    `- Política: ${code(job.policyVersion)}`,
    `- Análisis: ${job.inference === null || job.inference === 'none' ? 'determinista, sin modelo' : `modelo de nivel ${job.inference}`}`,
    '',
    '## Resumen',
    '',
  ];
  if (result) {
    lines.push(
      escapeReportText(result.summary, 800),
      '',
      `- Veredicto: **${VERDICT_LABEL[result.verdict] ?? result.verdict}** (confianza ${result.confidence})`,
      `- Prioridad recomendada: ${result.recommendedPriority ?? 'sin cambio sugerido'}`,
      `- Citas verificadas: ${result.verified ? 'sí' : '**no** — tratar como no verificado'}`,
      `- Razones de la política: ${result.deterministic.reasons.map(code).join(', ') || '—'}`,
      '',
      ...statements('Hechos observados', result.facts),
      ...statements('Inferencias', result.inferences),
      '### Vacíos',
      '',
      ...(result.gaps.length > 0
        ? result.gaps.map((gap) => `- ${escapeReportText(gap)}`)
        : ['_Ninguno declarado._']),
      '',
      '### Pasos sugeridos para una persona',
      '',
      ...(result.nextSteps.length > 0
        ? result.nextSteps.map((step) => `- ${escapeReportText(step)}`)
        : ['_Ninguno._']),
      '',
      '### Evidencia citada',
      '',
      ...(result.citations.length > 0
        ? result.citations.map(
            (citation) =>
              `- ${citation.kind} ${code(citation.id)} — ${escapeReportText(citation.label, 120)}`,
          )
        : ['_Sin citas._']),
      '',
    );
  } else {
    lines.push('_El expediente no tiene resultado._', '');
  }

  lines.push('## Cobertura de evidencia', '');
  if (evidenceSummary) {
    lines.push(
      `- Alertas: ${evidenceSummary.alertCount} · relacionadas: ${evidenceSummary.relatedAlertCount} · eventos: ${evidenceSummary.eventCount}`,
      `- Fuentes: ${evidenceSummary.sourceCount} (${evidenceSummary.unhealthySourceCount} sin datos frescos o con falla)`,
      `- Completa: ${evidenceSummary.complete ? 'sí' : '**no**'} · Truncada: ${evidenceSummary.truncated ? '**sí**' : 'no'} · Paquete recortado: ${evidenceSummary.packTruncated ? '**sí**' : 'no'}`,
      `- Marca de origen: ${code(evidenceSummary.watermark)}`,
      ...evidenceSummary.gaps.map((gap) => `- Vacío de cobertura: ${escapeReportText(gap)}`),
      '',
    );
  } else {
    lines.push('_No se llegó a leer evidencia._', '');
  }

  lines.push('## Acciones del analista', '');
  if (actions.length === 0) {
    lines.push('_Ninguna acción: el expediente es solo una recomendación._', '');
  } else {
    lines.push('| Acción | Estado | Motivo | Referencia |', '| --- | --- | --- | --- |');
    for (const action of actions) {
      lines.push(
        `| ${ACTION_LABEL[action.kind] ?? action.kind}${action.urgency ? ` (${action.urgency === 'immediate' ? 'inmediato' : 'en resumen'})` : ''} | ${action.state}${action.errorCode ? ` ${code(action.errorCode)}` : ''} | ${code(action.reason)} | ${action.ref ? `${action.ref.kind} ${code(action.ref.id)}` : '—'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Uso y costo estimado', '');
  if (invocations.length === 0) {
    lines.push('Sin llamadas a modelos: costo de inferencia estimado USD 0.0000 (estimado).', '');
  } else {
    lines.push(
      '| Nivel | Modelo | Estado | Entrada | Salida | Caché lectura | Caché escritura | Costo |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of invocations) {
      const cost =
        row.state === 'settled' && row.estimatedMicroUsd !== null
          ? formatEstimatedUsd(row.estimatedMicroUsd)
          : row.state === 'released'
            ? 'no enviado'
            : `hasta ${formatEstimatedUsd(row.reservedMicroUsd)} — sin confirmar`;
      lines.push(
        `| ${row.tier} | ${code(row.model)} | ${row.state} | ${row.usage?.inputTokens ?? '—'} | ${row.usage?.outputTokens ?? '—'} | ${row.usage?.cacheReadTokens ?? '—'} | ${row.usage?.cacheWriteTokens ?? '—'} | ${cost} |`,
      );
    }
    lines.push(
      '',
      `Tarifa: ${[...new Set(invocations.map((row) => row.rateCardVersion))].map(code).join(', ')}. Los importes son estimaciones calculadas con el uso reportado por el proveedor; no son facturación confirmada.`,
      '',
    );
  }

  lines.push('## Etapas', '');
  for (const event of events) {
    lines.push(`- ${iso(event.at)} · ${event.stage} · ${event.kind}`);
  }
  if (events.length === 0) lines.push('_Sin eventos registrados._');
  lines.push(
    '',
    '## Limitaciones',
    '',
    '- Documento generado de forma determinista a partir del expediente; no incluye evidencia cruda ni texto sin validar del modelo.',
    '- Una coincidencia temporal no prueba causalidad. El veredicto es una recomendación para revisión humana.',
    '- El analista no ejecuta contención ni respuesta; esas acciones requieren aprobación en Ankay.',
    ...(job.lastErrorCode ? [`- Último código de error: ${code(job.lastErrorCode)}.`] : []),
    '',
  );
  return { filename: `expediente-analista-${job.id}.md`, markdown: lines.join('\n') };
}

export interface DigestPendingItem {
  readonly jobId: string;
  readonly subjectId: string;
  readonly title: string;
  readonly priority: InvestigationPriority;
  readonly status: string;
  readonly reason: string;
}

export interface OperationsDigest {
  readonly from: Date;
  readonly to: Date;
  readonly totals: {
    readonly runs: number;
    readonly escalated: number;
    readonly closedBenign: number;
    readonly requiresReview: number;
    readonly withoutInference: number;
    readonly failed: number;
  };
  readonly byPriority: Readonly<Record<InvestigationPriority, number>>;
  readonly topRules: readonly { readonly ruleId: string; readonly runs: number }[];
  /** Suma de estimaciones liquidadas que quien llama pasa en `options`; 0 si no se pasa. */
  readonly estimatedMicroUsd: number;
  /** Lo que necesita a una persona, lo más grave primero. */
  readonly pendingReview: readonly DigestPendingItem[];
  /** Cobertura de la cola; los campos que dependen de `alertsReceived` son `null` sin ese dato. */
  readonly coverage: {
    readonly alertsReceived: number | null;
    readonly alertsInvestigated: number;
    readonly resolvedWithoutHuman: number;
    readonly awaitingHuman: number;
    readonly stillUnreviewed: number | null;
  };
  readonly markdown: string;
}

const NEEDS_HUMAN = [
  'requires_review',
  'partial',
  'budget_exhausted',
  'usage_unreconciled',
  'failed',
];

/**
 * Resumen de operación de un turno o día. `jobs`: trabajos terminados en `[from, to)`;
 * `actions`: su libro. `options.alertsReceived` (alertas que entraron a la cola en la ventana) y
 * `options.estimatedMicroUsd` (de `budgetSnapshot`) los aporta el host.
 */
export function buildDigest(
  jobs: readonly InvestigationJob[],
  actions: readonly InvestigationAction[],
  from: Date,
  to: Date,
  options: { readonly alertsReceived?: number; readonly estimatedMicroUsd?: number } = {},
): OperationsDigest {
  const finished = jobs.filter(
    (job) => job.finishedAt !== null && job.finishedAt >= from && job.finishedAt < to,
  );
  const byJob = new Map<string, InvestigationAction[]>();
  for (const action of actions) {
    byJob.set(action.jobId, [...(byJob.get(action.jobId) ?? []), action]);
  }
  const executed = (jobId: string, kind: InvestigationAction['kind']): boolean =>
    (byJob.get(jobId) ?? []).some((action) => action.kind === kind && action.state === 'executed');
  const review = (jobId: string): InvestigationAction | undefined =>
    (byJob.get(jobId) ?? []).find((action) => action.kind === 'request_review');

  const byPriority: Record<InvestigationPriority, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const rules = new Map<string, number>();
  const investigated = new Set<string>();
  const resolved = new Set<string>();
  const awaiting = new Set<string>();
  const pendingReview: DigestPendingItem[] = [];
  const totals = {
    runs: finished.length,
    escalated: 0,
    closedBenign: 0,
    requiresReview: 0,
    withoutInference: 0,
    failed: 0,
  };
  for (const job of finished) {
    byPriority[job.priority] += 1;
    const ruleId = job.subject.ruleId;
    if (ruleId) rules.set(ruleId, (rules.get(ruleId) ?? 0) + 1);
    if (job.status === 'cancelled') continue;
    if (executed(job.id, 'escalate')) totals.escalated += 1;
    if (executed(job.id, 'close_benign')) totals.closedBenign += 1;
    if (job.status === 'failed') totals.failed += 1;
    if (job.inference === 'none' || job.inference === null) totals.withoutInference += 1;
    const escalated = executed(job.id, 'escalate');
    const needsHuman = NEEDS_HUMAN.includes(job.status) || escalated;
    if (NEEDS_HUMAN.includes(job.status)) totals.requiresReview += 1;
    for (const alertId of job.alertIds) {
      investigated.add(alertId);
      if (needsHuman) awaiting.add(alertId);
      else resolved.add(alertId);
    }
    if (needsHuman) {
      pendingReview.push({
        jobId: job.id,
        subjectId: job.subject.id,
        title: job.subject.title,
        priority: job.priority,
        status: job.status,
        reason:
          review(job.id)?.reason ??
          (escalated ? 'ESCALATED' : (job.lastErrorCode ?? job.status.toUpperCase())),
      });
    }
  }
  for (const alertId of awaiting) resolved.delete(alertId);
  pendingReview.sort(
    (left, right) =>
      left.priority.localeCompare(right.priority) || left.jobId.localeCompare(right.jobId),
  );
  const topRules = [...rules.entries()]
    .map(([ruleId, runs]) => ({ ruleId, runs }))
    .sort((left, right) => right.runs - left.runs || left.ruleId.localeCompare(right.ruleId))
    .slice(0, 10);
  const received = options.alertsReceived ?? null;
  const coverage = {
    alertsReceived: received,
    alertsInvestigated: investigated.size,
    resolvedWithoutHuman: resolved.size,
    awaitingHuman: awaiting.size,
    stillUnreviewed: received === null ? null : Math.max(0, received - investigated.size),
  };
  const estimatedMicroUsd = options.estimatedMicroUsd ?? 0;

  const shown = pendingReview.slice(0, 50);
  const markdown = [
    '# Analista IA — resumen de operación',
    '',
    `Ventana: ${from.toISOString()} → ${to.toISOString()}`,
    '',
    '## Cobertura de la cola',
    '',
    `- Alertas recibidas: ${received ?? 'dato no disponible'}`,
    `- Alertas investigadas por el analista: ${coverage.alertsInvestigated}`,
    `- Resueltas sin intervención humana: ${coverage.resolvedWithoutHuman}`,
    `- En espera de una persona: ${coverage.awaitingHuman}`,
    `- Aún sin revisar: ${coverage.stillUnreviewed ?? 'dato no disponible'}`,
    '',
    '## Pendiente de revisión humana',
    '',
    ...(shown.length === 0
      ? ['_Nada pendiente en esta ventana._']
      : [
          '| Prioridad | Caso | Estado | Motivo | Expediente |',
          '| --- | --- | --- | --- | --- |',
          ...shown.map(
            (item) =>
              `| ${item.priority} | ${escapeReportText(item.title, 100)} | ${STATUS_LABEL[item.status] ?? item.status} | ${code(item.reason)} | ${code(item.jobId)} |`,
          ),
          ...(pendingReview.length > shown.length
            ? ['', `_Se muestran ${shown.length} de ${pendingReview.length}._`]
            : []),
        ]),
    '',
    '## Totales',
    '',
    `- Investigaciones terminadas: ${totals.runs}`,
    `- Escaladas: ${totals.escalated}`,
    `- Cerradas como benigno conocido: ${totals.closedBenign}`,
    `- Requieren revisión: ${totals.requiresReview}`,
    `- Resueltas sin modelo: ${totals.withoutInference}`,
    `- Fallidas: ${totals.failed}`,
    `- Por prioridad: P1 ${byPriority.P1} · P2 ${byPriority.P2} · P3 ${byPriority.P3} · P4 ${byPriority.P4}`,
    `- Costo de inferencia: ${formatEstimatedUsd(estimatedMicroUsd)}; no es facturación confirmada.`,
    '',
    '## Reglas con más investigaciones',
    '',
    ...(topRules.length === 0
      ? ['_Sin datos de regla._']
      : topRules.map((rule) => `- ${code(rule.ruleId)}: ${rule.runs}`)),
    '',
  ].join('\n');

  return {
    from,
    to,
    totals,
    byPriority,
    topRules,
    estimatedMicroUsd,
    pendingReview,
    coverage,
    markdown,
  };
}
