-- Support bounded recent receipt scans used by source-to-API freshness metrics.
CREATE INDEX IF NOT EXISTS "wazuh_push_inbox_hints_received_idx"
  ON "wazuh_push_inbox_hints" ("received_at" DESC, "id" DESC);
