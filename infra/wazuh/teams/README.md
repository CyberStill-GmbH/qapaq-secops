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

## Instalación manual controlada

1. Instalar `custom-qapaq-teams` en `/var/ossec/integrations/`, propietario
   `root:wazuh`, modo `0750`.
2. Crear el archivo del secreto por un canal seguro, modo `0640`, propietario
   `root:wazuh`.
3. Integrar el bloque `ossec-teams-workflow.xml` dentro de `<ossec_config>` de
   `/var/ossec/etc/ossec.conf` sin duplicar otros `<integration>` existentes.
4. Validar la sintaxis de `ossec.conf`, reiniciar `wazuh-manager` en ventana
   controlada y revisar `ossec.log` sin activar debug ni imprimir secretos.
5. Disparar una regla sintética de nivel 12+, confirmar una sola tarjeta y probar
   que un nivel inferior no produce POST. Verificar timeout/429 y la recuperación
   del integratord. Mantener habilitado el flujo de notificación aprobado.

Este repo no contiene actualmente el Manager Wazuh desplegado ni su paquete Azure.
El script queda versionado para incorporarse al bootstrap del backend cuando el
artefacto 4.x y el endpoint real de Key Vault estén disponibles. No se aplicó en
un host ni se transmitió una alerta real.
