/**
 * Riesgo por entidad (servicio `qapaq-correlator`), de solo lectura para la consola y Qapaqzito.
 *
 * El correlador no publica puertos: esta API lo consulta por la red Docker privada con su token
 * de lectura y entrega una proyección con la misma sesión y capacidades que `/api/alerts`
 * (`alerts.read`). Como en D-10b, la URL solo lleva referencias opacas `ent_…`: el UPN o la IP
 * viajan en el cuerpo como `label`, nunca en la ruta ni en la query.
 */

import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { correlatorGet } from '../runtime/correlator-link.js';
import { ENTITY_REF_PATTERN } from '../runtime/entity-refs.js';
import { entityRiskLookup, type EntityRiskLookup } from '../runtime/entity-risk.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { rankAttention } from './attention-ranking.js';
import { readingActor } from './session-actor.js';
import { alertView } from './soc.controller.js';
import { SECOPS_RUNTIME } from './tokens.js';

const ENTITY_TYPES = new Set(['user', 'host', 'ip', 'cloud']);
const CANDIDATE_STATUSES = new Set(['proposed', 'emitted', 'suppressed', 'emit_failed']);

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function keyParts(key: string): { kind: string; label: string } | undefined {
  const separator = key.indexOf(':');
  if (separator <= 0) return undefined;
  const kind = key.slice(0, separator);
  return ENTITY_TYPES.has(kind) ? { kind, label: key.slice(separator + 1) } : undefined;
}

@Controller('api/risk')
export class RiskController {
  private riskLookup: EntityRiskLookup | undefined;

  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  private lookup(): EntityRiskLookup {
    this.riskLookup ??= entityRiskLookup({ link: this.runtime.correlatorRead });
    return this.riskLookup;
  }

  private async actor(request: IncomingRequest) {
    const resolved = await readingActor(this.runtime, request);
    if (
      !resolved.actor.capabilities.has('alerts.read') ||
      resolved.actor.tenantId !== this.runtime.tenantId
    ) {
      throw new ApiError('RESOURCE_UNAVAILABLE', resolved.correlationId);
    }
    return resolved;
  }

  private async read(path: string, correlationId: string): Promise<Json> {
    const link = this.runtime.correlatorRead;
    if (!link) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    let result;
    try {
      result = await correlatorGet(link, path);
    } catch {
      throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    }
    if (result.status === 404) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    if (result.status !== 200) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    return record(result.body);
  }

  private ref(key: string): string | null {
    return this.runtime.entityRefOf(this.runtime.tenantId, key) ?? null;
  }

  /** `{ref, kind, label}` de una clave `tipo:valor`; las claves internas no salen. */
  private entityOf(key: unknown) {
    if (typeof key !== 'string') return null;
    const parts = keyParts(key);
    return parts ? { ref: this.ref(key), kind: parts.kind, label: parts.label } : null;
  }

  private summary(item: unknown) {
    const entity = record(item);
    const key = typeof entity['key'] === 'string' ? entity['key'] : '';
    return {
      ...this.entityOf(key),
      score: entity['score'],
      breakdown: entity['breakdown'],
      peak: entity['peak'],
      peakAt: entity['peakAt'],
      firstSeen: entity['firstSeen'],
      lastSeen: entity['lastSeen'],
      observations: entity['observations'],
      suppressedObservations: entity['suppressedObservations'],
      sources: list(entity['sources']),
      tactics: list(entity['tactics']),
      criticality: entity['criticality'],
      candidateIds: list(entity['candidateIds']),
    };
  }

  private candidate(item: unknown) {
    const c = record(item);
    const entity = record(c['entity']);
    const key =
      typeof entity['type'] === 'string' && typeof entity['value'] === 'string'
        ? `${entity['type']}:${entity['value']}`
        : '';
    return {
      id: c['id'],
      kind: c['kind'],
      patternId: c['patternId'],
      title: c['title'],
      summary: c['summary'],
      entity: this.entityOf(key),
      relatedEntities: list(c['relatedEntityKeys'])
        .map((related) => this.entityOf(related))
        .filter((related) => related !== null),
      score: c['score'],
      riskScore: c['riskScore'],
      priority: c['priority'],
      signal: c['signal'],
      stages: list(c['stages']),
      memberCount: c['memberCount'],
      qapaqAlertIds: list(c['qapaqAlertIds']),
      sources: list(c['sources']),
      tactics: list(c['tactics']),
      firstSeen: c['firstSeen'],
      lastSeen: c['lastSeen'],
      status: c['status'],
      alertId: c['alertId'] ?? null,
      explanation: this.explanation(c['explanation']),
    };
  }

  /**
   * Explicación del candidato para la vista de investigación: patrón, etapas, entidades (con
   * referencia opaca y rol), ids de evidencia de Wazuh, aportes principales y próximos pasos.
   */
  private explanation(value: unknown) {
    const x = record(value);
    return {
      patternId: x['patternId'] ?? null,
      patternTitle: x['patternTitle'] ?? null,
      narrative: x['narrative'] ?? null,
      stages: list(x['stages']),
      entities: list(x['entities'])
        .map((item) => {
          const entity = record(item);
          const projected = this.entityOf(entity['key']);
          return projected
            ? { ...projected, role: entity['role'] === 'pivot' ? 'pivot' : 'related' }
            : null;
        })
        .filter((entity) => entity !== null),
      evidenceObservationIds: list(x['evidenceObservationIds']),
      topContributors: list(x['topContributors']),
      score: {
        base: x['scoreBase'] ?? null,
        diversityMultiplier: x['diversityMultiplier'] ?? null,
        progressionBonus: x['progressionBonus'] ?? null,
      },
      nextSteps: list(x['nextSteps']),
    };
  }

  /**
   * «Alertas que requieren atención» de la vista general: alertas abiertas ordenadas por
   * prioridad + riesgo de entidad del correlador + cadena, con un `why` corto por alerta.
   * Aditivo y degradable: sin correlador devuelve el orden histórico (prioridad y recencia) con
   * `riskAvailable: false` y sin error.
   */
  @Get('attention')
  public async attention(@Req() request: IncomingRequest, @Query() query: { limit?: string }) {
    const { actor, correlationId } = await this.actor(request);
    const limit = query.limit === undefined ? 6 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['limit']);
    }
    const open = await this.runtime.soc.listAlerts({ tenantId: actor.tenantId, status: 'open' });
    const risk = await this.lookup().snapshot();
    const ranked = rankAttention(open.items, risk, limit);
    return {
      correlationId,
      riskAvailable: risk.available,
      totalOpen: open.total,
      items: ranked.map(({ alert, attention }) => ({
        ...alertView(alert, actor.capabilities),
        attention: {
          score: attention.attentionScore,
          why: attention.why,
          entityRisk: attention.entityRisk,
        },
      })),
    };
  }

  /**
   * Propuestas del bucle de retroalimentación (veredictos de analistas → lista de permitidos,
   * degradación o revisión). Solo lectura para el líder SOC: aplicar una propuesta es un cambio
   * de detección por PR (CDB), nunca desde esta ruta.
   */
  @Get('feedback')
  public async feedback(@Req() request: IncomingRequest) {
    const { correlationId } = await this.actor(request);
    const body = await this.read('/v1/feedback', correlationId);
    return {
      correlationId,
      evaluatedAt: body['evaluatedAt'],
      verdicts: body['verdicts'],
      falsePositiveVerdicts: body['falsePositiveVerdicts'],
      truePositiveVerdicts: body['truePositiveVerdicts'],
      reviewCoverage: body['reviewCoverage'],
      reviewCoverageStatus: body['reviewCoverageStatus'],
      activeSuppressions: body['activeSuppressions'],
      cdbListName: body['cdbListName'],
      proposals: list(body['proposals']).map((item) => {
        const p = record(item);
        return {
          id: p['id'],
          kind: p['kind'],
          ruleId: p['ruleId'],
          entity: this.entityOf(p['entityKey']),
          falsePositives: p['falsePositives'],
          truePositives: p['truePositives'],
          ratio: p['ratio'],
          entities: p['entities'] ?? null,
          suppression: p['suppression'],
          protected: p['protected'] === true,
          reason: p['reason'],
          highestPriority: p['highestPriority'],
          thresholdAt: p['thresholdAt'],
          expiresAt: p['expiresAt'] ?? null,
        };
      }),
    };
  }

  @Get('entities')
  public async entities(
    @Req() request: IncomingRequest,
    @Query() query: { top?: string; type?: string },
  ) {
    const { correlationId } = await this.actor(request);
    const top = query.top === undefined ? 20 : Number(query.top);
    if (!Number.isInteger(top) || top < 1 || top > 100) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['top']);
    }
    if (query.type !== undefined && !ENTITY_TYPES.has(query.type)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['type']);
    }
    const body = await this.read(
      `/v1/entities?top=${top}${query.type ? `&type=${query.type}` : ''}`,
      correlationId,
    );
    return {
      correlationId,
      asOf: body['asOf'],
      ready: body['ready'] === true,
      threshold: body['threshold'],
      items: list(body['items']).map((item) => this.summary(item)),
    };
  }

  @Get('entities/:type/:value')
  public async entity(
    @Req() request: IncomingRequest,
    @Param('type') type: string,
    @Param('value') value: string,
  ) {
    const { correlationId } = await this.actor(request);
    // Solo referencias opacas: un UPN o una IP en la URL se rechazan (D-10b).
    if (!ENTITY_TYPES.has(type) || !ENTITY_REF_PATTERN.test(value)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['type', 'value']);
    }
    const keys = list((await this.read(`/v1/entities/keys?type=${type}`, correlationId))['keys']);
    const key = keys.find(
      (candidate) => typeof candidate === 'string' && this.ref(candidate) === value,
    );
    if (typeof key !== 'string') throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const body = await this.read(`/v1/entity?key=${encodeURIComponent(key)}`, correlationId);
    const detail = record(body['entity']);
    return {
      correlationId,
      asOf: body['asOf'],
      entity: {
        ...this.summary(detail),
        aliases: list(detail['aliases'])
          .map((alias) => this.entityOf(alias))
          .filter((alias) => alias !== null)
          .map((alias) => ({ kind: alias.kind, label: alias.label })),
        related: list(detail['related'])
          .map((related) => this.entityOf(related))
          .filter((related) => related !== null),
        contributors: list(detail['contributors']).map((item) => {
          const c = record(item);
          return {
            at: c['at'],
            ruleId: c['ruleId'],
            level: c['level'],
            description: c['description'],
            source: c['source'],
            tactics: list(c['tactics']),
            points: c['points'],
            suppressed: c['suppressed'] === true,
          };
        }),
        timeline: list(detail['timeline']),
      },
      candidates: list(body['candidates']).map((item) => this.candidate(item)),
    };
  }

  @Get('candidates')
  public async candidates(
    @Req() request: IncomingRequest,
    @Query() query: { status?: string; limit?: string },
  ) {
    const { correlationId } = await this.actor(request);
    if (query.status !== undefined && !CANDIDATE_STATUSES.has(query.status)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['status']);
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['limit']);
    }
    const body = await this.read(
      `/v1/candidates?limit=${limit}${query.status ? `&status=${query.status}` : ''}`,
      correlationId,
    );
    return {
      correlationId,
      asOf: body['asOf'],
      reduction: body['reduction'],
      items: list(body['items']).map((item) => this.candidate(item)),
    };
  }
}
