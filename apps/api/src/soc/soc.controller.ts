/**
 * C-17/C-21 — superficie HTTP del flujo SOC.
 *
 * Cada endpoint resuelve la sesión, delega en el caso de uso y traduce el fallo al
 * catálogo de C-27. La autorización no se evalúa aquí: vive en el caso de uso, de modo
 * que un cliente que no sea esta API obtiene exactamente la misma decisión.
 *
 * Las mutaciones exigen además el token CSRF de la sesión (B-01) y los listados se
 * entregan por páginas con cursor (B-02).
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { IncomingRequest } from '../http/http-contracts.js';

import { projectFields } from '@qapaq/access';
import {
  ALERT_STATUSES,
  executeAlertCommand,
  executeIncidentCommand,
  openIncidentFromAlert,
  INCIDENT_STATUSES,
  type Alert,
  type AlertStatus,
  type Incident,
  type IncidentStatus,
  type TriageVerdict,
} from '@qapaq/soc';

import { ApiError, fromSocFailure } from '../http/api-error.js';
import { ENTITY_REF_PATTERN } from '../runtime/entity-refs.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { mutatingActor, readingActor } from './session-actor.js';
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
      // Correlación de C-16. `entities[].ref` es lo único apto para URLs y filtros (D-10b);
      // `label` (UPN o IP) solo viaja en este cuerpo. Las claves internas no se exponen.
      entities: alert.entityKeys.map((key, index) => {
        const separator = key.indexOf(':');
        return {
          ref: alert.entityRefs[index] ?? null,
          kind: key.slice(0, separator),
          label: key.slice(separator + 1),
        };
      }),
      signal: alert.signal,
      relatedAlertIds: alert.relatedAlertIds,
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

/** Filtro de estado de alertas: `open` (y su alias histórico `active`) o un estado real. */
const ALERT_STATUS_FILTERS: readonly string[] = ['open', 'active', ...ALERT_STATUSES];
/** Incidentes `active`: todo lo que todavía requiere trabajo. */
const ACTIVE_INCIDENT_STATUSES: readonly IncidentStatus[] = INCIDENT_STATUSES.filter(
  (status) => status !== 'resolved' && status !== 'closed',
);

@Controller('api')
export class SocController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('alerts')
  public async alerts(
    @Req() request: IncomingRequest,
    @Query()
    query: PageQuery & { status?: string; q?: string; priority?: string; entity?: string },
  ) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('alerts.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const search = (query.q ?? '').trim().toLocaleLowerCase();
    if (search.length > 120) throw new ApiError('VALIDATION_FAILED', correlationId, ['q']);
    if (query.status && !ALERT_STATUS_FILTERS.includes(query.status)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['status']);
    }
    if (query.priority && !['P1', 'P2', 'P3', 'P4'].includes(query.priority)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['priority']);
    }
    // Solo referencias opacas: un UPN o una IP en la URL se rechazan (D-10b).
    const entity = query.entity?.trim();
    if (entity !== undefined && entity !== '' && !ENTITY_REF_PATTERN.test(entity)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['entity']);
    }
    const status =
      query.status === 'active' ? 'open' : (query.status as AlertStatus | 'open' | undefined);
    const result = await this.runtime.soc.listAlerts({
      tenantId: actor.tenantId,
      ...(status ? { status } : {}),
      ...(query.priority ? { priority: query.priority as Alert['priority'] } : {}),
      ...(search ? { search } : {}),
      ...(entity ? { entityRef: entity } : {}),
    });
    const page = paginate(
      result.items,
      (alert) => ({ at: alert.occurredAt.getTime(), id: alert.id }),
      query,
      `alerts:status=${query.status ?? ''}:q=${search}:priority=${query.priority ?? ''}:entity=${entity ?? ''}`,
      correlationId,
    );
    return {
      correlationId,
      items: page.items.map((alert) => alertView(alert, actor.capabilities)),
      nextCursor: page.nextCursor,
      totalCount: result.total,
    };
  }

  @Get('alerts/:id')
  public async alert(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const alert = await this.runtime.soc.alertById(actor.tenantId, id);
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
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
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
    this.runtime.dispatcher.kick();
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
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
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
    this.runtime.dispatcher.kick();
    return { correlationId, incident: incidentView(result.value) };
  }

  @Get('incidents/:id')
  public async incident(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const incident = await this.runtime.soc.incidentById(actor.tenantId, id);
    if (!incident || !actor.capabilities.has('incidents.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    return { correlationId, incident: incidentView(incident) };
  }

  @Get('incidents')
  public async incidents(
    @Req() request: IncomingRequest,
    @Query() query: PageQuery & { status?: string; q?: string },
  ) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('incidents.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const search = (query.q ?? '').trim().toLocaleLowerCase();
    if (search.length > 120) throw new ApiError('VALIDATION_FAILED', correlationId, ['q']);
    // Un estado desconocido no es error: devuelve un listado vacío, como antes.
    const statuses =
      query.status === 'active'
        ? ACTIVE_INCIDENT_STATUSES
        : query.status
          ? [query.status as IncidentStatus]
          : undefined;
    const result = await this.runtime.soc.listIncidents({
      tenantId: actor.tenantId,
      ...(statuses ? { statuses } : {}),
      ...(search ? { search } : {}),
    });
    const incidents = result.items;
    const page = paginate(
      incidents,
      (incident) => ({ at: incident.openedAt.getTime(), id: incident.id }),
      query,
      `incidents:status=${query.status ?? ''}:q=${search}`,
      correlationId,
    );
    return {
      correlationId,
      items: page.items.map(incidentView),
      nextCursor: page.nextCursor,
      totalCount: result.total,
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
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
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
    this.runtime.dispatcher.kick();
    return { correlationId, incident: incidentView(result.value) };
  }
}
