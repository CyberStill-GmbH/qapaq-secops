-- Analista IA (docs/27): investigaciones durables en segundo plano.
--
--   ai_investigation_jobs         cola durable + expediente (lease, fencing, idempotencia)
--   ai_investigation_events       bitácora append-only de progreso (sin prompts ni evidencia)
--   ai_investigation_invocations  libro de llamadas al modelo: reserva del peor caso antes del
--                                 envío, uso reportado y costo ESTIMADO con tarifa versionada
--   ai_investigation_actions      libro de acciones sobre el SOC, una por (trabajo, tipo)
--   ai_analyst_settings           ajustes por tenant con compare-and-set
--
-- Aditiva: solo crea tablas nuevas. Rollback: DROP de estas cinco tablas.
BEGIN;

CREATE TABLE "ai_investigation_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "subject_title" TEXT NOT NULL,
    "subject_rule_id" TEXT,
    "alert_ids" JSONB NOT NULL,
    "priority" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "initiated_by" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "inference" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "last_error_code" TEXT,
    "result" JSONB,
    "planned_status" TEXT,
    "evidence" JSONB,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "ai_investigation_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_investigation_jobs_status_allowed" CHECK (
        "status" IN ('queued', 'running', 'completed', 'requires_review', 'partial',
                     'budget_exhausted', 'usage_unreconciled', 'cancelled', 'failed')
    ),
    CONSTRAINT "ai_investigation_jobs_stage_allowed" CHECK (
        "stage" IS NULL
        OR "stage" IN ('fetching_evidence', 'triage', 'model', 'validating', 'writing', 'acting')
    ),
    CONSTRAINT "ai_investigation_jobs_stage_only_running" CHECK (
        "status" = 'running' OR "stage" IS NULL
    ),
    CONSTRAINT "ai_investigation_jobs_inference_allowed" CHECK (
        "inference" IS NULL OR "inference" IN ('none', 'economy', 'advanced')
    ),
    CONSTRAINT "ai_investigation_jobs_planned_status_allowed" CHECK (
        "planned_status" IS NULL
        OR ("status" IN ('queued', 'running')
            AND "planned_status" IN ('completed', 'requires_review', 'partial',
                                     'budget_exhausted', 'usage_unreconciled', 'failed'))
    ),
    CONSTRAINT "ai_investigation_jobs_priority_allowed" CHECK (
        "priority" IN ('P1', 'P2', 'P3', 'P4')
    ),
    CONSTRAINT "ai_investigation_jobs_subject_kind_allowed" CHECK (
        "subject_kind" IN ('alert', 'candidate')
    ),
    CONSTRAINT "ai_investigation_jobs_trigger_allowed" CHECK (
        ("trigger" = 'system' AND "source" IN ('new_alert', 'backlog') AND "initiated_by" IS NULL)
        OR ("trigger" = 'user' AND "source" = 'manual' AND "initiated_by" IS NOT NULL)
    ),
    CONSTRAINT "ai_investigation_jobs_lease_coherent" CHECK (
        ("status" = 'running') = ("lease_until" IS NOT NULL)
    ),
    CONSTRAINT "ai_investigation_jobs_finished_coherent" CHECK (
        ("status" IN ('queued', 'running')) = ("finished_at" IS NULL)
    ),
    CONSTRAINT "ai_investigation_jobs_counters_valid" CHECK (
        "attempt" >= 0 AND "fencing_token" >= 0 AND "event_sequence" >= 0 AND "revision" >= 1
    ),
    CONSTRAINT "ai_investigation_jobs_error_code_format" CHECK (
        "last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    ),
    CONSTRAINT "ai_investigation_jobs_fields_bounded" CHECK (
        char_length("tenant_id") BETWEEN 1 AND 128
        AND char_length("subject_id") BETWEEN 1 AND 128
        AND char_length("subject_title") BETWEEN 1 AND 300
        AND ("subject_rule_id" IS NULL OR char_length("subject_rule_id") BETWEEN 1 AND 128)
        AND ("initiated_by" IS NULL OR char_length("initiated_by") BETWEEN 1 AND 256)
        AND char_length("idempotency_key") BETWEEN 1 AND 200
        AND "fingerprint" ~ '^[0-9a-f]{64}$'
        AND char_length("policy_version") BETWEEN 1 AND 64
    ),
    CONSTRAINT "ai_investigation_jobs_alert_ids_array" CHECK (
        jsonb_typeof("alert_ids") = 'array'
        AND jsonb_array_length("alert_ids") BETWEEN 1 AND 200
    ),
    CONSTRAINT "ai_investigation_jobs_documents_bounded" CHECK (
        ("result" IS NULL
         OR (jsonb_typeof("result") = 'object' AND pg_column_size("result") <= 65536))
        AND ("evidence" IS NULL
         OR (jsonb_typeof("evidence") = 'object' AND pg_column_size("evidence") <= 16384))
    )
);

CREATE UNIQUE INDEX "ai_investigation_jobs_idempotency_key"
    ON "ai_investigation_jobs" ("tenant_id", "idempotency_key");
-- Claim: prioridad primero (P1→P4), luego antigüedad.
CREATE INDEX "ai_investigation_jobs_claim_idx"
    ON "ai_investigation_jobs" ("status", "priority", "available_at", "created_at", "id");
CREATE INDEX "ai_investigation_jobs_lease_idx"
    ON "ai_investigation_jobs" ("status", "lease_until");
CREATE INDEX "ai_investigation_jobs_tenant_idx"
    ON "ai_investigation_jobs" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "ai_investigation_jobs_tenant_status_idx"
    ON "ai_investigation_jobs" ("tenant_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "ai_investigation_jobs_tenant_finished_idx"
    ON "ai_investigation_jobs" ("tenant_id", "finished_at");

CREATE TABLE "ai_investigation_events" (
    "job_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "stage" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "ai_investigation_events_pkey" PRIMARY KEY ("job_id", "sequence"),
    CONSTRAINT "ai_investigation_events_job_fkey" FOREIGN KEY ("job_id")
        REFERENCES "ai_investigation_jobs" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ai_investigation_events_sequence_positive" CHECK ("sequence" >= 1),
    CONSTRAINT "ai_investigation_events_stage_allowed" CHECK (
        "stage" IN ('fetching_evidence', 'triage', 'model', 'validating', 'writing', 'acting')
    ),
    CONSTRAINT "ai_investigation_events_kind_allowed" CHECK (
        "kind" IN ('started', 'completed', 'skipped', 'failed')
    ),
    CONSTRAINT "ai_investigation_events_detail_bounded" CHECK (
        jsonb_typeof("detail") = 'object' AND pg_column_size("detail") <= 8192
    )
);

CREATE INDEX "ai_investigation_events_tenant_idx"
    ON "ai_investigation_events" ("tenant_id", "at");

CREATE TABLE "ai_investigation_invocations" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reserved_input_tokens" INTEGER NOT NULL,
    "reserved_output_tokens" INTEGER NOT NULL,
    "reserved_micro_usd" BIGINT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "estimated_micro_usd" BIGINT,
    "rate_card_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3),
    CONSTRAINT "ai_investigation_invocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_investigation_invocations_job_fkey" FOREIGN KEY ("job_id")
        REFERENCES "ai_investigation_jobs" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ai_investigation_invocations_phase_allowed" CHECK ("phase" IN ('analysis')),
    CONSTRAINT "ai_investigation_invocations_tier_allowed" CHECK (
        "tier" IN ('economy', 'advanced')
    ),
    CONSTRAINT "ai_investigation_invocations_state_allowed" CHECK (
        "state" IN ('reserved', 'dispatching', 'settled', 'released', 'usage_unknown')
    ),
    CONSTRAINT "ai_investigation_invocations_reservation_valid" CHECK (
        "reserved_input_tokens" >= 0 AND "reserved_output_tokens" >= 0
        AND "reserved_micro_usd" >= 0
    ),
    CONSTRAINT "ai_investigation_invocations_settled_coherent" CHECK (
        ("state" = 'settled') = ("settled_at" IS NOT NULL)
        AND ("state" = 'settled') = ("estimated_micro_usd" IS NOT NULL)
        AND ("state" = 'settled') = ("input_tokens" IS NOT NULL AND "output_tokens" IS NOT NULL
            AND "cache_read_tokens" IS NOT NULL AND "cache_write_tokens" IS NOT NULL)
    ),
    CONSTRAINT "ai_investigation_invocations_usage_valid" CHECK (
        COALESCE("input_tokens", 0) >= 0 AND COALESCE("output_tokens", 0) >= 0
        AND COALESCE("cache_read_tokens", 0) >= 0 AND COALESCE("cache_write_tokens", 0) >= 0
        AND COALESCE("estimated_micro_usd", 0) >= 0
    ),
    CONSTRAINT "ai_investigation_invocations_fields_bounded" CHECK (
        "fingerprint" ~ '^[0-9a-f]{64}$'
        AND char_length("model") BETWEEN 1 AND 200
        AND char_length("rate_card_version") BETWEEN 1 AND 64
    )
);

CREATE UNIQUE INDEX "ai_investigation_invocations_job_phase_fingerprint"
    ON "ai_investigation_invocations" ("job_id", "phase", "fingerprint");
-- Techo diario por tenant y reutilización por huella de evidencia.
CREATE INDEX "ai_investigation_invocations_tenant_day_idx"
    ON "ai_investigation_invocations" ("tenant_id", "created_at");
CREATE INDEX "ai_investigation_invocations_tenant_fingerprint_idx"
    ON "ai_investigation_invocations" ("tenant_id", "fingerprint", "state");

CREATE TABLE "ai_investigation_actions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "urgency" TEXT,
    "group_key" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "executed_at" TIMESTAMPTZ(3),
    "ref_kind" TEXT,
    "ref_id" TEXT,
    "error_code" TEXT,
    CONSTRAINT "ai_investigation_actions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_investigation_actions_job_fkey" FOREIGN KEY ("job_id")
        REFERENCES "ai_investigation_jobs" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- No existe ningún tipo de acción de contención o respuesta.
    CONSTRAINT "ai_investigation_actions_kind_allowed" CHECK (
        "kind" IN ('escalate', 'close_benign', 'acknowledge', 'report', 'request_review')
    ),
    CONSTRAINT "ai_investigation_actions_state_allowed" CHECK (
        "state" IN ('planned', 'executed', 'skipped', 'failed')
    ),
    CONSTRAINT "ai_investigation_actions_reason_format" CHECK (
        "reason" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    ),
    CONSTRAINT "ai_investigation_actions_urgency_allowed" CHECK (
        ("kind" = 'request_review' AND "urgency" IN ('immediate', 'digest'))
        OR ("kind" <> 'request_review' AND "urgency" IS NULL)
    ),
    CONSTRAINT "ai_investigation_actions_executed_coherent" CHECK (
        ("state" = 'executed') = ("executed_at" IS NOT NULL)
    ),
    CONSTRAINT "ai_investigation_actions_ref_coherent" CHECK (
        ("ref_kind" IS NULL AND "ref_id" IS NULL)
        OR ("ref_kind" IN ('alert', 'incident', 'notification', 'report')
            AND char_length("ref_id") BETWEEN 1 AND 200)
    ),
    CONSTRAINT "ai_investigation_actions_error_code_format" CHECK (
        "error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    ),
    CONSTRAINT "ai_investigation_actions_group_key_bounded" CHECK (
        "group_key" IS NULL OR char_length("group_key") BETWEEN 1 AND 300
    )
);

CREATE UNIQUE INDEX "ai_investigation_actions_job_kind"
    ON "ai_investigation_actions" ("job_id", "kind");
CREATE INDEX "ai_investigation_actions_tenant_idx"
    ON "ai_investigation_actions" ("tenant_id", "at");

CREATE TABLE "ai_analyst_settings" (
    "tenant_id" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    CONSTRAINT "ai_analyst_settings_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "ai_analyst_settings_revision_positive" CHECK ("revision" >= 1),
    CONSTRAINT "ai_analyst_settings_document_bounded" CHECK (
        jsonb_typeof("document") = 'object' AND pg_column_size("document") <= 16384
    ),
    CONSTRAINT "ai_analyst_settings_fields_bounded" CHECK (
        char_length("tenant_id") BETWEEN 1 AND 128
        AND char_length("updated_by") BETWEEN 1 AND 256
    )
);

COMMIT;
