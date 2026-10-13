/**
 * Sprint 5 · S5-D10 — feed de cambios para datos en vivo.
 *
 * `GET /api/changes?after=<cursor>` es un long-poll: si ya hay cambios responde al momento y,
 * si no, retiene la petición hasta `HOLD_MS` (2,5 s) y responde en cuanto aparece uno. Se eligió sobre
 * SSE o WebSocket porque KrakenD CE corta toda respuesta a los 4 s; el ciclo
 * pedir → esperar → responder cabe dentro de ese límite y funciona con varias réplicas,
 * porque la fuente es PostgreSQL y no la memoria de un proceso.
 *
 * La fuente es la cadena de auditoría: toda mutación del SOC deja un AuditEvent con secuencia
 * por tenant, así el feed no puede perder un cambio que sí ocurrió ni anunciar uno que se
 * deshizo (la auditoría entra en la misma transacción). El feed dice solo **qué** cambió
 * (tipo, id, si es nuevo o actualizado); nunca el contenido, el actor ni el motivo. El
 * cliente recarga el recurso por su endpoint normal, que vuelve a aplicar autorización.
 * Cada tipo de recurso se filtra por su capability de lectura.
 */

import { Controller, Get, Inject, Query, Req } from '@nestjs/common';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

/**
 * Tiempo máximo de retención. El gateway corta a `GATEWAY_ENDPOINT_TIMEOUT` (4 s en el demo);
 * 2,5 s más una lectura deja margen para responder siempre antes del corte.
 */
const HOLD_MS = 2_500;
/** Intervalo entre lecturas mientras se retiene la petición. */
const POLL_MS = 400;
/** Cambios por respuesta; si quedan más, el cliente vuelve a pedir de inmediato. */
const BATCH = 200;
/** Atraso máximo tolerado; más allá conviene recargar la vista que reproducir el historial. */
const RESYNC_GAP = 500n;
const CURSOR_PATTERN = /^\d{1,19}$/u;

/** Capability de lectura que habilita ver cambios de cada tipo de recurso. */
const READ_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  alert: 'alerts.read',
  incident: 'incidents.read',
  incident_task: 'incidents.read',
  incident_note: 'incidents.read',
  notification: 'notifications.read',
  session: 'sessions.read',
  source: 'sources.health.read',
});

const CREATED_ACTIONS = /\.(created|open|added|ingested)$/u;

interface Change {
  readonly seq: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly kind: 'created' | 'updated';
  readonly at: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Controller('api/changes')
export class ChangesController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get()
  public async changes(@Req() request: IncomingRequest, @Query() query: { after?: string }) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const audit = this.runtime.audit;

    // Sin cursor: punto de partida, sin historial. La vista ya cargó su estado actual.
    if (query.after === undefined || query.after === '') {
      const head = await audit.head(actor.tenantId);
      return {
        correlationId,
        cursor: (head?.sequence ?? 0n).toString(),
        changes: [],
        resync: false,
      };
    }
    if (!CURSOR_PATTERN.test(query.after)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['after']);
    }
    const after = BigInt(query.after);
    const visible = (type: string) => {
      const capability = READ_CAPABILITY[type];
      return capability !== undefined && actor.capabilities.has(capability as never);
    };

    // Reloj real, no el del dominio: la retención es tiempo de red, no tiempo de negocio.
    const deadline = Date.now() + HOLD_MS;
    let cursor = after;
    for (;;) {
      const events = await audit.range(actor.tenantId, cursor + 1n, BATCH);
      if (events.length > 0) {
        const last = events.at(-1)!.sequence;
        // Un cliente muy atrasado recarga la vista en lugar de reproducir cientos de cambios.
        if (events.length === BATCH && last - after >= RESYNC_GAP) {
          const head = await audit.head(actor.tenantId);
          return {
            correlationId,
            cursor: (head?.sequence ?? last).toString(),
            changes: [],
            resync: true,
          };
        }
        const changes: Change[] = events
          .filter((event) => event.outcome === 'succeeded' && visible(event.resource.type))
          .map((event) => ({
            seq: event.sequence.toString(),
            resource: { type: event.resource.type, id: event.resource.id },
            kind: CREATED_ACTIONS.test(event.action) ? 'created' : 'updated',
            at: event.occurredAt.toISOString(),
          }));
        cursor = last;
        // Solo hubo cambios invisibles para este lector: se avanza el cursor y se sigue
        // esperando, así no recibe respuestas vacías en ráfaga.
        if (changes.length > 0 || events.length === BATCH) {
          return { correlationId, cursor: cursor.toString(), changes, resync: false };
        }
      }
      if (Date.now() + POLL_MS > deadline) break;
      await delay(POLL_MS);
    }
    return { correlationId, cursor: cursor.toString(), changes: [], resync: false };
  }
}
