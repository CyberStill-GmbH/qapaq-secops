/**
 * Acción `start_investigation` de Qapaqzito/MCP ligada a la persona que pregunta (docs/27).
 *
 * Mismas reglas que `POST /api/ai-investigations`: capacidad `investigations.run`, alerta del
 * tenant, analista activo, encolado idempotente y auditoría. El MCP ya exigió sesión y CSRF.
 */

import { randomUUID } from 'node:crypto';

import type { Actor } from '@qapaq/access';
import type { ToolOutcome } from '@qapaq/assistant';
import { recordAudit } from '@qapaq/audit';

import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

export function startInvestigationAction(
  runtime: SecOpsRuntime,
  actor: Actor,
  correlationId: string,
  via: 'mcp' | 'qapaqzito',
): ((alertId: string) => Promise<ToolOutcome>) | undefined {
  const host = runtime.analyst;
  if (!host || !actor.capabilities.has('investigations.run') || actor.tenantId !== runtime.tenantId) {
    return undefined;
  }
  return async (alertId) => {
    if (!host.enabled) return { ok: false, error: 'El Analista IA está apagado en este entorno.' };
    const alert = await runtime.soc.alertById(runtime.tenantId, alertId);
    if (!alert || alert.tenantId !== actor.tenantId) {
      return { ok: false, error: 'No disponible: la alerta no existe o tu rol no tiene acceso.' };
    }
    const { job, created } = await host.enqueueAlert(alert, {
      source: 'manual',
      initiatedBy: actor.subjectId,
    });
    await recordAudit(runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: runtime.now(),
      actor: { id: actor.subjectId, type: 'user', sessionId: actor.sessionId },
      action: 'ai.analyst.investigation.requested',
      resource: { type: 'ai_investigation', id: job.id },
      outcome: 'succeeded',
      correlationId,
      metadata: { alertId: alert.id, created, priority: job.priority, via },
    });
    return {
      ok: true,
      data: { investigationId: job.id, status: job.status, created, priority: job.priority },
      citations: [{ kind: 'alert', id: alert.id, label: `Alerta ${alert.id}` }],
    };
  };
}
