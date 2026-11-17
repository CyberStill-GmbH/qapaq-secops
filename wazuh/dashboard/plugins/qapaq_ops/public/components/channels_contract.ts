/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */

import type {
  NotificationChannelState,
  NotificationChannelTest,
  NotificationChannelView,
  NotificationChannelsResponse,
} from '../../common';

/** Adapts the registry DTO and the stable UI DTO without exposing webhook secrets. */
export function normalizeChannelsResponse(value: unknown): NotificationChannelsResponse {
  if (!isRecord(value)) return { channels: [] };
  const rows = Array.isArray(value.channels)
    ? value.channels
    : Array.isArray(value.items)
      ? value.items
      : [];
  return {
    channels: rows.flatMap((row): NotificationChannelView[] => {
      if (!isRecord(row)) return [];
      const apiId = row.id;
      const id = apiId === 'email' ? 'fallback_email' : apiId === 'push' ? 'manual_console' : apiId;
      if (id !== 'teams' && id !== 'fallback_email' && id !== 'manual_console') return [];
      const health = isRecord(row.health) ? row.health : {};
      const status = row.status;
      const state: NotificationChannelState = isChannelState(row.state)
        ? row.state
        : status === 'ok'
          ? 'active'
          : status === 'failing' || status === 'degraded'
            ? 'failing'
            : status === 'disabled'
              ? 'inactive'
              : status === 'unknown'
                ? 'unknown'
                : 'unconfigured';
      const successAt = stringOrNull(health.lastSuccessAt);
      const failureAt = stringOrNull(health.lastFailureAt);
      const successTime = parseTimestamp(successAt);
      const failureTime = parseTimestamp(failureAt);
      const latestIsSuccess =
        successAt !== null &&
        (failureAt === null ||
          (successTime !== null && (failureTime === null || successTime >= failureTime)));
      const lastAt = latestIsSuccess ? successAt : failureAt;
      return [
        {
          id,
          apiId: isApiChannelId(apiId) ? apiId : undefined,
          enabled: row.enabled === true,
          configured: row.configured === true,
          state,
          target: stringOrNull(row.target) ?? stringOrNull(row.destination),
          lastDelivery: lastAt
            ? {
                ok: latestIsSuccess,
                at: lastAt,
                ...(!latestIsSuccess && stringOrNull(health.lastFailureReason)
                  ? { reason: stringOrNull(health.lastFailureReason) }
                  : {}),
              }
            : null,
          ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
          ...(typeof row.updatedBy === 'string' ? { updatedBy: row.updatedBy } : {}),
          ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
          ...(typeof row.needsSetup === 'boolean' ? { needsSetup: row.needsSetup } : {}),
        },
      ];
    }),
  };
}

export type ChannelsLoadProblem = 'forbidden' | 'unavailable';

/**
 * The API answers 404/RESOURCE_UNAVAILABLE both when the caller lacks `notifications.read` and
 * when the channel registry is not served. The session capability tells them apart; any other
 * failure is a regular error with retry.
 */
export function channelsLoadProblem(error: unknown, canRead: boolean): ChannelsLoadProblem | null {
  if (!isRecord(error)) return null;
  if (error.status === 403) return 'forbidden';
  if (error.status === 404 || error.code === 'RESOURCE_UNAVAILABLE') {
    return canRead ? 'unavailable' : 'forbidden';
  }
  return null;
}

/**
 * Critical notices leave through Teams and, if Teams does not confirm, through email. Browser
 * push and the QAPAQ inbox do not count as external delivery.
 */
export function channelsDeliveryWarning(
  channels: readonly NotificationChannelView[],
): string | null {
  const external = channels.filter(
    (channel) => channel.id === 'teams' || channel.id === 'fallback_email',
  );
  if (external.length === 0) return null;
  if (external.some((channel) => channel.configured && channel.enabled)) return null;
  return 'Ningún canal externo (Teams o correo) puede entregar avisos críticos ahora. Hasta configurarlo y activarlo, solo quedan en la bandeja de QAPAQ.';
}

export function normalizeChannelTest(value: unknown): NotificationChannelTest {
  const body = isRecord(value) ? value : {};
  const result = isRecord(body.result) ? body.result : body;
  const failure = isRecord(result.failure) ? result.failure : {};
  const accepted = result.outcome === 'accepted' || result.httpStatus === 202;
  return {
    ok: result.ok === true || accepted,
    accepted,
    at: typeof result.at === 'string' ? result.at : new Date().toISOString(),
    ...(typeof result.reason === 'string'
      ? { reason: result.reason }
      : typeof failure.code === 'string'
        ? { reason: failure.code }
        : {}),
    ...(typeof result.latencyMs === 'number' ? { latencyMs: result.latencyMs } : {}),
  };
}

export function channelTestSuccessLabel(test: NotificationChannelTest): string {
  return test.accepted ? 'Prueba aceptada por el proveedor' : 'Prueba correcta';
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isApiChannelId(value: unknown): value is 'teams' | 'email' | 'push' {
  return value === 'teams' || value === 'email' || value === 'push';
}

function isChannelState(value: unknown): value is NotificationChannelState {
  return (
    value === 'active' ||
    value === 'inactive' ||
    value === 'failing' ||
    value === 'unconfigured' ||
    value === 'unknown'
  );
}
