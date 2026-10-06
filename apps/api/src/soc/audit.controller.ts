/**
 * C-19 — consulta y verificación de auditoría sobre HTTP.
 *
 * La proyección se redacta según las capabilities del lector, y la verificación de la
 * cadena es una capability distinta de leerla: comprobar integridad y leer contenido no
 * son el mismo permiso.
 */

import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { IncomingRequest } from '../http/http-contracts.js';

import { AUDIT_VERIFY, planAuditQuery, projectAuditEvent, verifyChain } from '@qapaq/audit';

import { ApiError } from '../http/api-error.js';
import { correlationIdOf, originOf, sessionIdOf } from '../http/request-context.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

@Controller('api/audit')
export class AuditController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('events')
  public async events(
    @Req() request: IncomingRequest,
    @Query()
    query: {
      from?: string;
      to?: string;
      pageSize?: string;
      cursor?: string;
      action?: string;
      actorId?: string;
      resourceType?: string;
      resourceId?: string;
      outcome?: string | string[];
    },
  ) {
    const correlationId = correlationIdOf(request);
    const resolved = await this.runtime.resolveActor(sessionIdOf(request), originOf(request));
    if (!resolved.ok) throw new ApiError(resolved.reason, correlationId);
    const plan = planAuditQuery(
      {
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.pageSize === undefined ? {} : { pageSize: Number(query.pageSize) }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
        ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
        ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
        ...(query.outcome === undefined
          ? {}
          : { outcome: Array.isArray(query.outcome) ? query.outcome : [query.outcome] }),
      },
      { tenantId: resolved.actor.tenantId, capabilities: resolved.actor.capabilities },
    );
    if (!plan.ok) {
      throw plan.rejection.code === 'UNAUTHORIZED'
        ? new ApiError('RESOURCE_UNAVAILABLE', correlationId)
        : new ApiError('VALIDATION_FAILED', correlationId, [plan.rejection.field]);
    }
    const page = await this.runtime.audit.read(plan.query);
    return {
      correlationId,
      nextCursor: page.nextCursor,
      items: page.events.map((event) =>
        projectAuditEvent(event, { includeSensitive: plan.query.includeSensitive }),
      ),
    };
  }

  @Get('verify')
  public async verify(@Req() request: IncomingRequest) {
    const correlationId = correlationIdOf(request);
    const resolved = await this.runtime.resolveActor(sessionIdOf(request), originOf(request));
    if (!resolved.ok) throw new ApiError(resolved.reason, correlationId);
    if (!resolved.actor.capabilities.has(AUDIT_VERIFY)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const events = await this.runtime.audit.range(resolved.actor.tenantId, 1n, 1_000);
    const verification = verifyChain(events);
    return {
      correlationId,
      ok: verification.ok,
      checked: verification.checked,
      headSequence: verification.head?.sequence.toString() ?? '0',
      violations: verification.violations.map((violation) => ({
        code: violation.code,
        sequence: violation.sequence.toString(),
        detail: violation.detail,
      })),
    };
  }
}
