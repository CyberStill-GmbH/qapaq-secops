/**
 * Seudonimización de datos personales hacia el modelo (decisión N2, minimización).
 *
 * Correos e IPv4 se sustituyen por marcadores estables dentro de una conversación
 * (`<usuario_1>`, `<ip_2>`) antes de salir hacia el modelo, y se restituyen en la respuesta que ve
 * la persona. El modelo razona sobre «el mismo usuario» sin conocer su identidad real.
 *
 * Alcance honesto: solo cubre estos dos patrones. Nombres propios u otros identificadores que
 * aparezcan en texto libre no se detectan.
 */

// Cuantificadores acotados (RFC 5321: 64 local, 253 dominio): sin ellos, un texto largo sin «@»
// cuesta O(n²) en retrocesos (un resultado de herramienta de 50 kB tardaba segundos).
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/gu;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/gu;
const MARKER = /<(?:usuario|ip)_\d+>/gu;

export class Pseudonymizer {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();
  private readonly counters = { usuario: 0, ip: 0 };

  public constructor(private readonly enabled = true) {}

  private token(kind: 'usuario' | 'ip', value: string): string {
    const key = `${kind}:${value.toLowerCase()}`;
    const known = this.forward.get(key);
    if (known) return known;
    this.counters[kind] += 1;
    const marker = `<${kind}_${this.counters[kind]}>`;
    this.forward.set(key, marker);
    this.reverse.set(marker, value);
    return marker;
  }

  /** Texto hacia el modelo. */
  public mask(text: string): string {
    if (!this.enabled) return text;
    return text
      .replace(EMAIL, (match) => this.token('usuario', match))
      .replace(IPV4, (match) => this.token('ip', match));
  }

  /** Estructura JSON hacia el modelo: enmascara cada cadena (valores y claves). */
  public maskJson(value: unknown): unknown {
    return this.walk(value, (text) => this.mask(text));
  }

  /** Respuesta del modelo hacia la persona. */
  public unmask(text: string): string {
    if (!this.enabled || this.reverse.size === 0) return text;
    return text.replace(MARKER, (marker) => this.reverse.get(marker) ?? marker);
  }

  /** Argumentos de herramienta que pidió el modelo: vuelven a valores reales. */
  public unmaskJson(value: unknown): unknown {
    return this.walk(value, (text) => this.unmask(text));
  }

  private walk(value: unknown, map: (text: string) => string): unknown {
    if (!this.enabled) return value;
    if (typeof value === 'string') return map(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item, map));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          map(key),
          this.walk(item, map),
        ]),
      );
    }
    return value;
  }
}
