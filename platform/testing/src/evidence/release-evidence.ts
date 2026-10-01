/**
 * C-22 — matriz de evidencia y decisión de preparación.
 *
 * La decisión del timebox no se discute en prosa: se deriva de una matriz donde cada
 * requisito tiene estado, evidencia y, si está bloqueado, dueño y motivo. Tres reglas
 * que el Sprint 3 fija y este módulo impone:
 *
 * - un requisito **P0 en FAIL** produce `NOT_READY`; no existe "casi listo";
 * - un requisito **P0 en BLOCKED** impide `MVP CANDIDATE` y produce `LIMITED`, con sus
 *   restricciones enumeradas;
 * - un `BLOCKED` sin dueño y sin fecha no es un bloqueo gestionado, es un hueco, y la
 *   matriz se rechaza antes de llegar a la Review.
 *
 * La matriz se ata a un commit y a un ambiente. Una evidencia sin esos dos datos no
 * dice nada sobre lo que se va a promover.
 */

export const EVIDENCE_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const PRIORITIES = ['P0', 'P1'] as const;
export type EvidencePriority = (typeof PRIORITIES)[number];

export const READINESS_DECISIONS = ['MVP_CANDIDATE', 'LIMITED', 'NOT_READY'] as const;
export type ReadinessDecision = (typeof READINESS_DECISIONS)[number];

export interface EvidenceItem {
  readonly id: string;
  readonly component: string;
  readonly requirement: string;
  readonly priority: EvidencePriority;
  readonly status: EvidenceStatus;
  /** Comando, artefacto o enlace que permite repetir la comprobación. */
  readonly evidence: string;
  readonly blockedBy?: string;
  readonly owner?: string;
  readonly dueDate?: string;
}

export interface ReleaseContext {
  readonly commit: string;
  readonly environment: string;
  readonly generatedAt: string;
  readonly toolchain: Readonly<Record<string, string>>;
}

export interface ReadinessOutcome {
  readonly decision: ReadinessDecision;
  readonly rationale: string;
  readonly failing: readonly string[];
  readonly blocked: readonly string[];
  readonly notRun: readonly string[];
}

export const MATRIX_ERROR_CODES = [
  'COMMIT_REQUIRED',
  'ENVIRONMENT_REQUIRED',
  'DUPLICATE_ID',
  'BLOCKED_WITHOUT_OWNER',
  'BLOCKED_WITHOUT_DUE_DATE',
  'EVIDENCE_REQUIRED',
] as const;
export type MatrixErrorCode = (typeof MATRIX_ERROR_CODES)[number];

export interface MatrixProblem {
  readonly code: MatrixErrorCode;
  readonly itemId?: string;
  readonly detail: string;
}

const COMMIT = /^[0-9a-f]{40}$/u;

export function validateMatrix(
  context: ReleaseContext,
  items: readonly EvidenceItem[],
): readonly MatrixProblem[] {
  const problems: MatrixProblem[] = [];
  if (!COMMIT.test(context.commit)) {
    problems.push({
      code: 'COMMIT_REQUIRED',
      detail: 'La matriz debe citar el commit completo del candidato.',
    });
  }
  if (!context.environment.trim()) {
    problems.push({ code: 'ENVIRONMENT_REQUIRED', detail: 'Falta el ambiente evaluado.' });
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      problems.push({ code: 'DUPLICATE_ID', itemId: item.id, detail: 'Identificador repetido.' });
    }
    seen.add(item.id);
    if (!item.evidence.trim()) {
      problems.push({
        code: 'EVIDENCE_REQUIRED',
        itemId: item.id,
        detail: 'Un estado sin evidencia repetible no es evidencia.',
      });
    }
    if (item.status === 'BLOCKED') {
      if (!item.owner?.trim()) {
        problems.push({
          code: 'BLOCKED_WITHOUT_OWNER',
          itemId: item.id,
          detail: 'Un bloqueo sin dueño no se desbloquea solo.',
        });
      }
      if (!item.dueDate?.trim()) {
        problems.push({
          code: 'BLOCKED_WITHOUT_DUE_DATE',
          itemId: item.id,
          detail: 'Un bloqueo sin fecha de revisión se vuelve permanente.',
        });
      }
    }
  }
  return problems;
}

export function decideReadiness(items: readonly EvidenceItem[]): ReadinessOutcome {
  const p0 = items.filter((item) => item.priority === 'P0');
  const failing = p0.filter((item) => item.status === 'FAIL').map((item) => item.id);
  const blocked = p0.filter((item) => item.status === 'BLOCKED').map((item) => item.id);
  const notRun = p0.filter((item) => item.status === 'NOT_RUN').map((item) => item.id);

  if (failing.length > 0) {
    return {
      decision: 'NOT_READY',
      rationale: `Hay ${failing.length} requisito(s) P0 en FAIL: la ruta crítica no se demuestra.`,
      failing,
      blocked,
      notRun,
    };
  }
  if (notRun.length > 0) {
    return {
      decision: 'NOT_READY',
      // Un P0 sin ejecutar es una afirmación sin respaldo, no un riesgo aceptado.
      rationale: `Hay ${notRun.length} requisito(s) P0 sin ejecutar.`,
      failing,
      blocked,
      notRun,
    };
  }
  if (blocked.length > 0) {
    return {
      decision: 'LIMITED',
      rationale: `Existe incremento usable, pero ${blocked.length} gate(s) P0 impiden la promoción.`,
      failing,
      blocked,
      notRun,
    };
  }
  return {
    decision: 'MVP_CANDIDATE',
    rationale: 'Todos los requisitos P0 cumplen Done y no hay gate crítico bloqueado.',
    failing,
    blocked,
    notRun,
  };
}

export interface ReleaseEvidence {
  readonly context: ReleaseContext;
  readonly items: readonly EvidenceItem[];
  readonly outcome: ReadinessOutcome;
  readonly problems: readonly MatrixProblem[];
}

export function buildReleaseEvidence(
  context: ReleaseContext,
  items: readonly EvidenceItem[],
): ReleaseEvidence {
  return {
    context,
    items,
    outcome: decideReadiness(items),
    problems: validateMatrix(context, items),
  };
}

const STATUS_MARK: Readonly<Record<EvidenceStatus, string>> = {
  PASS: '✅ PASS',
  FAIL: '❌ FAIL',
  BLOCKED: '⛔ BLOCKED',
  NOT_RUN: '⚪ NOT_RUN',
};

export function renderMarkdown(evidence: ReleaseEvidence): string {
  const rows = evidence.items
    .map((item) =>
      [
        item.id,
        item.component,
        item.priority,
        STATUS_MARK[item.status],
        item.requirement,
        item.evidence,
        item.status === 'BLOCKED'
          ? `${item.blockedBy ?? ''} · ${item.owner ?? ''} · ${item.dueDate ?? ''}`
          : '—',
      ].join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');
  const counts = EVIDENCE_STATUSES.map(
    (status) => `${status}: ${evidence.items.filter((item) => item.status === status).length}`,
  ).join(' · ');
  return [
    '# C-22 — Matriz de evidencia del candidato',
    '',
    `Commit: \`${evidence.context.commit}\``,
    `Ambiente: ${evidence.context.environment}`,
    `Generada: ${evidence.context.generatedAt}`,
    `Toolchain: ${Object.entries(evidence.context.toolchain)
      .map(([key, value]) => `${key} ${value}`)
      .join(', ')}`,
    '',
    `## Decisión: ${evidence.outcome.decision}`,
    '',
    evidence.outcome.rationale,
    '',
    `Resumen: ${counts}`,
    '',
    '| ID | Componente | Prioridad | Estado | Requisito | Evidencia | Bloqueo · dueño · fecha |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    ...(evidence.problems.length > 0
      ? [
          '## Problemas de la propia matriz',
          '',
          ...evidence.problems.map(
            (problem) =>
              `- ${problem.code}${problem.itemId ? ` (${problem.itemId})` : ''}: ${problem.detail}`,
          ),
          '',
        ]
      : []),
  ].join('\n');
}
