-- Keep urgent dispatch bounded independently from old P2/P3/P4 backlog.
-- The predicate mirrors the SQL urgent claim; no duplicated classification column can drift.
CREATE INDEX IF NOT EXISTS "soc_outbox_messages_urgent_claim_idx"
  ON "soc_outbox_messages" ("available_at", "message_id")
  WHERE "status" <> 'published'
    AND COALESCE((
      ("aggregate_type" = 'alert'
        AND "message_type" IN ('soc.alert.created', 'soc.alert.escalated')
        AND "payload"->>'priority' = 'P1')
      OR ("aggregate_type" = 'incident'
        AND "message_type" = 'soc.incident.opened'
        AND "payload"->>'severity' = 'critical')
    ), false);