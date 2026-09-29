-- C-24: guardas de ciclo de vida en la base, complementarias a la concurrencia
-- optimista de la aplicación. Siguen el precedente de C-04 (c04_protect_identity /
-- c04_reject_mutation): una invariante que el dominio ya respeta se vuelve además
-- imposible de violar por UPDATE directo, migración futura o defecto de código.
--
-- No añaden columnas ni cambian datos existentes.
BEGIN;

-- La identidad de un secreto gestionado y su origen no se reescriben.
CREATE FUNCTION c24_protect_secret_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" <> OLD."id"
        OR NEW."logical_name" <> OLD."logical_name"
        OR NEW."provider" <> OLD."provider"
        OR NEW."created_at" <> OLD."created_at"
        OR NEW."created_by" <> OLD."created_by" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Identidad C-24 inmutable';
    END IF;
    RETURN NEW;
END;
$$;

-- La revisión solo avanza: una escritura concurrente perdida o un replay que
-- intente restaurar una revisión anterior queda rechazado por la base.
-- Un secreto revocado es terminal y su versión vigente nunca retrocede.
CREATE FUNCTION c24_protect_secret_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."revision" <= OLD."revision" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Revisión C-24 no avanza';
    END IF;
    IF OLD."status" = 'REVOKED' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Secreto C-24 revocado es terminal';
    END IF;
    IF NEW."current_version" < OLD."current_version" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Versión C-24 no retrocede';
    END IF;
    RETURN NEW;
END;
$$;

-- Una versión que dejó de ser vigente no puede volver a estarlo: eso reactivaría
-- material ya reemplazado o revocado, justo el fallback que ADR-025 prohíbe.
CREATE FUNCTION c24_protect_version_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."secret_id" <> OLD."secret_id"
        OR NEW."version" <> OLD."version"
        OR NEW."fingerprint" <> OLD."fingerprint"
        OR NEW."provider_ref" <> OLD."provider_ref"
        OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Versión C-24 inmutable';
    END IF;
    IF OLD."status" <> 'ACTIVE' AND NEW."status" = 'ACTIVE' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Versión C-24 no se reactiva';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER managed_secrets_identity_immutable
BEFORE UPDATE ON "managed_secrets"
FOR EACH ROW EXECUTE FUNCTION c24_protect_secret_identity();

CREATE TRIGGER managed_secrets_lifecycle_guard
BEFORE UPDATE ON "managed_secrets"
FOR EACH ROW EXECUTE FUNCTION c24_protect_secret_lifecycle();

CREATE TRIGGER secret_versions_history_guard
BEFORE UPDATE ON "secret_versions"
FOR EACH ROW EXECUTE FUNCTION c24_protect_version_history();

COMMIT;
