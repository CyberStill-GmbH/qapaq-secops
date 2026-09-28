-- C-04: estructura Prisma y restricciones PostgreSQL complementarias.
BEGIN;

-- Crear esquema
CREATE SCHEMA IF NOT EXISTS "public";

-- Crear tabla
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "instance_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- Crear tabla
CREATE TABLE "source_checkpoints" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "cursor_version" TEXT NOT NULL,
    "source_generation" TEXT,
    "last_occurred_at" TIMESTAMPTZ(3),
    "last_tie_breaker" TEXT,
    "revision" BIGINT NOT NULL,
    "committed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_checkpoints_pkey" PRIMARY KEY ("id")
);

-- Crear tabla
CREATE TABLE "ingestion_manifests" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "dataset" TEXT NOT NULL,
    "manifest_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'durable',
    "admission_digest" TEXT NOT NULL,
    "admission_format_version" TEXT NOT NULL DEFAULT '1',
    "cursor_from" TEXT,
    "cursor_to" TEXT,
    "cursor_version" TEXT,
    "source_generation" TEXT,
    "checkpoint_revision" BIGINT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "durable_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "event_count" INTEGER NOT NULL,
    "accepted_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "quarantined_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ingestion_manifests_pkey" PRIMARY KEY ("id")
);

-- Crear tabla
CREATE TABLE "raw_event_references" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "manifest_id" UUID NOT NULL,
    "object_ref" TEXT NOT NULL,
    "object_version" TEXT,
    "sha256" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_event_references_pkey" PRIMARY KEY ("id")
);

-- Crear tabla
CREATE TABLE "event_inbox" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "manifest_id" UUID NOT NULL,
    "raw_event_reference_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "provider_event_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'admitted',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "processing_started_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_inbox_pkey" PRIMARY KEY ("id")
);

-- Crear tabla
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- Crear tabla
CREATE TABLE "quarantined_events" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "manifest_id" UUID NOT NULL,
    "inbox_id" UUID NOT NULL,
    "raw_event_reference_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "error_code" TEXT NOT NULL,
    "error_path" TEXT,
    "contract_version" TEXT,
    "parser_version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'quarantined',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "quarantined_at" TIMESTAMPTZ(3) NOT NULL,
    "last_reprocessed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quarantined_events_pkey" PRIMARY KEY ("id")
);

-- Crear índice
CREATE UNIQUE INDEX "sources_identity_key" ON "sources"("tenant_id", "provider", "product", "dataset", "instance_key");

-- Crear índice
CREATE UNIQUE INDEX "sources_id_dataset_key" ON "sources"("id", "dataset");

-- Crear índice
CREATE UNIQUE INDEX "source_checkpoints_source_dataset_key" ON "source_checkpoints"("source_id", "dataset");

-- Crear índice
CREATE INDEX "ingestion_manifests_source_received_idx" ON "ingestion_manifests"("source_id", "received_at", "id");

-- Crear índice
CREATE UNIQUE INDEX "ingestion_manifests_source_key" ON "ingestion_manifests"("source_id", "manifest_key");

-- Crear índice
CREATE UNIQUE INDEX "ingestion_manifests_source_id_key" ON "ingestion_manifests"("source_id", "id");

-- Crear índice
CREATE UNIQUE INDEX "raw_event_references_object_ref_key" ON "raw_event_references"("object_ref");

-- Crear índice
CREATE INDEX "raw_event_references_manifest_idx" ON "raw_event_references"("source_id", "manifest_id", "id");

-- Crear índice
CREATE UNIQUE INDEX "raw_event_references_source_id_key" ON "raw_event_references"("source_id", "id");

-- Crear índice
CREATE UNIQUE INDEX "event_inbox_record_id_key" ON "event_inbox"("record_id");

-- Crear índice
CREATE INDEX "event_inbox_manifest_idx" ON "event_inbox"("source_id", "manifest_id", "id");

-- Crear índice
CREATE INDEX "event_inbox_raw_idx" ON "event_inbox"("source_id", "raw_event_reference_id");

-- Crear índice
CREATE UNIQUE INDEX "event_inbox_source_idempotency_key" ON "event_inbox"("source_id", "idempotency_key");

-- Crear índice
CREATE UNIQUE INDEX "event_inbox_receipt_key" ON "event_inbox"("source_id", "manifest_id", "id", "raw_event_reference_id", "record_id");

-- Crear índice
CREATE UNIQUE INDEX "outbox_messages_message_id_key" ON "outbox_messages"("message_id");

-- Crear índice
CREATE UNIQUE INDEX "outbox_messages_idempotency_key" ON "outbox_messages"("idempotency_key");

-- Crear índice
CREATE INDEX "outbox_messages_pending_idx" ON "outbox_messages"("status", "available_at", "id");

-- Crear índice
CREATE UNIQUE INDEX "outbox_messages_aggregate_key" ON "outbox_messages"("aggregate_type", "aggregate_id");

-- Crear índice
CREATE INDEX "quarantined_events_receipt_idx" ON "quarantined_events"("source_id", "manifest_id", "inbox_id", "raw_event_reference_id", "record_id");

-- Añadir clave foránea
ALTER TABLE "source_checkpoints" ADD CONSTRAINT "source_checkpoints_source_fkey" FOREIGN KEY ("source_id", "dataset") REFERENCES "sources"("id", "dataset") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Añadir clave foránea
ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_source_fkey" FOREIGN KEY ("source_id", "dataset") REFERENCES "sources"("id", "dataset") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Añadir clave foránea
ALTER TABLE "raw_event_references" ADD CONSTRAINT "raw_event_references_manifest_fkey" FOREIGN KEY ("source_id", "manifest_id") REFERENCES "ingestion_manifests"("source_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Añadir clave foránea
ALTER TABLE "event_inbox" ADD CONSTRAINT "event_inbox_manifest_fkey" FOREIGN KEY ("source_id", "manifest_id") REFERENCES "ingestion_manifests"("source_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Añadir clave foránea
ALTER TABLE "event_inbox" ADD CONSTRAINT "event_inbox_raw_fkey" FOREIGN KEY ("source_id", "raw_event_reference_id") REFERENCES "raw_event_references"("source_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Añadir clave foránea
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_manifest_fkey" FOREIGN KEY ("source_id", "aggregate_id") REFERENCES "ingestion_manifests"("source_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Añadir clave foránea
ALTER TABLE "quarantined_events" ADD CONSTRAINT "quarantined_events_receipt_fkey" FOREIGN KEY ("source_id", "manifest_id", "inbox_id", "raw_event_reference_id", "record_id") REFERENCES "event_inbox"("source_id", "manifest_id", "id", "raw_event_reference_id", "record_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Los CHECK no se representan en Prisma; se verifican por catálogo y SQL real.
ALTER TABLE "sources" ADD CONSTRAINT "sources_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "sources" ADD CONSTRAINT "sources_text_check"
    CHECK ((char_length("tenant_id") BETWEEN 1 AND 128 AND "tenant_id" !~ '[[:cntrl:]]') AND
           (char_length("provider") BETWEEN 1 AND 128 AND "provider" !~ '[[:cntrl:]]') AND
           (char_length("product") BETWEEN 1 AND 128 AND "product" !~ '[[:cntrl:]]') AND
           (char_length("dataset") BETWEEN 1 AND 128 AND "dataset" !~ '[[:cntrl:]]') AND
           (char_length("instance_key") BETWEEN 1 AND 128 AND "instance_key" !~ '[[:cntrl:]]'));

ALTER TABLE "source_checkpoints" ADD CONSTRAINT "source_checkpoints_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "source_checkpoints" ADD CONSTRAINT "source_checkpoints_text_check"
    CHECK ((char_length("dataset") BETWEEN 1 AND 128 AND "dataset" !~ '[[:cntrl:]]') AND
           (char_length("cursor_version") BETWEEN 1 AND 64 AND "cursor_version" !~ '[[:cntrl:]]') AND
           (char_length("source_generation") BETWEEN 1 AND 128 AND "source_generation" !~ '[[:cntrl:]]') AND
           (char_length("last_tie_breaker") BETWEEN 1 AND 512 AND "last_tie_breaker" !~ '[[:cntrl:]]'));

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_text_check"
    CHECK ((char_length("dataset") BETWEEN 1 AND 128 AND "dataset" !~ '[[:cntrl:]]') AND
           (char_length("manifest_key") BETWEEN 1 AND 128 AND "manifest_key" !~ '[[:cntrl:]]') AND
           (char_length("cursor_version") BETWEEN 1 AND 64 AND "cursor_version" !~ '[[:cntrl:]]') AND
           (char_length("source_generation") BETWEEN 1 AND 128 AND "source_generation" !~ '[[:cntrl:]]'));

ALTER TABLE "raw_event_references" ADD CONSTRAINT "raw_event_references_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "raw_event_references" ADD CONSTRAINT "raw_event_references_text_check"
    CHECK ((char_length("object_version") BETWEEN 1 AND 256 AND "object_version" !~ '[[:cntrl:]]') AND
           (char_length("media_type") BETWEEN 3 AND 128 AND "media_type" !~ '[[:cntrl:]]'));

ALTER TABLE "event_inbox" ADD CONSTRAINT "event_inbox_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
           "record_id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "event_inbox" ADD CONSTRAINT "event_inbox_text_check"
    CHECK ((char_length("provider_event_id") BETWEEN 1 AND 512 AND "provider_event_id" !~ '[[:cntrl:]]') AND
           (char_length("idempotency_key") BETWEEN 1 AND 128 AND "idempotency_key" !~ '[[:cntrl:]]'));

ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
           "message_id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_text_check"
    CHECK ((char_length("idempotency_key") BETWEEN 1 AND 128 AND "idempotency_key" !~ '[[:cntrl:]]'));

ALTER TABLE "quarantined_events" ADD CONSTRAINT "quarantined_events_uuid7_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
           "record_id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

ALTER TABLE "quarantined_events" ADD CONSTRAINT "quarantined_events_text_check"
    CHECK ((char_length("error_code") BETWEEN 1 AND 64 AND "error_code" !~ '[[:cntrl:]]') AND
           (char_length("error_path") BETWEEN 1 AND 256 AND "error_path" !~ '[[:cntrl:]]') AND
           (char_length("contract_version") BETWEEN 1 AND 64 AND "contract_version" !~ '[[:cntrl:]]') AND
           (char_length("parser_version") BETWEEN 1 AND 64 AND "parser_version" !~ '[[:cntrl:]]'));

ALTER TABLE "sources" ADD CONSTRAINT "sources_status_check"
    CHECK (status IN ('planned', 'paused'));

ALTER TABLE "source_checkpoints" ADD CONSTRAINT "source_checkpoints_cursor_check"
    CHECK (octet_length(cursor) BETWEEN 1 AND 8192 AND cursor !~ '[[:cntrl:]]');

ALTER TABLE "source_checkpoints" ADD CONSTRAINT "source_checkpoints_revision_check"
    CHECK (revision >= 1);

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_cursor_size_check"
    CHECK ((octet_length(cursor_from) BETWEEN 1 AND 8192 AND cursor_from !~ '[[:cntrl:]]') AND
           (octet_length(cursor_to) BETWEEN 1 AND 8192 AND cursor_to !~ '[[:cntrl:]]'));

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_cursor_shape_check"
    CHECK ((cursor_to IS NULL AND cursor_from IS NULL AND cursor_version IS NULL
            AND source_generation IS NULL AND checkpoint_revision IS NULL)
        OR (cursor_to IS NOT NULL AND cursor_version IS NOT NULL
            AND checkpoint_revision IS NOT NULL AND checkpoint_revision >= 1));

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_digest_check"
    CHECK (admission_digest ~ '^[0-9a-f]{64}$' AND admission_format_version = '1');

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_counts_check"
    CHECK (event_count BETWEEN 1 AND 500 AND accepted_count BETWEEN 0 AND 500
        AND duplicate_count = 0 AND quarantined_count BETWEEN 0 AND 500
        AND event_count = accepted_count + quarantined_count + duplicate_count);

ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_state_check"
    CHECK (status = 'durable' AND completed_at IS NULL);

ALTER TABLE "raw_event_references" ADD CONSTRAINT "raw_event_references_object_check"
    CHECK (object_ref ~ '^raw:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND sha256 ~ '^[0-9a-f]{64}$' AND size_bytes BETWEEN 0 AND 262144);

ALTER TABLE "event_inbox" ADD CONSTRAINT "event_inbox_state_check"
    CHECK (status = 'admitted' AND attempt_count = 0
        AND processing_started_at IS NULL AND processed_at IS NULL AND last_error_code IS NULL);

ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_state_check"
    CHECK (status = 'pending' AND attempt_count = 0
        AND processing_started_at IS NULL AND published_at IS NULL AND last_error_code IS NULL);

ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_type_check"
    CHECK (aggregate_type = 'IngestionManifest' AND message_type = 'AdmissionDurable' AND schema_version = '1');

ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_payload_check"
    CHECK (payload = jsonb_build_object('manifestId', aggregate_id::text)
        AND octet_length(payload::text) <= 4096);

ALTER TABLE "quarantined_events" ADD CONSTRAINT "quarantined_events_state_check"
    CHECK (status = 'quarantined' AND attempt_count = 0 AND last_reprocessed_at IS NULL);

-- Las identidades no pueden cambiar aunque no tengan filas dependientes.
CREATE FUNCTION c04_protect_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    field_name text;
BEGIN
    FOREACH field_name IN ARRAY TG_ARGV LOOP
        IF (to_jsonb(NEW) -> field_name) IS DISTINCT FROM (to_jsonb(OLD) -> field_name) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Identidad C-04 inmutable';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER sources_identity_immutable BEFORE UPDATE ON sources
FOR EACH ROW EXECUTE FUNCTION c04_protect_identity('id', 'tenant_id', 'provider', 'product', 'dataset', 'instance_key');
CREATE TRIGGER source_checkpoints_identity_immutable BEFORE UPDATE ON source_checkpoints
FOR EACH ROW EXECUTE FUNCTION c04_protect_identity('id', 'source_id', 'dataset');
CREATE TRIGGER event_inbox_identity_immutable BEFORE UPDATE ON event_inbox
FOR EACH ROW EXECUTE FUNCTION c04_protect_identity('id', 'source_id', 'manifest_id', 'raw_event_reference_id', 'record_id', 'idempotency_key');
CREATE TRIGGER outbox_messages_identity_immutable BEFORE UPDATE ON outbox_messages
FOR EACH ROW EXECUTE FUNCTION c04_protect_identity('id', 'message_id', 'source_id', 'aggregate_id', 'aggregate_type', 'message_type', 'schema_version', 'idempotency_key', 'payload');

-- El manifiesto confirmado, el raw y la historia de cuarentena son inmutables.
-- El procesamiento o la retención requerirán una migración explícita.
CREATE FUNCTION c04_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Registro C-04 inmutable';
END;
$$;
CREATE TRIGGER ingestion_manifests_immutable BEFORE UPDATE OR DELETE ON ingestion_manifests
FOR EACH ROW EXECUTE FUNCTION c04_reject_mutation();
CREATE TRIGGER raw_event_references_immutable BEFORE UPDATE OR DELETE ON raw_event_references
FOR EACH ROW EXECUTE FUNCTION c04_reject_mutation();
CREATE TRIGGER quarantined_events_immutable BEFORE UPDATE OR DELETE ON quarantined_events
FOR EACH ROW EXECUTE FUNCTION c04_reject_mutation();

COMMIT;
