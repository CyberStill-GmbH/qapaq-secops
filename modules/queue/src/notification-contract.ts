/** Jobs solo transportan la referencia durable del outbox; el contenido se recupera del store. */
export const NOTIFICATION_QUEUE = 'notifications';
export const NOTIFICATION_DLQ = 'notifications-dlq';

export interface OutboxReference {
  readonly schemaVersion: 1;
  readonly outboxId: string;
}

export function notificationJobId(outboxId: string): string {
  if (!isOutboxId(outboxId)) throw new Error('OUTBOX_ID_INVALID');
  // BullMQ reserva el carácter dos puntos como separador interno de jobId.
  return `outbox-${outboxId}`;
}

export function parseOutboxReference(value: unknown): OutboxReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('OUTBOX_REFERENCE_INVALID');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.outboxId !== 'string') {
    throw new Error('OUTBOX_REFERENCE_INVALID');
  }
  if (!isOutboxId(candidate.outboxId)) throw new Error('OUTBOX_ID_INVALID');
  // Reject unknown fields so raw content cannot be smuggled into a queue job.
  if (Object.keys(candidate).some((key) => key !== 'schemaVersion' && key !== 'outboxId')) {
    throw new Error('OUTBOX_REFERENCE_INVALID');
  }
  return { schemaVersion: 1, outboxId: candidate.outboxId };
}

function isOutboxId(value: string): boolean {
  // The current store uses UUIDs. Keep this stricter than arbitrary provider identifiers.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
