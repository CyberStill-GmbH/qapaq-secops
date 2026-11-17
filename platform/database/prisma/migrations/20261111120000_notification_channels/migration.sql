-- Canales de aviso administrables desde la consola (docs/18 §Notificaciones).
--
-- `secret_ciphertext` guarda el webhook de Teams cifrado con AES-256-GCM (clave derivada en el API
-- de QAPAQ_ENTITY_REF_KEY); `secret_hint` es solo la máscara visible. Sin DELETE para el runtime:
-- quitar un webhook es desactivar el canal o reemplazarlo.
BEGIN;

CREATE TABLE "notification_channels" (
    "tenant_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secret_ciphertext" TEXT,
    "secret_hint" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT,
    "last_success_at" TIMESTAMPTZ(3),
    "last_failure_at" TIMESTAMPTZ(3),
    "last_http_status" INTEGER,
    "last_failure_reason" TEXT,
    "last_test_at" TIMESTAMPTZ(3),
    "last_test_outcome" TEXT,
    "last_test_http_status" INTEGER,
    "last_test_provider_id" TEXT,
    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("tenant_id", "channel_id"),
    CONSTRAINT "notification_channels_id_allowed" CHECK ("channel_id" IN ('teams', 'email', 'push')),
    CONSTRAINT "notification_channels_secret_pair" CHECK (
        ("secret_ciphertext" IS NULL) = ("secret_hint" IS NULL)
    ),
    CONSTRAINT "notification_channels_ciphertext_format" CHECK (
        "secret_ciphertext" IS NULL OR "secret_ciphertext" LIKE 'v1:%'
    ),
    CONSTRAINT "notification_channels_test_outcome" CHECK (
        "last_test_outcome" IS NULL OR "last_test_outcome" IN ('accepted', 'failed')
    )
);

COMMIT;
