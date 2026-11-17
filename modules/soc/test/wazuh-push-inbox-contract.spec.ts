import { createHash } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PrismaWazuhPushInboxStore } from '@qapaq/database';

import {
  assertWazuhPushHint,
  type WazuhPushHint,
  type WazuhPushInboxStore,
} from '../src/wazuh-push-inbox.js';

function hint(overrides: Partial<WazuhPushHint> = {}): WazuhPushHint {
  const identity = overrides.alertId ?? 'alert-1';
  return {
    managerName: 'manager-a',
    alertId: identity,
    occurredAt: '2026-11-11T12:00:00.123+0000',
    idempotencyKey: createHash('sha256')
      .update(`manager-a|${identity}|2026-11-11T12:00:00.123+0000`)
      .digest('hex'),
    ...overrides,
  };
}

describe('Wazuh push hint contract', () => {
  it('exposes the PostgreSQL adapter through the public store contract', () => {
    expectTypeOf<PrismaWazuhPushInboxStore>().toMatchTypeOf<WazuhPushInboxStore>();
  });

  it.each([
    '2026-11-11T12:00:00Z',
    '2026-11-11T12:00:00.123+00:00',
    '2026-11-11T12:00:00.123+0000',
  ])('accepts valid source timestamp %s without rewriting it', (occurredAt) => {
    const valid = hint({ occurredAt });

    expect(() => assertWazuhPushHint(valid)).not.toThrow();
    expect(valid.occurredAt).toBe(occurredAt);
  });

  it.each([
    ['managerName', ''],
    ['managerName', 'name\nforged'],
    ['alertId', ' '.repeat(129)],
    ['occurredAt', 'not-a-timestamp'],
    ['occurredAt', '2026-02-30T12:00:00Z'],
    ['idempotencyKey', 'raw-manager-alert-id'],
  ] as const)('rejects invalid %s', (field, value) => {
    const invalid = { ...hint(), [field]: value } as WazuhPushHint;

    expect(() => assertWazuhPushHint(invalid)).toThrow('WAZUH_PUSH_HINT_INVALID');
  });
});
