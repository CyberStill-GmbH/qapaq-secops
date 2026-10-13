/**
 * Lenguaje de consulta del explorador de eventos — gramática `qapaq-events-v1`.
 *
 * Es deliberadamente pequeño y **no** es SQL, PPL ni el DSL de búsqueda del proveedor: el navegador nunca
 * envía lenguaje del proveedor (events-read-through.md). El resultado del parser es el mismo
 * objeto de filtros neutrales que producen los filtros visuales, así ambos modos son
 * intercambiables y el backend compila siempre una consulta allowlisted.
 *
 * Gramática (espacios libres entre tokens; palabras clave y valores sin distinguir mayúsculas):
 *
 *   consulta   := vacío | predicado ( "AND" predicado )*
 *   predicado  := campo ":" valor ( "," valor )*
 *   campo      := "severity" | "category" | "outcome"
 *
 * - `severity`: `informational | low | medium | high | critical` (varios con coma = cualquiera).
 * - `category`: categorías del contrato salvo `unclassified` (varias con coma = cualquiera).
 * - `outcome`: `success | failure`, un solo valor.
 * - Un predicado por campo; como máximo 3 predicados y 16 valores por campo; 512 caracteres.
 * - Solo ASCII imprimible. No hay `OR`, `NOT`, paréntesis, comillas, comodines, regex,
 *   funciones, pipes, comentarios ni texto libre: cualquiera de ellos es un error con posición.
 *   Nunca se ignora un fragmento.
 *
 * Es puro (sin dependencias de Node): lo usan el BFF, que es la autoridad, y la consola, para
 * marcar errores en línea con posición y alternativas esperadas. El error nunca repite la
 * consulta: solo código, posición y lo que se esperaba.
 */

import { NORMALIZED_SEVERITIES, SECURITY_EVENT_CATEGORIES } from '../security-event/catalogs.js';

export const EVENTS_QUERY_GRAMMAR = 'qapaq-events-v1' as const;

export const EVENTS_QUERY_LIMITS = Object.freeze({
  maximumLength: 512,
  maximumPredicates: 3,
  maximumValuesPerField: 16,
  maximumTokens: 128,
});

export const EVENTS_QUERY_FIELDS = ['severity', 'category', 'outcome'] as const;
export type EventsQueryField = (typeof EVENTS_QUERY_FIELDS)[number];

/** Valores admitidos por campo, en el orden canónico. */
export const EVENTS_QUERY_VALUES: Readonly<Record<EventsQueryField, readonly string[]>> =
  Object.freeze({
    severity: NORMALIZED_SEVERITIES.filter((value) => value !== 'unknown'),
    category: SECURITY_EVENT_CATEGORIES.filter((value) => value !== 'unclassified'),
    outcome: ['success', 'failure'],
  });

export const EVENTS_QUERY_ERROR_CODES = [
  'TOO_LONG',
  'INVALID_CHARACTER',
  'UNEXPECTED_TOKEN',
  'UNSUPPORTED_OPERATOR',
  'UNKNOWN_FIELD',
  'UNKNOWN_VALUE',
  'DUPLICATE_FIELD',
  'DUPLICATE_VALUE',
  'SINGLE_VALUE_FIELD',
  'TOO_MANY_PREDICATES',
  'TOO_MANY_VALUES',
  'TOO_MANY_TOKENS',
  'INCOMPLETE',
] as const;
export type EventsQueryErrorCode = (typeof EVENTS_QUERY_ERROR_CODES)[number];

export interface EventsQueryFilters {
  readonly severity?: readonly string[];
  readonly category?: readonly string[];
  readonly outcome?: string;
}

export interface EventsQueryError {
  readonly code: EventsQueryErrorCode;
  /** Índice (base 0) del carácter donde se detectó el error. */
  readonly position: number;
  /** Lo que la gramática admitía en esa posición (p. ej. `[":"]` o los valores del campo). */
  readonly expected: readonly string[];
}

export type EventsQueryParse =
  | {
      readonly ok: true;
      readonly filters: EventsQueryFilters;
      /** Forma canónica: campos en orden fijo, valores ordenados, `AND` en mayúsculas. */
      readonly canonical: string;
    }
  | { readonly ok: false; readonly error: EventsQueryError };

type TokenKind = 'word' | 'colon' | 'comma';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly position: number;
}

const WORD = /[A-Za-z0-9_.-]/u;
/** ASCII imprimible más espacio, tabulador y saltos de línea. */
const ALLOWED = /^[\x20-\x7E\t\r\n]*$/u;
const UNSUPPORTED_KEYWORDS = new Set(['or', 'not', 'in', 'like', 'select', 'from', 'where']);

class QueryError extends Error {
  public constructor(public readonly detail: EventsQueryError) {
    super(detail.code);
  }
}

function fail(
  code: EventsQueryErrorCode,
  position: number,
  expected: readonly string[] = [],
): never {
  throw new QueryError({ code, position, expected });
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index]!;
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      index += 1;
      continue;
    }
    if (character === ':' || character === ',') {
      tokens.push({
        kind: character === ':' ? 'colon' : 'comma',
        text: character,
        position: index,
      });
      index += 1;
    } else if (WORD.test(character)) {
      const start = index;
      while (index < input.length && WORD.test(input[index]!)) index += 1;
      tokens.push({ kind: 'word', text: input.slice(start, index), position: start });
    } else {
      // Comillas, paréntesis, comodines, operadores, `;`, `|`, `=`, `/`…: fuera de la gramática.
      fail('INVALID_CHARACTER', index);
    }
    if (tokens.length > EVENTS_QUERY_LIMITS.maximumTokens) fail('TOO_MANY_TOKENS', index);
  }
  return tokens;
}

/** Analiza una consulta. Una consulta vacía (o solo espacios) es válida y no filtra nada. */
export function parseEventsQuery(input: string): EventsQueryParse {
  try {
    if (input.length > EVENTS_QUERY_LIMITS.maximumLength) {
      fail('TOO_LONG', EVENTS_QUERY_LIMITS.maximumLength);
    }
    if (!ALLOWED.test(input)) {
      const position = [...input].findIndex((character) => !ALLOWED.test(character));
      fail('INVALID_CHARACTER', Math.max(position, 0));
    }
    const tokens = tokenize(input);
    const filters: { severity?: string[]; category?: string[]; outcome?: string } = {};
    let cursor = 0;
    let predicates = 0;
    const end = input.length;
    const peek = () => tokens[cursor];

    while (cursor < tokens.length) {
      if (predicates > 0) {
        const joiner = peek()!;
        if (joiner.kind !== 'word' || joiner.text.toLowerCase() !== 'and') {
          if (joiner.kind === 'word' && UNSUPPORTED_KEYWORDS.has(joiner.text.toLowerCase())) {
            fail('UNSUPPORTED_OPERATOR', joiner.position, ['AND']);
          }
          fail('UNEXPECTED_TOKEN', joiner.position, ['AND']);
        }
        cursor += 1;
        if (cursor >= tokens.length) fail('INCOMPLETE', end, [...EVENTS_QUERY_FIELDS]);
      }

      const fieldToken = peek()!;
      if (fieldToken.kind !== 'word')
        fail('UNEXPECTED_TOKEN', fieldToken.position, [...EVENTS_QUERY_FIELDS]);
      const lowered = fieldToken.text.toLowerCase();
      if (UNSUPPORTED_KEYWORDS.has(lowered) || lowered === 'and') {
        fail('UNSUPPORTED_OPERATOR', fieldToken.position, [...EVENTS_QUERY_FIELDS]);
      }
      if (!(EVENTS_QUERY_FIELDS as readonly string[]).includes(lowered)) {
        fail('UNKNOWN_FIELD', fieldToken.position, [...EVENTS_QUERY_FIELDS]);
      }
      const field = lowered as EventsQueryField;
      if (filters[field] !== undefined) fail('DUPLICATE_FIELD', fieldToken.position);
      predicates += 1;
      if (predicates > EVENTS_QUERY_LIMITS.maximumPredicates) {
        fail('TOO_MANY_PREDICATES', fieldToken.position);
      }
      cursor += 1;

      const colon = peek();
      if (!colon) fail('INCOMPLETE', end, [':']);
      if (colon.kind !== 'colon') fail('UNEXPECTED_TOKEN', colon.position, [':']);
      cursor += 1;

      const allowed = EVENTS_QUERY_VALUES[field];
      const values: string[] = [];
      for (;;) {
        const valueToken = peek();
        if (!valueToken) fail('INCOMPLETE', end, allowed);
        if (valueToken.kind !== 'word') fail('UNEXPECTED_TOKEN', valueToken.position, allowed);
        const value = valueToken.text.toLowerCase();
        if (!allowed.includes(value)) fail('UNKNOWN_VALUE', valueToken.position, allowed);
        if (values.includes(value)) fail('DUPLICATE_VALUE', valueToken.position);
        values.push(value);
        if (values.length > EVENTS_QUERY_LIMITS.maximumValuesPerField) {
          fail('TOO_MANY_VALUES', valueToken.position);
        }
        cursor += 1;
        if (peek()?.kind !== 'comma') break;
        if (field === 'outcome') fail('SINGLE_VALUE_FIELD', peek()!.position);
        cursor += 1;
      }
      if (field === 'outcome') filters.outcome = values[0]!;
      else filters[field] = values;
    }
    return { ok: true, filters: canonicalFilters(filters), canonical: formatEventsQuery(filters) };
  } catch (error) {
    if (error instanceof QueryError) return { ok: false, error: error.detail };
    throw error;
  }
}

/** Filtros con valores en el orden canónico del catálogo, sin duplicados ni listas vacías. */
export function canonicalFilters(filters: EventsQueryFilters): EventsQueryFilters {
  const order = (field: 'severity' | 'category', values: readonly string[] | undefined) =>
    EVENTS_QUERY_VALUES[field].filter((value) => values?.includes(value));
  const severity = order('severity', filters.severity);
  const category = order('category', filters.category);
  return {
    ...(severity.length > 0 ? { severity } : {}),
    ...(category.length > 0 ? { category } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
  };
}

/**
 * Forma canónica de unos filtros (la misma que produce el parser). Permite sincronizar el
 * editor con los filtros visuales: `formatEventsQuery(parse(q).filters) === canonical`.
 */
export function formatEventsQuery(filters: EventsQueryFilters): string {
  const canonical = canonicalFilters(filters);
  const parts: string[] = [];
  if (canonical.severity) parts.push(`severity:${canonical.severity.join(',')}`);
  if (canonical.category) parts.push(`category:${canonical.category.join(',')}`);
  if (canonical.outcome) parts.push(`outcome:${canonical.outcome}`);
  return parts.join(' AND ');
}
