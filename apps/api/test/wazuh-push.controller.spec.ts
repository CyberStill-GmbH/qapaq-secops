import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { WazuhPushHint } from '@qapaq/soc';
import type { IncomingRequest } from '../src/http/http-contracts.js';
import { WazuhPushController } from '../src/soc/wazuh-push.controller.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const SECRET = 'unit-test-secret';
const BODY = {
  alertId: 'alert-123',
  managerName: 'wazuh-manager',
  occurredAt: '2026-11-11T11:59:59.000+0000',
};
const CROSS_LANGUAGE_VECTOR = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/wazuh-push-hmac-vector.json'), 'utf8'),
) as {
  secret: string;
  timestamp: string;
  body: typeof BODY;
  canonicalBody: string;
  signature: string;
};

function signedRequest(
  body: unknown = BODY,
  timestamp = String(Math.floor(NOW.getTime() / 1_000)),
) {
  const canonical = JSON.stringify(BODY);
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonical}`, 'utf8')
    .digest('hex');
  const request: IncomingRequest = {
    headers: { 'x-qapaq-timestamp': timestamp, 'x-qapaq-signature': `sha256=${signature}` },
    ip: '127.0.0.1',
  };
  return { body, request };
}

function harness(overrides: Record<string, unknown> = {}) {
  const acceptWazuhPushHint = vi.fn(
    async (_hint: WazuhPushHint): Promise<'inserted' | 'duplicate' | 'reopened-terminal'> =>
      'inserted',
  );
  const runtime = {
    wazuhPushSecret: SECRET,
    canAcceptWazuhPush: true,
    now: () => NOW,
    acceptWazuhPushHint,
    ...overrides,
  } as unknown as SecOpsRuntime;
  return { controller: new WazuhPushController(runtime), acceptWazuhPushHint };
}

async function expectStatus(action: () => Promise<unknown>, status: number) {
  try {
    await action();
    throw new Error(`expected HTTP ${status}`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
  }
}

describe('POST /api/ingest/wazuh controller', () => {
  it('accepts the shared canonical HMAC vector emitted by the Python integration', async () => {
    const { controller, acceptWazuhPushHint } = harness({
      wazuhPushSecret: CROSS_LANGUAGE_VECTOR.secret,
    });
    const { body, timestamp, canonicalBody, signature } = CROSS_LANGUAGE_VECTOR;
    expect(JSON.stringify(body)).toBe(canonicalBody);
    expect(
      createHmac('sha256', CROSS_LANGUAGE_VECTOR.secret)
        .update(`${timestamp}.${canonicalBody}`, 'utf8')
        .digest('hex'),
    ).toBe(signature);
    const request: IncomingRequest = {
      headers: {
        'x-qapaq-timestamp': timestamp,
        'x-qapaq-signature': `sha256=${signature}`,
      },
      ip: '127.0.0.1',
    };

    await expect(controller.wake(request, body)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      requeued: false,
      mode: 'durable-inbox',
    });
    expect(acceptWazuhPushHint).toHaveBeenCalledWith({
      ...body,
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('acknowledges only after durable acceptance and returns duplicate state', async () => {
    const { controller, acceptWazuhPushHint } = harness();
    acceptWazuhPushHint.mockResolvedValueOnce('duplicate');
    const { body, request } = signedRequest();

    await expect(controller.wake(request, body)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      requeued: false,
      mode: 'durable-inbox',
    });
    expect(acceptWazuhPushHint).toHaveBeenCalledWith({
      ...BODY,
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('reports when an exact authenticated redelivery reopens a terminal receipt', async () => {
    const { controller, acceptWazuhPushHint } = harness();
    acceptWazuhPushHint.mockResolvedValueOnce('reopened-terminal');
    const { body, request } = signedRequest();

    await expect(controller.wake(request, body)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      requeued: true,
      mode: 'durable-inbox',
    });
  });

  it('does not acknowledge when the inbox commit fails', async () => {
    const { controller } = harness({
      acceptWazuhPushHint: vi.fn(async () => {
        throw new Error('database internals must not escape');
      }),
    });
    const { body, request } = signedRequest();

    await expectStatus(() => controller.wake(request, body), 503);
  });

  it('rejects tampered, stale and missing signatures before enqueue', async () => {
    const { controller, acceptWazuhPushHint } = harness();
    const original = signedRequest();
    const tampered = {
      ...original,
      request: {
        ...original.request,
        headers: { ...original.request.headers, 'x-qapaq-signature': `sha256=${'0'.repeat(64)}` },
      },
    };
    const stale = signedRequest(BODY, String(Math.floor(NOW.getTime() / 1_000) - 301));
    const missing: IncomingRequest = { headers: {}, ip: '127.0.0.1' };

    await expectStatus(() => controller.wake(tampered.request, tampered.body), 401);
    await expectStatus(() => controller.wake(stale.request, stale.body), 401);
    await expectStatus(() => controller.wake(missing, BODY), 401);
    expect(acceptWazuhPushHint).not.toHaveBeenCalled();
  });

  it('rejects unapproved fields and nested alert payloads before enqueue', async () => {
    const { controller, acceptWazuhPushHint } = harness();
    const { request } = signedRequest();

    await expectStatus(
      () => controller.wake(request, { ...BODY, full_log: 'must not be accepted' }),
      400,
    );
    await expectStatus(
      () => controller.wake(request, { ...BODY, managerName: { name: 'nested' } }),
      400,
    );
    expect(acceptWazuhPushHint).not.toHaveBeenCalled();
  });

  it('keeps the route unavailable without a durable inbox processor', async () => {
    const { controller, acceptWazuhPushHint } = harness({ canAcceptWazuhPush: false });
    const { body, request } = signedRequest();

    await expectStatus(() => controller.wake(request, body), 404);
    expect(acceptWazuhPushHint).not.toHaveBeenCalled();
  });
});
