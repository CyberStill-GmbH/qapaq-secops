-- Enriquecimiento de reputación de archivos por hash, a pedido del analista.
--
-- `file_reputation_cache` guarda el último resultado normalizado por tenant, servicio y hash
-- durante 24 h para no repetir consultas; un resultado vencido se reemplaza con UPSERT, nunca se
-- borra. `file_reputation_quota_uses` registra cada consulta que salió al servicio: es el
-- contador compartido de la cuota (4/min y 500/día por tenant), así que vale entre réplicas y
-- reinicios. El runtime no tiene DELETE; el volumen está acotado por la propia cuota.
BEGIN;

CREATE TABLE "file_reputation_cache" (
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "file_reputation_cache_pkey" PRIMARY KEY ("tenant_id", "provider", "hash"),
    CONSTRAINT "file_reputation_cache_provider" CHECK ("provider" ~ '^[a-z0-9-]{1,40}$'),
    CONSTRAINT "file_reputation_cache_hash_shape" CHECK (
        ("algorithm" = 'md5' AND "hash" ~ '^[0-9a-f]{32}$') OR
        ("algorithm" = 'sha1' AND "hash" ~ '^[0-9a-f]{40}$') OR
        ("algorithm" = 'sha256' AND "hash" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "file_reputation_cache_status" CHECK ("status" IN ('found', 'unknown')),
    CONSTRAINT "file_reputation_cache_result_present" CHECK (
        ("status" = 'found') = ("result" IS NOT NULL)
    ),
    CONSTRAINT "file_reputation_cache_result_bounded" CHECK (
        "result" IS NULL OR octet_length("result"::text) <= 8192
    ),
    CONSTRAINT "file_reputation_cache_expiry" CHECK ("expires_at" > "checked_at")
);

CREATE TABLE "file_reputation_quota_uses" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "file_reputation_quota_uses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "file_reputation_quota_uses_provider" CHECK ("provider" ~ '^[a-z0-9-]{1,40}$')
);

CREATE INDEX "file_reputation_quota_uses_window_idx"
    ON "file_reputation_quota_uses" ("tenant_id", "provider", "used_at" DESC);

COMMIT;
