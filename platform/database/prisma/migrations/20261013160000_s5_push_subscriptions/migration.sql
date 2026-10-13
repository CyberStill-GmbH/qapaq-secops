-- Sprint 5: dispositivos de cada persona para avisos Web Push.
--
-- La fila guarda el endpoint del servicio de push del navegador y sus claves públicas (no son
-- credenciales de QAPAQ: solo permiten enviar avisos a ese navegador). El push no lleva
-- contenido: el dispositivo pide el detalle a QAPAQ con su sesión. El runtime no tiene DELETE:
-- quitar un dispositivo es marcar `revoked_at`.
BEGIN;

CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_success_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" TEXT,
    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscriptions_endpoint_https" CHECK (
        "endpoint" LIKE 'https://%' AND char_length("endpoint") <= 1024
    ),
    CONSTRAINT "push_subscriptions_label_length" CHECK (char_length("label") BETWEEN 1 AND 80),
    CONSTRAINT "push_subscriptions_revocation_complete" CHECK (
        ("revoked_at" IS NULL) = ("revocation_reason" IS NULL)
    )
);

-- Un mismo navegador no se registra dos veces por tenant.
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions" ("tenant_id", "endpoint");
CREATE INDEX "push_subscriptions_subject_idx" ON "push_subscriptions" ("tenant_id", "subject_key")
    WHERE "revoked_at" IS NULL;

COMMIT;
