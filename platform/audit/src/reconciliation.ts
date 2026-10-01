/**
 * C-19 — reconciliación mínima entre la cadena viva y el archivo.
 *
 * El archivo existe para sobrevivir a la base; por eso la reconciliación no asume que
 * una de las dos partes sea la verdad. Compara cobertura y contenido y clasifica lo que
 * encuentra, sin reparar nada: cualquier corrección sobre auditoría es una decisión con
 * dueño humano, no un efecto colateral de una tarea programada.
 */

import { verifyChain, type ChainViolation } from './hash-chain.js';
import type { SealedAuditEvent } from './audit-event.js';
import type { AuditArchive, AuditArchiveSegmentRef, AuditStore } from './ports.js';

export const RECONCILIATION_FINDINGS = [
  'ARCHIVE_GAP',
  'ARCHIVE_OVERLAP',
  'ARCHIVE_DIVERGED',
  'ARCHIVE_UNREADABLE',
  'ARCHIVE_BEHIND',
  'LIVE_CHAIN_BROKEN',
] as const;
export type ReconciliationFindingCode = (typeof RECONCILIATION_FINDINGS)[number];

export interface ReconciliationFinding {
  readonly code: ReconciliationFindingCode;
  readonly tenantId: string;
  readonly sequence: bigint;
  readonly detail: string;
}

export interface ReconciliationReport {
  readonly tenantId: string;
  readonly ok: boolean;
  readonly liveHeadSequence: bigint;
  readonly archivedThroughSequence: bigint;
  readonly comparedEvents: number;
  readonly findings: readonly ReconciliationFinding[];
}

export interface ReconcileOptions {
  /** Página de lectura contra el store; acota memoria en tenants largos. */
  readonly batchSize?: number;
}

function toFinding(violation: ChainViolation): ReconciliationFinding {
  return {
    code: 'LIVE_CHAIN_BROKEN',
    tenantId: violation.tenantId,
    sequence: violation.sequence,
    detail: `${violation.code}: ${violation.detail}`,
  };
}

async function readSegment(
  archive: AuditArchive,
  ref: AuditArchiveSegmentRef,
  findings: ReconciliationFinding[],
): Promise<readonly SealedAuditEvent[] | undefined> {
  try {
    return await archive.read(ref);
  } catch (error) {
    findings.push({
      code: 'ARCHIVE_UNREADABLE',
      tenantId: ref.tenantId,
      sequence: ref.fromSequence,
      detail: error instanceof Error ? error.message : 'Segmento ilegible.',
    });
    return undefined;
  }
}

export async function reconcileAudit(
  tenantId: string,
  store: AuditStore,
  archive: AuditArchive,
  options: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const batchSize = options.batchSize ?? 500;
  const findings: ReconciliationFinding[] = [];
  const head = await store.head(tenantId);
  const liveHeadSequence = head?.sequence ?? 0n;
  const segments = await archive.list(tenantId);

  let expected = 1n;
  let archivedThrough = 0n;
  let compared = 0;

  for (const ref of segments) {
    if (ref.fromSequence > expected) {
      findings.push({
        code: 'ARCHIVE_GAP',
        tenantId,
        sequence: expected,
        detail: `El archivo salta de ${expected - 1n} a ${ref.fromSequence}.`,
      });
    } else if (ref.fromSequence < expected) {
      findings.push({
        code: 'ARCHIVE_OVERLAP',
        tenantId,
        sequence: ref.fromSequence,
        detail: `El segmento ${ref.objectRef} repite secuencias ya archivadas.`,
      });
    }
    const archived = await readSegment(archive, ref, findings);
    expected = ref.toSequence + 1n;
    archivedThrough = ref.toSequence > archivedThrough ? ref.toSequence : archivedThrough;
    if (!archived) continue;

    const live = await store.range(tenantId, ref.fromSequence, archived.length);
    const liveBySequence = new Map(live.map((event) => [event.sequence, event]));
    for (const event of archived) {
      compared += 1;
      const counterpart = liveBySequence.get(event.sequence);
      if (!counterpart) {
        findings.push({
          code: 'ARCHIVE_DIVERGED',
          tenantId,
          sequence: event.sequence,
          detail: 'La secuencia está archivada pero no existe en la cadena viva.',
        });
        continue;
      }
      if (counterpart.hash !== event.hash) {
        findings.push({
          code: 'ARCHIVE_DIVERGED',
          tenantId,
          sequence: event.sequence,
          detail: 'El hash vivo y el archivado no coinciden.',
        });
      }
    }
  }

  if (archivedThrough < liveHeadSequence) {
    findings.push({
      code: 'ARCHIVE_BEHIND',
      tenantId,
      sequence: archivedThrough + 1n,
      detail: `Quedan ${liveHeadSequence - archivedThrough} evento(s) sin archivar.`,
    });
  }

  for (let cursor = 1n; cursor <= liveHeadSequence; cursor += BigInt(batchSize)) {
    const page = await store.range(tenantId, cursor, batchSize);
    if (page.length === 0) break;
    const previous =
      cursor === 1n
        ? undefined
        : await store
            .range(tenantId, cursor - 1n, 1)
            .then((rows) =>
              rows[0] ? { sequence: rows[0].sequence, hash: rows[0].hash } : undefined,
            );
    const verification = verifyChain(page, previous ? { from: previous } : {});
    findings.push(...verification.violations.map(toFinding));
  }

  return {
    tenantId,
    ok: findings.length === 0,
    liveHeadSequence,
    archivedThroughSequence: archivedThrough,
    comparedEvents: compared,
    findings,
  };
}
