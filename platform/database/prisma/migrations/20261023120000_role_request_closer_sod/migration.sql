-- Cierra SoD para el rechazo de la etapa Seguridad: quien aprobó Acceso no puede cerrar
-- la segunda etapa, tampoco por una escritura directa contra PostgreSQL.
--
-- Si ya existe una fila histórica que viola esta regla, abortamos sin modificarla. Debe
-- revisarse y remediarse explícitamente antes de reintentar esta migración.
BEGIN;

DO $$
BEGIN
    IF to_regclass('public.access_role_requests') IS NULL THEN
        RAISE EXCEPTION 'access_role_requests must exist before applying the closer SoD constraint';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "access_role_requests"
        WHERE "closed_by_oid" IS NOT NULL
          AND "access_approver_oid" IS NOT NULL
          AND "closed_by_oid" = "access_approver_oid"
    ) THEN
        RAISE EXCEPTION 'access_role_requests contains a closure by the prior access approver; review and remediate before retrying';
    END IF;
END;
$$;

ALTER TABLE "access_role_requests"
    DROP CONSTRAINT "access_role_requests_closer_distinct";

ALTER TABLE "access_role_requests"
    ADD CONSTRAINT "access_role_requests_closer_distinct" CHECK (
        "closed_by_oid" IS NULL
        OR (
            "closed_by_oid" <> "requester_oid"
            AND "closed_by_oid" <> "target_oid"
            AND (
                "access_approver_oid" IS NULL
                OR "closed_by_oid" <> "access_approver_oid"
            )
        )
    ) NOT VALID;

ALTER TABLE "access_role_requests"
    VALIDATE CONSTRAINT "access_role_requests_closer_distinct";

COMMIT;
