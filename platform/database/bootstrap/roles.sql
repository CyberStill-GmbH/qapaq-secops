-- QAPAQ SecOps — roles de mínimo privilegio para PostgreSQL (decisión D-6).
--
-- Lo ejecuta la tarea `migrator` en modo `bootstrap-roles` con la credencial master de RDS,
-- una vez por ambiente y cada vez que se rotan las contraseñas. Es idempotente.
--
--   qapaq_migrator     dueño del esquema y de las tablas: aplica migraciones (DDL).
--   qapaq_soc_runtime  login del API: DML sin DELETE ni TRUNCATE y sin DDL.
--
-- Las contraseñas llegan como settings de sesión (`qapaq.migrator_password`,
-- `qapaq.runtime_password`) porque CREATE/ALTER ROLE no aceptan parámetros enlazados; se
-- citan con `format('%L')`. Nunca se escriben en este archivo ni en logs.
--
-- Tablas append-only (auditoría) no reciben UPDATE para el runtime: además del trigger de la
-- migración, el permiso no existe. Una migración futura que agregue otra tabla append-only
-- debe revocar UPDATE explícitamente para `qapaq_soc_runtime`.

DO $roles$
DECLARE
  migrator_password text := current_setting('qapaq.migrator_password');
  runtime_password  text := current_setting('qapaq.runtime_password');
BEGIN
  IF length(migrator_password) < 32 OR length(runtime_password) < 32 THEN
    RAISE EXCEPTION 'Las contraseñas de rol deben tener al menos 32 caracteres.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qapaq_migrator') THEN
    EXECUTE format('CREATE ROLE qapaq_migrator LOGIN PASSWORD %L', migrator_password);
  ELSE
    EXECUTE format('ALTER ROLE qapaq_migrator WITH LOGIN PASSWORD %L', migrator_password);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qapaq_soc_runtime') THEN
    EXECUTE format('CREATE ROLE qapaq_soc_runtime LOGIN PASSWORD %L', runtime_password);
  ELSE
    EXECUTE format('ALTER ROLE qapaq_soc_runtime WITH LOGIN PASSWORD %L', runtime_password);
  END IF;

  -- Ninguno puede crear bases, roles ni saltarse RLS.
  ALTER ROLE qapaq_migrator NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ALTER ROLE qapaq_soc_runtime NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  -- Un statement colgado del API no debe retener locks indefinidamente.
  ALTER ROLE qapaq_soc_runtime SET statement_timeout = '15s';
  ALTER ROLE qapaq_soc_runtime SET idle_in_transaction_session_timeout = '30s';
END
$roles$;

-- El master necesita pertenecer a `qapaq_migrator` para transferirle la propiedad.
GRANT qapaq_migrator TO CURRENT_USER;

DO $grants$
DECLARE
  database_name text := current_database();
  relation record;
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', database_name);
  -- CREATE sobre la base: la migración C-04 abre con `CREATE SCHEMA IF NOT EXISTS "public"`,
  -- y PostgreSQL exige el permiso aunque el esquema ya exista. Solo el rol de DDL lo tiene.
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO qapaq_migrator', database_name);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO qapaq_soc_runtime', database_name);

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE, CREATE ON SCHEMA public TO qapaq_migrator;
  GRANT USAGE ON SCHEMA public TO qapaq_soc_runtime;

  -- Las tablas creadas antes por el master pasan a `qapaq_migrator`, que es quien migra.
  FOR relation IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
       AND pg_get_userbyid(c.relowner) <> 'qapaq_migrator'
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO qapaq_migrator',
      CASE relation.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        ELSE 'TABLE'
      END,
      relation.relname
    );
  END LOOP;
END
$grants$;

-- Permisos del runtime sobre lo existente: DML sin DELETE ni TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO qapaq_soc_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qapaq_soc_runtime;

-- Excepciones: auditoría append-only y el historial de migraciones de solo lectura.
DO $exceptions$
BEGIN
  IF to_regclass('public.audit_events') IS NOT NULL THEN
    REVOKE UPDATE ON public.audit_events FROM qapaq_soc_runtime;
  END IF;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE ON public._prisma_migrations FROM qapaq_soc_runtime;
  END IF;
END
$exceptions$;

-- Lo que `qapaq_migrator` cree en adelante nace con los mismos permisos para el runtime.
ALTER DEFAULT PRIVILEGES FOR ROLE qapaq_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO qapaq_soc_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE qapaq_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO qapaq_soc_runtime;
