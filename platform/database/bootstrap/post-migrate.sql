-- QAPAQ SecOps — endurecimiento después de cada `prisma migrate deploy`.
--
-- Los default privileges de `roles.sql` dan SELECT/INSERT/UPDATE al runtime sobre toda tabla
-- nueva. Estas excepciones se reaplican tras cada migración porque las tablas que cubren
-- pueden crearse en ella. Lo ejecuta `qapaq_migrator`, dueño de las tablas. Idempotente.

DO $hardening$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qapaq_soc_runtime') THEN
    -- Auditoría append-only: el trigger rechaza UPDATE/DELETE y además el permiso no existe.
    IF to_regclass('public.audit_events') IS NOT NULL THEN
      REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events FROM qapaq_soc_runtime;
    END IF;
    -- Bitácora de incidente append-only (S5-D8): solo SELECT e INSERT.
    IF to_regclass('public.incident_notes') IS NOT NULL THEN
      REVOKE UPDATE, DELETE, TRUNCATE ON public.incident_notes FROM qapaq_soc_runtime;
    END IF;
    -- Bitácora de salud de fuentes append-only (Sprint 5 · fase 2).
    IF to_regclass('public.source_health_transitions') IS NOT NULL THEN
      REVOKE UPDATE, DELETE, TRUNCATE ON public.source_health_transitions FROM qapaq_soc_runtime;
    END IF;
    -- El historial de migraciones es solo lectura para el API.
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public._prisma_migrations FROM qapaq_soc_runtime;
      GRANT SELECT ON public._prisma_migrations TO qapaq_soc_runtime;
    END IF;
    -- Historial de Qapaqzito: única tabla con borrado real (la persona borra lo suyo y la retención
    -- purga lo inactivo). DELETE sí; TRUNCATE no.
    IF to_regclass('public.assistant_conversations') IS NOT NULL THEN
      GRANT DELETE ON public.assistant_conversations TO qapaq_soc_runtime;
      REVOKE TRUNCATE ON public.assistant_conversations FROM qapaq_soc_runtime;
    END IF;
    -- Archivos de Qapaqzito (informes): efimeros; el API purga los vencidos. DELETE si; TRUNCATE no.
    IF to_regclass('public.assistant_artifacts') IS NOT NULL THEN
      GRANT DELETE ON public.assistant_artifacts TO qapaq_soc_runtime;
      REVOKE TRUNCATE ON public.assistant_artifacts FROM qapaq_soc_runtime;
    END IF;
    -- Bitácora de progreso del Analista IA append-only (docs/27): solo SELECT e INSERT.
    IF to_regclass('public.ai_investigation_events') IS NOT NULL THEN
      REVOKE UPDATE, DELETE, TRUNCATE ON public.ai_investigation_events FROM qapaq_soc_runtime;
    END IF;
  END IF;
END
$hardening$;
