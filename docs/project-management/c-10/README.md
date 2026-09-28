# C-10 / PBI-007 — diagnóstico real de Microsoft 365 en Wazuh

Fecha: 2026-09-28 · Estado: `BLOCKED`, diagnóstico real completado.

## Qué se intentó

Con el app registration de Microsoft Entra ya creado (2026-09-22,
`credential_ref: secret://qapaq/microsoft/entra-app`, valores locales en
`.env` gitignored) se ejecutó una verificación real, no documental, de si
esas credenciales alcanzan para que Wazuh consuma actividad de Microsoft 365:

1. `client_credentials` grant contra
   `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` pidiendo
   `https://graph.microsoft.com/.default` y `https://manage.office.com/.default`.
2. Inspección del claim `roles` del token emitido (la lista autoritativa de
   permisos de aplicación concedidos).
3. Llamada real de solo lectura al endpoint que usa el módulo `o365` de
   Wazuh: `GET /api/v1.0/{tenant}/activity/feed/subscriptions/list`.

## Resultado real

| Paso | Resultado |
| --- | --- |
| Token Graph (`.default`) | `200`, token emitido, `roles: []` |
| Token Office 365 Management API (`.default`) | `200`, token emitido, `roles: []` |
| `subscriptions/list` (llamada real) | **`401 AF10001`** — *"The permission set () sent in the request does not include the expected permission."* |

**Conclusión verificada:** el app registration es válido y autentica
correctamente (no es un problema de tenant/client ID/secret incorrectos),
pero **no tiene ningún permiso de aplicación concedido** ni en Microsoft
Graph ni en la Office 365 Management API. Microsoft valida permisos en el
servidor de recursos, no en la emisión del token; por eso el token se emite
igual pero cualquier llamada real de datos se rechaza. Ningún cambio de
código, endpoint o reintento de este lado resuelve esto — requiere una
acción en el tenant de Microsoft Entra.

## Acción pendiente (fuera del repositorio, en Azure Portal)

Sobre el mismo app registration ya creado (`appid` conservado como
`secret://qapaq/microsoft/entra-app`, no se repite aquí por no ser necesario
para operar):

1. **Entra ID → App registrations → API permissions → Add a permission →
   Office 365 Management APIs → Application permissions** → agregar
   `ActivityFeed.Read` (mínimo) y `ActivityFeed.ReadDlp` si se requieren
   eventos DLP.
2. **Grant admin consent for [tenant]** — este es el paso que falta hoy; se
   puede haber agregado el permiso sin completar el consentimiento, lo que
   produce exactamente el síntoma observado (`roles: []`).
3. Repetir la verificación de este documento (los tres pasos de arriba) tras
   el consentimiento; solo entonces `subscriptions/list` debe responder con
   una lista de suscripciones o `404`/vacío si aún no hay ninguna creada, no
   `401`.

Esta acción requiere un rol de Entra con `Application Administrator` y la
capacidad de otorgar consentimiento de administrador sobre el tenant; no es
algo que credenciales de aplicación puedan auto-concederse.

## Configuración objetivo del módulo `o365` de Wazuh (referencia, no versionada)

Por regla de mantenimiento de
[`wazuh-engine-and-opensearch.md`](../../architecture/wazuh-engine-and-opensearch.md#reglas-de-mantenimiento),
este repositorio no versiona `ossec.conf` real. El bloque siguiente es una
**referencia para quien administra el Wazuh Manager** (Infraestructura),
lista para aplicarse en cuanto el consentimiento de arriba esté otorgado; usa
solo referencias de secreto, nunca el valor literal:

```xml
<ossec_config>
  <o365>
    <enabled>yes</enabled>
    <interval>10m</interval>
    <curl_max_size>5M</curl_max_size>
    <only_future_events>yes</only_future_events>
    <api_auth>
      <tenant_id>secret://qapaq/microsoft/entra-app#tenant_id</tenant_id>
      <client_id>secret://qapaq/microsoft/entra-app#client_id</client_id>
      <client_secret_path>/run/secrets/qapaq-microsoft-entra-client-secret</client_secret_path>
      <api_type>subscriptions</api_type>
      <subscription>Audit.AzureActiveDirectory</subscription>
      <subscription>Audit.Exchange</subscription>
      <subscription>Audit.SharePoint</subscription>
      <subscription>Audit.General</subscription>
    </api_auth>
  </o365>
</ossec_config>
```

`client_secret_path` apunta a un archivo materializado en tiempo de arranque
por el `SecretProvider` (consistente con el control plane write-only de
ADR-025), nunca a un valor en texto plano en este repositorio ni en
`ossec.conf` versionado. Las suscripciones (`Audit.*`) determinan qué
categorías de actividad de Microsoft 365 llegan a Wazuh; el dataset final
para PBI-007 debe confirmarse con Franco antes de activarlas todas — cada una
amplía el alcance de datos personales/operativos que Wazuh procesa.

## Qué sí queda avanzado

- El diagnóstico es evidencia real reutilizable: la próxima persona no
  necesita repetir la investigación, solo el consentimiento y la re-prueba.
- La configuración `o365` de destino está lista para aplicarse sin
  improvisar en el momento en que haya Wazuh Manager real disponible (ver
  [C-06 — plan y ejecución](../c-06/README.md) para el estado de esa
  infraestructura).
- **PBI-007 permanece `BLOCKED`.** Este documento no lo cierra; documenta por
  qué y exactamente qué falta, con el error real observado como evidencia.

[Daily Scrum](../daily-scrum.md) · [Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Decisiones sin resolver](../../decisions/unresolved.md) ·
[C-08 — contrato operativo Wazuh](../c-08/README.md)
