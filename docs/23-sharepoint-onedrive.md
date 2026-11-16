# 23 · SharePoint y OneDrive

> Leyenda: **[verificado]** comprobado contra el tenant o el manager real; **[sin datos]** instalado y probado con
> fixtures sintéticos, sin eventos reales; **[bloqueado]** falta un permiso de Entra. Estado al 2026-11-10.
> Integración de [18](18-integraciones.md); detecciones en [`detections/sharepoint/`](../detections/sharepoint);
> runbook [Exfiltración desde SharePoint y OneDrive](detection-engineering/runbooks/exfiltracion-sharepoint.md).
> Todo es de **solo lectura**: QAPAQ no cambia nada en Microsoft 365.

## Alcance y estado

| Área | Qué | Vía | Estado |
| --- | --- | --- | --- |
| Actividad (auditoría) | Descargas y sincronización, accesos, borrados y papelera, enlaces anónimos creados/usados, invitaciones, cambios de política, administradores de sitio, etiquetas, DLP | **A1** módulo `office365` de Wazuh (`Audit.SharePoint`) o **A2** collector Purview Audit Search | **[verificado]** A1 activo desde 2026-11-10 (`ActivityFeed.Read`): 753 eventos SharePoint/OneDrive en 24 h; A2 sin `AuditLogsQuery-*` (no hace falta) |
| Contexto | Fuera de horario (Lima 08–20, fin de semana), red nueva para el usuario (línea base 30 días), cuenta deshabilitada, invitado, IP en Spamhaus/Feodo/Tor | Collector A2 (`qapaq.*`) y listas CDB de reputación | Cuentas deshabilitadas **[verificado]** (Graph `User.Read.All`) |
| Postura | Configuración de uso compartido del tenant (diff con dirección *weakened*), inventario de sitios y sitios nuevos, enlaces anónimos y permisos externos en las bibliotecas | Collector de postura (Graph) | **[bloqueado]** |
| Salud de la fuente | Estado de cada función según los permisos; aviso si un permiso que funcionaba se pierde | Ambos collectors (eventos `capability`) | **[verificado]** timers activos en AWS (auditoría 5 min en modo `native`, postura 60 min) |

La integración aparece en **Resumen del SOC** e **Integraciones** (tarjeta «SharePoint y OneDrive»,
`qapaq_ops.integrations.sharepoint.*`) y tiene su dashboard «QAPAQ · SharePoint y OneDrive»
(`qapaq-dashboard-sharepoint-onedrive`, en `wazuh/dashboard/saved-objects/qapaq-provider-dashboards.ndjson`). En el
monitor de plataforma es la fuente `sharepoint` (collectors `sharepoint-audit` y `sharepoint-posture`),
deshabilitada con motivo mientras A1 y A2 estén bloqueadas.

### A1 · Módulo `office365` (vía preferida)

`wazuh/office365/ossec-office365.xml.tmpl` ya suscribe `Audit.SharePoint` (y `DLP.All` si se activa DLP). Necesita
**Office 365 Management APIs › `ActivityFeed.Read`**. Cuando el token lo trae, el collector A2 pasa a modo `native`
y no consulta nada (sin duplicados). Las reglas QAPAQ de SharePoint cuelgan de la cadena oficial
`0755-office365_rules.xml` (91532, 91536–91538, 91542, 91544, 91702) y de 100515.

### A2 · Collector Purview Audit Search (alternativa)

`wazuh/provider-ingestion/sharepoint/sharepoint.py audit` (timer `qapaq-collector-sharepoint-audit`):

1. Sin consulta pendiente crea `POST /v1.0/security/auditLog/queries` para `[cursor − 2 h, ahora − 30 min]`
   (máx. 24 h; primera vez, últimas 24 h) con `recordTypeFilters` según el permiso: `SharePoint`,
   `SharePointFileOperation`, `SharePointSharingOperation`, `OneDrive` y, con `AuditLogsQuery.Read.All`, también
   `ComplianceDLPSharePoint`, `SensitivityLabelAction`, `SensitivityLabeledFileAction`,
   `SharePointAppPermissionOperation` (nombres del `$metadata` de Graph v1.0; si el tenant rechaza un tipo con 400,
   reintenta solo con los de servicio).
2. En las siguientes ejecuciones sondea el estado; `succeeded` → pagina `/records` (hasta 15 000 por ejecución y
   retoma el `@odata.nextLink`); `failed`/`cancelled` o más de 3 h corriendo → la recrea.
3. Cada registro se emite con la **misma forma que el módulo** (`integration: office365`, `office365.*` = `auditData`,
   `RecordType` numérico) + `qapaq.*`; deduplica por id de registro (20 000 recientes) y el solape de 2 h absorbe la
   demora de Purview. JSONL con checkpoint write-ahead y `fsync` (`common/qapaq_collector.py`).

### Postura

`sharepoint.py posture` (timer `qapaq-collector-sharepoint-posture`): `GET /v1.0/admin/sharepoint/settings` (foto
diaria y diff de `sharingCapability`, dominios permitidos/bloqueados, re-compartir de externos, invitación con el
mismo correo, sincronización no administrada, autenticación heredada, cierre de sesión por inactividad…),
`GET /v1.0/sites/getAllSites` (sitios nuevos; en la primera pasada solo los creados en los últimos 7 días) y un
recorrido acotado y rotativo de bibliotecas (20 sitios por pasada, 3 bibliotecas, 300 ítems, profundidad 3; los
recientes primero) que solo pide `/permissions` de los ítems con faceta `shared`. Los dominios propios salen de
`/organization` (`Organization.Read.All`, ya concedido). Un sitio inaccesible no detiene el inventario (hasta 10).

## Permisos

Entra ID › Registros de aplicaciones › «Soc Interno» › Permisos de API › **de aplicación** + consentimiento de
administrador. Verificado el 2026-11-10 en el host con `check_sharepoint_access.py` (solo GET; código HTTP y conteos):
el token de `manage.office.com` trae **`ActivityFeed.Read`** y `subscriptions/list` responde **200** (4 suscripciones);
Graph sumó `RealTimeActivityFeed.Read.All`. Siguen en **403**: `auditLog/queries` (v1.0 y beta),
`admin/sharepoint/settings`, `sites/getAllSites` y `sites?search=*`. No hay `Mail.Send`, `ActivityFeed.ReadDlp`,
`SecurityAlert.Read.All` ni `SecurityIncident.Read.All`. Estado anterior (2026-11-09):

| Sondeo | HTTP | Resultado |
| --- | --- | --- |
| Token Graph | 200 | Roles: Organization.Read.All, Policy.Read.All, SecurityEvents.Read.All, User.Read.All, UserAuthenticationMethod.Read.All |
| Token `manage.office.com` | 200 | **Sin roles** |
| `activity/feed/subscriptions/list` | 401 | Falta `ActivityFeed.Read` |
| `/v1.0` y `/beta` `security/auditLog/queries` | 403 / 403 | Falta `AuditLogsQuery-*` |
| `/v1.0/admin/sharepoint/settings` | 403 | Falta `SharePointTenantSettings.Read.All` |
| `/v1.0/sites/getAllSites`, `/sites?search=*` | 403 / 403 | Falta `Sites.Read.All` |
| `/v1.0/users` deshabilitados / invitados | 200 / 200 | 26 / 110 |

Conjunto recomendado de **mínimo privilegio**:

| API | Permiso | Para qué | Necesidad |
| --- | --- | --- | --- |
| Office 365 Management APIs | `ActivityFeed.Read` | A1: Audit.SharePoint (y Entra/Exchange/General del módulo office365) | Uno de A1/A2 |
| Microsoft Graph | `AuditLogsQuery-SharePoint.Read.All` + `AuditLogsQuery-OneDrive.Read.All` | A2 sin ActivityFeed (acotados por servicio) | Uno de A1/A2 |
| Microsoft Graph | `SharePointTenantSettings.Read.All` | Postura del tenant | Recomendado |
| Microsoft Graph | `Sites.Read.All` | Inventario de sitios y enlaces anónimos/externos | Recomendado |
| Office 365 Management APIs | `ActivityFeed.ReadDlp` | DLP vía A1 (`DLP.All`) | Opcional |
| Microsoft Graph | `User.Read.All` | Cuentas deshabilitadas | **Ya concedido** |

`AuditLogsQuery.Read.All` reemplaza a los dos acotados y añade DLP y etiquetas en A2, pero lee la auditoría de
**todos** los servicios: preferir los acotados salvo que se quiera DLP/etiquetas sin `ActivityFeed.ReadDlp`.
`Sites.Read.All` lee el contenido de todos los sitios; `Sites.Selected` no sirve para inventariar.

## Detecciones (rango 101900–101979, grupo `qapaq_sharepoint`)

Escala QAPAQ: 12–15 P1, 8–11 P2, 4–7 P3, 0–3 P4. Correo desde nivel 8. MITRE por regla en el XML.

| Caso de uso | Reglas | Qué | Nivel |
| --- | --- | --- | --- |
| `exfiltration` | 101900–101914 | Descarga web/API masiva 150/10 min (10); sincronización del cliente OneDrive 500/10 min (7; 11 desde red nueva); fuera de horario 40/30 min (12); masiva desde red nueva (12); invitado 30/10 min (10); cuenta deshabilitada (10); IP Spamhaus/Feodo (12) o Tor (11); 50 usos de enlaces anónimos/10 min por IP (10) | 2–12 |
| `mass-deletion` | 101915–101920 | Borrado masivo 100/10 min (10), destrucción 300/15 min (13), vaciado de la papelera de 2.ª etapa 25/15 min (12) | 2–13 |
| `external-sharing` | 101925–101930 | Correo personal (9; 5 en 1 h = 12), invitado externo (4), 10 enlaces anónimos en 1 h (11); cuentas aprobadas bajan a 2–3 | 2–12 |
| `sharing-policy-and-admins` | 101935–101941 | Política cambiada (8) o abierta a «Cualquier persona» (12); administrador de sitio (10), en el OneDrive de otra persona (11), invitado (12) | 3–12 |
| `labels-and-dlp` | 101945–101951 | Etiqueta quitada/rebajada (8), 10 en 1 h (12), **compartido fuera tras quitar la etiqueta** (13); DLP (7), alta (11), anulación (9) | 7–13 |
| `posture` | 101960–101972 | Tenant debilitado (12) o cambiado (8), tenant con «Cualquier persona» (6), sitio nuevo (5), sitio reciente con enlaces externos (10), enlace anónimo (7) o de edición (10), permiso externo (5), función perdida (7) | 0–12 |

Reducción de falsos positivos: listas CDB **versionadas** (el repo es la fuente de verdad, cambio por PR, las
instala `deploy-detections.sh`) `qapaq-m365-service-accounts` (sincronización y servicios; `app@sharepoint` en el
aprovisionamiento de OneDrive) y `qapaq-m365-sharing-approved` (publicación con enlaces anónimos y socios; hoy solo
una cuenta sintética `.example`), que **degradan sin suprimir**; umbrales por usuario; la señal fuerte (P1) exige un
segundo indicio (horario, red nueva, reputación, etiqueta quitada); la línea base de redes tiene 7 días de
calentamiento e ignora redes internas; las marcas quedan en nivel 3 (por debajo del 4 oficial de `FileDownloaded`).
No cerrar una alerta solo porque el usuario es invitado o de servicio: los cambios de permisos, la actividad fuera
de horario o una cuenta deshabilitada se revisan igual.

Pruebas: 1832 casos sintéticos de `wazuh-logtest` (TP y benignos) generados por
`wazuh/provider-ingestion/sharepoint/tests/make_fixtures.py` con un modelo del algoritmo de frecuencia de Wazuh;
13 pruebas unitarias del collector (`python -m unittest tests/test_sharepoint_collector.py`).
**[verificado] 2026-11-10 en AWS:** 832/832 casos en un manager 4.14.8 desechable; réplica de las 755 auditorías
reales de SharePoint/OneDrive de 24 h (todas en segundos, cota superior para las reglas de frecuencia): 0 alertas de
nivel ≥ 4 de estas reglas (70 marcas de descarga 101900 y 3 de enlace anónimo usado 101910, nivel 3). Despliegue en
el manager con `wazuh-analysisd -t` OK y agente 001 activo; los eventos de capacidad del collector (101969) llegan a
`wazuh-alerts-*`.

**Calibración con datos reales (2026-11-10 13:01 → 2026-11-11 14:47 UTC):** 7893 alertas `qapaq_sharepoint`, todas
marcas salvo 45 de 101902 (P2) de 3 usuarios, 44 de ellas del cliente de sincronización: el 97 % de las descargas
eran `FileSyncDownloadedFull` («OneDrive SyncEngine», WinDesktop) y un solo equipo resincronizó 6449 archivos. Se
separó la sincronización (101912/101913, 500/10 min, P3 sin correo; 101914 P2 desde red nueva) de la descarga web o
por API (101900/101902). Réplica de 2000 eventos reales con la regla nueva: una sola alerta 101913 (nivel 7) y 0 de
nivel ≥ 8. También dispararon en real 101915 (borrado, marca), 101910 (enlace anónimo usado), 101928 (compartido con
externo, 2) y 100515 (enlace anónimo, 4). Los nombres de
operación sin registro real llevan el grupo `qapaq_pending_provider_evidence` (como en `wazuh/office365`) y los casos
de uso están en `pending-provider-evidence` hasta el primer registro real redactado.

## Activación segura

1. Conceder en Entra los permisos de la tabla y confirmar los efectivos (no basta con verlos configurados):
   `sudo python3 /opt/qapaq/collectors/provider-ingestion/sharepoint/check_sharepoint_access.py`.
2. A1: `sudo bash /opt/qapaq/src/wazuh/office365/apply-office365-docker.sh` y esperar hasta 12 h a que Microsoft active
   las suscripciones.
3. Collectors: `sudo env QAPAQ_ENABLE_SHAREPOINT=true bash /opt/qapaq/src/wazuh/provider-ingestion/install-qapaq-collectors.sh`.
   El instalador falla cerrado: si la auditoría está bloqueada o el diagnóstico recibe HTTP 403, deja ambos timers
   apagados. Revisar `systemctl status qapaq-collector-sharepoint-audit.timer qapaq-collector-sharepoint-posture.timer`
   y los JSONL en `/var/ossec/logs/qapaq-collectors/`.
4. Reglas y listas: `sudo bash /opt/qapaq/src/detections/tools/deploy-detections.sh` (respaldo, `analysisd -t`,
   reinicio y verificación del agente 001).
5. Reemplazar por PR la cuenta sintética de `detections/lists/qapaq-m365-sharing-approved` y agregar las cuentas de
   sincronización/servicio reales a `qapaq-m365-service-accounts` (claves exactas como `UserId`, sensibles a mayúsculas).
6. Cambiar `qapaq_ops.integrations.sharepoint.state` a `auto`, habilitar la fuente `sharepoint` del monitor
   (`install-platform-monitoring.sh`) y recrear el contenedor de OpenSearch Dashboards.

## Mapamundi

> Al importar en AWS (2026-11-10) los dos objetos `map` (`qapaq-microsoft-365-verified-map`,
> `qapaq-sharepoint-verified-map`) fallaron con tipo desconocido: la imagen del dashboard no trae el plugin Maps. El
> resto (50 objetos, incluido `qapaq-dashboard-sharepoint-onedrive`) se importó.

Los dashboards M365 y SharePoint incluyen un mapa base real de OpenSearch Maps. La capa de eventos está
desactivada y el estado vacío indica que `data.office365.geoip.location` aún debe existir en
`wazuh-alerts-*` con mapping `geo_point`. No se convierten IPs en coordenadas ni se usan datos ficticios.
Tras desplegar GeoIP confiable y confirmar el mapping y el plugin Maps en la imagen de Wazuh Dashboard
4.14.8, habilitar la capa para eventos del proveedor y regenerar/importar los saved objects.

## Límites

- Purview Audit Search entrega con demora (30 min a varias horas): A2 no es de tiempo real. El horario se calcula
  con la hora del evento, no la de llegada.
- El contexto `qapaq.*` (horario, red nueva, cuenta deshabilitada) solo existe en A2; con A1 aplican el volumen, la
  reputación de IP, el uso compartido, la política, las etiquetas y la DLP.
- No hay país de origen: los registros de SharePoint no traen geolocalización del cliente; se usa reputación de IP
  y la línea base de redes por usuario.
- Graph no expone la configuración de uso compartido **por sitio** (requiere SharePoint REST/PowerShell con
  `Sites.FullControl.All` y certificado); se infiere de los enlaces encontrados y de la auditoría
  (`SharingPolicyChanged`). El recorrido de enlaces es por muestreo rotativo, no exhaustivo.
- Las reglas de frecuencia de Wazuh comparten la lista de coincidencias: alertas simultáneas de varios usuarios
  pueden retrasar el conteo de otro hasta que la marca salga de la ventana.
