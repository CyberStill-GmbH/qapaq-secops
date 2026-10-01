/**
 * Serialización canónica para la cadena de hash de C-19.
 *
 * El hash de un AuditEvent debe ser reproducible por cualquier verificador, hoy y
 * dentro de siete años, sobre el mismo contenido lógico. `JSON.stringify` no sirve:
 * conserva el orden de inserción de claves, de modo que dos representaciones del
 * mismo evento producirían hashes distintos. Aquí el orden de claves es
 * lexicográfico, `undefined` se omite y los números no finitos se rechazan en lugar
 * de degradarse a `null`.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export class CanonicalizationError extends Error {
  public constructor(public readonly path: string) {
    super(`Valor no canonicalizable en ${path}.`);
    this.name = 'CanonicalizationError';
  }
}

export function canonicalize(value: CanonicalValue, path = '$'): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalizationError(path);
    // -0 y 0 son el mismo valor lógico; deben producir el mismo hash.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, CanonicalValue | undefined>)
      .filter((entry): entry is [string, CanonicalValue] => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`)
      .join(',')}}`;
  }
  throw new CanonicalizationError(path);
}
