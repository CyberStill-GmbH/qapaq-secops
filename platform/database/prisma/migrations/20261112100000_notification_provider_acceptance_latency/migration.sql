-- Support tenant-scoped outbox window scans and the bounded message-to-attempt join.
CREATE INDEX IF NOT EXISTS "soc_outbox_tenant_created_message_idx"
  ON "soc_outbox_messages" ("tenant_id", "created_at" DESC, "message_id" DESC);

CREATE INDEX IF NOT EXISTS "notification_attempts_tenant_message_idx"
  ON "notification_attempts" ("tenant_id", "message_id");
