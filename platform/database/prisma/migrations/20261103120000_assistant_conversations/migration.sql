-- Historial de conversaciones de Qapaqzito, el asistente de IA (docs/15).
--
-- Una fila por conversación; los mensajes viven en `messages` (arreglo jsonb) para que un turno
-- (pregunta + respuesta) se agregue con una sola escritura atómica. Cada consulta filtra por
-- (tenant_id, owner_id): nadie más que el dueño lee, continúa o borra una conversación.
--
-- Es la única tabla del runtime con borrado real: la persona borra lo suyo y la retención
-- (`QAPAQ_QAPAQZITO_RETENTION_DAYS`) purga lo inactivo. `post-migrate.sql` concede DELETE al runtime
-- solo sobre esta tabla. El texto se guarda tal como lo vio la persona; el cifrado en reposo lo
-- da el motor (RDS cifrado con KMS).
BEGIN;

CREATE TABLE "assistant_conversations" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "message_count" INTEGER NOT NULL,
    "messages" JSONB NOT NULL,
    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_conversations_owner_present" CHECK (
        char_length("tenant_id") BETWEEN 1 AND 200 AND char_length("owner_id") BETWEEN 1 AND 200
    ),
    CONSTRAINT "assistant_conversations_title_length" CHECK (char_length("title") BETWEEN 1 AND 80),
    CONSTRAINT "assistant_conversations_message_count" CHECK ("message_count" BETWEEN 0 AND 200),
    CONSTRAINT "assistant_conversations_messages_array" CHECK (
        jsonb_typeof("messages") = 'array' AND jsonb_array_length("messages") = "message_count"
    ),
    CONSTRAINT "assistant_conversations_chronology" CHECK ("updated_at" >= "created_at")
);

-- Listado de la persona: más recientes primero, con el id como desempate (paginación por clave).
CREATE INDEX "assistant_conversations_owner_idx"
    ON "assistant_conversations" ("tenant_id", "owner_id", "updated_at" DESC, "id" DESC);
-- Purga por retención del tenant.
CREATE INDEX "assistant_conversations_retention_idx"
    ON "assistant_conversations" ("tenant_id", "updated_at");

COMMIT;
