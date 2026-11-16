-- Keep frequently polled tenant health queries bounded to non-published queue rows.
-- The key order supports status count/minimum and lease-expiry range lookup per tenant.
CREATE INDEX IF NOT EXISTS "soc_outbox_messages_pending_health_idx"
  ON "soc_outbox_messages" ("tenant_id", "available_at")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "soc_outbox_messages_processing_lease_health_idx"
  ON "soc_outbox_messages" ("tenant_id", "lease_until")
  WHERE "status" = 'processing';
