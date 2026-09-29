# PBI-007 — Configurar Microsoft 365 en Wazuh

Fecha del diagnóstico: 2026-09-28 · Estado: `BLOCKED` · Responsable de la
dependencia externa: Product Owner / administrador del tenant.

## Decisión y estado

PBI-007 no está resuelto ni aceptado. El diagnóstico identificó una causa raíz
accionable en el registro de aplicación de Microsoft Entra: la autenticación
`client_credentials` emite tokens, pero estos no contienen roles de aplicación;
la Office 365 Management API rechaza la lectura de suscripciones. La evidencia y
los pasos que siguen son el resultado de una comprobación real documentada por
CesarQAPAQ en el commit `189e281` (2026-09-28); no sustituyen la concesión de
permisos ni la validación posterior.

## Comprobaciones realizadas

Con un registro de aplicación existente —secret reference
`secret://qapaq/microsoft/entra-app`; no se versionan valores— se verificaron:

1. Flujo `client_credentials` contra los endpoints de token de Microsoft Graph y
   Office 365 Management API, solicitando sus scopes `/.default`.
2. El claim `roles` de cada token emitido.
3. Una lectura de `GET /api/v1.0/{tenant}/activity/feed/subscriptions/list`, la
   operación que necesita el módulo `o365` de Wazuh.

| Comprobación | Resultado observado |
| --- | --- |
| Emisión de token para Microsoft Graph | HTTP 200; `roles: []` |
| Emisión de token para Office 365 Management API | HTTP 200; `roles: []` |
| Lista de suscripciones de actividad | HTTP 401 `AF10001`; el recurso indica que no se presentó el permiso esperado |

La emisión exitosa del token solo demuestra que la aplicación se autenticó ante
Entra. No demuestra autorización para leer datos. Con la evidencia disponible,
el prerequisito pendiente es el permiso de aplicación `ActivityFeed.Read` para
Office 365 Management APIs y el consentimiento administrativo correspondiente.
El responsable del tenant debe confirmar y conceder el permiso con el rol
apropiado; desarrollo no puede suplir esa acción.

## Acciones para desbloquear

1. El administrador de Entra revisa y concede el permiso mínimo requerido
   `ActivityFeed.Read` y el admin consent. `ActivityFeed.ReadDlp` queda fuera del
   alcance salvo aprobación explícita del dataset DLP.
2. El Product Owner confirma los datasets Office 365 necesarios, suscripciones,
   retención y minimización de datos antes de activar más categorías.
3. Repetir las comprobaciones con identidad autorizada. La lista de suscripciones
   debe responder satisfactoriamente (o indicar que todavía no existen), no con
   `401 AF10001`.
4. Configurar el módulo oficial `o365` en un Manager Wazuh autorizado usando
   `SecretProvider`/secret references. No versionar `ossec.conf` real ni valores
   de secretos.
5. Generar actividad sintética autorizada en el tenant y demostrar la alerta en
   Wazuh, con procedencia, y su lectura por el pipeline. Registrar artefactos
   redactados ligados a commit y ambiente.

## Configuración objetivo del módulo `o365`

Esta plantilla es una referencia para Infraestructura cuando se habilite un
Manager autorizado. `ossec.conf` productivo no se versiona y los secretos se
materializan en runtime desde `SecretProvider`:

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

El Product Owner confirma el conjunto de suscripciones antes de activarlo: cada
categoría amplía el volumen y la clasificación de datos operativos/personales.
`ActivityFeed.ReadDlp` no se agrega sin aprobar expresamente el dataset DLP. El
diagnóstico original y esta plantilla derivan del registro de CesarQAPAQ en el
commit `189e281`; se preservaron aquí al separar PBI-007 de la guía técnica C-10.

## Alcance que no queda aceptado

- El diagnóstico de permisos no configura por sí solo Wazuh ni produce una
  alerta de Microsoft 365.
- Las suites locales de C-10/C-28 no consultan Microsoft Graph, Office 365,
  Manager ni Indexer reales; tampoco cierran PBI-007.
- C-10 puede avanzar con sus contratos locales y C-11/C-24 pueden comenzar sus
  contratos internos. Las pruebas que requieran tenant, permisos, red o
  infraestructura autorizados continúan `BLOCKED` hasta disponer de ellos.
- El Sprint Goal y el MVP Candidate no pueden declararse logrados sin el flujo
  autorizado Microsoft 365 → Wazuh → QAPAQ.

Referencias: [ADR-024 — vertical Microsoft 365/Wazuh](../../adr/024-microsoft-365-wazuh-mvp-vertical.md) ·
[C-06 — integración](../c-06/README.md) ·
[C-10 — adapter Wazuh](../c-10/README.md) ·
[Product Backlog](../product-backlog.md) ·
[Decisiones sin resolver](../../decisions/unresolved.md).
