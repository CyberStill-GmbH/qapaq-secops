import { describe, expect, it } from 'vitest';

import {
  normalizeChannelTest,
  normalizeChannelsResponse,
} from '../../wazuh/dashboard/plugins/qapaq_ops/public/components/channels_contract';

describe('notification channel API contract adapter', () => {
  it('shows registry items and keeps the API ids for channel actions', () => {
    const result = normalizeChannelsResponse({
      correlationId: 'c-1',
      canManage: true,
      items: [
        {
          id: 'teams',
          enabled: true,
          configured: true,
          destination: 'https://workflows.example/***',
          status: 'ok',
          health: { lastSuccessAt: '2026-11-12T10:00:00.000Z' },
        },
        { id: 'email', enabled: true, configured: true, status: 'unknown', health: {} },
        { id: 'push', enabled: false, configured: false, status: 'not_configured', health: {} },
      ],
    });

    expect(result.channels.map((channel) => channel.id)).toEqual([
      'teams',
      'fallback_email',
      'manual_console',
    ]);
    expect(result.channels.map((channel) => channel.apiId)).toEqual(['teams', 'email', 'push']);
    expect(result.channels[0]).toMatchObject({
      configured: true,
      state: 'active',
      target: 'https://workflows.example/***',
    });
    expect(result.channels[1]?.state).toBe('unknown');
  });

  it('adapts the API test-result wrapper and preserves accepted versus failed', () => {
    expect(
      normalizeChannelTest({ result: { outcome: 'accepted', at: '2026-11-12T10:00:00Z' } }),
    ).toMatchObject({ ok: true, at: '2026-11-12T10:00:00Z' });
    expect(
      normalizeChannelTest({
        result: { outcome: 'failed', at: '2026-11-12T10:01:00Z', reason: 'HTTP_503' },
      }),
    ).toMatchObject({ ok: false, at: '2026-11-12T10:01:00Z', reason: 'HTTP_503' });
  });
});
