-- C-24: write-only secret lifecycle metadata. This migration contains no secret material column.
BEGIN;

CREATE TABLE "managed_secrets" (
    "id" UUID NOT NULL,
    "logical_name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "rotated_by" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" TEXT,
    CONSTRAINT "managed_secrets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "secret_versions" (
    "secret_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "provider_version" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" TEXT,
    CONSTRAINT "secret_versions_pkey" PRIMARY KEY ("secret_id", "version")
);

CREATE TABLE "secret_lifecycle_operations" (
    "operation_id" TEXT NOT NULL,
    "secret_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "secret_lifecycle_operations_pkey" PRIMARY KEY ("operation_id")
);

CREATE TABLE "secret_lifecycle_audit" (
    "id" UUID NOT NULL,
    "secret_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "version" INTEGER,
    "fingerprint" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "result" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "failure_class" TEXT,
    CONSTRAINT "secret_lifecycle_audit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "secret_reconciliations" (
    "id" UUID NOT NULL,
    "operation_id" TEXT NOT NULL,
    "secret_id" UUID NOT NULL,
    "logical_name" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "fingerprint" TEXT,
    "intended_version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" TEXT,
    CONSTRAINT "secret_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_secrets_logical_name_key" ON "managed_secrets"("logical_name");
CREATE UNIQUE INDEX "managed_secrets_current_version_key" ON "managed_secrets"("id", "current_version");
CREATE UNIQUE INDEX "secret_versions_provider_ref_key" ON "secret_versions"("provider_ref");
CREATE INDEX "secret_versions_status_idx" ON "secret_versions"("secret_id", "status");
CREATE INDEX "secret_lifecycle_operations_secret_idx" ON "secret_lifecycle_operations"("secret_id", "completed_at");
CREATE INDEX "secret_lifecycle_audit_secret_idx" ON "secret_lifecycle_audit"("secret_id", "occurred_at", "id");
CREATE UNIQUE INDEX "secret_reconciliations_operation_key" ON "secret_reconciliations"("operation_id");
CREATE INDEX "secret_reconciliations_pending_idx" ON "secret_reconciliations"("reason", "created_at");

ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_secret_fkey" FOREIGN KEY ("secret_id") REFERENCES "managed_secrets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "secret_lifecycle_operations" ADD CONSTRAINT "secret_lifecycle_operations_secret_fkey" FOREIGN KEY ("secret_id") REFERENCES "managed_secrets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_state_check"
  CHECK ((status = 'ACTIVE' AND revoked_at IS NULL AND revoked_by IS NULL) OR
         (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL) OR
         status = 'RECONCILIATION_REQUIRED');
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_uuid_v7_check"
  CHECK (substring(id::text, 15, 1) = '7');
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_revision_check"
  CHECK (current_version >= 1 AND revision >= 1);
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_text_check"
  CHECK (char_length(logical_name) BETWEEN 1 AND 128 AND logical_name !~ '[[:cntrl:]]' AND
         char_length(purpose) BETWEEN 1 AND 128 AND purpose !~ '[[:cntrl:]]' AND
         char_length(owner) BETWEEN 1 AND 128 AND owner !~ '[[:cntrl:]]' AND
         char_length(classification) BETWEEN 1 AND 128 AND classification !~ '[[:cntrl:]]' AND
         char_length(provider) BETWEEN 1 AND 64 AND provider !~ '[[:cntrl:]]');
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_metadata_check"
  CHECK (version >= 1 AND provider_ref ~ '^secret://[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' AND
         fingerprint ~ '^hmac-sha256:v1:[0-9a-f]{64}$' AND status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED', 'RECONCILIATION_REQUIRED'));
ALTER TABLE "secret_lifecycle_operations" ADD CONSTRAINT "secret_lifecycle_operations_type_check"
  CHECK (operation IN ('create', 'rotate', 'revoke') AND version >= 1);
ALTER TABLE "secret_lifecycle_audit" ADD CONSTRAINT "secret_lifecycle_audit_check"
  CHECK (action IN ('secret.create', 'secret.rotate', 'secret.revoke') AND
         result IN ('success', 'failure', 'reconciliation_required'));
ALTER TABLE "secret_lifecycle_audit" ADD CONSTRAINT "secret_lifecycle_audit_uuid_v7_check"
  CHECK (substring(id::text, 15, 1) = '7');
ALTER TABLE "secret_reconciliations" ADD CONSTRAINT "secret_reconciliations_check"
  CHECK (operation IN ('create', 'rotate', 'revoke') AND intended_version >= 1 AND
         reason IN ('PROVIDER_STATE_UNKNOWN', 'METADATA_PERSISTENCE_FAILED', 'CONCURRENT_STATE_CHANGE'));
ALTER TABLE "secret_reconciliations" ADD CONSTRAINT "secret_reconciliations_uuid_v7_check"
  CHECK (substring(id::text, 15, 1) = '7');

CREATE TRIGGER secret_lifecycle_operations_immutable BEFORE UPDATE OR DELETE ON secret_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION c04_reject_mutation();
CREATE TRIGGER secret_lifecycle_audit_immutable BEFORE UPDATE OR DELETE ON secret_lifecycle_audit
FOR EACH ROW EXECUTE FUNCTION c04_reject_mutation();

COMMIT;
