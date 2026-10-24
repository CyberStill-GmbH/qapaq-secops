# Wazuh → Microsoft Teams Workflows

Adaptador de notificación para **Wazuh Manager 4.x** (`wazuh-integratord`). No
corresponde a Wazuh 5.x, que ya no usa `<integration>`/integratord. El script
envía una Adaptive Card al webhook de Workflows y rechaza el formato heredado
`/IncomingWebhook/`.

## Datos y credenciales

- Solo envía alertas con regla de nivel 12 o mayor.
- La tarjeta contiene nivel, ID de regla, ID de alerta y fecha. No envía mensaje
  original, usuario, IP, agente, evento crudo, token ni evidencia.
- La URL firmada no se guarda en `ossec.conf`, parámetros de proceso, logs o Git.
  El argumento `hook_url` es la ruta a un archivo protegido por el SO.
- Crear `/var/ossec/etc/integrations/qapaq-teams-workflow-url` con el secreto
  obtenido de Key Vault por el mecanismo de identidad administrada del host.
  Permisos esperados: `root:wazuh`, modo `0640`. No copiarlo a una variable de CI.
- La URL debe ser HTTPS de Azure Logic Apps o Power Platform y tener una ruta
  `/workflows/`; endpoints con ruta `/IncomingWebhook/` se rechazan.

## Instalación Azure

El bundle Azure fija `custom-qapaq-teams`, `apply_teams_workflow.py` y el bloque
XML en su manifiesto de hashes. Si `siem_host.wazuh_secret_names` contiene la
clave `qapaq-teams-workflow-url`, el bootstrap lee ese nombre de secreto desde
Key Vault con la identidad administrada. El nombre puede apuntar al mismo
secreto ya referenciado por `core_secret_names.QAPAQ_TEAMS_WORKFLOW_URL`.

El instalador valida que la URL sea de Teams Workflows, copia el archivo con
modo `0640` a `/var/ossec/etc/integrations/`, instala el adaptador como
`root:wazuh` con modo `0750`, fusiona el bloque de forma idempotente y valida
`wazuh-analysisd -t`. Conserva una copia de `ossec.conf`; si la validación o el
reinicio fallan, restaura la configuración previa. Nunca escribe la URL en
`ossec.conf`, argv, CI o logs. Si la referencia opcional no está configurada,
no instala ni activa la integración.

## Instalación manual controlada

1. Instalar `custom-qapaq-teams` en `/var/ossec/integrations/`, propietario
   `root:wazuh`, modo `0750`.
2. Crear el archivo del secreto por un canal seguro, modo `0600`, propietario
   `root:root`; el instalador lo copia al destino de Wazuh con modo `0640`,
   propietario `root:wazuh`.
3. Integrar el bloque `ossec-teams-workflow.xml` dentro de `<ossec_config>` de
   `/var/ossec/etc/ossec.conf` sin duplicar otros `<integration>` existentes.
4. Validar la sintaxis de `ossec.conf`, reiniciar `wazuh-manager` en ventana
   controlada y revisar `ossec.log` sin activar debug ni imprimir secretos.
5. Disparar una regla sintética de nivel 12+, confirmar una sola tarjeta y probar
   que un nivel inferior no produce POST. Verificar timeout/429 y la recuperación
   del integratord. Mantener habilitado el flujo de notificación aprobado.

La integración ya forma parte del contrato reproducible del bundle Azure; las
pruebas locales cubren selección de endpoint, idempotencia y rechazo de
configuración duplicada. Esto no demuestra instalación en una VM ni entrega al
tenant Teams: esas pruebas requieren que el bundle actualizado se publique,
Key Vault contenga la URL vigente y el host supere la validación y una prueba
sintética de regla 12+.
