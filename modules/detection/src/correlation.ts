/**
 * C-16 — correlación por entidad sobre alertas QAPAQ.
 *
 * El motor de origen evalúa cada documento por separado: veinte alertas sobre la misma
 * cuenta son veinte filas en su consola. La correlación responde las preguntas que una alerta
 * aislada no puede responder:
 *
 * 1. ¿Qué otras alertas recientes comparten usuario o IP con esta? (agrupación)
 * 2. ¿Es la misma regla repitiéndose sobre la misma entidad? (repetición)
 * 3. ¿La secuencia encaja con un compromiso de cuenta: primero acceso a credenciales o
 *    inicio de sesión anómalo y después persistencia, escalamiento, evasión o
 *    exfiltración sobre el mismo usuario? (cadena)
 *
 * Todo es puro y determinista: recibe la ventana de alertas ya cargada por un puerto y
 * devuelve una señal que la priorización convierte en reason codes. No consulta bases ni
 * relojes, por eso es verificable con specs unitarias y reproducible en un replay.
 *
 * Límites deliberados del MVP:
 * - La correlación es sobre alertas promovidas, no sobre todo el volumen de eventos: lo
 *   que no llegó a alerta no participa. La regla del motor de origen debe elevar lo que
 *   importa.
 * - Las cadenas solo se buscan sobre identidades de usuario. Una IP compartida agrupa,
 *   pero no basta para afirmar que fue el mismo actor (NAT, proxies, VPN corporativa).
 */

import type { SecurityEvent } from '@qapaq/contracts';

export const CORRELATION_VERSION = '1.0.0' as const;

/**
 * Clase de señal de una alerta, alineada con tácticas MITRE ATT&CK. Es la unidad con la
 * que se describen las cadenas; la regla concreta del proveedor no importa aquí.
 */
export const SIGNAL_CLASSES = [
  'credential_access',
  'initial_access',
  'persistence',
  'privilege_escalation',
  'defense_evasion',
  'collection',
  'exfiltration',
  'other',
] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

/** Ventanas en milisegundos. Configurables por política, con estos valores por defecto. */
export interface CorrelationPolicy {
  /** Ventana para agrupar alertas relacionadas por entidad. */
  readonly groupingWindowMs: number;
  /** Ventana para contar la misma regla sobre la misma entidad. */
  readonly repetitionWindowMs: number;
  /** Ventana máxima entre el primer paso y el último de una cadena. */
  readonly chainWindowMs: number;
  /** Tope de alertas relacionadas que se registran; el resto se cuenta, no se lista. */
  readonly maximumRelated: number;
}

export const DEFAULT_CORRELATION_POLICY: CorrelationPolicy = Object.freeze({
  groupingWindowMs: 24 * 60 * 60 * 1000,
  repetitionWindowMs: 60 * 60 * 1000,
  chainWindowMs: 24 * 60 * 60 * 1000,
  maximumRelated: 50,
});

/** Lo mínimo que la correlación necesita saber de una alerta ya existente. */
export interface CorrelatableAlert {
  readonly id: string;
  readonly occurredAt: Date;
  readonly entityKeys: readonly string[];
  readonly signal: SignalClass | null;
  readonly ruleId: string | null;
}

export interface ChainMatch {
  readonly chainId: string;
  readonly description: string;
  /** Alertas previas que cumplen el primer paso de la cadena. */
  readonly precursorAlertIds: readonly string[];
}

export interface CorrelationSignal {
  readonly version: string;
  readonly entityKeys: readonly string[];
  readonly signal: SignalClass;
  readonly relatedAlertIds: readonly string[];
  readonly relatedCount: number;
  readonly recentSimilarCount: number;
  readonly chain?: ChainMatch;
}

/**
 * Catálogo `acción → clase de señal`. El dominio no conoce los nombres de operación de
 * ningún proveedor: el composition root entrega el catálogo de cada fuente conectada
 * (por ejemplo, las operaciones de la fuente de identidad y correo del MVP). Sin catálogo,
 * la clasificación cae a grupos de regla y categoría.
 */
export type SignalCatalog = Readonly<Record<string, SignalClass>>;

export const EMPTY_SIGNAL_CATALOG: SignalCatalog = Object.freeze({});

/**
 * Convención QAPAQ de grupos de regla: `qapaq_<táctica>`. Cualquier regla local de
 * cualquier fuente que declare uno de estos grupos se clasifica sin catálogo adicional.
 */
const SIGNAL_BY_GROUP: Readonly<Record<string, SignalClass>> = Object.freeze({
  qapaq_credential_access: 'credential_access',
  qapaq_initial_access: 'initial_access',
  qapaq_persistence: 'persistence',
  qapaq_privilege_escalation: 'privilege_escalation',
  qapaq_defense_evasion: 'defense_evasion',
  qapaq_collection: 'collection',
  qapaq_exfiltration: 'exfiltration',
  authentication_failures: 'credential_access',
  brute_force: 'credential_access',
});

const ACCESS_SIGNALS: ReadonlySet<SignalClass> = new Set(['credential_access', 'initial_access']);
const IMPACT_SIGNALS: ReadonlySet<SignalClass> = new Set([
  'persistence',
  'privilege_escalation',
  'defense_evasion',
  'collection',
  'exfiltration',
]);

export const ACCOUNT_COMPROMISE_CHAIN_ID = 'm365.account-compromise' as const;

/**
 * Claves de entidad estables: `user:<upn en minúsculas>` e `ip:<ip>`. Son el índice por
 * el que el adapter busca alertas recientes, así que su formato es parte del contrato de
 * persistencia (columna `entity_keys`).
 */
export function entityKeysOf(event: SecurityEvent): readonly string[] {
  const keys = new Set<string>();
  for (const identity of event.entities.identities) {
    const principal = identity.principal ?? identity.name;
    if (identity.kind === 'user' && principal) keys.add(`user:${principal.toLowerCase()}`);
  }
  for (const resource of event.entities.resources) {
    if (resource.kind === 'ip' && resource.id) keys.add(`ip:${resource.id.toLowerCase()}`);
  }
  return Object.freeze([...keys].sort());
}

/** Clasifica el evento: primero por grupo de regla QAPAQ, luego por acción, luego por categoría. */
export function signalOf(
  event: SecurityEvent,
  catalog: SignalCatalog = EMPTY_SIGNAL_CATALOG,
): SignalClass {
  for (const group of event.detection?.rule.groups ?? []) {
    const signal = SIGNAL_BY_GROUP[group.toLowerCase()];
    if (signal) return signal;
  }
  const byAction = event.action ? catalog[event.action] : undefined;
  if (byAction) return byAction;
  if (event.category.includes('authentication')) {
    return event.outcome === 'failure' ? 'credential_access' : 'initial_access';
  }
  return 'other';
}

function within(at: number, reference: number, windowMs: number): boolean {
  // Solo hacia atrás: una alerta posterior no puede ser precursora de esta.
  return at <= reference && reference - at <= windowMs;
}

/**
 * Correlaciona el evento con la ventana de alertas previas de su tenant. `recent` puede
 * traer alertas ajenas a la entidad (el adapter puede sobrecargar la consulta); aquí se
 * filtra de nuevo, de modo que la corrección no depende del adapter.
 */
export function correlate(
  event: SecurityEvent,
  recent: readonly CorrelatableAlert[],
  policy: CorrelationPolicy = DEFAULT_CORRELATION_POLICY,
  catalog: SignalCatalog = EMPTY_SIGNAL_CATALOG,
): CorrelationSignal {
  const entityKeys = entityKeysOf(event);
  const signal = signalOf(event, catalog);
  const ruleId = event.detection?.rule.id ?? null;
  const reference = new Date(event.occurredAt).getTime();
  const own = new Set(entityKeys);
  const userKeys = new Set(entityKeys.filter((key) => key.startsWith('user:')));

  const sharing = recent
    .filter((alert) => alert.entityKeys.some((key) => own.has(key)))
    // Orden estable: más reciente primero, desempate por id.
    .sort(
      (left, right) =>
        right.occurredAt.getTime() - left.occurredAt.getTime() || left.id.localeCompare(right.id),
    );

  const related = sharing.filter((alert) =>
    within(alert.occurredAt.getTime(), reference, policy.groupingWindowMs),
  );
  const recentSimilarCount = sharing.filter(
    (alert) =>
      ruleId !== null &&
      alert.ruleId === ruleId &&
      within(alert.occurredAt.getTime(), reference, policy.repetitionWindowMs),
  ).length;

  let chain: ChainMatch | undefined;
  if (IMPACT_SIGNALS.has(signal) && userKeys.size > 0) {
    const precursors = sharing.filter(
      (alert) =>
        alert.signal !== null &&
        ACCESS_SIGNALS.has(alert.signal) &&
        alert.entityKeys.some((key) => userKeys.has(key)) &&
        within(alert.occurredAt.getTime(), reference, policy.chainWindowMs),
    );
    if (precursors.length > 0) {
      chain = {
        chainId: ACCOUNT_COMPROMISE_CHAIN_ID,
        description:
          'Acceso a credenciales o inicio de sesión alertado seguido de cambio de ' +
          `${signal} sobre el mismo usuario.`,
        precursorAlertIds: precursors.slice(0, policy.maximumRelated).map((alert) => alert.id),
      };
    }
  }

  return {
    version: CORRELATION_VERSION,
    entityKeys,
    signal,
    relatedAlertIds: related.slice(0, policy.maximumRelated).map((alert) => alert.id),
    relatedCount: related.length,
    recentSimilarCount,
    ...(chain ? { chain } : {}),
  };
}

/**
 * Puerto de lectura para la correlación. El adapter devuelve alertas del tenant que
 * compartan al menos una clave y hayan ocurrido desde `since`; el tope protege la
 * consulta frente a una entidad ruidosa.
 */
export interface CorrelationWindowQuery {
  recentByEntities(
    tenantId: string,
    entityKeys: readonly string[],
    since: Date,
    limit: number,
  ): Promise<readonly CorrelatableAlert[]>;
}

/** Instante desde el que el adapter debe leer para cubrir todas las ventanas de la política. */
export function correlationHorizon(
  event: SecurityEvent,
  policy: CorrelationPolicy = DEFAULT_CORRELATION_POLICY,
): Date {
  const longest = Math.max(
    policy.groupingWindowMs,
    policy.repetitionWindowMs,
    policy.chainWindowMs,
  );
  return new Date(new Date(event.occurredAt).getTime() - longest);
}
