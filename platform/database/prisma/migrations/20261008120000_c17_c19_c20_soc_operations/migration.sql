-- C-17/C-19/C-20: operación SOC, auditoría append-only y notificación crítica.
-- La auditoría no se puede actualizar ni borrar: además de revocar privilegios, un
-- trigger rechaza la operación aunque alguien conceda permisos más adelante.
BEGIN;

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "actor_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_session" TEXT,
    "actor_ip" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "previous_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "audit_events_actor_type_allowed" CHECK ("actor_type" IN ('user', 'service', 'system')),
    CONSTRAINT "audit_events_outcome_allowed" CHECK ("outcome" IN ('allowed', 'denied', 'succeeded', 'failed')),
    CONSTRAINT "audit_events_hash_format" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "audit_events_previous_hash_format" CHECK ("previous_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "audit_events_tenant_not_blank" CHECK (length(btrim("tenant_id")) > 0)
);

CREATE UNIQUE INDEX "audit_events_tenant_sequence_key" ON "audit_events" ("tenant_id", "sequence");
CREATE UNIQUE INDEX "audit_events_tenant_hash_key" ON "audit_events" ("tenant_id", "hash");
CREATE INDEX "audit_events_tenant_time_idx" ON "audit_events" ("tenant_id", "occurred_at", "sequence");
CREATE INDEX "audit_events_action_idx" ON "audit_events" ("tenant_id", "action", "occurred_at");

-- Append-only a nivel de base. La función no distingue roles a propósito: si una fila
-- de auditoría se pudiera corregir, dejaría de ser evidencia.
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events es append-only: % no está permitido', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_events_no_update"
    BEFORE UPDATE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();

CREATE TRIGGER "audit_events_no_delete"
    BEFORE DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();

CREATE TRIGGER "audit_events_no_truncate"
    BEFORE TRUNCATE ON "audit_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();

CREATE TABLE "detection_candidates" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_record_id" UUID NOT NULL,
    "event_uid" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "ruleset_id" TEXT NOT NULL,
    "ruleset_version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "detection_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "detection_candidates_priority_allowed" CHECK ("priority" IN ('P1', 'P2', 'P3', 'P4')),
    CONSTRAINT "detection_candidates_score_range" CHECK ("score" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "detection_candidates_idempotency_key" ON "detection_candidates" ("tenant_id", "idempotency_key");
CREATE INDEX "detection_candidates_time_idx" ON "detection_candidates" ("tenant_id", "occurred_at", "id");

CREATE TABLE "soc_incidents" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closure_reason" TEXT,
    "revision" INTEGER NOT NULL,
    CONSTRAINT "soc_incidents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "soc_incidents_severity_allowed" CHECK ("severity" IN ('critical', 'high', 'medium', 'low')),
    CONSTRAINT "soc_incidents_status_allowed" CHECK ("status" IN ('open', 'contained', 'eradicated', 'resolved', 'closed')),
    CONSTRAINT "soc_incidents_revision_positive" CHECK ("revision" > 0),
    -- Un caso cerrado sin motivo ni instante sería un cierre sin rastro.
    CONSTRAINT "soc_incidents_closure_complete" CHECK (
        ("status" <> 'closed') OR ("closed_at" IS NOT NULL AND "closure_reason" IS NOT NULL)
    )
);

CREATE INDEX "soc_incidents_board_idx" ON "soc_incidents" ("tenant_id", "status", "opened_at");

CREATE TABLE "soc_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "candidate_id" UUID NOT NULL,
    "event_record_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "assignee_id" TEXT,
    "verdict" TEXT,
    "triage_note" TEXT,
    "incident_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "revision" INTEGER NOT NULL,
    CONSTRAINT "soc_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "soc_alerts_priority_allowed" CHECK ("priority" IN ('P1', 'P2', 'P3', 'P4')),
    CONSTRAINT "soc_alerts_status_allowed" CHECK ("status" IN ('new', 'acknowledged', 'triaged', 'escalated', 'closed')),
    CONSTRAINT "soc_alerts_verdict_allowed" CHECK (
        "verdict" IS NULL OR "verdict" IN ('true_positive', 'false_positive', 'benign', 'duplicate')
    ),
    -- Un estado `triaged` sin veredicto ni nota no es un triaje.
    CONSTRAINT "soc_alerts_triage_complete" CHECK (
        "status" NOT IN ('triaged', 'escalated') OR ("verdict" IS NOT NULL AND "triage_note" IS NOT NULL)
    ),
    CONSTRAINT "soc_alerts_revision_positive" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "soc_alerts_candidate_key" ON "soc_alerts" ("candidate_id");
CREATE INDEX "soc_alerts_board_idx" ON "soc_alerts" ("tenant_id", "status", "occurred_at");
CREATE INDEX "soc_alerts_incident_idx" ON "soc_alerts" ("tenant_id", "incident_id");

ALTER TABLE "soc_alerts" ADD CONSTRAINT "soc_alerts_candidate_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "detection_candidates" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "soc_alerts" ADD CONSTRAINT "soc_alerts_incident_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "soc_incidents" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "notification_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_failure_code" TEXT,
    "last_failure_class" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by" TEXT,
    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_attempts_channel_allowed" CHECK ("channel" IN ('teams', 'fallback_email', 'manual_console')),
    CONSTRAINT "notification_attempts_status_allowed" CHECK (
        "status" IN ('pending', 'sending', 'sent', 'indeterminate', 'failed', 'fallback', 'acknowledged')
    ),
    CONSTRAINT "notification_attempts_count_non_negative" CHECK ("attempt_count" >= 0),
    -- `sent` exige instante de entrega; el acuse exige quién lo registró.
    CONSTRAINT "notification_attempts_sent_has_time" CHECK ("status" <> 'sent' OR "sent_at" IS NOT NULL),
    CONSTRAINT "notification_attempts_ack_has_actor" CHECK (
        "status" <> 'acknowledged' OR ("acknowledged_at" IS NOT NULL AND "acknowledged_by" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "notification_attempts_idempotency_key" ON "notification_attempts" ("tenant_id", "idempotency_key");
CREATE INDEX "notification_attempts_pending_idx" ON "notification_attempts" ("status", "available_at", "id");

COMMIT;
