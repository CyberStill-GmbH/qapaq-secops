import { describe, expect, it, vi } from 'vitest';
import { GraphDirectoryReader } from '../src/runtime/graph-directory.js';

describe('Graph token rejection recovery', () => {
  it('retries once with refreshed permission-bearing token and prohibits redirects', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }), {
          status: 403,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ id: '00000000-0000-0000-0000-000000000001' }] })),
      );
    const refresh = vi.fn(async () => 'fresh-token');
    const reader = new GraphDirectoryReader({
      accessToken: async () => 'old-token',
      refreshRejectedToken: refresh,
      fetch: fetcher,
    });
    expect(await reader.resolveGroupId('Accesos_SOC')).toBe('00000000-0000-0000-0000-000000000001');
    expect(refresh).toHaveBeenCalledWith('old-token');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer fresh-token' },
    });
  });
  it('keeps denial diagnostic after a failed refresh, without retry loops', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }), {
          status: 403,
        }),
    );
    const reader = new GraphDirectoryReader({
      accessToken: async () => 'old',
      refreshRejectedToken: async () => 'new',
      fetch: fetcher,
    });
    await expect(reader.resolveGroupId('Accesos_SOC')).rejects.toMatchObject({
      code: 'DIRECTORY_PERMISSION_MISSING',
      diagnostic: { status: 403, operation: 'resolveGroupId' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('honors refresh cooldown and preserves authorization denial', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    const reader = new GraphDirectoryReader({
      accessToken: async () => 'old',
      refreshRejectedToken: async () => null,
      fetch: fetcher,
    });
    await expect(reader.resolveGroupId('Accesos_SOC')).rejects.toMatchObject({
      code: 'DIRECTORY_FORBIDDEN',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
