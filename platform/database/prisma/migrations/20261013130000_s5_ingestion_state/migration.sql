-- Sprint 5 · fase 0 (S5-D1, S5-D4): estado durable de la ingesta de fuentes hacia el SOC.
--
-- `soc_ingestion_cursors` guarda, por tenant, fuente y dataset, la marca de agua (hora del
-- evento más reciente ya procesado) y un lease con fencing (`claim_id`): solo la réplica que
-- tiene el claim vigente avanza la marca, y si muere el lease vence y otra continúa.
--
-- `source_poll_observations` registra cada pasada (intento, resultado, filas vistas, error
-- normalizado). Es la señal verificable de un poll exitoso, incluso vacío, que usa la salud por
-- fuente. Nunca guarda mensajes del proveedor ni datos personales: solo un código de error.
BEGIN;

CREATE TABLE "soc_ingestion_cursors" (
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "watermark" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "claim_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "soc_ingestion_cursors_pkey" PRIMARY KEY ("tenant_id", "source_id", "dataset"),
    -- Un lease sin dueño o un dueño sin lease es un estado que nadie puede liberar.
    CONSTRAINT "soc_ingestion_cursors_lease_coherent" CHECK (
        ("lease_until" IS NULL) = ("claim_id" IS NULL)
    )
);

CREATE TABLE "source_poll_observations" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "records_seen" INTEGER NOT NULL,
    "promoted" INTEGER NOT NULL,
    "quarantined" INTEGER NOT NULL,
    "newest_event_at" TIMESTAMPTZ(3),
    "error_class" TEXT,
    CONSTRAINT "source_poll_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "source_poll_observations_outcome_allowed" CHECK (
        "outcome" IN ('success', 'retryable_error', 'permanent_error')
    ),
    CONSTRAINT "source_poll_observations_counts_non_negative" CHECK (
        "records_seen" >= 0 AND "promoted" >= 0 AND "quarantined" >= 0
    ),
    CONSTRAINT "source_poll_observations_order" CHECK ("completed_at" >= "attempted_at"),
    -- Un error siempre lleva su código; un éxito nunca lo lleva.
    CONSTRAINT "source_poll_observations_error_coherent" CHECK (
        ("outcome" = 'success') = ("error_class" IS NULL)
    ),
    CONSTRAINT "source_poll_observations_error_class_format" CHECK (
        "error_class" IS NULL OR "error_class" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    )
);

CREATE INDEX "source_poll_observations_recent_idx"
    ON "source_poll_observations" ("tenant_id", "source_id", "dataset", "attempted_at" DESC);

-- Fase 2: bitácora append-only de la salud de cada fuente. Se escribe solo cuando cambia el
-- estado; es la evidencia de interrupciones (inicio, recuperación, duración), independiente
-- del estado actual. El trigger y post-migrate.sql impiden editarla o borrarla.
CREATE TABLE "source_health_transitions" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "source_health_transitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "source_health_transitions_states_allowed" CHECK (
        "to_state" IN ('unknown', 'healthy', 'degraded', 'failed', 'disabled')
        AND ("from_state" IS NULL
             OR "from_state" IN ('unknown', 'healthy', 'degraded', 'failed', 'disabled'))
    ),
    CONSTRAINT "source_health_transitions_is_change" CHECK ("from_state" IS DISTINCT FROM "to_state"),
    CONSTRAINT "source_health_transitions_reason_format" CHECK ("reason" ~ '^[A-Z][A-Z_]{2,63}$')
);

CREATE INDEX "source_health_transitions_recent_idx"
    ON "source_health_transitions" ("tenant_id", "source_id", "dataset", "at" DESC);

-- Fase 2: actividad medida por stream de la fuente (p. ej. cada suscripción de Office 365).
-- Informativa: sirve para ver un stream callado, no para declarar la fuente sana.
CREATE TABLE "source_stream_activity" (
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "last_event_at" TIMESTAMPTZ(3),
    "events_in_window" INTEGER NOT NULL,
    "window_hours" INTEGER NOT NULL,
    "measured_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "source_stream_activity_pkey" PRIMARY KEY ("tenant_id", "source_id", "dataset", "stream"),
    CONSTRAINT "source_stream_activity_counts" CHECK ("events_in_window" >= 0 AND "window_hours" BETWEEN 1 AND 744),
    CONSTRAINT "source_stream_activity_stream_length" CHECK (char_length("stream") BETWEEN 1 AND 128)
);

CREATE FUNCTION source_health_transitions_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $append_only$
BEGIN
    RAISE EXCEPTION 'source_health_transitions es append-only' USING ERRCODE = 'integrity_constraint_violation';
END
$append_only$;

CREATE TRIGGER source_health_transitions_append_only BEFORE UPDATE OR DELETE ON "source_health_transitions"
    FOR EACH ROW EXECUTE FUNCTION source_health_transitions_append_only();

COMMIT;
