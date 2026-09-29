-- C-24: metadata write-only de credenciales de integración.
-- Ninguna columna admite material secreto. El valor vive exclusivamente en el
-- gestor externo; aquí solo existen referencia, fingerprint no reversible y
-- metadata no sensible.
BEGIN;

CREATE TABLE "integration_secret_metadata" (
    "id" UUID NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL,
    "revision" BIGINT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "labels" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "rotated_by" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_secret_metadata_pkey" PRIMARY KEY ("id")
);

-- Registro de operaciones aplicadas. Sostiene la idempotencia de create/rotate/revoke
-- sin conservar el cuerpo de la solicitud.
CREATE TABLE "integration_secret_operations" (
    "request_id" TEXT NOT NULL,
    "secret_metadata_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_secret_operations_pkey" PRIMARY KEY ("request_id")
);

CREATE UNIQUE INDEX "integration_secret_metadata_secret_ref_key"
    ON "integration_secret_metadata" ("secret_ref");
CREATE INDEX "integration_secret_metadata_status_idx"
    ON "integration_secret_metadata" ("status", "expires_at");
CREATE INDEX "integration_secret_operations_metadata_idx"
    ON "integration_secret_operations" ("secret_metadata_id", "applied_at");

ALTER TABLE "integration_secret_operations"
    ADD CONSTRAINT "integration_secret_operations_metadata_fkey"
    FOREIGN KEY ("secret_metadata_id") REFERENCES "integration_secret_metadata"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Identificadores generados por la aplicación, nunca en SQL.
ALTER TABLE "integration_secret_metadata"
    ADD CONSTRAINT "integration_secret_metadata_id_check"
    CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

-- La referencia conserva el formato de C-03 y no admite credenciales embebidas.
ALTER TABLE "integration_secret_metadata"
    ADD CONSTRAINT "integration_secret_metadata_secret_ref_check"
    CHECK (char_length("secret_ref") BETWEEN 12 AND 256
        AND "secret_ref" ~ '^secret://[a-z][a-z0-9-]{0,62}/[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$'
        AND "secret_ref" !~ '/\.\./'
        AND "secret_ref" !~ '/\.\.$');

-- El fingerprint tiene longitud fija: la columna no puede alojar un secreto.
ALTER TABLE "integration_secret_metadata"
    ADD CONSTRAINT "integration_secret_metadata_fingerprint_check"
    CHECK ("fingerprint" ~ '^hmac-sha256:v1:[0-9a-f]{8}:[A-Za-z0-9_-]{22}$');

ALTER TABLE "integration_secret_metadata"
    ADD CONSTRAINT "integration_secret_metadata_identity_check"
    CHECK ((char_length("namespace") BETWEEN 1 AND 63 AND "namespace" ~ '^[a-z][a-z0-9-]*$')
        AND (char_length("purpose") BETWEEN 2 AND 64 AND "purpose" ~ '^[a-z][a-z0-9-]*$')
        AND (char_length("provider") BETWEEN 1 AND 64 AND "provider" !~ '[[:cntrl:]]')
        AND (char_length("owner") BETWEEN 2 AND 128 AND "owner" !~ '[[:cntrl:]]')
        AND (char_length("created_by") BETWEEN 2 AND 128 AND "created_by" !~ '[[:cntrl:]]')
        AND ("rotated_by" IS NULL OR char_length("rotated_by") BETWEEN 2 AND 128)
        AND ("revoked_by" IS NULL OR char_length("revoked_by") BETWEEN 2 AND 128));

ALTER TABLE "integration_secret_metadata"
    ADD CONSTRAINT "integration_secret_metadata_lifecycle_check"
    CHECK ("status" IN ('active', 'revoked')
        AND "version" >= 1
        AND "revision" >= 1
        AND ("status" <> 'revoked' OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL))
        AND ("status" <> 'active' OR ("revoked_at" IS NULL AND "revoked_by" IS NULL))
        AND (("rotated_at" IS NULL) = ("rotated_by" IS NULL))
        AND ("rotated_at" IS NULL OR "rotated_at" >= "created_at")
        AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at"));

-- Las etiquetas son el único campo libre: se acotan en tamaño y se prohíben claves
-- con forma sensible para que no sirvan de almacén encubierto.
CREATE FUNCTION c24_labels_are_safe("labels" jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof($1) = 'object'
        AND length($1::text) <= 2048
        AND (SELECT count(*) FROM jsonb_object_keys($1)) <= 16
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_each_text($1) AS entry(key, value)
            WHERE entry.key ~* '(authorization|cookie|credential|password|private.?key|secret|token|api.?key|access.?key|connection.?string)'
                OR length(entry.value) > 128
                OR entry.value ~ '[[:cntrl:]]'
        );
$$;

ALTER TABLE "integration_secret_metadata"
    ADD CONSTRAINT "integration_secret_metadata_labels_check"
    CHECK (c24_labels_are_safe("labels"));

ALTER TABLE "integration_secret_operations"
    ADD CONSTRAINT "integration_secret_operations_check"
    CHECK ((char_length("request_id") BETWEEN 8 AND 128 AND "request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')
        AND (char_length("correlation_id") BETWEEN 8 AND 128 AND "correlation_id" !~ '[[:cntrl:]]')
        AND "action" IN ('created', 'rotated', 'revoked'));

-- La identidad de la referencia y su origen no se reescriben.
CREATE FUNCTION c24_protect_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" <> OLD."id"
        OR NEW."secret_ref" <> OLD."secret_ref"
        OR NEW."namespace" <> OLD."namespace"
        OR NEW."created_at" <> OLD."created_at"
        OR NEW."created_by" <> OLD."created_by" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Identidad C-24 inmutable';
    END IF;
    RETURN NEW;
END;
$$;

-- La revisión avanza de uno en uno: una escritura concurrente perdida es detectable.
-- Una referencia revocada es terminal y no puede volver a considerarse activa.
CREATE FUNCTION c24_protect_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."revision" <> OLD."revision" + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Revisión C-24 no monótona';
    END IF;
    IF OLD."status" = 'revoked' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Secreto C-24 revocado es terminal';
    END IF;
    IF NEW."version" < OLD."version" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Versión C-24 no decrece';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER integration_secret_metadata_identity_immutable
BEFORE UPDATE ON "integration_secret_metadata"
FOR EACH ROW EXECUTE FUNCTION c24_protect_identity();

CREATE TRIGGER integration_secret_metadata_lifecycle_guard
BEFORE UPDATE ON "integration_secret_metadata"
FOR EACH ROW EXECUTE FUNCTION c24_protect_lifecycle();

-- El registro de idempotencia es append-only: reescribirlo permitiría repetir una
-- operación de ciclo de vida ya aplicada.
CREATE FUNCTION c24_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Registro C-24 inmutable';
END;
$$;

CREATE TRIGGER integration_secret_operations_immutable
BEFORE UPDATE OR DELETE ON "integration_secret_operations"
FOR EACH ROW EXECUTE FUNCTION c24_reject_mutation();

COMMIT;
