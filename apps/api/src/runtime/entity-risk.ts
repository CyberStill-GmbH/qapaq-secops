/**
 * Riesgo de entidad del correlador QAPAQ como búsqueda en memoria (clave `tipo:valor` → riesgo).
 *
 * Alimenta dos consumidores que no deben depender de que el correlador esté arriba:
 * la cola «Alertas que requieren atención» (`/api/risk/attention`) y los avisos de Teams/correo.
 * Una sola consulta `/v1/entities?top=100` se reutiliza durante `ttlMs`; si falla, se devuelve
 * el último resultado bueno (hasta `staleMs`) y, si no hay ninguno, un mapa vacío: el llamador
 * degrada a su comportamiento anterior sin error.
 */

import { correlatorGet } from './correlator-link.js';

export interface EntityRisk {
  /** Puntaje del motor (puede superar 100; el umbral de candidato es `threshold`). */
  readonly score: number;
  readonly sources: readonly string[];
  readonly tactics: readonly string[];
  /** Candidatos (cadenas) del correlador en los que participa la entidad. */
  readonly candidateCount: number;
}

export interface EntityRiskSnapshot {
  readonly available: boolean;
  readonly byKey: ReadonlyMap<string, EntityRisk>;
}

export interface EntityRiskLookup {
  snapshot(): Promise<EntityRiskSnapshot>;
}

export const NO_ENTITY_RISK: EntityRiskSnapshot = { available: false, byKey: new Map() };

export function normalizeEntityKey(key: string): string {
  return key.trim().toLowerCase();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function parseEntityRisk(body: unknown): ReadonlyMap<string, EntityRisk> {
  const result = new Map<string, EntityRisk>();
  const raw = typeof body === 'object' && body !== null ? (body as { items?: unknown }).items : [];
  const items: unknown[] = Array.isArray(raw) ? raw : [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const key = entry['key'];
    const score = entry['score'];
    if (typeof key !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) continue;
    result.set(normalizeEntityKey(key), {
      score,
      sources: strings(entry['sources']),
      tactics: strings(entry['tactics']),
      candidateCount: strings(entry['candidateIds']).length,
    });
  }
  return result;
}

export function entityRiskLookup(input: {
  readonly link: { readonly baseUrl: string; readonly token: string } | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly staleMs?: number;
  readonly timeoutMs?: number;
  readonly get?: typeof correlatorGet;
}): EntityRiskLookup {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? 30_000;
  const staleMs = input.staleMs ?? 5 * 60_000;
  const get = input.get ?? correlatorGet;
  let good: { at: number; byKey: ReadonlyMap<string, EntityRisk> } | undefined;
  let failedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<EntityRiskSnapshot> | undefined;

  const lastGood = (): EntityRiskSnapshot =>
    good && now() - good.at <= staleMs ? { available: true, byKey: good.byKey } : NO_ENTITY_RISK;

  const refresh = async (link: { baseUrl: string; token: string }): Promise<EntityRiskSnapshot> => {
    try {
      const result = await get(link, '/v1/entities?top=100', input.timeoutMs ?? 2_500);
      if (result.status !== 200) throw new Error('correlator_unavailable');
      good = { at: now(), byKey: parseEntityRisk(result.body) };
      return { available: true, byKey: good.byKey };
    } catch {
      failedAt = now();
      return lastGood();
    }
  };

  return {
    async snapshot() {
      const link = input.link;
      if (!link) return NO_ENTITY_RISK;
      if (good && now() - good.at < ttlMs) return { available: true, byKey: good.byKey };
      // Tras un fallo no se reintenta durante unos segundos: evita que cada tarjeta o cada
      // carga de la vista espere el tiempo de espera completo con el correlador caído.
      if (now() - failedAt < 10_000) return lastGood();
      inflight ??= refresh(link).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
