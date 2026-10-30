/**
 * Asistente Claude — seudonimización de lo que sale hacia Anthropic.
 *
 * Decisión del dueño (SBS 504-2021, Ley 29733): ningún UPN, correo, IP, hostname ni nombre de
 * persona sale del núcleo hacia el proveedor del modelo. Todo texto o dato que se envía pasa por
 * aquí y cada entidad se reemplaza por la referencia opaca de D-10b (`ent_<22>`), la misma que
 * usa la consola para pivotar. La tabla `ref → valor en claro` vive solo en memoria del proceso,
 * dentro de la conversación, y se usa para re-resolver la respuesta que ve el analista.
 *
 * Tres fuentes de entidades, en este orden:
 *
 * 1. **Conocidas**: las que el núcleo ya identificó (claves `user:`/`ip:` de las alertas, el
 *    padrón del grupo SOC con nombre y UPN, la persona que conversa). Se reemplazan por texto
 *    exacto sin distinguir mayúsculas: así también caen los nombres de persona, que ninguna
 *    expresión regular reconoce con fiabilidad.
 * 2. **Por forma**: correos/UPN, IPv4/IPv6 (validadas con `node:net`), `DOMINIO\usuario` y
 *    nombres de host con dominio. Cubren lo que llega en texto libre (títulos de alerta, notas
 *    de la bitácora, el propio mensaje del analista).
 * 3. **Identificadores de personas del SOC** (asignado, dueño, autor): se envían como referencia
 *    `actor:` y nunca como OID.
 *
 * Se prefiere seudonimizar de más: un nombre de archivo con forma de dominio también se
 * reemplaza. Es reversible para el analista y no filtra nada al proveedor.
 */

import { isIPv4, isIPv6 } from 'node:net';

import type { EntityRefFactory } from '@qapaq/soc';

/** Mismo formato que `ENTITY_REF_PATTERN` (D-10b), sin anclas, para buscar dentro del texto. */
const REF_IN_TEXT = /ent_[A-Za-z0-9_-]{22}/gu;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}/gu;
const DOMAIN_ACCOUNT = /\b[A-Za-z0-9][A-Za-z0-9-]{0,14}\\[A-Za-z0-9._-]{1,64}/gu;
const IPV4_CANDIDATE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu;
/** Candidatos IPv6: se confirman con `isIPv6` para no confundir horas (`10:20:30`). */
const IPV6_CANDIDATE =
  /(?<![A-Za-z0-9:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![A-Za-z0-9:])/gu;
const HOSTNAME =
  /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}[A-Za-z0-9]\b/gu;

/** Nombres y UPN de menos de 3 caracteres no se buscan como texto: romperían palabras comunes. */
const MINIMUM_KNOWN_LABEL_LENGTH = 3;

export type PseudonymKind = 'user' | 'ip' | 'host' | 'person' | 'actor';

export interface Pseudonym {
  readonly ref: string;
  readonly kind: PseudonymKind;
  /** Valor en claro. Nunca se serializa hacia el proveedor. */
  readonly label: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Tabla de seudónimos de una conversación. No es compartida entre conversaciones ni personas:
 * cada una solo puede re-resolver lo que su propia conversación seudonimizó.
 */
export class ConversationPseudonymizer {
  private readonly byRef = new Map<string, Pseudonym>();
  private readonly refByKey = new Map<string, string>();
  /** Valores conocidos para el reemplazo exacto, del más largo al más corto. */
  private known: Array<{ readonly pattern: RegExp; readonly ref: string }> = [];

  public constructor(
    private readonly tenantId: string,
    private readonly refOf: EntityRefFactory,
  ) {}

  /** Seudónimo estable de una entidad; la clave sigue el formato `tipo:valor` de C-16. */
  public pseudonym(kind: PseudonymKind, label: string): string {
    const normalized = kind === 'person' || kind === 'actor' ? label : label.toLowerCase();
    const key = `${kind}:${normalized}`;
    const existing = this.refByKey.get(key);
    if (existing) return existing;
    const ref = this.refOf(this.tenantId, key);
    this.refByKey.set(key, ref);
    this.byRef.set(ref, { ref, kind, label });
    if (kind !== 'actor' && label.length >= MINIMUM_KNOWN_LABEL_LENGTH) {
      this.known.push({
        pattern: new RegExp(
          // Bordes de palabra explícitos: `\b` no reconoce letras acentuadas como letras. `@`
          // tampoco es borde: «Ana» no debe cortar «ana@qapaq.pe», que se reemplaza entero abajo.
          `(?<![\\p{L}\\p{N}_@.-])${escapeRegExp(label)}(?![\\p{L}\\p{N}_@-])`,
          'giu',
        ),
        ref,
      });
      this.known.sort((left, right) => right.pattern.source.length - left.pattern.source.length);
    }
    return ref;
  }

  /**
   * Registra una clave de entidad de C-16 (`user:…`, `ip:…`). Si la alerta trae su referencia,
   * se respeta para que el modelo y la consola hablen de la misma entidad.
   */
  public entity(entityKey: string, knownRef?: string | null): { ref: string; kind: string } {
    const separator = entityKey.indexOf(':');
    const kind = entityKey.slice(0, separator);
    const label = entityKey.slice(separator + 1);
    const pseudonymKind: PseudonymKind = kind === 'ip' ? 'ip' : kind === 'user' ? 'user' : 'host';
    const ref = this.pseudonym(pseudonymKind, label);
    if (knownRef && knownRef !== ref && !this.byRef.has(knownRef)) {
      this.byRef.set(knownRef, { ref: knownRef, kind: pseudonymKind, label });
    }
    return { ref: knownRef ?? ref, kind };
  }

  /** Persona del SOC (asignado, dueño, autor): solo su referencia, nunca el OID. */
  public actor(subjectId: string | null): string | null {
    return subjectId === null ? null : this.pseudonym('actor', subjectId);
  }

  /** Reemplaza toda entidad del texto por su referencia opaca. */
  public scrub(text: string): string {
    let result = text;
    for (const { pattern, ref } of this.known) result = result.replace(pattern, ref);
    result = result.replace(EMAIL, (match) => this.pseudonym('user', match));
    result = result.replace(DOMAIN_ACCOUNT, (match) => this.pseudonym('user', match));
    result = result.replace(IPV4_CANDIDATE, (match) =>
      isIPv4(match) ? this.pseudonym('ip', match) : match,
    );
    result = result.replace(IPV6_CANDIDATE, (match) =>
      isIPv6(match) ? this.pseudonym('ip', match) : match,
    );
    result = result.replace(HOSTNAME, (match) => this.pseudonym('host', match));
    return result;
  }

  /** Re-resuelve las referencias de esta conversación; las ajenas quedan como están. */
  public reveal(text: string): string {
    return text.replace(REF_IN_TEXT, (ref) => this.byRef.get(ref)?.label ?? ref);
  }

  /** Valor en claro de una referencia que el modelo pidió consultar (entrada de herramienta). */
  public resolve(ref: string): Pseudonym | undefined {
    return this.byRef.get(ref);
  }

  /** Cantidad de seudónimos, para métricas sin contenido. */
  public get size(): number {
    return this.byRef.size;
  }
}
