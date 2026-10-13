-- Sprint 5 · fase 3 (S5-D6, S5-D7): padrón del grupo de admisión de Entra.
--
-- Datos mínimos para la administración: OID (clave estable), nombre, UPN y si la cuenta está
-- habilitada. `directory_sync_state` guarda el enlace delta del proveedor y un lease con fencing
-- (`claim_id`) para que una sola réplica sincronice a la vez.
--
-- El runtime no tiene DELETE: una baja de miembro y un dueño que deja de serlo se registran
-- como cambio de estado (`membership = 'removed'`, `active = false`), lo que además conserva la
-- historia del padrón.
BEGIN;

CREATE TABLE "directory_sync_state" (
    "tenant_id" TEXT NOT NULL,
    "group_id" UUID NOT NULL,
    "delta_link" TEXT,
    "status" TEXT NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error_class" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "claim_id" UUID,
    CONSTRAINT "directory_sync_state_pkey" PRIMARY KEY ("tenant_id", "group_id"),
    CONSTRAINT "directory_sync_state_status_allowed" CHECK ("status" IN ('never', 'ok', 'failed')),
    CONSTRAINT "directory_sync_state_lease_coherent" CHECK (("lease_until" IS NULL) = ("claim_id" IS NULL)),
    -- El enlace delta solo puede apuntar al proveedor: un valor alterado no redirige nada.
    CONSTRAINT "directory_sync_state_delta_link_origin" CHECK (
        "delta_link" IS NULL OR "delta_link" LIKE 'https://graph.microsoft.com/%'
    ),
    CONSTRAINT "directory_sync_state_error_format" CHECK (
        "last_error_class" IS NULL OR "last_error_class" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    )
);

CREATE TABLE "directory_members" (
    "tenant_id" TEXT NOT NULL,
    "group_id" UUID NOT NULL,
    "oid" UUID NOT NULL,
    "display_name" TEXT,
    "upn" TEXT,
    "account_enabled" BOOLEAN,
    "membership" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "directory_members_pkey" PRIMARY KEY ("tenant_id", "group_id", "oid"),
    CONSTRAINT "directory_members_membership_allowed" CHECK ("membership" IN ('member', 'removed'))
);

CREATE TABLE "directory_owners" (
    "tenant_id" TEXT NOT NULL,
    "group_id" UUID NOT NULL,
    "oid" UUID NOT NULL,
    "display_name" TEXT,
    "upn" TEXT,
    "active" BOOLEAN NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "directory_owners_pkey" PRIMARY KEY ("tenant_id", "group_id", "oid")
);

COMMIT;
