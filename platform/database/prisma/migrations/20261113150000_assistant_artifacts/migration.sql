-- Archivos generados por Qapaqzito (informes PDF/XLSX/CSV), solo aditivo.
--
-- Una fila por archivo, con el contenido en `content` (bytea). Efimeros: `expires_at` (24 h) y el
-- API purga las filas vencidas. Cada consulta filtra por (tenant_id, owner_id): solo el dueno
-- lista y descarga. El contenido nunca va a auditoria ni a logs. `post-migrate.sql` concede
-- DELETE al runtime solo sobre esta tabla (ademas de `assistant_conversations`).
BEGIN;

CREATE TABLE "assistant_artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "conversation_id" UUID,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "assistant_artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_artifacts_owner_present" CHECK (
        char_length("tenant_id") BETWEEN 1 AND 200 AND char_length("owner_id") BETWEEN 1 AND 200
    ),
    CONSTRAINT "assistant_artifacts_format" CHECK ("format" IN ('pdf', 'xlsx', 'csv')),
    CONSTRAINT "assistant_artifacts_size" CHECK (
        "size" BETWEEN 0 AND 26214400 AND octet_length("content") = "size"
    ),
    CONSTRAINT "assistant_artifacts_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "assistant_artifacts_chronology" CHECK ("expires_at" > "created_at")
);

-- Listado y descarga de la persona (vigentes), y recuento diario.
CREATE INDEX "assistant_artifacts_owner_expiry_idx"
    ON "assistant_artifacts" ("tenant_id", "owner_id", "expires_at");
-- Purga de vencidos.
CREATE INDEX "assistant_artifacts_expiry_idx" ON "assistant_artifacts" ("expires_at");

COMMIT;
