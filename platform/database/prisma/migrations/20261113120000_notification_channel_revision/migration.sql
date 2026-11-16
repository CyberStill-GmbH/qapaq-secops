-- Revisión de la configuración de cada canal de aviso (docs/18 §Inicialización de canales).
--
-- La consola envía `expectedRevision` y el API hace compare-and-set sobre esta columna: dos
-- administradores no se pisan y la siembra del arranque (`system:bootstrap`) nunca reemplaza una
-- fila existente. Los resultados de envío (salud) se escriben sin tocarla. Las filas previas
-- quedan en 1. Aditiva: no reescribe datos.
BEGIN;

ALTER TABLE "notification_channels"
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "notification_channels"
    ADD CONSTRAINT "notification_channels_revision_positive" CHECK ("revision" >= 1);

COMMIT;
