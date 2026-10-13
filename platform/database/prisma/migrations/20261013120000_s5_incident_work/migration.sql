-- Sprint 5 · fase 4 (S5-D8, S5-D9): tareas y bitácora del incidente.
--
-- `incident_tasks` es trabajo asignable con revisión para compare-and-set. Una tarea
-- obligatoria abierta impide cerrar el incidente; esa regla vive en el dominio y aquí se
-- garantiza que el estado y su evidencia sean coherentes.
--
-- `incident_notes` es append-only: una corrección es una nota nueva con `corrects_note_id`.
-- El trigger rechaza UPDATE y DELETE incluso si un permiso quedara mal aplicado; además
-- `post-migrate.sql` retira esos permisos al runtime.
BEGIN;

CREATE TABLE "incident_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "incident_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "assignee_id" TEXT,
    "due_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT,
    "revision" INTEGER NOT NULL,
    CONSTRAINT "incident_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "incident_tasks_incident_fk" FOREIGN KEY ("incident_id")
        REFERENCES "soc_incidents" ("id") ON DELETE RESTRICT,
    CONSTRAINT "incident_tasks_status_allowed" CHECK (
        "status" IN ('open', 'in_progress', 'done', 'cancelled')
    ),
    CONSTRAINT "incident_tasks_title_length" CHECK (char_length("title") BETWEEN 3 AND 200),
    CONSTRAINT "incident_tasks_description_length" CHECK (char_length("description") <= 4000),
    CONSTRAINT "incident_tasks_revision_positive" CHECK ("revision" > 0),
    -- Una tarea terminada tiene instante de término; una abierta no.
    CONSTRAINT "incident_tasks_completion_coherent" CHECK (
        ("status" = 'done') = ("completed_at" IS NOT NULL)
    ),
    -- Cancelar una obligatoria exige motivo: es la excepción que permite cerrar.
    CONSTRAINT "incident_tasks_required_cancel_reason" CHECK (
        NOT ("required" AND "status" = 'cancelled')
        OR char_length(coalesce("cancellation_reason", '')) BETWEEN 10 AND 500
    )
);

CREATE INDEX "incident_tasks_incident_idx" ON "incident_tasks" ("tenant_id", "incident_id", "created_at" DESC);
-- Guardia de cierre: tareas obligatorias abiertas de un incidente.
CREATE INDEX "incident_tasks_open_required_idx" ON "incident_tasks" ("tenant_id", "incident_id")
    WHERE "required" AND "status" IN ('open', 'in_progress');

CREATE TABLE "incident_notes" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "incident_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "corrects_note_id" UUID,
    CONSTRAINT "incident_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "incident_notes_incident_fk" FOREIGN KEY ("incident_id")
        REFERENCES "soc_incidents" ("id") ON DELETE RESTRICT,
    CONSTRAINT "incident_notes_corrects_fk" FOREIGN KEY ("corrects_note_id")
        REFERENCES "incident_notes" ("id") ON DELETE RESTRICT,
    CONSTRAINT "incident_notes_body_length" CHECK (char_length("body") BETWEEN 1 AND 10000),
    CONSTRAINT "incident_notes_not_self_correction" CHECK ("corrects_note_id" IS DISTINCT FROM "id")
);

CREATE INDEX "incident_notes_incident_idx" ON "incident_notes" ("tenant_id", "incident_id", "created_at" DESC);

CREATE FUNCTION incident_notes_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $append_only$
BEGIN
    RAISE EXCEPTION 'incident_notes es append-only' USING ERRCODE = 'integrity_constraint_violation';
END
$append_only$;

CREATE TRIGGER incident_notes_append_only BEFORE UPDATE OR DELETE ON "incident_notes"
    FOR EACH ROW EXECUTE FUNCTION incident_notes_append_only();

COMMIT;
