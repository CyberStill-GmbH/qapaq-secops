-- Roles concedidos por QAPAQ desde la administración (entra-soc-user-admin.md).
--
-- Una fila por persona (`tenant_id`, `oid`) con el conjunto completo de sus roles dinámicos. Es
-- una fuente separada de `QAPAQ_ROLE_BINDINGS` y de los dueños del grupo: esta tabla no las
-- copia ni las sustituye. Cada cambio reemplaza el conjunto bajo compare-and-set sobre
-- `revision`; retirar todo guarda el arreglo vacío. El runtime no tiene DELETE: la historia de
-- cambios (quién, cuándo, motivo, antes y después) vive en `audit_events`.
--
-- El catálogo de roles se repite aquí a propósito: un valor escrito por fuera del API no puede
-- conceder un rol que el runtime no conoce.
BEGIN;

CREATE TABLE "access_role_grants" (
    "tenant_id" TEXT NOT NULL,
    "oid" UUID NOT NULL,
    "roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    CONSTRAINT "access_role_grants_pkey" PRIMARY KEY ("tenant_id", "oid"),
    CONSTRAINT "access_role_grants_revision_positive" CHECK ("revision" > 0),
    CONSTRAINT "access_role_grants_roles_allowed" CHECK (
        "roles" <@ ARRAY['qapaq.soc.analyst', 'qapaq.soc.lead', 'qapaq.auditor', 'qapaq.platform.admin']::TEXT[]
    ),
    CONSTRAINT "access_role_grants_roles_bounded" CHECK (cardinality("roles") <= 4),
    CONSTRAINT "access_role_grants_updated_by_present" CHECK (length("updated_by") > 0)
);

COMMIT;
