# 18 · Integraciones

> Estado (2026-11-08). Fuente de verdad de los textos de la página «Integraciones»:
> `wazuh/dashboard/plugins/qapaq_ops/common/integrations.ts`; estados declarados en
> `infra/aws-poweruser/host/opensearch_dashboards.yml` (`qapaq_ops.integrations.*`). Rangos de reglas
> registrados en [`detections/catalog.yaml`](../detections/catalog.yaml). Las reglas de correlación
> del programa de detección (101700–101769) se documentan en [17](17-ingenieria-de-deteccion.md).
> Ninguna integración ejecuta acciones en el proveedor: todas son de **solo lectura**.

## Resumen

| Fuente | Mecanismo | Intervalo | Reglas QAPAQ | Estado |
| --- | --- | --- | --- | --- |
| Agentes Wazuh | Agente → manager (TCP 1514/1515) | Tiempo real | Ruleset oficial + QAPAQ (AD 101300–101307, endpoint, Linux 101750–101769) | Activo: solo el agente del propio nodo |
| Microsoft 365 / Entra ID | Módulo `office365` de Wazuh | 1 min | 100502–100530 (+ cadenas 101700–101709) | **Activo** (2026-11-10): `ActivityFeed.Read` concedido; 4 suscripciones (Entra ID, Exchange, SharePoint, General) |
| Microsoft 365 · SharePoint/OneDrive | Módulo `office365` (Audit.SharePoint) o collector Purview `sharepoint.py audit` + postura `sharepoint.py posture` | 5 min · 60 min | 101900–101979 (+ 100515) | **Activo** (auditoría por el módulo office365); postura **bloqueada**: faltan `SharePointTenantSettings.Read.All` y `Sites.Read.All` |
| Bitdefender GravityZone | Collector `gravityzone.py` (systemd) | 10 min | 101400–101411 (+ 101720–101729) | Activo |
| Snyk | Collector `issues.py` (systemd) | 15 min | 101450–101458 (+ 101730–101739) | Activo |
| Cloudflare | Collector `security.py` (systemd) | 5 min | 101500–101513 (+ 101740–101749) | Activo |
| AWS (cuenta QAPAQ) | EventBridge → SNS → webhook → receptor `aws-events` | Push, casi tiempo real | 101600–101699 (+ 101710–101719) | Activo (17 suscripciones) |
| Correo de alertas | `qapaq_alert_mail.py` → Microsoft Graph `sendMail` | `ALERT_INTERVAL_MIN` | Nivel ≥ 8 | **Bloqueado**: falta `Mail.Send` |
| Qapaqzito | API de Anthropic (Claude) | Bajo demanda | — | Activo si hay clave ([15](15-qapaqzito-asistente.md)) |
| Ankay | Embebido por SSO | Bajo demanda | — | Activo ([20](20-guia-de-usuario.md#ankay)) |

Escala de severidad QAPAQ sobre `rule.level` (`modules/telemetry`): baja 0–3, media 4–7, **alta
8–11**, **crítica 12–15**. El correo y la portada usan esa escala.

Los collectors leen secretos de archivos 0600 en `/opt/qapaq/secrets/collectors/` (separados de
`services.env` por el instalador), escriben JSONL con `fsync` y checkpoint dentro del volumen de logs
del manager (`/var/ossec/logs/qapaq-collectors/`) y el manager los lee con
`<localfile log_format="json">`. Instalación de los tres collectors y del correo:

```bash
sudo bash /opt/qapaq/src/wazuh/provider-ingestion/install-qapaq-collectors.sh
```

`QAPAQ_ENABLE_{BITDEFENDER,SNYK,CLOUDFLARE,ALERT_MAIL}=true|false` fuerza cada uno; por defecto se
activa el que tenga sus secretos. El instalador valida con `wazuh-analysisd -t`, revierte si falla y
reinicia solo el manager. Estado: `systemctl list-timers 'qapaq-*'`.

> Trabajo en curso de otro agente (sin fusionar): una variante de monitoreo de proveedores con
> `deploy-provider-monitoring.sh`, timers `qapaq-provider-*` (incluida la salud de M365) y reglas
> `qapaq_provider_service_rules.xml` (101216–101299). Cuando se fusione, esta página se actualiza.

## Agentes Wazuh (endpoints y servidores)

- **Recoge:** logs del sistema (journald, Windows Event Log), FIM, SCA (CIS), inventario y
  vulnerabilidades, rootcheck.
- **Enrolamiento:** `agents.dev.security.qapaq.pe`, contraseña obligatoria
  (`/opt/qapaq/secrets/wazuh-authd.pass`, distribuir por gestor de secretos o MDM). Instrucciones
  Linux y Windows en [AGENTS.md](../infra/aws-poweruser/AGENTS.md).
- **Grupos instalados en el nodo:** `linux-pilot`, `windows-pilot`, `windows-sysmon-pilot`,
  `windows-domain-controller` (`setup-wazuh-content.sh`). Las políticas por grupo de
  [16](16-politicas.md) (`linux-servers`, `windows-servers`, …) se aplican con
  `apply-policies.sh`; usar el grupo que corresponda al enrolar (`WAZUH_AGENT_GROUP`).
- **Estado:** solo el propio nodo está enrolado. Cobertura de endpoints reales: brecha
  [19 #1](19-brechas-y-roadmap.md).

## Metadatos de mensaje para investigación correlada

- El schema oficial de Microsoft define `MailboxOwnerUPN` y `recipientList` como campos opcionales del
  schema de Exchange Mailbox; `InternetMessageId` y `NetworkMessageId` aparecen en determinados tipos
  de registro y no son universales. `recipientList` puede contener hasta 1000 direcciones, pero QAPAQ
  proyecta como máximo 50 direcciones únicas por evento e incluye `recipientCount` y
  `recipientsTruncated` para que el analista vea cuándo el resumen quedó limitado. Véase el
  [schema de Office 365 Management Activity API](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema).
- El parser QAPAQ solo permite esos campos expresamente declarados; no copia `Parameters`,
  `ModifiedProperties`, cuerpos ni adjuntos. Las direcciones son datos personales: quedan sujetas a
  los controles y retención del índice de auditoría. La versión local del mapping pasa a `1.3.0`.
- La investigación puede pivotar de remitente/propietario a destinatarios y agrupar eventos solo cuando
  comparten un `NetworkMessageId` o `InternetMessageId` explícito. Una coincidencia temporal o de usuario
  sigue siendo contexto correlado, no evidencia de que sea el mismo mensaje. La proyección local tiene
  fixtures sintéticos; falta validar que el tenant y el parser Wazuh entreguen estos campos en los
  eventos reales aprobados.
- El template estándar Wazuh 4.14.8 mapea strings dinámicos como `keyword`, lo que permite el pivot
  `term` sobre `data.office365.recipientList.Address` en índices creados con ese template; el mapping de
  los índices existentes del entorno aún debe comprobarse. Véase el
  [template oficial Wazuh 4.14.8](https://raw.githubusercontent.com/wazuh/wazuh/v4.14.8/extensions/elasticsearch/7.x/wazuh-template.json).
- La consulta de investigación limita cada grupo a ocho entidades seleccionadas. Aunque la proyección
  admite hasta 50 destinatarios en un evento, un expediente grande puede requerir seleccionar/pivotar
  varios destinatarios en consultas separadas; no se anuncia una expansión ilimitada de la búsqueda.

## Microsoft 365 / Entra ID

- **Recoge:** `Audit.AzureActiveDirectory`, `Audit.Exchange`, `Audit.SharePoint`, `Audit.General`
  (inicios de sesión, roles, consentimientos OAuth, reglas de bandeja, reenvíos, auditoría).
- **Reglas:** 100502–100530 (fuerza bruta, spray, login tras fuerza bruta, reenvío, roles, OAuth,
  federación, auditoría desactivada, break-glass por lista CDB `qapaq-break-glass`). Tabla completa en
  [`wazuh/office365/README.md`](../wazuh/office365/README.md).
- **Permisos necesarios:** app de Entra con **Office 365 Management APIs › `ActivityFeed.Read`**
  (aplicación, consentimiento de administrador). Unified Audit Log activo. Salida HTTPS a
  `login.microsoftonline.com` y `manage.office.com`.
- **Estado actual (2026-11-10):** `ActivityFeed.Read` fue concedido y se documentaron eventos de auditoria recibidos.
  Comprueba la salud de la fuente y la hora del ultimo evento antes de interpretar que no hay actividad.
  `SecurityAlert.Read.All` y `SecurityIncident.Read.All` siguen siendo permisos separados para el modulo
  `ms-graph`; su ausencia no implica que el feed `Audit.*` este bloqueado. Diagnostico sin secretos:
  `python3 wazuh/office365/check_entra_app.py`.
- **Operar:** si la fuente aparece degradada, revisar salud, suscripciones activas y errores del modulo
  en el host; no volver a conceder permisos ni cambiar el estado del dashboard sin validar la causa.


## Microsoft 365 · SharePoint y OneDrive

- **Recoge:** actividad de archivos (descargas y sincronización, borrados y papelera, enlaces anónimos e
  invitaciones, política de uso compartido, administradores de sitio, etiquetas y DLP) por el módulo `office365`
  (A1) o, sin `ActivityFeed.Read`, por Purview Audit Search (A2, `sharepoint.py audit`, misma forma
  `office365.*` + contexto `qapaq.*`: fuera de horario, red nueva, cuenta deshabilitada, invitado). Postura cada
  60 min (`sharepoint.py posture`): configuración de uso compartido del tenant, sitios nuevos y enlaces
  anónimos/externos.
- **Reglas:** 101900–101979 (`detections/sharepoint/`, 6 casos de uso, 54 reglas, 1832 casos de logtest): descarga web/API
  masiva 150/10 min (10), sincronización OneDrive 500/10 min (7), fuera de horario 40/30 min (12), destrucción 300/15 min (13), correo personal (9), etiqueta
  quitada y compartido (13), tenant debilitado (12). Allowlists `qapaq-m365-service-accounts` y
  `qapaq-m365-sharing-approved`; reputación `qapaq-ti-blocklist` / `qapaq-ti-tor`.
- **Permisos mínimos:** `ActivityFeed.Read` **o** `AuditLogsQuery-SharePoint.Read.All` +
  `AuditLogsQuery-OneDrive.Read.All`; `SharePointTenantSettings.Read.All` y `Sites.Read.All` para la postura;
  `User.Read.All` (concedido). Diagnóstico sin secretos: `check_sharepoint_access.py`.
- **Estado (2026-11-10):** `ActivityFeed.Read` concedido → auditoría por el módulo office365 (753 eventos de
  SharePoint/OneDrive en 24 h); reglas, listas y timers `qapaq-collector-sharepoint-{audit,posture}` activos en AWS.
  Postura bloqueada (403 en `admin/sharepoint/settings` y `sites`): faltan `SharePointTenantSettings.Read.All` y
  `Sites.Read.All`. Purview (`auditLog/queries`) en 403: no hace falta mientras exista `ActivityFeed.Read`.
- **Detalle:** [23](23-sharepoint-onedrive.md) · runbook
  [exfiltración desde SharePoint](detection-engineering/runbooks/exfiltracion-sharepoint.md).

## Bitdefender GravityZone

- **Recoge:** estado de endpoints administrados (infección, aislamiento, módulos apagados, firmas o
  agente desactualizados, política no aplicada; cambios + snapshot diario) y cuarentena.
- **Reglas:** 101400–101411. Infectado nivel 12; detección, aislado, antimalware apagado o
  cuarentena nivel 10; 3+ cuarentenas en 1 h nivel 13.
- **Permisos:** API key con Network y Quarantine (solo lectura). La key actual también tiene
  Accounts, Companies, Policies y Reports; **no** tiene Push, Licensing, Packages ni Integrations, e
  Incidents responde «sin EDR» (verificado 2026-11-03).
- **Secretos:** `BITDEFENDER_API_KEY`, `BITDEFENDER_REGION`. Diagnóstico:
  `journalctl -u qapaq-collector-bitdefender`.

## Snyk

- **Recoge:** issues REST (`version=2024-10-15`) por `updated_after`, con severidad, paquete, CVE y
  madurez del exploit; sin `SNYK_ORG_ID` lee todas las organizaciones visibles.
- **Reglas:** 101450–101458. Crítica 12 (13 con exploit maduro), alta 10 (11), media 5, baja 3;
  resueltos e ignorados nivel 2. Exposición a Internet (101730–101731) con la lista
  `qapaq-internet-facing-projects`.
- **Permisos:** token de servicio con lectura de la organización. Secretos: `SNYK_TOKEN`,
  `SNYK_ORG_ID`, `SNYK_API_URL`.
- **Nota:** un evento por cambio de issue; sin cambios no hay eventos nuevos.

## Cloudflare

- **Recoge:** audit logs de la cuenta (DNS, reglas de seguridad, tokens, miembros) y
  `firewallEventsAdaptive` (GraphQL) por zona.
- **Reglas:** 101500–101513. Zona eliminada 12; control de seguridad eliminado o cambio de
  tokens/miembros 10; 20 bloqueos de una IP en 5 min 10.
- **Permisos:** API token con `Account Audit Logs:Read` y `Zone Analytics:Read`. Secreto:
  `CLOUDFLARE_API_TOKEN`.
- **Nota:** los bloqueos del WAF dependen del tráfico real; 0 eventos puede ser normal.

## AWS (cuenta 061098277310)

- **Mecanismo (sin IAM):** trail de la cuenta → EventBridge (bus default; reglas por categoría en
  `us-east-1` y un centinela que reenvía toda escritura en cada una de las otras 16 regiones
  habilitadas) → SNS cifrado con CMK propia (política de recurso con `aws:SourceArn`) →
  `https://dev.security.qapaq.pe/hooks/aws-sns` (ALB + WAF → edge: solo POST, 300 KB, 50 r/s) →
  receptor `aws-events` (firma SNS v2, `TopicArn` permitido, deduplicación, timestamp ≤ 1 h) →
  `/var/ossec/logs/qapaq-collectors/aws/aws-events.jsonl`.
- **Recoge:** consola y root, IAM/Identity Center/Organizations/Access Analyzer, red y EC2 sensible,
  S3 (políticas, ACL, bloqueo público, cifrado), KMS, CloudTrail/GuardDuty/Security Hub/Config,
  manipulación del propio pipeline y actividad en regiones no habituales. Solo **eventos de
  escritura** de gestión.
- **Reglas:** 101600–101699 (p. ej. 101605 login de root, 101620 CloudTrail detenido, 101641 SG
  abierto a Internet, 101616 cambio del pipeline); 50/50 casos en
  `wazuh/aws-events/tests/run-aws-logtest.sh`. Correlación 101710–101719 en [17](17-ingenieria-de-deteccion.md).
- **No recoge:** eventos de lectura ni de datos (S3 GetObject), VPC Flow Logs, CloudWatch Logs,
  cambios de Identity Center (viven en la cuenta de administración). GuardDuty y Security Hub están
  apagados: sus reglas (101663–101673) quedan listas sin datos.
- **Habilitar en un nodo nuevo:** `terraform apply`, copiar `terraform output -raw
  aws_events_receiver_env` a `infra/aws-poweruser/host/aws-events.env`, `sudo bash
  wazuh/aws-events/install-aws-events.sh` y recrear `aws-events`. Las suscripciones se confirman solas.

## Correo de alertas

- **Qué hace:** un correo por intervalo con las alertas nuevas de nivel ≥ 8 (lotes de hasta 50,
  máximo 6 correos/hora, deduplicado, cola acotada), HTML y texto en español con enlace a la cola.
- **Permiso necesario:** Microsoft Graph **`Mail.Send`** (aplicación) con consentimiento,
  idealmente limitado al buzón `ALERT_EMAIL_FROM` con una Application Access Policy de Exchange.
- **Bloqueado:** la app «Soc Interno» tiene `Organization.Read.All`, `Policy.Read.All`,
  `SecurityEvents.Read.All`, `User.Read.All` y `UserAuthenticationMethod.Read.All`, pero no
  `Mail.Send`. El instalador deja `qapaq-alert-mail.timer` apagado.
- **Habilitar:** conceder el permiso; comprobar con
  `python3 /opt/qapaq/collectors/alert-mail/qapaq_alert_mail.py --config /opt/qapaq/collectors/etc/alert-mail.json --check`
  y `--test`; relanzar `install-qapaq-collectors.sh`; cambiar `qapaq_ops.integrations.alertMail.state`.

## Inicialización de canales de aviso

Los avisos del SOC (API, `modules/soar`) salen por tres canales administrables en
**Notificaciones → Canales**: Microsoft Teams (Workflows), correo de respaldo (Graph `Mail.Send`)
y avisos al navegador (Web Push). La bandeja de QAPAQ es el último respaldo y no se apaga.

| Canal | Entrada del despliegue | Queda «configurado» cuando |
| --- | --- | --- |
| `teams` | `QAPAQ_TEAMS_WORKFLOW_URL` en `secrets/services.env`, o el webhook pegado en la consola | hay URL en la base o en el entorno |
| `email` | `QAPAQ_ALERT_MAIL_SENDER` en `secrets/services.env` + `QAPAQ_ENTRA_CLIENT_SECRET` | están el buzón y el secreto de la app |
| `push` | `QAPAQ_VAPID_PRIVATE_KEY` | existe la clave VAPID |

**Qué hace el arranque** (`NotificationChannelRegistry.initialize()`, idempotente):

- Por cada canal sin fila en `notification_channels` escribe una con autor `system:bootstrap` y
  `revision = 1`. Configurado ⇒ nace activo; sin configurar ⇒ nace apagado y la consola lo muestra
  como pendiente (`setup: configure`), nunca como canal sano.
- Si hay URL de Teams en el entorno y existe `QAPAQ_ENTITY_REF_KEY`, la guarda cifrada
  (AES-256-GCM). Sin clave, o si la URL no pasa la validación del webhook, no guarda el secreto:
  la URL sigue sirviendo desde el entorno y el arranque lo informa (`secretSkipped`).
- Una fila existente no se toca: **la base manda sobre el entorno**. Varias réplicas pueden
  arrancar a la vez (inserción «solo si no existe»).
- Cada siembra queda auditada (`notifications.channel.initialized`, actor de servicio) solo con
  la máscara del destino. Con la base caída el arranque no falla: lo reporta y los canales
  configurados por entorno siguen entregando.

**Dónde se ve:** una línea de arranque `notifications.channel.status` por canal (estado, `setup`,
origen, revisión; sin destino); `degradedReasons` de `GET /api/operations/health`
(`NOTIFICATION_TEAMS_NOT_CONFIGURED`, `NOTIFICATION_NO_P1_CHANNEL`); y la pestaña Canales, con la
guía de puesta en marcha de Teams mientras falte configurar, activar o probar.

**Concurrencia:** `GET /api/notifications/channels` publica `revision`, `setup` y `needsSetup`
por canal. `PUT …/teams` y `POST …/{id}/enable|disable` aceptan `expectedRevision`; si la fila
cambió responden `STATE_CONFLICT` sin escribir. Los resultados de envío (salud) se guardan
aparte y no cambian la revisión. Con el canal `push` apagado no se avisa a ningún dispositivo.

Procedimiento paso a paso: [06 · Operación](06-operacion.md#inicialización-de-canales-de-aviso).

## Integraciones instaladas sin activar

- `custom-qapaq`, `custom-qapaq-shuffle`, `custom-qapaq-teams` en `/var/ossec/integrations` (sin bloque
  `<integration>`): necesitan URL y clave de destino.
- Para `custom-qapaq`, el código local del punto 1 envía un hint HMAC minimizado y espera aceptación
  durable de `POST /api/ingest/wazuh`; el API lo busca en Indexer antes de promoverlo. Aún falta
  cablear/verificar URL y secreto coincidentes en Manager y API, aplicar la migración PostgreSQL,
  habilitar el bloque `<integration>` y ejecutar un canario sintético. Hasta completar esas etapas,
  la ruta no se considera activa ni casi en tiempo real; el pull periódico sigue como recuperación.
  Estado y gates: [07](07-deteccion-ml-y-soar.md#ingesta-push-mas-reconciliacion) y
  [25](25-programa-confiabilidad-e-investigacion.md#punto-1--ingesta-push-durable-en-el-perfil-vigente).
- Sophos Central y Cato: código en `wazuh/provider-ingestion` (copiado a
  `/opt/qapaq/provider-ingestion` sin timers). No son fuentes contratadas por QAPAQ; su rango
  101550–101599 está reservado.
