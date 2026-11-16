-- Minimized Wazuh push receipts for the EC2 profile (no SQS/IAM dependency).
-- The queue stores only a lookup hint, never the alert body or full_log.
BEGIN;

CREATE TABLE "wazuh_push_inbox_hints" (
    "id" UUID NOT NULL,
    "manager_name" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "occurred_at" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "lease_until" TIMESTAMPTZ(3),
    "claim_id" UUID,
    "last_error_code" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "wazuh_push_inbox_hints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wazuh_push_inbox_hints_status_allowed" CHECK (
        "status" IN ('pending', 'processing', 'processed', 'failed-terminal')
    ),
    CONSTRAINT "wazuh_push_inbox_hints_attempts_non_negative" CHECK ("attempt_count" >= 0),
    CONSTRAINT "wazuh_push_inbox_hints_fields_bounded" CHECK (
        char_length("manager_name") BETWEEN 1 AND 256
        AND char_length("alert_id") BETWEEN 1 AND 128
        AND char_length("occurred_at") BETWEEN 20 AND 64
        AND char_length("idempotency_key") BETWEEN 1 AND 128
    ),
    CONSTRAINT "wazuh_push_inbox_hints_lease_coherent" CHECK (
        ("status" = 'processing' AND "lease_until" IS NOT NULL AND "claim_id" IS NOT NULL)
        OR ("status" <> 'processing' AND "lease_until" IS NULL AND "claim_id" IS NULL)
    ),
    CONSTRAINT "wazuh_push_inbox_hints_processed_coherent" CHECK (
        ("status" = 'processed') = ("processed_at" IS NOT NULL)
    ),
    CONSTRAINT "wazuh_push_inbox_hints_error_code_format" CHECK (
        "last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    ),
    CONSTRAINT "wazuh_push_inbox_hints_terminal_has_error" CHECK (
        "status" <> 'failed-terminal' OR "last_error_code" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "wazuh_push_inbox_hints_idempotency_key"
    ON "wazuh_push_inbox_hints" ("idempotency_key");
CREATE INDEX "wazuh_push_inbox_hints_pending_idx"
    ON "wazuh_push_inbox_hints" ("status", "available_at", "received_at", "id");
CREATE INDEX "wazuh_push_inbox_hints_processing_idx"
    ON "wazuh_push_inbox_hints" ("status", "lease_until", "received_at", "id");

COMMIT;
