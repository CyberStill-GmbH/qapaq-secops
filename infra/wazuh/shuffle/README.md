# Integración Wazuh → Ankay/Shuffle

Adaptador de salida para el backend **Wazuh Manager 4.x**. El Manager POSTea
metadatos mínimos de alertas filtradas a un webhook HTTPS de Shuffle/Ankay; no
ejecuta Active Response ni llama a Teams directamente. **Este camino solo inicia
triage de lectura**: no es el despachador canónico de acciones, no incluye
evidencia/IOC y no puede ejecutar workflows con efectos. El despacho gobernado de
acciones debe salir del outbox QAPAQ según ADR-028 y sigue pendiente de contrato e
implementación. Wazuh conserva detección y alertas, y QAPAQ mantiene casos,
autorizaciones y auditoría.

## Seguridad y contrato

- Solo se reenvían alertas Wazuh de nivel 12 o superior.
- El payload v1 envía referencia/fecha de alerta, regla, agente y manager. Excluye
  `full_log`, datos de proveedor, usuario, IP, ruta de archivo y evidencia.
- La llamada incluye `X-Qapaq-Integration` con valor acordado en el webhook trigger
  de Shuffle y `client-request-id` igual al ID de alerta. Shuffle debe configurar
  el header como obligatorio y rechazar solicitudes sin el valor correcto.
- Se exige HTTPS, path moderno `/api/v1/webhooks/webhook_<id>`, hostname FQDN y
  puerto 443. No se acepta HTTP, URL con user/password, query/fragments ni IP
  literal.
- URL y token se guardan juntos solo en
  `/var/ossec/etc/integrations/qapaq-shuffle-webhook.json`, propietario `root:ossec`,
  modo `0640`. No ponerlos en `ossec.conf`, argumentos, CI, Git ni logs. En Azure,
  obtener el archivo desde Key Vault mediante identidad administrada del Manager;
  no registrar el secreto en Terraform state.
- El envío es at-least-once. El workflow debe deduplicar por `alert.id` antes de
  cualquier efecto. Un ACK HTTP del webhook prueba recepción por Shuffle, no que
  el playbook terminó ni que hubo respuesta humana.
- En Wazuh config se establece nivel 12, timeout 8 s y hasta 3 reintentos por
  timeout. No habilitar contención automática, aislamiento, bloqueo de IP ni cambios
  de identidad desde el primer rollout.

## Flujo de trabajo de Shuffle

1. Crear un workflow `QAPAQ · Clasificación inicial Wazuh` y añadir un Webhook
   trigger POST. Configurar el header obligatorio `X-Qapaq-Integration` con un
   token aleatorio de al menos 32 caracteres; conservar ese valor fuera del repo.
2. Iniciar el trigger, guardar la URL `/api/v1/webhooks/webhook_<id>` en el archivo
   protegido del Manager y comprobar certificado TLS desde la red privada de Wazuh.
3. Primeros nodos: validar schema/version/nivel, deduplicar por `alert.id`, guardar
   ejecución y veredicto, y enrutar por regla/categoría a enriquecimiento read-only.
   El workflow no debe ejecutar código ni comandos recibidos en el payload.
4. Teams Workflows usa un receptor HTTP actual que puede publicar un mensaje o una
   Adaptive Card. El webhook firmado de Microsoft no se debe almacenar como una
   variable ordinaria de workflow. Usar autenticación/KMS de Shuffle verificada
   para la acción HTTP o delegar envío al outbox QAPAQ. ADR-022 mantiene a QAPAQ
   como dueño de avisos críticos; no habilitar una segunda entrega crítica desde
   Shuffle sin revisar ese ADR y su idempotencia.
5. Añadir aprobación humana, ejecución y verificación como etapas distintas para
   cualquier acción de contención. Empezar con una acción de notificación/triage
   sintética y auditar el resultado.

El catálogo inicial de escenarios M365/Graph, Sophos, Cato y VirusTotal está en
[`docs/security/ankay-playbooks/README.md`](../../../docs/security/ankay-playbooks/README.md)
y su manifiesto versionado en `catalog.yaml`. No se habilitan acciones con efectos
desde el trigger directo de Wazuh. En particular, Teams crítico permanece bajo el
outbox QAPAQ (ADR-022) para evitar doble envío.

## Integración de interfaz

La menor fricción es incluir `Ankay / Shuffle` en el menú del Dashboard y servir
`/ankay/*` a través del edge existente con `auth_request` de la sesión QAPAQ. Usar
link navegable en el mismo origen; no iframe ni acceso público. La app requiere
además un mecanismo de SSO confiable para no dejar un login local distinto. La
autorización previa cubre preparar la ruta protegida, pero el stack Azure actual
no contiene Manager, Shuffle ni edge desplegados y no puede activar esta ruta.

## Archivos y verificación

- `custom-qapaq-shuffle`: emisor HTTP Wazuh 4.x.
- `ossec-shuffle-webhook.xml`: bloque para integrar en `<ossec_config>` tras
  validar la configuración existente y evitar duplicados.
- Pruebas sintéticas: `python -m unittest discover -s infra/wazuh/shuffle/tests -v`.

El inventario de automatizaciones upstream y la priorización para M365, Sophos,
Cato y Wazuh están en
[`docs/security/ankay-playbooks/opensource-roadmap.md`](../../../docs/security/ankay-playbooks/opensource-roadmap.md).

La integración no se considera conectada hasta verificar TLS, header requerido,
entrega de una alerta sintética y visibilidad de su ejecución en Shuffle. No se
han aplicado cambios a un Manager ni a la consola de Shuffle.

## Referencias primarias

- [Wazuh: integración en `ossec.conf`](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/integration.html)
- [Shuffle: webhook trigger y autenticación por headers](https://shuffler.io/docs/workflows)
- [Microsoft: webhooks de Teams Workflows](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
