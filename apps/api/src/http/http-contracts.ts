/**
 * Forma mínima de la petición y la respuesta que usan los controladores.
 *
 * Los controladores no importan el servidor HTTP: solo el composition root conoce
 * Fastify (regla `clients-in-composition-root`). Declarar aquí lo que realmente se usa
 * mantiene esa frontera y deja explícito cuánto de la plataforma HTTP necesita el BFF,
 * que es poco: cabeceras, IP de la conexión y una respuesta encadenable.
 */

export type HeaderValue = string | readonly string[] | undefined;

export interface IncomingRequest {
  readonly headers: Readonly<Record<string, HeaderValue>>;
  /** IP de la conexión TCP. La política de proxies confiables vive en C-25. */
  readonly ip: string;
}

export interface OutgoingReply {
  status(code: number): OutgoingReply;
  header(name: string, value: string): OutgoingReply;
  send(body?: unknown): unknown;
}
