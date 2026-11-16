/** Internal, service-authenticated contract for the private deterministic correlator. */
import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import { constantTimeEquals } from '@qapaq/access';
import {
  candidateId,
  type DetectionCandidate,
  type Priority,
  type SignalClass,
} from '@qapaq/detection';
import { ingestCandidate } from '@qapaq/soc';
import { recordAudit } from '@qapaq/audit';
import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

const PRIORITIES = new Set<Priority>(['P1', 'P2', 'P3', 'P4']);
const SIGNALS = new Set<SignalClass>([
  'credential_access',
  'initial_access',
  'persistence',
  'privilege_escalation',
  'defense_evasion',
  'collection',
  'exfiltration',
  'other',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUDIT_ACTIONS = new Set([
  'risk.feedback.proposed',
  'risk.suppression.applied',
  'risk.suppression.expired',
]);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicateKeyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate?.code === 'P2002' ||
    candidate?.code === '23505' ||
    (candidate?.cause !== undefined && duplicateKeyError(candidate.cause))
  );
}

const STAGE = /^[a-z][a-z._]{2,39}$/u;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,119}$/u;
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,39}$/u;

type ExplanationReason = {
  code: 'ATTACK_CHAIN' | 'CORRELATED_ENTITY';
  delta: number;
  detail: string;
};

/**
 * Optional explanation of a correlated candidate (pattern stages, evidence ids, next steps). It
 * becomes extra alert reasons, which the console's investigation view and the notifications
 * already render. Returns `undefined` when the shape is invalid (the request is rejected).
 */
function explanationReasons(value: unknown): ExplanationReason[] | undefined {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) return undefined;
  const reasons: ExplanationReason[] = [];
  const narrative = value['narrative'];
  if (narrative !== undefined && narrative !== '') {
    if (!boundedText(narrative, 600)) return undefined;
    reasons.push({ code: 'ATTACK_CHAIN', delta: 0, detail: `Explicación: ${narrative.trim()}` });
  }
  const stages = value['stages'] ?? [];
  if (!Array.isArray(stages) || stages.length > 6) return undefined;
  for (const [index, raw] of stages.entries()) {
    if (!isRecord(raw)) return undefined;
    const at = typeof raw['at'] === 'string' ? new Date(raw['at']) : new Date('');
    const observationId = raw['observationId'] ?? '';
    if (
      typeof raw['stage'] !== 'string' ||
      !STAGE.test(raw['stage']) ||
      typeof raw['ruleId'] !== 'string' ||
      !RULE_ID.test(raw['ruleId']) ||
      typeof raw['source'] !== 'string' ||
      !SOURCE.test(raw['source']) ||
      Number.isNaN(at.getTime()) ||
      typeof observationId !== 'string' ||
      (observationId !== '' && !EVIDENCE_ID.test(observationId))
    ) {
      return undefined;
    }
    reasons.push({
      code: 'ATTACK_CHAIN',
      delta: 0,
      detail:
        `Etapa ${index + 1}: ${raw['stage']} · regla ${raw['ruleId']} · ${raw['source']} · ` +
        `${at.toISOString()}${observationId ? ` · evidencia wazuh:${observationId}` : ''}`,
    });
  }
  const evidence = value['evidenceObservationIds'] ?? [];
  if (
    !Array.isArray(evidence) ||
    evidence.length > 20 ||
    evidence.some((id) => typeof id !== 'string' || !EVIDENCE_ID.test(id))
  ) {
    return undefined;
  }
  if (evidence.length > 0) {
    reasons.push({
      code: 'CORRELATED_ENTITY',
      delta: 0,
      detail: `Evidencia (alertas Wazuh): ${(evidence as string[]).join(', ')}`.slice(0, 1200),
    });
  }
  const steps = value['nextSteps'] ?? [];
  if (!Array.isArray(steps) || steps.length > 4 || steps.some((step) => !boundedText(step, 300))) {
    return undefined;
  }
  for (const step of steps as string[]) {
    reasons.push({ code: 'CORRELATED_ENTITY', delta: 0, detail: `Siguiente paso: ${step.trim()}` });
  }
  return reasons;
}

@Controller('api/internal/correlator')
export class CorrelatorController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  private authenticate(request: IncomingRequest): string {
    const expected = this.runtime.correlatorServiceToken;
    const header = request.headers.authorization;
    const supplied =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!expected || expected.length < 32 || !constantTimeEquals(supplied, expected)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', randomUUID());
    }
    return randomUUID();
  }

  /** Compact, tenant-filtered verdict feedback. Raw Wazuh documents never leave the gateway. */
  @Get('alerts')
  public async alerts(@Req() request: IncomingRequest, @Query() query: { since?: string }) {
    const correlationId = this.authenticate(request);
    const since = query.since
      ? new Date(query.since)
      : new Date(this.runtime.now().getTime() - MAX_AGE_MS);
    const now = this.runtime.now();
    if (
      Number.isNaN(since.getTime()) ||
      since > now ||
      now.getTime() - since.getTime() > MAX_AGE_MS
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['since']);
    }
    const result = await this.runtime.soc.listAlerts({ tenantId: this.runtime.tenantId });
    const items = result.items
      .filter((alert) => alert.occurredAt >= since)
      .map((alert) => ({
        id: alert.id,
        ruleId: alert.ruleId ?? '',
        title: alert.title,
        priority: alert.priority,
        status: alert.status,
        verdict: alert.verdict ?? '',
        signal: alert.signal ?? '',
        entityKeys: alert.entityKeys,
        incidentId: alert.incidentId ?? '',
        occurredAt: alert.occurredAt.toISOString(),
        updatedAt: alert.updatedAt.toISOString(),
      }));
    return { items, truncated: result.total > result.items.length, correlationId };
  }

  /** Correlated candidates become normal QAPAQ alerts through the existing audited outbox path. */
  @Post('candidates')
  public async createCandidate(@Req() request: IncomingRequest, @Body() input: unknown) {
    const correlationId = this.authenticate(request);
    if (!isRecord(input)) throw new ApiError('VALIDATION_FAILED', correlationId, ['candidate']);
    const body = input;
    const occurredAt =
      typeof body['occurredAt'] === 'string' ? new Date(body['occurredAt']) : new Date('');
    const keys = body['entityKeys'];
    const related = body['relatedAlertIds'];
    if (
      !boundedText(body['idempotencyKey'], 256) ||
      body['idempotencyKey'].trim() !== body['idempotencyKey'] ||
      !boundedText(body['patternId'], 100) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(body['patternId']) ||
      !boundedText(body['title'], 240) ||
      !boundedText(body['summary'], 1200) ||
      !PRIORITIES.has(body['priority'] as Priority) ||
      !SIGNALS.has(body['signal'] as SignalClass) ||
      typeof body['score'] !== 'number' ||
      !Number.isInteger(body['score']) ||
      body['score'] < 0 ||
      body['score'] > 100 ||
      typeof body['riskScore'] !== 'number' ||
      !Number.isFinite(body['riskScore']) ||
      body['riskScore'] < 0 ||
      body['riskScore'] > 100 ||
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt.getTime() > this.runtime.now().getTime() + 60_000 ||
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > 8 ||
      keys.some((key) => !boundedText(key, 512) || !/^(user|host|ip|cloud):/u.test(key)) ||
      new Set(keys).size !== keys.length ||
      !Array.isArray(related) ||
      related.length > 50 ||
      related.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(related).size !== related.length
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['candidate']);
    }
    // IDs and domain idempotency are tenant-scoped and stable even if a retry has a changed
    // timestamp or content. The persisted tenant+key uniqueness is a second guard.
    const idem = createHash('sha256')
      .update(`qapaq-correlator\0${this.runtime.tenantId}\0${body['idempotencyKey']}`)
      .digest('hex');
    const idTimestamp = new Date(0);
    const id = candidateId(`qapaq-correlator|candidate|${idem}`, idTimestamp);
    const eventRecordId = candidateId(`qapaq-correlator|event|${idem}`, idTimestamp);
    for (const relatedId of related as string[]) {
      if (!(await this.runtime.soc.alertById(this.runtime.tenantId, relatedId))) {
        throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
      }
    }
    const explanation = explanationReasons(body['explanation']);
    if (explanation === undefined) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['explanation']);
    }
    const summary = body['summary'].trim();
    const score = Number(body['score']);
    // `riskScore` is currently validation-only: DetectionCandidate persists its integer
    // `score`, but has no distinct riskScore field. Do not imply the Go float is stored.
    const candidate: DetectionCandidate = {
      id,
      tenantId: this.runtime.tenantId,
      eventRecordId,
      eventUid: `qapaq-correlator:${idem}`,
      idempotencyKey: idem,
      priority: body['priority'] as Priority,
      score,
      reasons: [{ code: 'ATTACK_CHAIN', delta: score, detail: summary }, ...explanation],
      rulesetId: 'qapaq-correlator',
      rulesetVersion: '1.0.0',
      occurredAt,
      createdAt: this.runtime.now(),
      title: body['title'].trim(),
      entityKeys: keys as string[],
      signal: body['signal'] as SignalClass,
      ruleId: `qapaq-correlator:${body['patternId']}`,
      relatedAlertIds: related as string[],
    };
    const result = await ingestCandidate(
      this.runtime.socDependencies(),
      candidate,
      'system:qapaq-correlator',
    );
    if (!result.ok) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    this.runtime.dispatcher.kick();
    // Post-commit: el analista encola su investigación; un fallo no afecta esta respuesta.
    if (result.value.created) this.runtime.analyst?.alertCreated(result.value.alert);
    return { alertId: result.value.alert.id, created: result.value.created, correlationId };
  }

  /** Allowlisted, content-minimized feedback audit; deterministic event IDs make retries idempotent. */
  @Post('audit')
  public async audit(@Req() request: IncomingRequest, @Body() input: unknown) {
    const correlationId = this.authenticate(request);
    if (!isRecord(input)) throw new ApiError('VALIDATION_FAILED', correlationId, ['audit']);
    const body = input;
    const countsValid = ['falsePositives', 'truePositives'].every(
      (field) =>
        body[field] === undefined ||
        (typeof body[field] === 'number' &&
          Number.isSafeInteger(body[field]) &&
          body[field] >= 0 &&
          body[field] <= 1_000_000_000),
    );
    if (
      typeof body['action'] !== 'string' ||
      !AUDIT_ACTIONS.has(body['action']) ||
      !boundedText(body['resourceId'], 180) ||
      !boundedText(body['reason'], 1000) ||
      !boundedText(body['ruleId'], 100) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(body['ruleId']) ||
      !countsValid
    )
      throw new ApiError('VALIDATION_FAILED', correlationId, ['audit']);
    const action = body['action'] as string;
    const resourceId = body['resourceId'] as string;
    const identity = createHash('sha256')
      .update(`qapaq-correlator|audit|${this.runtime.tenantId}|${action}|${resourceId}`)
      .digest('hex');
    const eventId = candidateId(identity, new Date(0));
    const occurredAt = this.runtime.now();
    try {
      // The audit table's primary key is the cross-replica idempotency barrier. This read
      // also makes sequential retries idempotent for memory and other adapters that do not
      // enforce primary-key uniqueness themselves.
      let cursor: string | null = null;
      do {
        const existing = await this.runtime.soc.audit.read({
          tenantId: this.runtime.tenantId,
          from: new Date(0),
          to: occurredAt,
          pageSize: 200,
          cursor,
          action,
          actorId: null,
          resourceType: 'detection_feedback',
          resourceId,
          outcome: [],
          includeSensitive: true,
        });
        if (existing.events.some((event) => event.id === eventId)) {
          return { recorded: false, correlationId };
        }
        cursor = existing.nextCursor;
      } while (cursor);
      await recordAudit(this.runtime.soc.audit, {
        id: eventId,
        tenantId: this.runtime.tenantId,
        occurredAt: this.runtime.now(),
        actor: { id: 'system:qapaq-correlator', type: 'service' },
        action,
        resource: { type: 'detection_feedback', id: resourceId },
        outcome: 'succeeded',
        correlationId: identity,
        reason: String(body['reason']).slice(0, 1000),
        metadata: {
          ruleId: String(body['ruleId']).slice(0, 100),
          ...(Number.isInteger(body['falsePositives'])
            ? { falsePositives: Number(body['falsePositives']) }
            : {}),
          ...(Number.isInteger(body['truePositives'])
            ? { truePositives: Number(body['truePositives']) }
            : {}),
        },
      });
      return { recorded: true, correlationId };
    } catch (error) {
      if (duplicateKeyError(error)) return { recorded: false, correlationId };
      throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    }
  }
}
