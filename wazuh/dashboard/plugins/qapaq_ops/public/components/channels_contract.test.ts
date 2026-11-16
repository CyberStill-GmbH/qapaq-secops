/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import {
  channelsDeliveryWarning,
  channelsLoadProblem,
  channelTestSuccessLabel,
  normalizeChannelTest,
  normalizeChannelsResponse,
} from './channels_contract';

describe('normalizeChannelsResponse', () => {
  it('uses the latest failed run and shows its failure reason', () => {
    const response = normalizeChannelsResponse({
      channels: [
        {
          id: 'teams',
          enabled: true,
          configured: true,
          health: {
            lastSuccessAt: '2026-11-12T10:00:00Z',
            lastFailureAt: '2026-11-12T11:00:00Z',
            lastFailureReason: 'HTTP 503',
          },
        },
      ],
    });

    expect(response.channels[0].lastDelivery).toEqual({
      ok: false,
      at: '2026-11-12T11:00:00Z',
      reason: 'HTTP 503',
    });
  });

  it('uses the latest successful run and omits the stale failure reason', () => {
    const response = normalizeChannelsResponse({
      channels: [
        {
          id: 'teams',
          enabled: true,
          configured: true,
          health: {
            lastSuccessAt: '2026-11-12T11:00:00Z',
            lastFailureAt: '2026-11-12T10:00:00Z',
            lastFailureReason: 'HTTP 503',
          },
        },
      ],
    });

    expect(response.channels[0].lastDelivery).toEqual({
      ok: true,
      at: '2026-11-12T11:00:00Z',
    });
  });
});

describe('registry DTO (items) with revision and setup state', () => {
  const response = normalizeChannelsResponse({
    items: [
      { id: 'teams', enabled: false, configured: false, status: 'not_configured', revision: 1, needsSetup: true, destination: null },
      { id: 'email', enabled: true, configured: true, status: 'unknown', revision: 4, needsSetup: true },
      { id: 'push', enabled: true, configured: true, status: 'ok', revision: 2, needsSetup: false },
    ],
  });

  it('keeps push addressable by its API id so it can be toggled and tested', () => {
    const push = response.channels[2];
    expect(push.apiId).toBe('push');
    expect(response.channels.map((channel) => channel.apiId)).toEqual(['teams', 'email', 'push']);
    expect(push.state).toBe('active');
  });

  it('carries revision and needsSetup for optimistic concurrency and first-run', () => {
    expect(response.channels.map((channel) => [channel.revision, channel.needsSetup])).toEqual([
      [1, true],
      [4, true],
      [2, false],
    ]);
    expect(response.channels[0].state).toBe('unconfigured');
  });

  it('warns only when neither Teams nor email can deliver', () => {
    expect(channelsDeliveryWarning(response.channels)).toBeNull();
    const none = normalizeChannelsResponse({
      items: [
        { id: 'teams', enabled: false, configured: false },
        { id: 'email', enabled: false, configured: true },
        { id: 'push', enabled: true, configured: true },
      ],
    });
    expect(channelsDeliveryWarning(none.channels)).toContain('Ningún canal externo');
    expect(channelsDeliveryWarning([])).toBeNull();
  });
});

describe('channelsLoadProblem', () => {
  it('tells a missing capability apart from an API that does not serve channels', () => {
    const notFound = { status: 404, code: 'RESOURCE_UNAVAILABLE' };
    expect(channelsLoadProblem(notFound, false)).toBe('forbidden');
    expect(channelsLoadProblem(notFound, true)).toBe('unavailable');
    expect(channelsLoadProblem({ status: 403, code: 'RESOURCE_UNAVAILABLE' }, true)).toBe('forbidden');
  });

  it('leaves other failures to the regular error state with retry', () => {
    expect(channelsLoadProblem({ status: 503, code: 'DEPENDENCY_DEGRADED' }, true)).toBeNull();
    expect(channelsLoadProblem(new Error('network'), true)).toBeNull();
    expect(channelsLoadProblem(null, true)).toBeNull();
  });
});

describe('normalizeChannelTest', () => {
  it('marks HTTP 202 as provider acceptance, not delivery', () => {
    const result = normalizeChannelTest({
      result: { ok: true, at: '2026-11-12T11:00:00Z', httpStatus: 202 },
    });
    expect(result).toEqual({
      ok: true,
      accepted: true,
      at: '2026-11-12T11:00:00Z',
    });
    expect(channelTestSuccessLabel(result)).toBe('Prueba aceptada por el proveedor');
    expect(channelTestSuccessLabel({ ...result, accepted: false })).toBe('Prueba correcta');
  });
});
