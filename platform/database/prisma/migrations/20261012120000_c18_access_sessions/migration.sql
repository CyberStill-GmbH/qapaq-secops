-- C-18/C-25: sesiones del BFF en PostgreSQL.
--
-- El identificador de sesión es el valor de la cookie: quien lo conoce opera como la
-- persona. Por eso la base guarda solo su SHA-256 (`id_hash`) y nunca el valor original;
-- leer esta tabla no permite secuestrar sesiones.
--
-- Persistir las sesiones permite reiniciar o escalar el API sin cerrar la sesión de todo el
-- SOC, y es la base de la vista de sesiones de la administración de usuarios (C-10).
BEGIN;

CREATE TABLE "access_sessions" (
    "id_hash" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "state" TEXT NOT NULL,
    "roles" TEXT[] NOT NULL DEFAULT '{}',
    "scopes" TEXT[] NOT NULL DEFAULT '{}',
    "capabilities" TEXT[] NOT NULL DEFAULT '{}',
    "amr" TEXT[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "idp_session_id" TEXT,
    "client_ip" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" TEXT,
    "revision" INTEGER NOT NULL,
    CONSTRAINT "access_sessions_pkey" PRIMARY KEY ("id_hash"),
    CONSTRAINT "access_sessions_id_hash_format" CHECK ("id_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "access_sessions_state_allowed" CHECK (
        "state" IN ('active', 'expired', 'revoked', 'superseded')
    ),
    CONSTRAINT "access_sessions_revision_positive" CHECK ("revision" > 0),
    -- Una sesión revocada sin motivo ni instante sería una revocación sin rastro.
    CONSTRAINT "access_sessions_revocation_complete" CHECK (
        "state" = 'active' OR "state" = 'expired'
        OR ("revoked_at" IS NOT NULL AND "revocation_reason" IS NOT NULL)
    )
);

-- `activeBySubject`: sesión única por persona (C-25) y vista de sesiones por usuario.
CREATE INDEX "access_sessions_subject_idx" ON "access_sessions" ("tenant_id", "subject_id", "state");
-- Vista de administración: sesiones recientes del tenant.
CREATE INDEX "access_sessions_tenant_seen_idx" ON "access_sessions" ("tenant_id", "last_seen_at" DESC);

COMMIT;
