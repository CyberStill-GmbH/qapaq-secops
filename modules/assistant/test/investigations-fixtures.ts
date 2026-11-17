/** Dobles y datos sintéticos compartidos por las specs del Analista IA. */

import type { AssistantModel, ModelRequest, ModelResponse } from '../src/ports.js';
import {
  DEFAULT_ANALYST_SETTINGS,
  fingerprintOf,
  POLICY_VERSION,
  type AnalystSettings,
  type Clock,
  type EvidenceAlert,
  type EvidenceBundle,
  type EvidenceReader,
  type InvestigationJob,
  type InvestigationRunnerLimits,
  type NewInvestigationJob,
  type RateCard,
  type SocActions,
} from '../src/investigations/index.js';

export const TENANT = 'tenant-analyst';
export const BASE = Date.UTC(2026, 10, 13, 15, 0, 0);

let sequence = 0;
export function uuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

export class FakeClock implements Clock {
  public constructor(private current = BASE) {}
  public now(): Date {
    return new Date(this.current);
  }
  public advance(ms: number): void {
    this.current += ms;
  }
}

export function alert(overrides: Partial<EvidenceAlert> = {}): EvidenceAlert {
  return {
    id: 'alert-1',
    title: 'Inicio de sesión inusual',
    priority: 'P2',
    status: 'new',
    ruleId: 'rule-100',
    signal: 'identity',
    score: 62,
    reasonCodes: ['BASE_SEVERITY'],
    occurredAt: '2026-11-13T14:55:00.000Z',
    entityRefs: ['ent_aaa'],
    verdict: null,
    relatedAlertIds: [],
    incidentId: null,
    source: 'siem',
    ...overrides,
  };
}

export function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    alerts: [alert()],
    relatedAlerts: [],
    candidate: null,
    history: { total: 0, falsePositive: 0, truePositive: 0, open: 0 },
    events: [
      {
        id: 'event-1',
        occurredAt: '2026-11-13T14:54:00.000Z',
        source: 'siem',
        category: 'authentication',
        action: 'login',
        outcome: 'success',
        entityRefs: ['ent_aaa'],
      },
    ],
    sourceHealth: [{ id: 'source-siem', label: 'SIEM', state: 'healthy', fresh: true }],
    completeness: {
      complete: true,
      truncated: false,
      alertsScanned: 1,
      eventsScanned: 1,
      gaps: [],
    },
    watermark: 'wm-1',
    ...overrides,
  };
}

export function draft(overrides: Partial<NewInvestigationJob> = {}): NewInvestigationJob {
  const id = overrides.id ?? uuid();
  const alertIds = overrides.alertIds ?? ['alert-1'];
  return {
    id,
    tenantId: TENANT,
    subject: {
      kind: 'alert',
      id: alertIds[0] ?? 'alert-1',
      title: 'Inicio de sesión inusual',
      ruleId: 'rule-100',
    },
    alertIds,
    priority: 'P2',
    trigger: 'system',
    initiatedBy: null,
    idempotencyKey: `key-${id}`,
    fingerprint: fingerprintOf(overrides.tenantId ?? TENANT, alertIds, 'wm-0', POLICY_VERSION),
    policyVersion: POLICY_VERSION,
    createdAt: new Date(BASE),
    ...overrides,
  };
}

export const RATE_CARD: RateCard = {
  version: 'test-card-1',
  tiers: {
    economy: {
      inputMicroUsdPerMTok: 1_000_000,
      outputMicroUsdPerMTok: 5_000_000,
      cacheReadMicroUsdPerMTok: 100_000,
      cacheWriteMicroUsdPerMTok: 1_250_000,
    },
    advanced: {
      inputMicroUsdPerMTok: 5_000_000,
      outputMicroUsdPerMTok: 25_000_000,
      cacheReadMicroUsdPerMTok: 500_000,
      cacheWriteMicroUsdPerMTok: 6_250_000,
    },
  },
};

export const LIMITS: InvestigationRunnerLimits = {
  leaseMs: 60_000,
  heartbeatMs: 60_000,
  maxAttempts: 3,
  dailyCeilingMicroUsd: 5_000_000,
  maxInputTokens: 4_000,
  maxOutputTokens: 1_200,
  deadlineMs: 30_000,
};

export function analystJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Actividad de autenticación coherente con un acceso real del usuario.',
    verdict: 'likely_true_positive',
    confidence: 'high',
    recommendedPriority: null,
    facts: [{ text: 'La alerta alert-1 registra un inicio de sesión.', citations: ['alert-1'] }],
    inferences: [{ text: 'Podría tratarse de un viaje.', citations: ['event-1'] }],
    gaps: ['No hay datos del dispositivo.'],
    nextSteps: ['Confirmar con la persona usuaria.'],
    ...overrides,
  });
}

export function response(
  text: string,
  stopReason: ModelResponse['stopReason'] = 'end_turn',
): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason,
    usage: { inputTokens: 900, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

export class FakeModel implements AssistantModel {
  public readonly requests: ModelRequest[] = [];
  public constructor(
    private readonly reply: (
      request: ModelRequest,
      signal: AbortSignal | undefined,
    ) => Promise<ModelResponse> | ModelResponse = () => response(analystJson()),
  ) {}
  public async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    this.requests.push(request);
    return this.reply(request, signal);
  }
}

export class FakeEvidence implements EvidenceReader {
  public calls = 0;
  public constructor(
    public next: (job: InvestigationJob) => Promise<EvidenceBundle> | EvidenceBundle = () =>
      bundle(),
  ) {}
  public async collect(job: InvestigationJob): Promise<EvidenceBundle> {
    this.calls += 1;
    return this.next(job);
  }
}

export function settings(overrides: Partial<AnalystSettings> = {}): AnalystSettings {
  return {
    ...DEFAULT_ANALYST_SETTINGS,
    enabled: true,
    budget: { dailyCeilingMicroUsd: 5_000_000, maxOutputTokens: 1_200, advancedTierEnabled: true },
    ...overrides,
  };
}

export const AUTONOMOUS: AnalystSettings = settings({
  mode: 'autonomous',
  actions: {
    escalate: true,
    requestReview: true,
    acknowledge: true,
    closeBenign: true,
    attachReport: true,
  },
  closeBenign: { maxPriority: 'P3', minHistory: 5 },
});

export class FakeSocActions implements SocActions {
  public readonly calls: string[] = [];
  public readonly reviews: { reason: string; urgency: string; groupKey: string }[] = [];
  public failOn: string | null = null;
  private step(name: string): void {
    this.calls.push(name);
    if (this.failOn === name) throw new Error('host exploded with secret data');
  }
  public async escalate(): Promise<{ incidentId?: string }> {
    this.step('escalate');
    return { incidentId: 'incident-9' };
  }
  public async acknowledge(): Promise<void> {
    this.step('acknowledge');
  }
  public async closeBenign(): Promise<void> {
    this.step('close_benign');
  }
  public async requestReview(
    _job: InvestigationJob,
    _result: unknown,
    review: { reason: string; urgency: string; groupKey: string },
  ): Promise<{ notificationId?: string }> {
    this.step('request_review');
    this.reviews.push(review);
    return { notificationId: 'notification-3' };
  }
  public async attachReport(): Promise<{ reportId?: string }> {
    this.step('report');
    return { reportId: 'report-5' };
  }
}
