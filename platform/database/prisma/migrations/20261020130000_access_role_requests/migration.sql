-- Solicitudes de cambio de rol con aprobación separada (entra-soc-user-admin.md, ADR-017).
--
-- Nadie cambia `access_role_grants` directamente: una solicitud queda pendiente hasta que la
-- aprueba la etapa de Acceso y, para `qapaq.platform.admin`, además la de Seguridad. Solicitante,
-- objetivo y cada aprobador son personas distintas. La aprobación final, el grant y el AuditEvent se
-- confirman en la misma transacción. CAS sobre `revision`; el runtime no tiene DELETE.
--
-- Las reglas se repiten aquí a propósito: una fila escrita por fuera del API no puede saltarse una
-- etapa, aprobarse a sí misma ni dejar aprobado un rol privilegiado sin Seguridad.
BEGIN;

CREATE TABLE "access_role_requests" (
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "target_oid" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket" TEXT,
    "expected_grant_revision" INTEGER NOT NULL,
    "requester_oid" UUID NOT NULL,
    "requester_subject_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "access_approver_oid" UUID,
    "access_approver_subject_id" TEXT,
    "access_approved_at" TIMESTAMPTZ(3),
    "access_reason" TEXT,
    "security_approver_oid" UUID,
    "security_approver_subject_id" TEXT,
    "security_approved_at" TIMESTAMPTZ(3),
    "security_reason" TEXT,
    "closed_by_oid" UUID,
    "closed_by" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "closed_reason" TEXT,
    "revision" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "access_role_requests_pkey" PRIMARY KEY ("tenant_id", "id"),
    CONSTRAINT "access_role_requests_action_allowed" CHECK ("action" IN ('grant', 'revoke')),
    CONSTRAINT "access_role_requests_role_allowed" CHECK (
        "role" IN ('qapaq.soc.analyst', 'qapaq.soc.lead', 'qapaq.auditor', 'qapaq.platform.admin')
    ),
    CONSTRAINT "access_role_requests_status_allowed" CHECK (
        "status" IN ('pending_access', 'pending_security', 'approved', 'rejected', 'cancelled')
    ),
    CONSTRAINT "access_role_requests_reason_length" CHECK (char_length("reason") BETWEEN 10 AND 500),
    CONSTRAINT "access_role_requests_ticket_length" CHECK (
        "ticket" IS NULL OR char_length("ticket") BETWEEN 1 AND 120
    ),
    CONSTRAINT "access_role_requests_revisions" CHECK (
        "expected_grant_revision" >= 0 AND "revision" > 0
    ),
    CONSTRAINT "access_role_requests_requester_not_target" CHECK ("requester_oid" <> "target_oid"),
    CONSTRAINT "access_role_requests_access_complete" CHECK (
        ("access_approver_oid" IS NULL) = ("access_approver_subject_id" IS NULL)
        AND ("access_approver_oid" IS NULL) = ("access_approved_at" IS NULL)
        AND ("access_approver_oid" IS NULL) = ("access_reason" IS NULL)
    ),
    CONSTRAINT "access_role_requests_security_complete" CHECK (
        ("security_approver_oid" IS NULL) = ("security_approver_subject_id" IS NULL)
        AND ("security_approver_oid" IS NULL) = ("security_approved_at" IS NULL)
        AND ("security_approver_oid" IS NULL) = ("security_reason" IS NULL)
    ),
    CONSTRAINT "access_role_requests_closure_complete" CHECK (
        ("closed_at" IS NULL) = ("closed_by" IS NULL)
        AND ("closed_at" IS NULL) = ("closed_reason" IS NULL)
        AND ("closed_by_oid" IS NULL OR "closed_at" IS NOT NULL)
    ),
    CONSTRAINT "access_role_requests_access_distinct" CHECK (
        "access_approver_oid" IS NULL
        OR ("access_approver_oid" <> "requester_oid" AND "access_approver_oid" <> "target_oid")
    ),
    CONSTRAINT "access_role_requests_security_distinct" CHECK (
        "security_approver_oid" IS NULL
        OR (
            "access_approver_oid" IS NOT NULL
            AND "security_approver_oid" <> "requester_oid"
            AND "security_approver_oid" <> "target_oid"
            AND "security_approver_oid" <> "access_approver_oid"
        )
    ),
    CONSTRAINT "access_role_requests_closer_distinct" CHECK (
        "closed_by_oid" IS NULL
        OR ("closed_by_oid" <> "requester_oid" AND "closed_by_oid" <> "target_oid")
    ),
    CONSTRAINT "access_role_requests_security_only_privileged" CHECK (
        "security_approver_oid" IS NULL OR "role" = 'qapaq.platform.admin'
    ),
    CONSTRAINT "access_role_requests_status_coherent" CHECK (
        (
            "status" = 'pending_access'
            AND "access_approver_oid" IS NULL
            AND "security_approver_oid" IS NULL
            AND "closed_at" IS NULL
        )
        OR (
            "status" = 'pending_security'
            AND "role" = 'qapaq.platform.admin'
            AND "access_approver_oid" IS NOT NULL
            AND "security_approver_oid" IS NULL
            AND "closed_at" IS NULL
        )
        OR (
            "status" = 'approved'
            AND "access_approver_oid" IS NOT NULL
            AND ("role" <> 'qapaq.platform.admin' OR "security_approver_oid" IS NOT NULL)
            AND "closed_at" IS NULL
        )
        OR ("status" IN ('rejected', 'cancelled') AND "closed_at" IS NOT NULL)
    )
);

-- Una sola solicitud abierta por objetivo y rol: dos pedidos iguales no compiten por el grant.
CREATE UNIQUE INDEX "access_role_requests_open_key" ON "access_role_requests" ("tenant_id", "target_oid", "role")
    WHERE "status" IN ('pending_access', 'pending_security');
CREATE INDEX "access_role_requests_status_idx" ON "access_role_requests" ("tenant_id", "status", "created_at" DESC);

COMMIT;
