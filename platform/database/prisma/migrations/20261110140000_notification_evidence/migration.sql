-- Avisos explicativos, control de ruido y evidencia de entrega (docs/18 §Notificaciones).
--
-- `group_key`: hash opaco del grupo de ruido (incidente, patrón del correlador o regla+entidad).
-- `context`: resumen enmascarado de la alerta avisada, para que la consola explique el aviso.
-- `delivery`: evidencia por canal e intento (HTTP, id del proveedor, motivo); nunca contenido.
-- `suppressed`: no se publicó por política (agrupada, atrasada, tope, resumen); `superseded`: un
-- aviso posterior o una decisión registrada la reemplaza. Nada se borra.
BEGIN;

ALTER TABLE "notification_attempts"
    ADD COLUMN "group_key" TEXT,
    ADD COLUMN "context" JSONB,
    ADD COLUMN "delivery" JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN "suppression_reason" TEXT,
    ADD COLUMN "superseded_by" UUID,
    ADD COLUMN "digest_id" UUID;

ALTER TABLE "notification_attempts" DROP CONSTRAINT "notification_attempts_status_allowed";
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_status_allowed" CHECK (
    "status" IN (
        'pending', 'sending', 'sent', 'indeterminate', 'failed', 'fallback', 'acknowledged',
        'suppressed', 'superseded'
    )
);
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_delivery_array" CHECK (
    jsonb_typeof("delivery") = 'array'
);
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_context_object" CHECK (
    "context" IS NULL OR jsonb_typeof("context") = 'object'
);
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_suppression_reason" CHECK (
    "status" <> 'suppressed' OR "suppression_reason" IS NOT NULL
);
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_suppression_reason_allowed" CHECK (
    "suppression_reason" IS NULL
    OR "suppression_reason" IN ('grouped', 'stale_backlog', 'rate_limited', 'digest')
);

CREATE INDEX "notification_attempts_group_idx"
    ON "notification_attempts" ("tenant_id", "group_key", "sent_at");
CREATE INDEX "notification_attempts_undigested_idx"
    ON "notification_attempts" ("tenant_id", "created_at")
    WHERE "status" = 'suppressed' AND "digest_id" IS NULL;

-- Contexto mínimo de los avisos ya enviados, desde el mensaje del outbox y la alerta: la consola
-- puede explicar también los avisos anteriores a esta migración. Correos e IPs del título se
-- enmascaran igual que en los avisos nuevos.
UPDATE "notification_attempts" AS n
SET "context" = jsonb_build_object(
        'kind', o."aggregate_type",
        'alertId', CASE WHEN o."aggregate_type" = 'alert' THEN o."aggregate_id"::text END,
        'incidentId', CASE WHEN o."aggregate_type" = 'incident' THEN o."aggregate_id"::text
                           ELSE a."incident_id"::text END,
        'title', regexp_replace(
                     regexp_replace(COALESCE(o."payload"->>'title', o."message_type"),
                                    '([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@', '\1***@', 'g'),
                     '\m(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\M', '\1.\2.x.x', 'g'),
        'priority', o."payload"->>'priority',
        'severity', o."payload"->>'severity',
        'ruleId', COALESCE(o."payload"->>'ruleId', a."rule_id"),
        'score', o."payload"->'score',
        'relatedAlertCount', COALESCE((o."payload"->>'relatedAlertCount')::int, 0),
        'occurredAt', to_char(COALESCE(a."occurred_at", o."available_at") AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'summary', NULL,
        'mitre', '[]'::jsonb,
        'reasons', '[]'::jsonb,
        'test', false
    )
FROM "soc_outbox_messages" AS o
LEFT JOIN "soc_alerts" AS a ON a."id" = o."aggregate_id" AND o."aggregate_type" = 'alert'
WHERE o."message_id" = n."message_id" AND n."context" IS NULL;

-- Evidencia de los envíos previos: solo consta que el canal aceptó (2xx); no se guardó el estado
-- exacto ni el id del proveedor.
UPDATE "notification_attempts"
SET "delivery" = jsonb_build_array(jsonb_build_object(
        'channel', CASE WHEN "channel" = 'teams' THEN 'teams'
                        WHEN "channel" = 'fallback_email' THEN 'email' ELSE 'console' END,
        'outcome', 'accepted',
        'at', to_char("sent_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'httpStatus', NULL,
        'providerMessageId', NULL,
        'providerLink', NULL,
        'reason', 'registrado antes de guardar evidencia por intento'
    ))
WHERE "sent_at" IS NOT NULL AND "delivery" = '[]'::jsonb;

COMMIT;
