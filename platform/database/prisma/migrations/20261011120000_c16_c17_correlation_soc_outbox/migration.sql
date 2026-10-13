-- C-16/C-17: correlación por entidad y outbox propio del SOC.
--
-- 1. Candidatos y alertas guardan las claves de entidad (`user:<upn>`, `ip:<ip>`), la
--    clase de señal y la regla de origen. Son el índice de la correlación: sin ellas cada
--    alerta se evalúa aislada, que es exactamente lo que ya hace Wazuh.
-- 2. `soc_outbox_messages` es la cola durable de la que el despacho de C-20 reclama con
--    lease. La tabla `outbox_messages` de C-04 pertenece a la admisión (FK a
--    `ingestion_manifests`) y no puede recibir hechos del SOC sin romper ese contrato.
--
-- Todo es aditivo: las filas existentes reciben valores vacíos y siguen siendo válidas.
BEGIN;

ALTER TABLE "detection_candidates"
    ADD COLUMN "entity_keys" TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "signal" TEXT,
    ADD COLUMN "rule_id" TEXT,
    ADD COLUMN "related_alert_ids" UUID[] NOT NULL DEFAULT '{}';

ALTER TABLE "soc_alerts"
    ADD COLUMN "entity_keys" TEXT[] NOT NULL DEFAULT '{}',
    -- D-10b: referencias opacas (HMAC por tenant) de las mismas entidades. Los filtros y las
    -- URLs usan estas; el UPN o la IP solo viajan en el cuerpo de las respuestas.
    ADD COLUMN "entity_refs" TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "signal" TEXT,
    ADD COLUMN "rule_id" TEXT,
    ADD COLUMN "related_alert_ids" UUID[] NOT NULL DEFAULT '{}';

-- La clase de señal es un catálogo cerrado del dominio (`SIGNAL_CLASSES`).
ALTER TABLE "detection_candidates" ADD CONSTRAINT "detection_candidates_signal_allowed" CHECK (
    "signal" IS NULL OR "signal" IN (
        'credential_access', 'initial_access', 'persistence', 'privilege_escalation',
        'defense_evasion', 'collection', 'exfiltration', 'other'
    )
);
ALTER TABLE "soc_alerts" ADD CONSTRAINT "soc_alerts_signal_allowed" CHECK (
    "signal" IS NULL OR "signal" IN (
        'credential_access', 'initial_access', 'persistence', 'privilege_escalation',
        'defense_evasion', 'collection', 'exfiltration', 'other'
    )
);

-- Topes que impiden que una entidad ruidosa convierta la fila en un inventario.
ALTER TABLE "soc_alerts" ADD CONSTRAINT "soc_alerts_entity_keys_bounded" CHECK (
    cardinality("entity_keys") <= 128
);
-- Una referencia por clave, en el mismo orden.
ALTER TABLE "soc_alerts" ADD CONSTRAINT "soc_alerts_entity_refs_aligned" CHECK (
    cardinality("entity_refs") = 0 OR cardinality("entity_refs") = cardinality("entity_keys")
);
ALTER TABLE "soc_alerts" ADD CONSTRAINT "soc_alerts_related_bounded" CHECK (
    cardinality("related_alert_ids") <= 50
);

-- La correlación busca "alertas del tenant que compartan alguna clave desde X": GIN sobre
-- el arreglo resuelve el `&&` y el índice temporal acota la ventana.
CREATE INDEX "soc_alerts_entity_keys_idx" ON "soc_alerts" USING GIN ("entity_keys");
CREATE INDEX "soc_alerts_entity_refs_idx" ON "soc_alerts" USING GIN ("entity_refs");
CREATE INDEX "soc_alerts_tenant_time_idx" ON "soc_alerts" ("tenant_id", "occurred_at" DESC, "id");
CREATE INDEX "soc_alerts_event_record_idx" ON "soc_alerts" ("tenant_id", "event_record_id");

CREATE TABLE "soc_outbox_messages" (
    "message_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "message_type" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    -- Cola durable con lease (C-20). `processing` con `lease_until` vencido vuelve a ser
    -- reclamable: un despachador que murió a mitad de envío no deja el mensaje huérfano.
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    -- Fencing: cada claim recibe un identificador nuevo. Publicar o reprogramar exige el del
    -- claim vigente, así un despachador cuyo lease venció no puede pisar el de otro.
    "claim_id" UUID,
    "last_error_code" TEXT,
    "published_at" TIMESTAMPTZ(3),
    CONSTRAINT "soc_outbox_messages_pkey" PRIMARY KEY ("message_id"),
    CONSTRAINT "soc_outbox_messages_aggregate_allowed" CHECK ("aggregate_type" IN ('alert', 'incident')),
    CONSTRAINT "soc_outbox_messages_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "soc_outbox_messages_status_allowed" CHECK ("status" IN ('pending', 'processing', 'published')),
    CONSTRAINT "soc_outbox_messages_attempts_non_negative" CHECK ("attempt_count" >= 0),
    -- Un mensaje en proceso sin lease no podría recuperarse; uno publicado sin instante
    -- no dejaría rastro de cuándo salió.
    CONSTRAINT "soc_outbox_messages_processing_has_lease" CHECK (
        "status" <> 'processing' OR ("lease_until" IS NOT NULL AND "claim_id" IS NOT NULL)
    ),
    CONSTRAINT "soc_outbox_messages_published_has_time" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL)
);

-- La idempotencia del hecho la impone la base: el mismo hecho no se publica dos veces.
CREATE UNIQUE INDEX "soc_outbox_messages_idempotency_key" ON "soc_outbox_messages" ("idempotency_key");
-- Índice parcial: el despachador solo recorre lo no publicado, que es una fracción mínima.
CREATE INDEX "soc_outbox_messages_claim_idx" ON "soc_outbox_messages" ("available_at", "message_id")
    WHERE "status" <> 'published';

COMMIT;
