# Archivo crudo de Wazuh

`apply-archives.sh` habilita `logall_json` en Wazuh Manager, activa `archives` en el módulo
Filebeat y registra la política `qapaq-wazuh-archives-7d` antes del reinicio. El workflow
`.github/workflows/wazuh-archives.yml` ofrece `audit` (solo lectura) y `apply` por GitHub OIDC +
SSM. No cambia Terraform, DNS, secretos M365 ni políticas de `wazuh-alerts-*`.

La captura cruda abarca todos los eventos procesados por el Manager, incluidos eventos que no
generan alertas; no es un filtro exclusivo de M365. La política de siete días solo aplica a
`wazuh-archives-*`; los índices de alertas mantienen su
política actual. Los archivos locales se guardan con backup bajo `/root/qapaq-archives-backup-*`;
si la validación o los reinicios fallan, el script restaura `ossec.conf` y `filebeat.yml`.

## Datos existentes y nuevos

El archivo crudo comienza cuando el cambio queda activo. Los eventos M365 que ya se encuentran en
`wazuh-alerts-*` siguen visibles y consultables allí; activar archives no los convierte ni los
duplica retroactivamente. La configuración Office 365 actual usa `only_future_events=yes` para no
reprocesar actividad anterior. Por ese motivo, este paso no fuerza un replay masivo que pueda crear
alertas duplicadas. La recuperación de contenido aún disponible en Microsoft (hasta siete días
desde la notificación de disponibilidad) requiere un procedimiento de replay separado con dedupe
por `Id` y prueba controlada antes de habilitarlo.

Una vez que existan documentos archive, crear/seleccionar el patrón de Dashboard `wazuh-archives-*`
con campo de tiempo `timestamp`. El patrón actual `wazuh-alerts-*` continúa mostrando las alertas,
incluidas las reglas M365 QAPAQ.

La captura cruda incrementa disco y volumen del Indexer. Vigilar espacio libre, ingesta Filebeat y
la aplicación de ISM; no activar la misma integración en más de un Manager.
