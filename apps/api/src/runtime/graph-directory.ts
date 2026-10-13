/**
 * Sprint 5 · fase 3 — adapter de Microsoft Graph para el padrón (anti-corruption layer).
 *
 * Único lugar del API que conoce las URLs y formatos de Graph (C-23). Lectura solamente, con
 * token de aplicación (client credentials sobre `https://graph.microsoft.com/.default`) y
 * permiso mínimo `GroupMember.Read.All`; `accountEnabled` exige además `User.Read.All` y, si no
 * está concedido, se informa como desconocido en vez de fallar.
 *
 * - Miembros: `GET /groups/delta?$filter=id eq '<grupo>'&$select=members`. Graph entrega solo
 *   los ids en `members@delta`; los datos de cada alta se leen con `GET /users/<id>` (con
 *   concurrencia acotada). Una baja llega marcada con `@removed`. Miembros que no son usuarios
 *   (grupos anidados, dispositivos) se ignoran.
 * - Dueños: `GET /groups/<grupo>/owners/microsoft.graph.user`, paginado.
 * - Seguridad: los `nextLink` y `deltaLink` que se guardan y se reutilizan deben apuntar a
 *   `graph.microsoft.com`; si no, se rechazan (un estado alterado no puede redirigir el token).
 *   El token nunca se registra; las respuestas tienen tamaño máximo.
 * - Errores → `DirectoryError`: 429 `THROTTLED` (con `Retry-After`), 410 `DELTA_EXPIRED`,
 *   401/403 `FORBIDDEN`, 5xx o red `UNAVAILABLE`, forma inesperada `RESPONSE_INVALID`.
 */

import {
  DirectoryError,
  type DirectoryPerson,
  type DirectoryReader,
  type MemberChange,
  type MemberDeltaPage,
} from '@qapaq/access';

const GRAPH = 'https://graph.microsoft.com';
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_LOOKUP_CONCURRENCY = 4;
const MAXIMUM_OWNER_PAGES = 20;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface GraphDirectoryOptions {
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

type Json = Record<string, unknown>;

function trustedGraphUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw, GRAPH);
  } catch {
    throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
  }
  if (url.origin !== GRAPH) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
  return url;
}

function person(value: Json, includeEnabled: boolean): DirectoryPerson | undefined {
  const oid = value['id'];
  if (typeof oid !== 'string' || !GUID.test(oid)) return undefined;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null);
  return {
    oid: oid.toLowerCase(),
    displayName: text('displayName'),
    upn: text('userPrincipalName'),
    accountEnabled:
      includeEnabled && typeof value['accountEnabled'] === 'boolean'
        ? (value['accountEnabled'] as boolean)
        : null,
  };
}

export class GraphDirectoryReader implements DirectoryReader {
  /** `false` tras un 403 en `accountEnabled`: no se vuelve a pedir en este proceso. */
  #canReadAccountEnabled = true;

  public constructor(private readonly options: GraphDirectoryOptions) {}

  async #get(url: URL): Promise<Json> {
    const token = await this.options.accessToken();
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DirectoryError('DIRECTORY_UNAVAILABLE');
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new DirectoryError(
        'DIRECTORY_THROTTLED',
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined,
      );
    }
    if (response.status === 410) throw new DirectoryError('DIRECTORY_DELTA_EXPIRED');
    if (response.status === 401 || response.status === 403) {
      throw new DirectoryError('DIRECTORY_FORBIDDEN');
    }
    if (!response.ok) throw new DirectoryError('DIRECTORY_UNAVAILABLE');
    const text = await response.text();
    if (text.length > MAXIMUM_RESPONSE_BYTES)
      throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Json;
    } catch {
      throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
    }
  }

  async #user(oid: string): Promise<DirectoryPerson | undefined> {
    const select = this.#canReadAccountEnabled
      ? 'id,displayName,userPrincipalName,accountEnabled'
      : 'id,displayName,userPrincipalName';
    const url = trustedGraphUrl(`/v1.0/users/${encodeURIComponent(oid)}?$select=${select}`);
    try {
      return person(await this.#get(url), this.#canReadAccountEnabled);
    } catch (error) {
      // Sin User.Read.All, pedir `accountEnabled` da 403: se reintenta sin ese campo.
      if (
        error instanceof DirectoryError &&
        error.code === 'DIRECTORY_FORBIDDEN' &&
        this.#canReadAccountEnabled
      ) {
        this.#canReadAccountEnabled = false;
        return this.#user(oid);
      }
      throw error;
    }
  }

  public async readMemberDelta(groupId: string, cursor: string | null): Promise<MemberDeltaPage> {
    if (!GUID.test(groupId)) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
    const url = cursor
      ? trustedGraphUrl(cursor)
      : trustedGraphUrl(
          `/v1.0/groups/delta?$filter=${encodeURIComponent(`id eq '${groupId}'`)}&$select=members`,
        );
    const body = await this.#get(url);
    const groups = Array.isArray(body['value']) ? (body['value'] as Json[]) : undefined;
    if (!groups) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');

    const removed: string[] = [];
    const added: string[] = [];
    for (const group of groups) {
      if (typeof group['id'] !== 'string' || group['id'].toLowerCase() !== groupId.toLowerCase())
        continue;
      const members = group['members@delta'];
      if (!Array.isArray(members)) continue;
      for (const member of members as Json[]) {
        const type = member['@odata.type'];
        const oid = member['id'];
        if (type !== '#microsoft.graph.user' || typeof oid !== 'string' || !GUID.test(oid))
          continue;
        if (member['@removed'] !== undefined) removed.push(oid.toLowerCase());
        else added.push(oid.toLowerCase());
      }
    }

    const changes: MemberChange[] = removed.map((oid) => ({ kind: 'removed', oid }));
    for (let index = 0; index < added.length; index += USER_LOOKUP_CONCURRENCY) {
      const batch = added.slice(index, index + USER_LOOKUP_CONCURRENCY);
      const people = await Promise.all(batch.map((oid) => this.#user(oid)));
      for (const found of people) if (found) changes.push({ kind: 'upsert', person: found });
    }

    const next = body['@odata.nextLink'];
    const delta = body['@odata.deltaLink'];
    return {
      changes,
      ...(typeof next === 'string' ? { nextLink: trustedGraphUrl(next).toString() } : {}),
      ...(typeof delta === 'string' ? { deltaLink: trustedGraphUrl(delta).toString() } : {}),
    };
  }

  /**
   * Object ID del grupo por su nombre exacto (cuando el despliegue no conoce el ID). Debe haber
   * exactamente un grupo con ese nombre: ninguno o varios es un error, nunca se elige uno.
   * Las comillas simples se duplican según la sintaxis de `$filter` de OData.
   */
  public async resolveGroupId(displayName: string): Promise<string> {
    const filter = `displayName eq '${displayName.replaceAll("'", "''")}'`;
    const body = await this.#get(
      trustedGraphUrl(`/v1.0/groups?$filter=${encodeURIComponent(filter)}&$select=id&$top=2`),
    );
    const groups = Array.isArray(body['value']) ? (body['value'] as Json[]) : [];
    const id = groups[0]?.['id'];
    if (groups.length !== 1 || typeof id !== 'string' || !GUID.test(id)) {
      throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
    }
    return id.toLowerCase();
  }

  public async readOwners(groupId: string): Promise<readonly DirectoryPerson[]> {
    if (!GUID.test(groupId)) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
    const owners: DirectoryPerson[] = [];
    let url: URL | undefined = trustedGraphUrl(
      `/v1.0/groups/${groupId}/owners/microsoft.graph.user?$select=id,displayName,userPrincipalName&$top=100`,
    );
    for (let page = 0; url && page < MAXIMUM_OWNER_PAGES; page += 1) {
      const body = await this.#get(url);
      if (!Array.isArray(body['value'])) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
      for (const value of body['value'] as Json[]) {
        const found = person(value, false);
        if (found) owners.push(found);
      }
      const next = body['@odata.nextLink'];
      url = typeof next === 'string' ? trustedGraphUrl(next) : undefined;
    }
    // Más páginas que el tope: lectura incompleta, no se reemplaza el conjunto de dueños.
    if (url) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
    return owners;
  }
}
