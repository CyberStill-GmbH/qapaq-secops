/**
 * Analista IA — configuración por tenant, administrable desde la consola.
 *
 * La autonomía la concede el administrador con estos ajustes; el modelo nunca la amplía. Los
 * ajustes solo pueden restringir dentro de las guardas duras de `actions.ts` y de los límites
 * del despliegue: ningún valor aquí habilita cerrar un P1/P2 ni una acción de contención.
 */

import {
  INVESTIGATION_PRIORITIES,
  type InvestigationPriority,
  type InvestigationTerminalStatus,
} from './types.js';

export const ANALYST_MODES = ['shadow', 'assisted', 'autonomous'] as const;
/**
 * - `shadow`: solo planifica el informe.
 * - `assisted`: nunca cambia el estado de una alerta; recomienda y pide revisión humana.
 * - `autonomous`: puede ejecutar las acciones habilitadas, siempre con aviso a una persona.
 */
export type AnalystMode = (typeof ANALYST_MODES)[number];

export const REVIEW_NOTIFY_STATUSES = [
  'requires_review',
  'budget_exhausted',
  'usage_unreconciled',
  'partial',
  'failed',
] as const satisfies readonly InvestigationTerminalStatus[];
export type ReviewNotifyStatus = (typeof REVIEW_NOTIFY_STATUSES)[number];

export interface AnalystSettings {
  readonly enabled: boolean;
  readonly mode: AnalystMode;
  readonly scope: {
    /** Prioridades que el analista investiga. */
    readonly priorities: readonly InvestigationPriority[];
    /** Prioridad mínima que puede usar un modelo (`P2` ⇒ P1 y P2). */
    readonly inferenceMinPriority: 'P1' | 'P2' | 'P3';
  };
  readonly actions: {
    readonly escalate: boolean;
    readonly requestReview: boolean;
    readonly acknowledge: boolean;
    readonly closeBenign: boolean;
    readonly attachReport: boolean;
  };
  readonly escalation: {
    readonly minConfidence: 'medium' | 'high';
    readonly priorities: readonly InvestigationPriority[];
  };
  readonly closeBenign: {
    readonly maxPriority: 'P3' | 'P4';
    /** 3–50 cierres previos como falso positivo de la misma regla y entidad. */
    readonly minHistory: number;
  };
  readonly review: {
    readonly notifyPriorities: readonly InvestigationPriority[];
    readonly notifyOnStatuses: readonly ReviewNotifyStatus[];
    /** 1–60 pedidos inmediatos por hora; el exceso pasa al resumen periódico. */
    readonly maxImmediatePerHour: number;
  };
  readonly budget: {
    /** `null`: inferencia deshabilitada. Nunca supera el techo del despliegue. */
    readonly dailyCeilingMicroUsd: number | null;
    readonly maxOutputTokens: number;
    readonly advancedTierEnabled: boolean;
  };
  readonly reports: {
    readonly perRun: boolean;
    readonly digest: 'off' | 'daily';
    /** 0–23, hora de Lima. */
    readonly digestHourLima: number;
  };
  /** Orientación del administrador (≤ 1000 caracteres). No cambia el esquema ni las guardas. */
  readonly instructions: string;
}

export const ANALYST_SETTINGS_LIMITS = Object.freeze({
  minHistory: { min: 3, max: 50 },
  maxImmediatePerHour: { min: 1, max: 60 },
  maxOutputTokens: { min: 200, max: 4_000 },
  maxDailyCeilingMicroUsd: 1_000_000_000,
  maxInstructionsChars: 1_000,
});

export const DEFAULT_ANALYST_SETTINGS: AnalystSettings = Object.freeze({
  enabled: false,
  mode: 'shadow',
  scope: { priorities: ['P1', 'P2', 'P3', 'P4'], inferenceMinPriority: 'P2' },
  actions: {
    escalate: false,
    requestReview: true,
    acknowledge: false,
    closeBenign: false,
    attachReport: true,
  },
  escalation: { minConfidence: 'high', priorities: ['P1', 'P2'] },
  closeBenign: { maxPriority: 'P4', minHistory: 5 },
  review: {
    notifyPriorities: ['P1', 'P2'],
    notifyOnStatuses: ['requires_review', 'budget_exhausted', 'usage_unreconciled', 'failed'],
    maxImmediatePerHour: 6,
  },
  budget: { dailyCeilingMicroUsd: null, maxOutputTokens: 1_200, advancedTierEnabled: true },
  reports: { perRun: true, digest: 'daily', digestHourLima: 8 },
  instructions: '',
} satisfies AnalystSettings);

export type AnalystSettingsParseResult =
  | { readonly ok: true; readonly settings: AnalystSettings }
  | { readonly ok: false; readonly code: 'INVALID_SETTINGS'; readonly field: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class Invalid extends Error {
  public constructor(public readonly field: string) {
    super(field);
  }
}

function section(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Invalid(field);
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new Invalid(`${field}.${extra}`);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) throw new Invalid(`${field}.${missing}`);
  return value;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Invalid(field);
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Invalid(field);
  }
  return value as T;
}
function subset<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || value.length > allowed.length) throw new Invalid(field);
  const chosen = value.map((entry) => oneOf(entry, allowed, field));
  // Orden canónico y sin duplicados.
  return allowed.filter((entry) => chosen.includes(entry));
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Invalid(field);
  }
  return value;
}

/** Texto del administrador en una sola pasada: sin caracteres de control, acotado. */
export function scrubInstructions(value: string): string {
  return value
    .replace(/[^\P{Cc}\n]+/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Validador estricto: esquema cerrado, todos los campos presentes y acotados. */
export function parseAnalystSettings(input: unknown): AnalystSettingsParseResult {
  try {
    const root = section(input, 'settings', [
      'enabled',
      'mode',
      'scope',
      'actions',
      'escalation',
      'closeBenign',
      'review',
      'budget',
      'reports',
      'instructions',
    ]);
    const scope = section(root['scope'], 'scope', ['priorities', 'inferenceMinPriority']);
    const actions = section(root['actions'], 'actions', [
      'escalate',
      'requestReview',
      'acknowledge',
      'closeBenign',
      'attachReport',
    ]);
    const escalation = section(root['escalation'], 'escalation', ['minConfidence', 'priorities']);
    const closeBenign = section(root['closeBenign'], 'closeBenign', ['maxPriority', 'minHistory']);
    const review = section(root['review'], 'review', [
      'notifyPriorities',
      'notifyOnStatuses',
      'maxImmediatePerHour',
    ]);
    const budget = section(root['budget'], 'budget', [
      'dailyCeilingMicroUsd',
      'maxOutputTokens',
      'advancedTierEnabled',
    ]);
    const reports = section(root['reports'], 'reports', ['perRun', 'digest', 'digestHourLima']);
    const limits = ANALYST_SETTINGS_LIMITS;
    if (typeof root['instructions'] !== 'string') throw new Invalid('instructions');
    const instructions = scrubInstructions(root['instructions']);
    if (instructions.length > limits.maxInstructionsChars) throw new Invalid('instructions');
    const ceiling = budget['dailyCeilingMicroUsd'];

    return {
      ok: true,
      settings: {
        enabled: bool(root['enabled'], 'enabled'),
        mode: oneOf(root['mode'], ANALYST_MODES, 'mode'),
        scope: {
          priorities: subset(scope['priorities'], INVESTIGATION_PRIORITIES, 'scope.priorities'),
          inferenceMinPriority: oneOf(
            scope['inferenceMinPriority'],
            ['P1', 'P2', 'P3'] as const,
            'scope.inferenceMinPriority',
          ),
        },
        actions: {
          escalate: bool(actions['escalate'], 'actions.escalate'),
          requestReview: bool(actions['requestReview'], 'actions.requestReview'),
          acknowledge: bool(actions['acknowledge'], 'actions.acknowledge'),
          closeBenign: bool(actions['closeBenign'], 'actions.closeBenign'),
          attachReport: bool(actions['attachReport'], 'actions.attachReport'),
        },
        escalation: {
          minConfidence: oneOf(
            escalation['minConfidence'],
            ['medium', 'high'] as const,
            'escalation.minConfidence',
          ),
          priorities: subset(
            escalation['priorities'],
            INVESTIGATION_PRIORITIES,
            'escalation.priorities',
          ),
        },
        closeBenign: {
          maxPriority: oneOf(
            closeBenign['maxPriority'],
            ['P3', 'P4'] as const,
            'closeBenign.maxPriority',
          ),
          minHistory: integer(
            closeBenign['minHistory'],
            limits.minHistory.min,
            limits.minHistory.max,
            'closeBenign.minHistory',
          ),
        },
        review: {
          notifyPriorities: subset(
            review['notifyPriorities'],
            INVESTIGATION_PRIORITIES,
            'review.notifyPriorities',
          ),
          notifyOnStatuses: subset(
            review['notifyOnStatuses'],
            REVIEW_NOTIFY_STATUSES,
            'review.notifyOnStatuses',
          ),
          maxImmediatePerHour: integer(
            review['maxImmediatePerHour'],
            limits.maxImmediatePerHour.min,
            limits.maxImmediatePerHour.max,
            'review.maxImmediatePerHour',
          ),
        },
        budget: {
          dailyCeilingMicroUsd:
            ceiling === null
              ? null
              : integer(ceiling, 0, limits.maxDailyCeilingMicroUsd, 'budget.dailyCeilingMicroUsd'),
          maxOutputTokens: integer(
            budget['maxOutputTokens'],
            limits.maxOutputTokens.min,
            limits.maxOutputTokens.max,
            'budget.maxOutputTokens',
          ),
          advancedTierEnabled: bool(budget['advancedTierEnabled'], 'budget.advancedTierEnabled'),
        },
        reports: {
          perRun: bool(reports['perRun'], 'reports.perRun'),
          digest: oneOf(reports['digest'], ['off', 'daily'] as const, 'reports.digest'),
          digestHourLima: integer(reports['digestHourLima'], 0, 23, 'reports.digestHourLima'),
        },
        instructions,
      },
    };
  } catch (error) {
    if (error instanceof Invalid)
      return { ok: false, code: 'INVALID_SETTINGS', field: error.field };
    throw error;
  }
}

export interface StoredAnalystSettings {
  readonly tenantId: string;
  readonly settings: AnalystSettings;
  /** Compare-and-set de la consola; empieza en 1. */
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export interface AnalystSettingsStore {
  /** `undefined`: el tenant nunca guardó ajustes (rige `DEFAULT_ANALYST_SETTINGS`). */
  get(tenantId: string): Promise<StoredAnalystSettings | undefined>;
  /**
   * Compare-and-set: `expectedRevision` es la revisión leída (0 si aún no existe). Devuelve
   * `conflict` si otra persona guardó antes. Quien llama valida con `parseAnalystSettings`.
   */
  put(
    tenantId: string,
    settings: AnalystSettings,
    expectedRevision: number,
    by: string,
    at: Date,
  ): Promise<'ok' | 'conflict'>;
}

export class InMemoryAnalystSettingsStore implements AnalystSettingsStore {
  private readonly rows = new Map<string, StoredAnalystSettings>();

  public async get(tenantId: string): Promise<StoredAnalystSettings | undefined> {
    return this.rows.get(tenantId);
  }

  public async put(
    tenantId: string,
    settings: AnalystSettings,
    expectedRevision: number,
    by: string,
    at: Date,
  ): Promise<'ok' | 'conflict'> {
    const current = this.rows.get(tenantId);
    if ((current?.revision ?? 0) !== expectedRevision) return 'conflict';
    this.rows.set(tenantId, {
      tenantId,
      settings,
      revision: expectedRevision + 1,
      updatedAt: at,
      updatedBy: by,
    });
    return 'ok';
  }
}
