/**
 * C-15 — guarda de etiquetas de métricas.
 *
 * Dos riesgos distintos se cierran aquí, y conviene no confundirlos:
 *
 * 1. **Fuga de datos.** Una etiqueta con IP, usuario, token o URL completa convierte el
 *    sistema de métricas —que suele tener permisos más laxos que la base— en una copia no
 *    gobernada de datos sensibles (ADR-021).
 * 2. **Cardinalidad.** Una etiqueta con valores no acotados multiplica las series hasta
 *    tumbar la recolección. El identificador de un evento nunca es una etiqueta.
 *
 * La política es allowlist: lo que no está declarado, no se emite.
 */

export const ALLOWED_LABEL_KEYS = [
  'component',
  'stage',
  'dataset',
  'source_kind',
  'severity',
  'outcome',
  'status',
  'result',
  'error_code',
  // C-26 — señales del flujo SOC y del borde de acceso. Todas son de dominio acotado:
  // prioridad, veredicto, canal, decisión y zona de red tienen valores enumerados.
  'priority',
  'verdict',
  'channel',
  'decision',
  'network_zone',
  'failure_class',
] as const;

export type AllowedLabelKey = (typeof ALLOWED_LABEL_KEYS)[number];

export const LABEL_VIOLATIONS = [
  'KEY_NOT_ALLOWED',
  'VALUE_EMPTY',
  'VALUE_TOO_LONG',
  'VALUE_NOT_SLUG',
  'VALUE_LOOKS_LIKE_IP',
  'VALUE_LOOKS_LIKE_PRINCIPAL',
  'VALUE_LOOKS_LIKE_URL',
  'VALUE_LOOKS_LIKE_SECRET',
  'VALUE_LOOKS_LIKE_IDENTIFIER',
] as const;

export type LabelViolation = (typeof LABEL_VIOLATIONS)[number];

export interface LabelRejection {
  readonly key: string;
  readonly violation: LabelViolation;
}

export const MAXIMUM_LABEL_VALUE_LENGTH = 64;

const SLUG = /^[a-z0-9][a-z0-9_.:-]*$/u;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/u;
const IPV6 = /(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}/iu;
const PRINCIPAL = /@/u;
const URL_LIKE = /(?:^[a-z][a-z0-9+.-]*:\/\/)|[?&]=?|\/\//iu;
const JWT = /^ey[A-Za-z0-9_-]{8,}\./u;
const LONG_HEX = /^[0-9a-f]{32,}$/iu;
const BEARER = /^(?:bearer|basic|token)\b/iu;
/**
 * Un identificador por evento o por registro produce una serie por evento: es la forma más
 * rápida de tumbar la recolección. Se detecta aparte de los secretos porque el remedio es
 * distinto: no se redacta, simplemente no es una etiqueta.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function inspectValue(value: string): LabelViolation | undefined {
  if (value.length === 0) return 'VALUE_EMPTY';
  if (value.length > MAXIMUM_LABEL_VALUE_LENGTH) return 'VALUE_TOO_LONG';
  if (UUID.test(value)) return 'VALUE_LOOKS_LIKE_IDENTIFIER';
  if (BEARER.test(value) || JWT.test(value) || LONG_HEX.test(value)) {
    return 'VALUE_LOOKS_LIKE_SECRET';
  }
  if (IPV4.test(value) || IPV6.test(value)) return 'VALUE_LOOKS_LIKE_IP';
  if (PRINCIPAL.test(value)) return 'VALUE_LOOKS_LIKE_PRINCIPAL';
  if (URL_LIKE.test(value)) return 'VALUE_LOOKS_LIKE_URL';
  // El slug se evalúa al final: así un valor sensible se reporta por lo que es y no por su
  // forma, que es lo que un operador necesita leer en el rechazo.
  if (!SLUG.test(value)) return 'VALUE_NOT_SLUG';
  return undefined;
}

export type LabelCheck =
  | { readonly ok: true; readonly labels: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly rejections: readonly LabelRejection[] };

/** Valida un juego completo de etiquetas y reporta todas las violaciones, no solo la primera. */
export function checkLabels(labels: Readonly<Record<string, unknown>>): LabelCheck {
  const rejections: LabelRejection[] = [];
  const accepted: Record<string, string> = {};

  for (const [key, raw] of Object.entries(labels)) {
    if (!(ALLOWED_LABEL_KEYS as readonly string[]).includes(key)) {
      rejections.push({ key, violation: 'KEY_NOT_ALLOWED' });
      continue;
    }
    const value = typeof raw === 'string' ? raw : String(raw);
    const violation = inspectValue(value);
    if (violation) {
      rejections.push({ key, violation });
      continue;
    }
    accepted[key] = value;
  }

  return rejections.length > 0
    ? { ok: false, rejections: Object.freeze(rejections) }
    : { ok: true, labels: Object.freeze(accepted) };
}

/**
 * Presupuesto de cardinalidad por clave. Una etiqueta válida en forma puede seguir siendo
 * peligrosa si toma miles de valores distintos; esto lo detecta en ejecución.
 */
export class CardinalityBudget {
  readonly #seen = new Map<string, Set<string>>();

  public constructor(private readonly maximumPerKey: number) {
    if (!Number.isInteger(maximumPerKey) || maximumPerKey < 1) {
      throw new RangeError('El presupuesto de cardinalidad debe ser un entero positivo.');
    }
  }

  /** `true` si el valor cabe en el presupuesto; `false` si la clave ya se desbordó. */
  public admit(key: string, value: string): boolean {
    let values = this.#seen.get(key);
    if (values === undefined) {
      values = new Set();
      this.#seen.set(key, values);
    }
    if (values.has(value)) return true;
    if (values.size >= this.maximumPerKey) return false;
    values.add(value);
    return true;
  }

  public cardinality(key: string): number {
    return this.#seen.get(key)?.size ?? 0;
  }

  public exceededKeys(): readonly string[] {
    return Object.freeze(
      [...this.#seen.entries()]
        .filter(([, values]) => values.size >= this.maximumPerKey)
        .map(([key]) => key),
    );
  }
}
