/**
 * Enriquecimiento manual de reputación por hash: `POST /api/alerts/:id/enrichment/virustotal`.
 *
 * La clave disponible es de la API pública de VirusTotal, cuyos términos no admiten automatizarla
 * en un producto comercial. Por eso este endpoint es la única vía y está cerrado así:
 *
 * - Solo a pedido: lo dispara el analista desde la consola; ningún bucle, ingesta ni playbook lo
 *   llama. Exige sesión, CSRF y la capability `enrichment.virustotal`.
 * - Solo hashes que la alerta ya trae (`md5:`/`sha1:`/`sha256:` en sus claves de entidad). El
 *   cuerpo no se lee: el cliente no puede pedir un hash arbitrario, una URL ni una IP.
 * - Una consulta por petición, por el hash más fuerte de la alerta: los tres describen el mismo
 *   archivo y el servicio los resuelve al mismo reporte.
 * - Cuota del tenant (4/min y 500/día) y caché de 24 h en el almacenamiento compartido.
 * - Cada intento queda en la auditoría: actor, alerta, hash consultado y resultado resumido.
 */

import { randomUUID } from 'node:crypto';

import { Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';

import { recordAudit, type AuditOutcome, type CanonicalValue } from '@qapaq/audit';
import { enrichFileReputation, FILE_REPUTATION_CACHE_TTL_MS } from '@qapaq/connectors';
import {
  FILE_HASH_PREFERENCE,
  isFileHash,
  type FileHash,
  type FileReputationEnrichment,
} from '@qapaq/contracts';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest, OutgoingReply } from '../http/http-contracts.js';
import { mutatingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

export const FILE_REPUTATION_CAPABILITY = 'enrichment.virustotal' as const;
const AUDIT_ACTION = 'alert.enrichment.file_reputation';

/** Hash preferido entre las claves de entidad de la alerta; `undefined` si no trae ninguno. */
export function preferredFileHash(entityKeys: readonly string[]): FileHash | undefined {
  const hashes = new Map<string, string>();
  for (const key of entityKeys) {
    const separator = key.indexOf(':');
    const algorithm = key.slice(0, separator);
    const value = key.slice(separator + 1);
    if (separator > 0 && isFileHash(algorithm, value) && !hashes.has(algorithm)) {
      hashes.set(algorithm, value);
    }
  }
  for (const algorithm of FILE_HASH_PREFERENCE) {
    const value = hashes.get(algorithm);
    if (value !== undefined) return { algorithm, value };
  }
  return undefined;
}

@Controller('api')
export class EnrichmentController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Post('alerts/:id/enrichment/virustotal')
  @HttpCode(200)
  public async virusTotal(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: OutgoingReply,
  ): Promise<FileReputationEnrichment> {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (
      !actor.capabilities.has('alerts.read') ||
      !actor.capabilities.has(FILE_REPUTATION_CAPABILITY)
    ) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const alert = await this.runtime.soc.alertById(actor.tenantId, id);
    if (!alert) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const hash = preferredFileHash(alert.entityKeys);
    if (!hash) throw new ApiError('VALIDATION_FAILED', correlationId, ['hash']);
    const integration = this.runtime.fileReputation;
    if (!integration) throw new ApiError('INTEGRATION_NOT_CONFIGURED', correlationId);

    const outcome = await enrichFileReputation(
      { provider: integration.provider, store: integration.store, now: () => this.runtime.now() },
      { tenantId: actor.tenantId, hash },
    );

    const audit = async (
      result: AuditOutcome,
      metadata: Readonly<Record<string, CanonicalValue>>,
      reason?: string,
    ) =>
      recordAudit(this.runtime.audit, {
        id: randomUUID(),
        tenantId: actor.tenantId,
        occurredAt: this.runtime.now(),
        actor: { id: actor.subjectId, type: 'user', sessionId: actor.sessionId },
        action: AUDIT_ACTION,
        resource: { type: 'alert', id: alert.id },
        outcome: result,
        correlationId,
        ...(reason ? { reason } : {}),
        metadata: {
          provider: integration.provider.providerId,
          algorithm: hash.algorithm,
          hash: hash.value,
          ...metadata,
        },
      });

    if (outcome.kind === 'quota_exhausted') {
      await audit('denied', { window: outcome.window }, 'quota_exhausted');
      reply.header('retry-after', String(Math.ceil(outcome.retryAfterMs / 1_000)));
      throw new ApiError('RATE_LIMITED', correlationId);
    }
    if (outcome.kind === 'provider_failed') {
      await audit('failed', { errorCode: outcome.code }, 'provider_failed');
      // Credencial rechazada: para la persona es lo mismo que no tenerla configurada.
      throw new ApiError(
        outcome.code === 'REPUTATION_AUTHENTICATION_FAILED'
          ? 'INTEGRATION_NOT_CONFIGURED'
          : 'DEPENDENCY_DEGRADED',
        correlationId,
      );
    }

    await audit('succeeded', {
      status: outcome.status,
      cached: outcome.cached,
      detections: outcome.reputation?.detections ?? null,
      engines: outcome.reputation?.engines ?? null,
      threatLabels: [...(outcome.reputation?.threatLabels ?? [])],
    });
    return {
      correlationId,
      alertId: alert.id,
      hash,
      status: outcome.status,
      reputation: outcome.reputation,
      cached: outcome.cached,
      checkedAt: outcome.checkedAt.toISOString(),
      cacheTtlHours: FILE_REPUTATION_CACHE_TTL_MS / 3_600_000,
      quota: outcome.quota,
    };
  }
}
