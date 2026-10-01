/**
 * C-17/C-21 — superficie HTTP del flujo SOC.
 *
 * Cada endpoint resuelve la sesión, delega en el caso de uso y traduce el fallo al
 * catálogo de C-27. La autorización no se evalúa aquí: vive en el caso de uso, de modo
 * que un cliente que no sea esta API obtiene exactamente la misma decisión.
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { IncomingRequest } from '../http/http-contracts.js';

import { projectFields } from '@qapaq/access';
import {
  executeAlertCommand,
  executeIncidentCommand,
  openIncidentFromAlert,
  type Alert,
  type Incident,
  type TriageVerdict,
} from '@qapaq/soc';

import { ApiError, fromSocFailure } from '../http/api-error.js';
import { correlationIdOf, originOf, sessionIdOf } from '../http/request-context.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

function alertView(alert: Alert, capabilities: ReadonlySet<string>) {
  return projectFields(
    {
      id: alert.id,
      title: alert.title,
      priority: alert.priority,
      score: alert.score,
      status: alert.status,
      assigneeId: alert.assigneeId,
      verdict: alert.verdict,
      incidentId: alert.incidentId,
      occurredAt: alert.occurredAt.toISOString(),
      revision: alert.revision,
      reasons: alert.reasons.map((reason) => ({ code: reason.code, detail: reason.detail })),
      // `rawRef` solo se proyecta a quien tiene events.read_raw (C-18).
      rawRef: `raw:${alert.eventRecordId}`,
    },
    capabilities as never,
  );
}

function incidentView(incident: Incident) {
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    ownerId: incident.ownerId,
    alertIds: incident.alertIds,
    summary: incident.summary,
    openedAt: incident.openedAt.toISOString(),
    closedAt: incident.closedAt?.toISOString() ?? null,
    revision: incident.revision,
  };
}

@Controller('api')
export class SocController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  private async actorOf(request: IncomingRequest) {
    const correlationId = correlationIdOf(request);
    const resolved = await this.runtime.resolveActor(sessionIdOf(request), originOf(request));
    if (!resolved.ok) throw new ApiError(resolved.reason, correlationId);
    return { actor: resolved.actor, correlationId };
  }

  @Get('alerts')
  public async alerts(@Req() request: IncomingRequest, @Query() query: { status?: string }) {
    const { actor, correlationId } = await this.actorOf(request);
    if (!actor.capabilities.has('alerts.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const alerts = [...this.runtime.soc.alertRows.values()]
      .filter((alert) => alert.tenantId === actor.tenantId)
      .filter((alert) => !query.status || alert.status === query.status)
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
    return {
      correlationId,
      items: alerts.map((alert) => alertView(alert, actor.capabilities)),
    };
  }

  @Get('alerts/:id')
  public async alert(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await this.actorOf(request);
    const alert = this.runtime.soc.alertRows.get(`${actor.tenantId}|${id}`);
    if (!alert || !actor.capabilities.has('alerts.read')) {
      // Mismo error para inexistente y no autorizado: la API no enumera.
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    return { correlationId, alert: alertView(alert, actor.capabilities) };
  }

  @Post('alerts/:id/commands')
  public async command(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      expectedRevision?: number;
      verdict?: TriageVerdict;
      note?: string;
      assigneeId?: string;
    },
  ) {
    const { actor, correlationId } = await this.actorOf(request);
    const name = body.name as 'acknowledge' | 'assign' | 'triage' | 'escalate' | 'close' | 'reopen';
    if (!name || typeof body.expectedRevision !== 'number') {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['name', 'expectedRevision']);
    }
    const result = await executeAlertCommand(this.runtime.socDependencies(), {
      actor,
      alertId: id,
      correlationId,
      command: {
        name,
        expectedRevision: body.expectedRevision,
        ...(body.verdict === undefined ? {} : { verdict: body.verdict }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.assigneeId === undefined ? {} : { assigneeId: body.assigneeId }),
      },
    });
    if (!result.ok) throw fromSocFailure(result.code, correlationId);
    this.runtime.pumpOutbox();
    return { correlationId, alert: alertView(result.value, actor.capabilities) };
  }

  @Post('incidents')
  public async openIncident(
    @Req() request: IncomingRequest,
    @Body()
    body: {
      alertId?: string;
      title?: string;
      severity?: 'critical' | 'high' | 'medium' | 'low';
      summary?: string;
      expectedAlertRevision?: number;
    },
  ) {
    const { actor, correlationId } = await this.actorOf(request);
    if (
      !body.alertId ||
      !body.title ||
      !body.severity ||
      !body.summary ||
      typeof body.expectedAlertRevision !== 'number'
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, [
        'alertId',
        'title',
        'severity',
        'summary',
        'expectedAlertRevision',
      ]);
    }
    const result = await openIncidentFromAlert(this.runtime.socDependencies(), {
      actor,
      alertId: body.alertId,
      title: body.title,
      severity: body.severity,
      summary: body.summary,
      correlationId,
      expectedAlertRevision: body.expectedAlertRevision,
    });
    if (!result.ok) throw fromSocFailure(result.code, correlationId);
    this.runtime.pumpOutbox();
    return { correlationId, incident: incidentView(result.value) };
  }

  @Get('incidents')
  public async incidents(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await this.actorOf(request);
    if (!actor.capabilities.has('incidents.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    return {
      correlationId,
      items: [...this.runtime.soc.incidentRows.values()]
        .filter((incident) => incident.tenantId === actor.tenantId)
        .map(incidentView),
    };
  }

  @Post('incidents/:id/commands')
  public async incidentCommand(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Body()
    body: {
      name?: 'contain' | 'eradicate' | 'resolve' | 'close' | 'reopen' | 'reassign';
      expectedRevision?: number;
      closureReason?: string;
      ownerId?: string;
    },
  ) {
    const { actor, correlationId } = await this.actorOf(request);
    if (!body.name || typeof body.expectedRevision !== 'number') {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['name', 'expectedRevision']);
    }
    const result = await executeIncidentCommand(this.runtime.socDependencies(), {
      actor,
      incidentId: id,
      correlationId,
      command: {
        name: body.name,
        expectedRevision: body.expectedRevision,
        ...(body.closureReason === undefined ? {} : { closureReason: body.closureReason }),
        ...(body.ownerId === undefined ? {} : { ownerId: body.ownerId }),
      },
    });
    if (!result.ok) throw fromSocFailure(result.code, correlationId);
    this.runtime.pumpOutbox();
    return { correlationId, incident: incidentView(result.value) };
  }
}
