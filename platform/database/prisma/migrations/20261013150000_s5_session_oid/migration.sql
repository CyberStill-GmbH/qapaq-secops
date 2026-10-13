-- Sprint 5 · fase 3: OID de Entra en la sesión.
--
-- El padrón del grupo de admisión identifica a cada persona por su OID; la sesión guardaba solo
-- `sub`, que es propio de cada aplicación. Con esta columna, una baja del grupo o la pérdida de
-- la propiedad del grupo revocan las sesiones abiertas de esa persona. Las sesiones previas
-- quedan con NULL y vencen por su tope absoluto.
BEGIN;

ALTER TABLE "access_sessions" ADD COLUMN "subject_oid" TEXT;
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_sessions_subject_oid_format" CHECK (
    "subject_oid" IS NULL
    OR "subject_oid" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);
CREATE INDEX "access_sessions_oid_idx" ON "access_sessions" ("tenant_id", "subject_oid", "state");

COMMIT;
