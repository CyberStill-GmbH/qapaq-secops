import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_QUEUE,
  notificationJobId,
  parseOutboxReference,
} from '../src/notification-contract.js';

const outboxId = 'b25b59b2-5c61-4e0b-8eaf-123456789abc';

describe('notification queue contract', () => {
  it('uses a deterministic BullMQ-safe ID and accepts only an outbox reference', () => {
    expect(NOTIFICATION_QUEUE).toBe('notifications');
    expect(notificationJobId(outboxId)).toBe(`outbox-${outboxId}`);
    expect(parseOutboxReference({ schemaVersion: 1, outboxId })).toEqual({
      schemaVersion: 1,
      outboxId,
    });
  });

  it.each([
    { schemaVersion: 1, outboxId, raw: 'message body' },
    { schemaVersion: 1, outboxId, accessToken: 'secret' },
    { schemaVersion: 1, outboxId: 'provider-arbitrary-id' },
    { schemaVersion: 2, outboxId },
    null,
  ])('rejects malformed or oversized payloads: %j', (value) => {
    expect(() => parseOutboxReference(value)).toThrow();
  });

  it('rejects invalid IDs before they can form BullMQ keys', () => {
    expect(() => notificationJobId('bad:id')).toThrow('OUTBOX_ID_INVALID');
  });
});
