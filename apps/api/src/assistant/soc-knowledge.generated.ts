// GENERADO por apps/api/scripts/generate-qapaqzito-knowledge.py. No editar a mano.
// Fuentes: docs/detection-engineering (runbooks, playbooks), detections/ y XML de reglas QAPAQ.
/* eslint-disable */
import type { SocKnowledge } from './soc-knowledge.js';

export const SOC_KNOWLEDGE: SocKnowledge = {
 "attackVersion": "Enterprise v16",
 "runbookIndex": "# Runbooks de triage e investigación QAPAQ\n\nParte de [17 · Ingeniería de detección](../../17-ingenieria-de-deteccion.md). Cada runbook sigue el mismo\nesquema: **alcance** (reglas), **triage en 10 minutos**, **investigación**, **contención** (siempre por QAPAQ\nRespond con aprobación del Líder SOC), **recuperación**, **cierre y evidencia** y **consultas** (KQL para\nDiscover sobre `wazuh-alerts-*`).\n\n| Runbook | Casos de uso | Prioridad típica |\n| --- | --- | --- |\n| [Ataques de credenciales](credenciales.md) | M365 fuerza bruta/spray y cadena, BEC, Kerberos, consola AWS, SSH | P1–P2 |\n| [Escalada de privilegios](escalada-de-privilegios.md) | Roles de Entra y tier 0, IAM/Identity Center, grupos de AD, sudo/grupos y persistencia Linux | P1–P2 |\n| [Malware y EDR](malware-edr.md) | Bitdefender (malware, cuarentena, protección deshabilitada), Sophos, Outlook → proceso | P1–P2 |\n| [Vulnerabilidad expuesta](vulnerabilidad-expuesta.md) | Snyk crítica/alta con exploit maduro y expuesta, Wazuh VD | P1–P3 |\n| [Oleada en el WAF](oleada-waf.md) | Cloudflare 101513 y 101740, cambios de control | P2 |\n| [CloudTrail y auditoría](cloudtrail-y-auditoria.md) | CloudTrail/GuardDuty/Config apagados, auditoría de M365 desactivada | P1 |\n| [Exfiltración desde SharePoint](exfiltracion-sharepoint.md) | SharePoint/OneDrive: descarga masiva, borrado, uso compartido externo, política, etiquetas, postura | P1–P3 |\n| [Reglas estándar de Wazuh](reglas-estandar-wazuh.md) | Office 365 (MailItemsAccessed, envíos, descargas, admin), FIM, rootcheck, paquetes, SSH, SCA | P3–P4 |\n\nReglas comunes a todos:\n\n- **Evidencia primero:** antes de contener, exportar la alerta QAPAQ (id, prioridad, razones) y los documentos\n  Wazuh (`_id`, índice). La auditoría QAPAQ con cadena hash registra cada transición.\n- **Sin datos personales en canales abiertos:** en Teams/correo solo referencias; el detalle vive en QAPAQ (N2).\n- **Nada se suprime sin registro:** un falso positivo se documenta en el incidente y se convierte en afinamiento\n  (lista CDB, ventana de mantenimiento en QAPAQ o PR de la regla).\n- **Cierre:** clasificación VP/FP/benigno, causa raíz, acciones y lección para el backlog de detección.",
 "playbooks": "# 04 · Playbooks de Ankay\n\nParte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). Archivos:\n[`ankay/playbooks/`](../../ankay/playbooks/) (exportables de Shuffle 2.3.0, el motor heredado que\ncorre hoy en AWS con la marca Ankay). Contrato verificado por `node --test ankay/playbooks/playbooks.test.mjs`.\n\n> **Requieren aprobación de QAPAQ.** Ninguno está importado en la instancia. Los de contención llevan la compuerta\n> `qapaq_contencion_habilitada = false`: encenderla es una decisión que se registra en\n> [10](../10-decisiones.md) (A13, N5) junto con los permisos de proveedor que exige. El destino de diseño sigue\n> siendo Step Functions ([13](../13-ankay-qapaq.md)); estos flujos documentan la lógica para portarla.\n\n| Archivo | Catálogo | Riesgo | Aprobación | Efectos |\n| --- | --- | --- | --- | --- |\n| `qapaq-triage-enriquecimiento.json` | `qapaq.triage-enrichment` | Bajo | No (solo lectura) | Nota en el incidente QAPAQ y aviso por correo |\n| `qapaq-contencion-identidad-aprobada.json` | `qapaq.identity-containment` | Alto | Líder SOC + step-up, SoD | Revocar sesiones y deshabilitar la cuenta de Entra |\n| `qapaq-contencion-endpoint-aprobada.json` | `qapaq.endpoint-containment` | Medio | Líder SOC, SoD | `firewall-drop` 600 s en el agente (Wazuh Active Response) |\n\n## Triage y enriquecimiento\n\nDisparo: webhook del adaptador `infra/wazuh/shuffle` (alertas nivel ≥ 12, payload v1 **sin** usuario, IP ni\n`full_log`). Pasos: `validar_y_deduplicar` (contrato v1, `executionKey = alert.id`, clasifica la fuente y elige\nel runbook) → `buscar_alerta_qapaq` (prioridad P1–P4 y razones, API QAPAQ de solo lectura) y\n`contexto_agente_wazuh` (estado, SO y grupo) → `resumen_triage` (texto en español) → `nota_en_incidente_qapaq`\n(solo si la alerta ya está en un incidente) y `aviso_correo_qapaq`.\n\n**Correo:** usa el mismo contrato que el servicio de correo QAPAQ (`wazuh/alert-mail`): Graph `sendMail` desde el\nbuzón del SOC, asunto `QAPAQ SOC · <SEVERIDAD> · <título>`, contenido mínimo y enlace a la consola. Hoy la app no\ntiene `Mail.Send`; hasta concederlo (acotado al buzón con Application Access Policy), el paso falla cerrado y la\nnota en QAPAQ se conserva. Que Ankay tenga esa credencial es una excepción a «Respond no guarda credenciales\nde proveedor» y debe aprobarse; la alternativa es encolar la intención de aviso en el outbox de QAPAQ (contrato\npendiente en [14](../14-ankay-conexion-qapaq.md)).\n\n## Contención con aprobación\n\nDisparo: solicitud de QAPAQ Core (`incidentRef`, `executionKey`, `requestedBy`, `targetRef`, `actionId`; nunca\ncontraseñas ni tokens). Flujo: `validar_solicitud` → `contexto_para_aprobar` → **User Input**\n`aprobacion_lider_soc` → `verificar_compuerta` (aprobador ≠ solicitante **y** `qapaq_contencion_habilitada = true`)\n→ acción → `resultado_en_incidente_qapaq` (ejecutada, rechazada o bloqueada; sin reintento ciego, ADR-028).\n\n| Playbook | Prerrequisitos antes de habilitar |\n| --- | --- |\n| Identidad (Entra) | Permisos Graph `User.RevokeSessions.All` y `User.EnableDisableAccount.All` en una app dedicada; step-up para aprobar (docs/07, gate 2); prueba sobre una cuenta sintética |\n| Endpoint (Wazuh AR) | Usuario de la API de Wazuh con solo `active-response:command` (docs/07, gate 3); `firewall-drop` solo existe en agentes Linux; allowlist de IPs administrativas (`QAPAQ_AR_WHITELIST`) |\n\nLas autenticaciones se referencian por nombre (`qapaq-api-lectura`, `qapaq-graph-contencion`,\n`wazuh-api-active-response`, …) y se crean en el almacén cifrado de Ankay; el JSON no contiene secretos\n(lo comprueba el test).",
 "runbooks": [
  {
   "id": "cloudtrail-y-auditoria",
   "title": "Manipulación de CloudTrail y de la auditoría",
   "path": "docs/detection-engineering/runbooks/cloudtrail-y-auditoria.md",
   "sections": [
    "Triage en 10 minutos",
    "Contención",
    "Investigación",
    "M365: auditoría desactivada (100527, 100528)",
    "Consultas"
   ],
   "ruleIds": [
    "100527",
    "100528",
    "101620",
    "101621",
    "101710",
    "101711",
    "101712"
   ],
   "useCases": [
    "QAPAQ-DET-AWS-001",
    "QAPAQ-DET-M365-003"
   ],
   "markdown": "# Runbook · Manipulación de CloudTrail y de la auditoría\n\nAlcance: `aws/cloudtrail-tampering` (101710–101712, base 101620/101621 del paquete AWS), servicios de detección\nAWS (101622–101625, 101644), pipeline de monitoreo QAPAQ (101615) y `m365/audit-tampering` (100527, 100528).\n**Siempre P1**: borrar el rastro es la acción de un intruso o rompe la evidencia regulatoria (SBS 504-2021, N11).\n\n## Triage en 10 minutos\n\n1. **¿Quién?** `data.aws.principal` / `data.aws.principal_arn`, tipo (`Root`, `IAMUser`, `AssumedRole`) e IP.\n   Principal de CI/Terraform con cambio aprobado → documentar y cerrar como benigno.\n2. **¿Qué más hizo en la última hora?** 101710 (IAM antes), 101711 (root), 101712 (varios servicios) ya lo dicen;\n   ampliar a 24 h con `data.aws.principal:\"<p>\"`.\n3. **¿Sigue apagado?** Verificar en la consola: `GetTrailStatus` (IsLogging), GuardDuty, Config, Security Hub.\n\n## Contención\n\n1. **Restaurar el registro primero** (`StartLogging`, recrear el detector/recorder) — por un administrador con el ticket.\n2. Inhabilitar el principal: quitar sesiones/permisos del rol, desactivar access keys, y para root: cambiar\n   contraseña y revisar MFA.\n3. Si es la organización: SCP que impida `cloudtrail:StopLogging`/`DeleteTrail` salvo al rol de plataforma (BL-A).\n\n## Investigación\n\n- Hueco de evidencia: desde `StopLogging` hasta `StartLogging` no hay CloudTrail de ese trail; usar los eventos de\n  EventBridge ya entregados a QAPAQ, VPC Flow Logs y logs de servicios.\n- Revisar creaciones de usuarios/llaves/roles y snapshots compartidos (101645) en la ventana.\n\n## M365: auditoría desactivada (100527, 100528)\n\nReactivar `UnifiedAuditLogIngestionEnabled` / auditoría del buzón, identificar al administrador, revisar sus\ninicios de sesión y roles (runbook de [credenciales](credenciales.md)).\n\n## Consultas\n\n```text\nrule.id:(101620 or 101621 or 101710 or 101711 or 101712)\nrule.groups:qapaq_aws_defense_disabled\nrule.id:(100527 or 100528)\n```\n\n**Cierre:** registro restaurado y verificado, principal contenido, ventana sin evidencia documentada en el\nincidente (auditoría QAPAQ), y lección (SCP, alerta de salud del pipeline 101615)."
  },
  {
   "id": "credenciales",
   "title": "Ataques de credenciales",
   "path": "docs/detection-engineering/runbooks/credenciales.md",
   "sections": [
    "Triage en 10 minutos",
    "M365 / Entra: cadena de compromiso (101700–101703)",
    "BEC: reglas de bandeja y reenvío (100510–100514, 101702)",
    "Exfiltración (100515, 100529)",
    "Kerberos (101304–101307)",
    "Consola AWS tras fuerza bruta (101713)",
    "SSH tras fuerza bruta (101750)",
    "Consultas"
   ],
   "ruleIds": [
    "100502",
    "100503",
    "100504",
    "100505",
    "100506",
    "100510",
    "100511",
    "100512",
    "100513",
    "100514",
    "100515",
    "100529",
    "100530",
    "101304",
    "101305",
    "101306",
    "101307",
    "101700",
    "101701",
    "101702",
    "101703",
    "101713",
    "101750"
   ],
   "useCases": [
    "QAPAQ-DET-AD-002",
    "QAPAQ-DET-AWS-002",
    "QAPAQ-DET-LNX-001",
    "QAPAQ-DET-M365-002",
    "QAPAQ-DET-M365-005",
    "QAPAQ-DET-M365-001",
    "QAPAQ-DET-M365-004"
   ],
   "markdown": "# Runbook · Ataques de credenciales\n\nAlcance: `m365/credential-attacks` (100502–100506, 100530), `m365/compromise-chain` (101700–101703),\n`m365/bec-mailbox-persistence` (100510–100514), `m365/data-exfiltration`, `ad/kerberos-attacks` (101304–101307),\n`aws/console-bruteforce-success` (101713, base 101607/101608), `linux/ssh-bruteforce-success` (101750, base\n5710/5712/5763). Playbooks: `qapaq-triage-enriquecimiento` (automático) y `qapaq-contencion-identidad-aprobada` /\n`qapaq-contencion-endpoint-aprobada` (con aprobación).\n\n## Triage en 10 minutos\n\n1. ¿Hubo **éxito**? 100505, 101703, 101713, 101750 = sí → **P1**. Solo fallos (100503, 100504, 101608, 5712) → P2/P3.\n2. ¿La cuenta es privilegiada o break-glass? (razones `PRIVILEGED_IDENTITY` / `BREAK_GLASS_IDENTITY` en QAPAQ) → P1.\n3. ¿La IP de origen es de QAPAQ (oficina, VPN, CI)? Si sí y la persona confirma por un canal fuera de banda, es\n   benigno: documentar y cerrar.\n4. ¿Hay acciones posteriores de la misma cuenta (cadena)? Abrir la caza **H01** del dashboard «QAPAQ · Threat hunting».\n\n<a id=\"cadena-m365\"></a>\n## M365 / Entra: cadena de compromiso (101700–101703)\n\n- **Investigar:** en Discover, `data.office365.UserId:\"<cuenta>\"` 48 h: inicios (IP, país, cliente), cambios de\n  MFA (100526), reglas de bandeja (100510–100512), roles (100520/101704), consentimientos (100522).\n- **Contener (aprobación):** `m365.revoke-sessions` y, si hay persistencia, `m365.disable-user` desde QAPAQ. Mientras\n  el playbook no esté habilitado, lo ejecuta un administrador de Entra con el ticket del incidente.\n- **Recuperar:** restablecer contraseña, eliminar métodos MFA no reconocidos, borrar reglas de bandeja/reenvío,\n  revocar consentimientos y roles agregados, revisar correos enviados (fraude de pago).\n\n<a id=\"bec\"></a>\n## BEC: reglas de bandeja y reenvío (100510–100514, 101702)\n\n- Confirmar destino del reenvío (dominio externo = P1 si hay pagos involucrados).\n- Revisar mensajes movidos/borrados por la regla: suelen esconder respuestas de proveedores o bancos.\n- Avisar a Tesorería/Riesgos no financieros si el buzón gestiona pagos.\n\n<a id=\"exfiltracion\"></a>\n## Exfiltración (100515, 100529)\n\n- Enlace anónimo: ¿el archivo contiene datos personales o de clientes? Si sí, revocar el enlace y escalar a Legal.\n- eDiscovery: confirmar caso legal aprobado por Compliance; si no existe, P1.\n\n<a id=\"kerberos\"></a>\n## Kerberos (101304–101307)\n\n- Agrupar por cuenta de servicio y origen; RC4 aislado es higiene (P3), muchas cuentas desde un host = Kerberoasting (P1).\n- DCSync candidato: el principal debe ser un DC o una cuenta de sincronización documentada.\n\n<a id=\"aws\"></a>\n## Consola AWS tras fuerza bruta (101713)\n\n- Ver `data.aws.principal`, MFA y región; listar lo que hizo ese principal después (`data.aws.principal:\"<p>\"`).\n- Contener: deshabilitar el login profile / access keys del usuario IAM (consola AWS por un administrador con el\n  ticket; no hay acción automatizada para AWS) y rotar credenciales.\n\n<a id=\"ssh\"></a>\n## SSH tras fuerza bruta (101750)\n\n- `data.srcip` y `data.dstuser`: ¿cuenta con llave o contraseña? En los nodos QAPAQ la autenticación por contraseña\n  debería estar deshabilitada: si entró con contraseña, es hallazgo de hardening además del incidente.\n- Revisar lo que hizo la sesión: sudo (5402), cambios FIM (101755–101760), usuarios nuevos (5902).\n- Contener (aprobación): `endpoint.block-ip` (firewall-drop 600 s) y, si hubo acceso real, aislar el host.\n\n## Consultas\n\n```text\nrule.groups:qapaq_attack_chain\nrule.id:(100502 or 100503 or 100504 or 100505) and data.office365.UserId:\"<cuenta>\"\nrule.groups:sshd and data.srcip:\"<ip>\"\nrule.groups:aws and data.aws.source_ip:\"<ip>\"\n```\n\n**Cierre:** clasificación, métodos MFA y sesiones revocadas, IPs bloqueadas (con vencimiento), lección para el\nbacklog (p. ej. Conditional Access, deshabilitar contraseña en SSH)."
  },
  {
   "id": "escalada-de-privilegios",
   "title": "Escalada de privilegios (Entra, AWS, AD y Linux)",
   "path": "docs/detection-engineering/runbooks/escalada-de-privilegios.md",
   "sections": [
    "Triage en 10 minutos",
    "Entra",
    "AWS",
    "Active Directory",
    "Linux (grupos privilegiados y persistencia por FIM)",
    "Consultas"
   ],
   "ruleIds": [
    "100520",
    "100521",
    "100522",
    "100523",
    "100524",
    "100525",
    "100526",
    "101300",
    "101301",
    "101302",
    "101303",
    "101704",
    "101710",
    "101711",
    "101712",
    "101752",
    "101755",
    "101756",
    "101757",
    "101758",
    "101759",
    "101760"
   ],
   "useCases": [
    "QAPAQ-DET-AD-001",
    "QAPAQ-DET-AWS-001",
    "QAPAQ-DET-ENTRA-002",
    "QAPAQ-DET-ENTRA-003",
    "QAPAQ-DET-ENTRA-001",
    "QAPAQ-DET-LNX-003",
    "QAPAQ-DET-LNX-002"
   ],
   "markdown": "# Runbook · Escalada de privilegios (Entra, AWS, AD y Linux)\n\nAlcance: `entra/privileged-role-assignment` (100520, 100521, 101704), `entra/app-consent-and-credentials`\n(100522, 100523), `entra/auth-methods-and-federation` (100524–100526), reglas IAM/Identity Center/Organizations\ndel paquete AWS (101630–101636), `aws/cloudtrail-tampering` (101710), `ad/privileged-groups-and-policy`\n(101300–101303), `linux/privileged-group-membership` (101752) y `linux/persistence-fim` (101755–101760).\n\n## Triage en 10 minutos\n\n1. **¿Hay un cambio aprobado?** Buscar el ticket de cambio o la ventana de mantenimiento cargada en QAPAQ. Sin\n   cambio aprobado → mínimo P2; tier 0 (Global/Privileged Role Admin, `AdministratorAccess`, Domain Admins, root) → P1.\n2. **¿Quién lo hizo y quién lo recibió?** Actor (`UserId`, `aws.principal`, `srcuser`) y objetivo (`ObjectId`,\n   rol, `dstuser`). Un actor que se otorga a sí mismo = P1.\n3. **¿Vino después de un acceso anómalo?** Si hay 101700/101710 ya es cadena (P1).\n\n<a id=\"entra\"></a>\n## Entra\n\n- Ver la asignación en Entra (Roles y administradores → auditoría) y en PIM si es elegible o activa.\n- Consentimientos y credenciales de apps (100522/100523): ¿la app es interna? ¿quién la publicó? Revisar\n  permisos `Mail.Read`, `Files.Read.All`, `offline_access`.\n- Federación (100524): **P1 siempre**; validar con el equipo de identidad en el mismo turno.\n- **Contener:** retirar el rol/consentimiento/credencial (administrador de Entra con el ticket); si el actor está\n  comprometido, playbook de identidad (aprobación).\n\n## AWS\n\n- `data.aws.event_name` y `data.aws.request_parameters`: política adjunta, usuario/rol creado, permission set.\n- Revisar si el mismo principal tocó CloudTrail, GuardDuty o Config (101710/101712) → ver [CloudTrail y auditoría](cloudtrail-y-auditoria.md).\n- **Contener:** quitar la política/rol, desactivar access keys nuevas, SCP de bloqueo si es la organización.\n\n<a id=\"active-directory\"></a>\n## Active Directory\n\n- 4728/4732/4756 sobre grupos integrados: confirmar con el owner del grupo; AdminSDHolder/GPO (101303) con ticket.\n- Borrado de Security (101302): preservar el log del DC y escalar a P1.\n\n<a id=\"linux\"></a>\n## Linux (grupos privilegiados y persistencia por FIM)\n\n- 101752: ¿quién (`srcuser`) agregó a quién (`dstuser`) a `sudo`/`docker`/`lxd`? `docker` y `lxd` equivalen a root.\n- 101755 llaves SSH, 101758 sudoers, 101759 PAM: **P1 fuera de cambio**; comparar con el `diff` de FIM\n  (sin diff en `shadow` ni llaves por privacidad: pedir el archivo al owner del host).\n- 101756/101757 unidad systemd o cron: revisar `ExecStart`/comando; correlacionar con `dpkg` (2902/2904) para\n  descartar instalación de paquetes.\n- **Contener:** retirar la llave/entrada, revertir sudoers/PAM desde configuración versionada, bloquear la IP de\n  origen de la sesión (playbook de endpoint, aprobación) y rotar credenciales del host.\n\n## Consultas\n\n```text\nrule.groups:(qapaq_privilege_escalation or qapaq_aws_iam or azure_ad)\nrule.id:(100520 or 100521 or 101704 or 101700)\nrule.id:(101755 or 101756 or 101757 or 101758 or 101759 or 101760)\nrule.id:(2960 or 2961 or 101752)\n```"
  },
  {
   "id": "exfiltracion-sharepoint",
   "title": "Exfiltración desde SharePoint y OneDrive",
   "path": "docs/detection-engineering/runbooks/exfiltracion-sharepoint.md",
   "sections": [
    "Triage en 10 minutos",
    "Investigación",
    "Contención (con aprobación del Líder SOC)",
    "Recuperación y cierre",
    "Consultas"
   ],
   "ruleIds": [
    "101900",
    "101901",
    "101902",
    "101903",
    "101904",
    "101905",
    "101906",
    "101907",
    "101908",
    "101909",
    "101910",
    "101911",
    "101912",
    "101913",
    "101914",
    "101915",
    "101916",
    "101917",
    "101918",
    "101919",
    "101920",
    "101925",
    "101926",
    "101927",
    "101928",
    "101929",
    "101930",
    "101935",
    "101936",
    "101937",
    "101938",
    "101939",
    "101940",
    "101941",
    "101945",
    "101946",
    "101947",
    "101948",
    "101949",
    "101950",
    "101951",
    "101960",
    "101961",
    "101962",
    "101963",
    "101964",
    "101965",
    "101966",
    "101967",
    "101968",
    "101969",
    "101970",
    "101971",
    "101972"
   ],
   "useCases": [
    "QAPAQ-DET-SP-001",
    "QAPAQ-DET-SP-003",
    "QAPAQ-DET-SP-005",
    "QAPAQ-DET-SP-002",
    "QAPAQ-DET-SP-006",
    "QAPAQ-DET-SP-004"
   ],
   "markdown": "# Runbook · Exfiltración desde SharePoint y OneDrive\n\nAlcance: `sharepoint/exfiltration` (101900–101911), `sharepoint/mass-deletion` (101915–101920),\n`sharepoint/external-sharing` (101925–101930), `sharepoint/sharing-policy-and-admins` (101935–101941),\n`sharepoint/labels-and-dlp` (101945–101951), `sharepoint/posture` (101960–101972) y la regla heredada 100515\n(enlace anónimo). Fuente y permisos: [23 · SharePoint y OneDrive](../../23-sharepoint-onedrive.md).\nPlaybook: contención manual en el centro de administración de SharePoint/Entra por un operador con el ticket,\naprobada por el Líder SOC (QAPAQ no escribe en Microsoft 365).\n\n## Triage en 10 minutos\n\n1. **¿Quién y con qué identidad?** `data.office365.UserId`. Invitado (`#ext#`, 101905/101906), cuenta\n   deshabilitada (101907) o cuenta de servicio (lista `qapaq-m365-service-accounts`: si aparece ahí con nivel ≥ 8, la\n   lista no la cubre → revisar). Mirar en Entra los inicios de sesión de esa cuenta en las 24 h previas: un login\n   tras fuerza bruta (100505) o desde la IP de un spray (101703) convierte cualquier alerta de esta página en **P1**.\n2. **¿Desde dónde?** `data.office365.ClientIP`: en Spamhaus/Feodo (101908) o Tor (101909) → **P1** sin más\n   análisis. Red nueva para el usuario (101904, solo vía Purview) → confirmar con el usuario por un canal distinto\n   del correo.\n3. **¿Cuánto y cuándo?** 101902 (150 en 10 min) es P2; fuera de horario (101903, 40 en 30 min) es P1.\n   Distinguir **sincronización** (`FileSyncDownloadedFull`, cliente OneDrive, un dispositivo) de **descarga web**\n   (`FileDownloaded`, navegador, `UserAgent`): la primera suele ser un equipo nuevo; la segunda, extracción.\n4. **¿Sale de QAPAQ?** Enlace anónimo (100515/101926), correo personal (101927/101930), invitado (101928). Si el\n   mismo archivo perdió su etiqueta justo antes (101948) → **P1**, exfiltración preparada.\n5. **¿Destrucción?** 101917/101918/101920: borrado masivo o vaciado de la papelera de segunda etapa → P1 si hay\n   ransomware o salida del empleado; restaurar es urgente (la papelera de la colección conserva 93 días).\n6. **¿Cambió la superficie?** 101936/101937/101963 (Cualquier persona habilitado), 101938–101941 (administradores):\n   ¿hay ticket de TI? Sin ticket → tratar como compromiso de un administrador (runbook de\n   [escalada de privilegios](escalada-de-privilegios.md)).\n\n| Prioridad | Cuándo |\n| --- | --- |\n| P1 | IP maliciosa/Tor, fuera de horario, red nueva + volumen, etiqueta quitada y compartido, destrucción o papelera vaciada, tenant debilitado, administrador invitado |\n| P2 | Volumen en horario, invitado en volumen, cuenta deshabilitada, correo personal, enlaces anónimos en volumen, administrador agregado, DLP alta |\n| P3 | Enlace anónimo aislado, compartición con un socio, DLP media, sitio nuevo, permiso externo encontrado |\n| P4 | Marcas (nivel ≤ 3) y fotos de postura: solo búsqueda y contexto |\n\n## Investigación\n\n- **Alcance de lo descargado:** todos los `ObjectId`/`SourceFileName` del usuario en la ventana (consulta abajo);\n  sitios afectados (`SiteUrl`) y su clasificación; ¿hay archivos con etiqueta o DLP (101949–101951)?\n- **Dispositivo:** `UserAgent`, `Platform`, `DeviceDisplayName`, `IsManagedDevice` (si el registro los trae). Un\n  dispositivo no administrado + volumen sube la prioridad.\n- **Línea de tiempo:** inicio de sesión → acceso → descarga/compartición → borrado. Buscar reglas de bandeja o\n  reenvíos (100510–100512) del mismo usuario: el BEC suele exfiltrar por correo y SharePoint a la vez.\n- **Enlaces creados:** en el sitio, «Administrar acceso» del archivo; en postura, `sharepoint.finding.*`\n  (101966–101968) muestra enlaces anónimos y externos existentes aunque falte la auditoría.\n- **Empleado que se va:** cruzar con RR. HH.; la actividad de una cuenta ya deshabilitada (101907) puede ser\n  registrada antes del bloqueo (comparar `CreationTime` con la hora del bloqueo en Entra).\n\n## Contención (con aprobación del Líder SOC)\n\n- Revocar sesiones y restablecer credenciales en Entra; bloquear el inicio de sesión si hay compromiso.\n- Quitar los enlaces anónimos y los permisos externos del contenido afectado; si hace falta, bajar el uso\n  compartido del sitio a «Solo personas de la organización» mientras dura la investigación.\n- Quitar el administrador de colección agregado sin ticket y revisar los demás.\n- Destrucción: restaurar desde la papelera de la colección de sitios o con «Restaurar este OneDrive/biblioteca».\n- Revertir la configuración del tenant debilitada (`sharingCapability`) y registrar quién la cambió.\n\n## Recuperación y cierre\n\nVerificar que no quedan enlaces del atacante (siguiente pasada de postura, 101966–101968), que la etiqueta volvió\na los archivos afectados y que la cuenta de servicio legítima que causó un falso positivo quedó en la allowlist\npor PR (`detections/lists/qapaq-m365-service-accounts` o `qapaq-m365-sharing-approved`). Clasificar VP/FP/benigno,\ncausa raíz y lección para el backlog (umbral, lista o regla).\n\n## Consultas\n\n```text\nrule.groups:qapaq_sharepoint and rule.level >= 8\nrule.groups:qapaq_sharepoint and data.office365.UserId:\"<usuario>\"\nrule.id:(101900 or 101902 or 101903 or 101904) and data.office365.UserId:\"<usuario>\"\nrule.groups:qapaq_external_sharing or rule.id:(100515 or 101926)\nrule.id:(101945 or 101946 or 101948)\nrule.groups:qapaq_posture and data.sharepoint.finding.kind:anonymous_link\nrule.groups:qapaq_source_health and data.qapaq.capability.status:blocked\n```"
  },
  {
   "id": "malware-edr",
   "title": "Malware y EDR",
   "path": "docs/detection-engineering/runbooks/malware-edr.md",
   "sections": [
    "Triage en 10 minutos",
    "Protección deshabilitada + malware (101720–101723)",
    "Investigación",
    "Recuperación y cierre",
    "Consultas"
   ],
   "ruleIds": [
    "101100",
    "101401",
    "101402",
    "101403",
    "101404",
    "101405",
    "101406",
    "101407",
    "101408",
    "101409",
    "101410",
    "101411",
    "101720",
    "101721",
    "101722",
    "101723"
   ],
   "useCases": [
    "QAPAQ-DET-BD-001",
    "QAPAQ-DET-BD-002",
    "QAPAQ-DET-WIN-001"
   ],
   "markdown": "# Runbook · Malware y EDR\n\nAlcance: `bitdefender/malware-and-protection` (101401–101411), `bitdefender/protection-disabled-malware`\n(101720–101723), paquete de lanzamiento Sophos/Windows (101201, 101202, 101208–101211, 101219) y\n`windows/outlook-child-process` (101100). Playbook: `qapaq-contencion-endpoint-aprobada` (Linux) y aislamiento en la\nconsola del EDR (GravityZone) por un operador con el ticket.\n\n## Triage en 10 minutos\n\n1. **¿Activo o remediado?** `infected:true` (101402) = malware activo sin remediar → P1. Cuarentena (101410) = el\n   EDR actuó → P2, salvo repetición (101411, 3 en 1 h) → P1.\n2. **¿Con la protección apagada?** 101720–101723 → **P1**: el atacante o un técnico apagó la defensa con malware\n   presente. Llamar al usuario/owner del endpoint.\n3. **¿Endpoint crítico?** Razón `CRITICAL_ASSET` en QAPAQ (servidores de pagos, estaciones de Tesorería) → P1.\n\n<a id=\"proteccion-deshabilitada\"></a>\n## Protección deshabilitada + malware (101720–101723)\n\n- En GravityZone: política aplicada, módulos deshabilitados, quién cambió la política (auditoría de GravityZone).\n- ¿Hubo cambio aprobado (instalación de software)? Si no, tratar como evasión (T1562.001).\n- **Contener:** aislar el endpoint en GravityZone (aprobación del Líder SOC; el collector QAPAQ es solo lectura) y\n  volver a aplicar la política.\n\n## Investigación\n\n- Amenaza, ruta y hash (cuarentena); primer endpoint con esa amenaza (`bitdefender.quarantine.threat_name`).\n- Mismo usuario en M365/Entra: inicios y reenvíos en las 24 h previas (phishing como vector).\n- Si el endpoint tiene agente Wazuh: FIM y procesos (Sysmon cuando exista, BL-E01).\n\n## Recuperación y cierre\n\nEscaneo completo, reimagen si hubo persistencia, rotación de credenciales usadas en el equipo, verificación de que\nla política volvió (`policy_applied:true`) y lección (p. ej. bloquear la desinstalación del agente).\n\n## Consultas\n\n```text\nrule.groups:qapaq_malware\nrule.id:(101720 or 101721 or 101722 or 101723)\nrule.groups:bitdefender and data.bitdefender.endpoint.name:\"<host>\"\n```"
  },
  {
   "id": "oleada-waf",
   "title": "Oleada de ataques en el WAF (Cloudflare)",
   "path": "docs/detection-engineering/runbooks/oleada-waf.md",
   "sections": [
    "Triage en 10 minutos",
    "Contención (cambio aprobado)",
    "Investigación y cierre",
    "Consultas"
   ],
   "ruleIds": [
    "101501",
    "101502",
    "101503",
    "101504",
    "101505",
    "101506",
    "101507",
    "101508",
    "101509",
    "101510",
    "101511",
    "101512",
    "101513",
    "101740"
   ],
   "useCases": [
    "QAPAQ-DET-CF-001",
    "QAPAQ-DET-CF-002"
   ],
   "markdown": "# Runbook · Oleada de ataques en el WAF (Cloudflare)\n\nAlcance: `cloudflare/audit-and-waf` (101501–101513) y `cloudflare/waf-attack-surge` (101740).\n\n## Triage en 10 minutos\n\n1. **¿Una IP o muchas?** 101513 = una IP insistente (20 en 5 min); 101740 = oleada distribuida (50 IPs distintas en\n   10 min sobre un host) → P2.\n2. **¿Qué buscan?** Rutas (`data.cloudflare.firewall.path`) y regla del WAF (`rule_description`): SQLi, RCE,\n   `/login` (credenciales), rutas de un CVE reciente.\n3. **¿Pasa algo?** Eventos `log` (101511) con la misma firma = la regla está solo en modo registro: el ataque llega\n   a la aplicación → P1 si coincide con una vulnerabilidad expuesta (caza **H07**).\n4. **¿Alguien tocó los controles?** 101504/101505 (WAF/ruleset deshabilitado) en la misma ventana → P1.\n\n## Contención (cambio aprobado)\n\n- Rate limiting o regla de bloqueo por ASN/país/ruta; Under Attack mode si afecta disponibilidad.\n- Pasar a `block` la regla administrada que está en `log`.\n- Nunca bloquear rangos de proveedores de QAPAQ sin confirmar (pagos, monitoreo).\n\n## Investigación y cierre\n\nTop IPs, ASN y países (H08), user agents, horarios; correlacionar con errores 5xx de la aplicación y con logins\nexitosos en la misma ventana. Cerrar con la medida aplicada y su vencimiento.\n\n## Consultas\n\n```text\nrule.id:(101513 or 101740)\nrule.groups:qapaq_waf and data.cloudflare.firewall.host:\"<host>\"\nrule.id:101511\n```"
  },
  {
   "id": "reglas-estandar-wazuh",
   "title": "Reglas estándar de Wazuh con volumen en QAPAQ",
   "path": "docs/detection-engineering/runbooks/reglas-estandar-wazuh.md",
   "sections": [
    "Triage en 10 minutos",
    "Buzones de Exchange Online",
    "SharePoint y OneDrive",
    "Administración de Entra ID, Exchange y cumplimiento",
    "Integridad de archivos, paquetes y rootcheck",
    "SSH, SCA y agente",
    "Cierre y evidencia",
    "Consultas"
   ],
   "ruleIds": [
    "19003",
    "19007",
    "220",
    "2902",
    "2904",
    "510",
    "521",
    "550",
    "553",
    "554",
    "5710",
    "5762",
    "91533",
    "91548",
    "91578",
    "91702",
    "91703",
    "91707",
    "91708",
    "91712",
    "91713"
   ],
   "useCases": [
    "QAPAQ-STOCK-M365-001",
    "QAPAQ-STOCK-M365-002",
    "QAPAQ-STOCK-M365-003",
    "QAPAQ-STOCK-HOST-001",
    "QAPAQ-STOCK-HOST-002",
    "QAPAQ-STOCK-HOST-003",
    "QAPAQ-STOCK-HOST-004",
    "QAPAQ-STOCK-HOST-005",
    "QAPAQ-STOCK-WAZUH-001"
   ],
   "markdown": "# Runbook · Reglas estándar de Wazuh con volumen en QAPAQ\n\nAlcance: reglas estándar de Wazuh 4.14.8 con volumen en QAPAQ: Office 365 (91578, 91707, 91708, 91702, 91703, 91712, 91713, 91548, 91533), integridad de archivos (550, 553, 554), rootcheck (510, 521), paquetes (2902, 2904), SSH (5710, 5762), SCA (19003, 19007) y agente (220).\n\nMetadatos y guía por regla: [`detections/wazuh-stock/stock-rules.yaml`](../../../detections/wazuh-stock/stock-rules.yaml).\n\nCasi todo este volumen es **actividad normal registrada**, no ataque. El trabajo es separar lo\nhabitual de lo que no encaja, con la entidad (usuario, IP, host) como eje.\n\n## Triage en 10 minutos\n\n1. **¿Quién y dónde?** Usuario, IP y host de la alerta. ¿Es el dueño del recurso? ¿Es su IP o su país habitual?\n2. **¿Hay contexto que la explique?** Despliegue, actualización de paquetes, alta de personal o ventana de cambios en la misma hora.\n3. **¿Se acompaña de otra señal?** Alertas QAPAQ de la misma entidad (fuerza bruta, regla de bandeja, descarga masiva, cambio de rol) en ±24 h.\n4. **Volumen:** comparar con el historial de 30 días de la misma regla y entidad. Lo habitual y sin otra señal se cierra como benigno con la razón.\n\n## Buzones de Exchange Online\n\nCasos de uso `wazuh-stock/m365-mailbox-access` (91578 MailItemsAccessed, 91707 envío, 91708 envío con otros permisos).\n\n- MailItemsAccessed es auditoría de lectura del buzón: la sincronización de Outlook del propio dueño la genera sin parar. **Benigno** si el actor es el dueño (o un delegado conocido), desde su IP habitual y con un cliente conocido.\n- **Escalar** si accede alguien que no es el dueño ni delegado, una aplicación desconocida, desde IP o país inusual, con lectura masiva (Bind de muchos elementos) o `IsThrottled=true`; o si 91708 aparece sin delegación documentada o tras una regla de bandeja o reenvío (100510).\n- Siguiente paso de investigación: [credenciales](credenciales.md) (cadena M365 y BEC).\n\n## SharePoint y OneDrive\n\nCasos de uso `wazuh-stock/m365-sharepoint-files` (91702 descarga, 91703 nivel de permiso).\n\n- Descargas individuales son trabajo normal; el volumen lo vigilan las reglas QAPAQ de [exfiltración](exfiltracion-sharepoint.md).\n- **Escalar** si descarga un invitado o anónimo, desde IP inusual, o si se añade un nivel de permiso de control total por alguien que no administra el sitio.\n\n## Administración de Entra ID, Exchange y cumplimiento\n\nCasos de uso `wazuh-stock/m365-directory-admin` (91712, 91713, 91548, 91533).\n\n- **Escalar** si el grupo es privilegiado o da acceso a datos sensibles, si el actor no es administrador o actúa fuera de horario, o si el cmdlet cambia protección, retención o auditoría (Set-/Remove-/New-).\n- Ver [escalada de privilegios](escalada-de-privilegios.md).\n\n## Integridad de archivos, paquetes y rootcheck\n\nCasos de uso `wazuh-stock/host-integrity-fim` (550, 553, 554), `wazuh-stock/host-packages` (2902, 2904) y `wazuh-stock/host-rootcheck` (510, 521).\n\n- Un cambio FIM en binarios o en /etc a la misma hora que 2902/2904 es una **actualización**: benigno.\n- 521 sobre /var/lib/docker o /var/lib/containerd es el **falso positivo conocido** de las capas overlay (la política linux-servers lo ignora; si aparece, el agente no tiene la política al día).\n- **Escalar** cambios en SSH, sudoers, cuentas, cron, systemd o authorized_keys sin despliegue; binarios cambiados sin paquete; borrado de logs; herramientas ofensivas instaladas; 521 fuera de Docker o repetido.\n\n## SSH, SCA y agente\n\nCasos de uso `wazuh-stock/host-ssh` (5710, 5762), `wazuh-stock/host-hardening-sca` (19003, 19007) y `wazuh-stock/wazuh-agent-config` (220).\n\n- 5710 desde Internet es ruido de escáneres; **escalar** si después hay un login válido desde esa IP o si apuntan a usuarios reales.\n- SCA es postura, no incidente: P4 al backlog de hardening, salvo regresión súbita de controles críticos.\n- 220: la política de grupo publicada tiene algo que el agente no acepta; revisar `verify-agent-conf` y la visibilidad perdida del host.\n\n## Cierre y evidencia\n\n- Benigno: anotar la razón concreta (dueño del buzón desde IP habitual, actualización de paquetes a la misma hora…).\n- Si una misma causa benigna se repite, proponer afinamiento (lista CDB, exclusión de ruta o ajuste de nivel) en vez de cerrar a mano cada vez.\n- Verdadero positivo: abrir incidente y seguir el runbook específico enlazado arriba.\n\n## Consultas\n\n- MailItemsAccessed de un usuario: `rule.id:91578 and data.office365.UserId:\"usuario@qapaq.pe\"`\n- Accesos a buzón por alguien distinto del dueño: `rule.id:91578 and not data.office365.MailboxOwnerUPN:data.office365.UserId` (revisar en Discover, el campo cambia según la operación)\n- FIM con actualización en la misma hora: `rule.id:(550 or 553 or 554 or 2902 or 2904) and agent.name:\"host\"`"
  },
  {
   "id": "vulnerabilidad-expuesta",
   "title": "Vulnerabilidad expuesta",
   "path": "docs/detection-engineering/runbooks/vulnerabilidad-expuesta.md",
   "sections": [
    "Triage en 10 minutos",
    "Contención",
    "Remediación y SLA objetivo de parcheo [propuesto, N8]",
    "Consultas"
   ],
   "ruleIds": [
    "101451",
    "101452",
    "101453",
    "101454",
    "101455",
    "101456",
    "101457",
    "101458",
    "101730",
    "101731"
   ],
   "useCases": [
    "QAPAQ-DET-SNYK-002",
    "QAPAQ-DET-SNYK-001"
   ],
   "markdown": "# Runbook · Vulnerabilidad expuesta\n\nAlcance: `snyk/vulnerabilities` (101451–101458), `snyk/exposed-critical-exploit` (101730–101731) y Wazuh\nVulnerability Detection (`wazuh-states-vulnerabilities-*`, dashboard «QAPAQ · Gestión de vulnerabilidades»).\n\n## Triage en 10 minutos\n\n1. **¿Expuesta a Internet?** 101730/101731 (proyecto en `qapaq-internet-facing-projects`) → P1 crítica, P2 alta.\n   Si no está en la lista, confirmar con el equipo dueño si el servicio se publica por Cloudflare (y corregir la lista).\n2. **¿Explotable?** `exploit_maturity: Mature` o CVE en CISA KEV → sube un nivel de prioridad.\n3. **¿Alcanzable?** Snyk reachability / ruta de código; dependencia de desarrollo no desplegada → P3.\n4. **¿Hay ataque en curso?** Caza **H07**: WAF (101513/101740) sobre el host del proyecto en las últimas 24 h.\n\n## Contención\n\n- Regla temporal en el WAF de Cloudflare (virtual patching) sobre la ruta afectada, con cambio aprobado.\n- Si hay indicios de explotación: tratar como incidente de acceso inicial (T1190) y revisar logs de la app.\n\n## Remediación y SLA objetivo de parcheo [propuesto, N8]\n\n| Caso | Objetivo |\n| --- | --- |\n| Crítica expuesta con exploit maduro | 72 h (o mitigación WAF en 24 h) |\n| Crítica no expuesta / alta expuesta | 15 días |\n| Alta no expuesta | 30 días |\n| Media/baja | Ciclo normal de dependencias |\n\nInfraestructura (Wazuh VD): priorizar por `vulnerability.score.base`, número de agentes y paquetes del kernel o\nservicios expuestos (sshd, nginx, docker). Panel «paquetes a parchar primero».\n\n## Consultas\n\n```text\nrule.groups:qapaq_exposure\nrule.groups:snyk and data.snyk.issue.exploit_maturity:Mature\nvulnerability.severity:(Critical or High)          (índice wazuh-states-vulnerabilities-*)\n```"
  }
 ],
 "useCases": [
  {
   "id": "QAPAQ-STOCK-M365-001",
   "title": "Acceso a buzones de Exchange Online (MailItemsAccessed, envíos y envío con otros permisos)",
   "source": "wazuh-stock",
   "useCase": "m365-mailbox-access",
   "status": "stable",
   "ruleIds": [
    "91578",
    "91707",
    "91708"
   ],
   "mitre": [
    "T1114.002",
    "T1114.003"
   ],
   "priorityHint": "P4",
   "falsePositives": [
    "El propio dueño sincronizando su buzón (Outlook escritorio, móvil o web): MailItemsAccessed de tipo Sync o Bind continuo, mismo usuario que el buzón y su IP habitual. Es el 99 % del volumen.",
    "Buzones compartidos o delegados (asistentes, buzón de soporte): otro usuario con permiso FullAccess leyendo de forma habitual.",
    "Aplicaciones de respaldo, archivado o eDiscovery con permiso de aplicación: AppId conocido y acceso masivo programado.",
    "Envíos (91707) en el trabajo normal; envío con otros permisos (91708) de delegados configurados."
   ],
   "dataSources": [
    "Office 365 Management Activity API: Audit.Exchange (MailItemsAccessed, Send, SendAs, SendOnBehalf)"
   ],
   "escalateWhen": [
    "Quien accede NO es el dueño del buzón ni un delegado conocido, o es una aplicación (ClientAppId) desconocida.",
    "IP o país inusual para el usuario, o la misma IP aparece en alertas de autenticación fallida o de spray.",
    "Bind sobre muchos elementos en minutos (lectura masiva), o IsThrottled=true (más de 1000 eventos en 24 h: Microsoft deja de registrar el detalle).",
    "Envío con otros permisos (91708) sin delegación documentada, o justo después de una regla de bandeja o reenvío (100510)."
   ]
  },
  {
   "id": "QAPAQ-STOCK-M365-002",
   "title": "Archivos y permisos de SharePoint/OneDrive (descarga y nivel de permiso)",
   "source": "wazuh-stock",
   "useCase": "m365-sharepoint-files",
   "status": "stable",
   "ruleIds": [
    "91702",
    "91703"
   ],
   "mitre": [
    "T1530",
    "T1098"
   ],
   "priorityHint": "P4",
   "falsePositives": [
    "Descargas del trabajo diario y del cliente de sincronización de OneDrive.",
    "Niveles de permiso creados por el propietario del sitio o por TI al montar un sitio nuevo."
   ],
   "dataSources": [
    "Office 365 Management Activity API: Audit.SharePoint"
   ],
   "escalateWhen": [
    "Volumen anómalo de descargas de una persona (lo cubren las reglas QAPAQ 101902/101913 de exfiltración).",
    "Descarga por un usuario invitado o anónimo, o desde IP/país inusual.",
    "Nivel de permiso con control total añadido por alguien que no administra el sitio."
   ]
  },
  {
   "id": "QAPAQ-STOCK-M365-003",
   "title": "Cambios administrativos en Entra ID, Exchange y el centro de cumplimiento",
   "source": "wazuh-stock",
   "useCase": "m365-directory-admin",
   "status": "stable",
   "ruleIds": [
    "91712",
    "91713",
    "91548",
    "91533"
   ],
   "mitre": [
    "T1098",
    "T1098.007"
   ],
   "priorityHint": "P3",
   "falsePositives": [
    "Altas de grupos y miembros hechas por TI o por el flujo de alta de personal.",
    "Cmdlets de lectura (Get-*) del centro de cumplimiento y del registro de administración de Exchange."
   ],
   "dataSources": [
    "Office 365 Management Activity API: Audit.AzureActiveDirectory, Audit.Exchange (admin), SecurityComplianceCenterEOPCmdlet"
   ],
   "escalateWhen": [
    "El grupo es privilegiado (administradores, Accesos_SOC, grupos con roles de Entra asignables) o da acceso a datos sensibles.",
    "Quien hace el cambio no figura como administrador, o actúa fuera de horario o desde IP inusual.",
    "Cmdlets que cambian protección o retención (Set-/Remove-/New- de políticas de antispam, antimalware, retención o auditoría)."
   ]
  },
  {
   "id": "QAPAQ-STOCK-HOST-001",
   "title": "Integridad de archivos en servidores (FIM de Wazuh)",
   "source": "wazuh-stock",
   "useCase": "host-integrity-fim",
   "status": "stable",
   "ruleIds": [
    "550",
    "553",
    "554"
   ],
   "mitre": [
    "T1565.001",
    "T1070.004",
    "T1485"
   ],
   "priorityHint": "P4",
   "falsePositives": [
    "Actualizaciones de paquetes: cambios en /usr/bin, /usr/sbin, /etc o /boot en la misma ventana que 2902/2904 (dpkg) o unattended-upgrades.",
    "Despliegues de QAPAQ (releases en /opt/qapaq) y rotación de configuración por el propio orquestador.",
    "Archivos temporales o de estado que el ruido conocido aún no ignora."
   ],
   "dataSources": [
    "Wazuh syscheck (FIM programado cada 12 h y en tiempo real en rutas de persistencia)"
   ],
   "escalateWhen": [
    "Cambio en /etc/ssh, sudoers, /etc/passwd|shadow, cron, systemd o authorized_keys sin despliegue ni actualización en la ventana.",
    "Binario del sistema modificado sin paquete instalado o actualizado a la misma hora.",
    "Borrado (553) de logs, de reglas de auditoría o de archivos de seguridad."
   ]
  },
  {
   "id": "QAPAQ-STOCK-HOST-002",
   "title": "Instalación y configuración de paquetes Debian/Ubuntu",
   "source": "wazuh-stock",
   "useCase": "host-packages",
   "status": "stable",
   "ruleIds": [
    "2902",
    "2904"
   ],
   "mitre": [],
   "priorityHint": "P4",
   "falsePositives": [
    "unattended-upgrades y parches programados: muchos paquetes juntos, nombres del sistema base.",
    "«half configured» (2904) transitorio durante una actualización normal."
   ],
   "dataSources": [
    "syslog /var/log/dpkg.log (agente Wazuh)"
   ],
   "escalateWhen": [
    "Paquete de herramientas ofensivas o de red (nmap, netcat, socat, masscan, hydra, proxychains) o de acceso remoto.",
    "Instalación manual fuera de una ventana de cambios, por una sesión SSH interactiva no esperada.",
    "2904 repetido para el mismo paquete: actualización rota que deja el host sin parches."
   ]
  },
  {
   "id": "QAPAQ-STOCK-HOST-003",
   "title": "Rootcheck (anomalías del host y posible rootkit de kernel)",
   "source": "wazuh-stock",
   "useCase": "host-rootcheck",
   "status": "stable",
   "ruleIds": [
    "510",
    "521"
   ],
   "mitre": [
    "T1014"
   ],
   "priorityHint": "P3",
   "falsePositives": [
    "Capas overlay de Docker/containerd (/var/lib/docker, /var/lib/containerd): cambian mientras check_sys las recorre y disparan 521. La política linux-servers ya las ignora; si aparecen, el agente no tiene la política al día.",
    "Procesos o puertos efímeros de contenedores que existen en un chequeo y no en el siguiente."
   ],
   "dataSources": [
    "Wazuh rootcheck (cada 12 h)"
   ],
   "escalateWhen": [
    "521 en una ruta fuera de Docker/containerd, o repetido en el mismo archivo en pasadas distintas.",
    "Proceso oculto o puerto oculto confirmado con ps/ss en el host.",
    "Coincide con cambios FIM en binarios del sistema o módulos del kernel."
   ]
  },
  {
   "id": "QAPAQ-STOCK-HOST-004",
   "title": "SSH expuesto (usuarios inexistentes y conexiones reiniciadas)",
   "source": "wazuh-stock",
   "useCase": "host-ssh",
   "status": "stable",
   "ruleIds": [
    "5710",
    "5762"
   ],
   "mitre": [
    "T1110.001",
    "T1021.004"
   ],
   "priorityHint": "P4",
   "falsePositives": [
    "Escáneres de Internet contra un SSH expuesto: usuarios genéricos (admin, test, oracle) desde IPs de nube o de listas de reputación.",
    "Conexiones reiniciadas (5762) por clientes que cortan el handshake o por balanceadores."
   ],
   "dataSources": [
    "journald/sshd (agente Wazuh)"
   ],
   "escalateWhen": [
    "La misma IP o rango consigue un login válido después (reglas QAPAQ de fuerza bruta con éxito).",
    "Intentos contra usuarios reales del host o desde IPs internas.",
    "SSH no debería estar expuesto a Internet (allowed_admin_cidrs): revisar el security group."
   ]
  },
  {
   "id": "QAPAQ-STOCK-HOST-005",
   "title": "Configuración segura (SCA, benchmarks CIS)",
   "source": "wazuh-stock",
   "useCase": "host-hardening-sca",
   "status": "stable",
   "ruleIds": [
    "19003",
    "19007"
   ],
   "mitre": [],
   "priorityHint": "P4",
   "falsePositives": [
    "Controles CIS que QAPAQ acepta por diseño (por ejemplo particiones separadas en instancias de nube): no son incidentes."
   ],
   "dataSources": [
    "Wazuh SCA (cada 12 h)"
   ],
   "escalateWhen": [
    "Un control que antes pasaba ahora falla (regresión de hardening) en SSH, auditd, permisos de archivos sensibles o cuentas.",
    "Puntaje que cae de golpe tras un cambio: posible manipulación o despliegue defectuoso."
   ]
  },
  {
   "id": "QAPAQ-STOCK-WAZUH-001",
   "title": "Agente Wazuh no aplica la configuración remota",
   "source": "wazuh-stock",
   "useCase": "wazuh-agent-config",
   "status": "stable",
   "ruleIds": [
    "220"
   ],
   "mitre": [],
   "priorityHint": "P3",
   "falsePositives": [
    "Política de grupo recién publicada con un bloque que el agente no admite (por ejemplo comandos remotos sin logcollector.remote_commands=1): el agente sigue con la configuración anterior."
   ],
   "dataSources": [
    "Wazuh agentd (configuración centralizada agent.conf)"
   ],
   "escalateWhen": [
    "El agente queda sin FIM, rootcheck o logs tras el fallo: se pierde visibilidad del host.",
    "Nadie publicó un cambio de política: alguien modificó agent.conf en el manager fuera del repositorio."
   ]
  },
  {
   "id": "QAPAQ-DET-AD-002",
   "title": "Kerberoasting, AS-REP roasting, DCSync y spray Kerberos",
   "source": "ad",
   "useCase": "kerberos-attacks",
   "status": "experimental",
   "ruleIds": [
    "101304",
    "101305",
    "101306",
    "101307"
   ],
   "mitre": [
    "T1558.003",
    "T1558.004",
    "T1003.006",
    "T1110.003"
   ],
   "priorityHint": "P3 aislado; P1 si se correlaciona",
   "falsePositives": [
    "Aplicaciones heredadas que exigen RC4.",
    "Replicación legítima entre DC (DCSync candidato)."
   ],
   "dataSources": [
    "Windows Security de DC (4769, 4768, 4662, 4771)"
   ]
  },
  {
   "id": "QAPAQ-DET-AD-001",
   "title": "Grupos privilegiados, política de auditoría, GPO y borrado de Security",
   "source": "ad",
   "useCase": "privileged-groups-and-policy",
   "status": "experimental",
   "ruleIds": [
    "101300",
    "101301",
    "101302",
    "101303"
   ],
   "mitre": [
    "T1098.007",
    "T1562.002",
    "T1070.001",
    "T1484.001"
   ],
   "priorityHint": "P1 borrado de Security y grupos tier 0",
   "falsePositives": [
    "Cambios de GPO del equipo de plataforma con ticket."
   ],
   "dataSources": [
    "Windows Security de controladores de dominio (4728/4732/4756, 4719, 1102, 5136)"
   ]
  },
  {
   "id": "QAPAQ-DET-AWS-001",
   "title": "Manipulación de CloudTrail con contexto (IAM previo, root, cegamiento múltiple)",
   "source": "aws",
   "useCase": "cloudtrail-tampering",
   "status": "testing",
   "ruleIds": [
    "101710",
    "101711",
    "101712"
   ],
   "mitre": [
    "T1562.008",
    "T1098.003",
    "T1078.004",
    "T1562.001"
   ],
   "priorityHint": "P1",
   "falsePositives": [
    "Reconfiguración planificada del trail por Terraform (principal de CI con cambio aprobado).",
    "Desmontaje de un entorno de pruebas (cuenta sandbox)."
   ],
   "dataSources": [
    "CloudTrail management events vía EventBridge → SNS → receptor QAPAQ (wazuh/aws-events)"
   ]
  },
  {
   "id": "QAPAQ-DET-AWS-002",
   "title": "Acceso a la consola AWS tras fuerza bruta",
   "source": "aws",
   "useCase": "console-bruteforce-success",
   "status": "testing",
   "ruleIds": [
    "101713"
   ],
   "mitre": [
    "T1110.001",
    "T1078.004"
   ],
   "priorityHint": "P1",
   "falsePositives": [
    "Persona que se equivocó cinco veces y luego acertó (confirmar fuera de banda)."
   ],
   "dataSources": [
    "AWS Console Sign In vía EventBridge"
   ]
  },
  {
   "id": "QAPAQ-TUNE-AWS-001",
   "title": "Cambios del propio SOC en el pipeline de monitoreo AWS",
   "source": "aws",
   "useCase": "trusted-principals",
   "status": "testing",
   "ruleIds": [
    "101714",
    "101715",
    "101716"
   ],
   "mitre": [
    "T1562.008"
   ],
   "priorityHint": "P4 / P2",
   "falsePositives": [
    "Credenciales del SOC robadas: por eso lo destructivo no baja de 9 y 101710–101712 siguen evaluando la cadena."
   ],
   "dataSources": [
    "CloudTrail vía EventBridge → SNS → receptor QAPAQ (trail de la cuenta, 598294a)"
   ]
  },
  {
   "id": "QAPAQ-DET-BD-001",
   "title": "Malware, cuarentena y protección degradada en GravityZone",
   "source": "bitdefender",
   "useCase": "malware-and-protection",
   "status": "production",
   "ruleIds": [
    "101401",
    "101402",
    "101403",
    "101404",
    "101405",
    "101406",
    "101407",
    "101408",
    "101409",
    "101410",
    "101411"
   ],
   "mitre": [
    "T1204",
    "T1562.001"
   ],
   "priorityHint": "P1 infectado; P2 detección y protección deshabilitada",
   "falsePositives": [
    "Archivos EICAR de pruebas.",
    "Desinstalación planificada del agente (aparece como antimalware deshabilitado)."
   ],
   "dataSources": [
    "Bitdefender GravityZone API (collector qapaq-collector-bitdefender, cada 10 min)"
   ]
  },
  {
   "id": "QAPAQ-DET-BD-002",
   "title": "Malware con la protección deshabilitada (EDR + evasión)",
   "source": "bitdefender",
   "useCase": "protection-disabled-malware",
   "status": "testing",
   "ruleIds": [
    "101720",
    "101721",
    "101722",
    "101723"
   ],
   "mitre": [
    "T1204",
    "T1562.001"
   ],
   "priorityHint": "P1",
   "falsePositives": [
    "Técnico que apaga el antimalware para instalar software aprobado y coincide con una detección PUA."
   ],
   "dataSources": [
    "Bitdefender GravityZone API (estado del endpoint con cambio)"
   ]
  },
  {
   "id": "QAPAQ-DET-CF-001",
   "title": "Auditoría de cuenta y WAF de Cloudflare",
   "source": "cloudflare",
   "useCase": "audit-and-waf",
   "status": "production",
   "ruleIds": [
    "101501",
    "101502",
    "101503",
    "101504",
    "101505",
    "101506",
    "101507",
    "101510",
    "101511",
    "101512",
    "101513"
   ],
   "mitre": [
    "T1584.002",
    "T1562",
    "T1562.007",
    "T1098",
    "T1485",
    "T1190",
    "T1595"
   ],
   "priorityHint": "P2 controles; P1 zona borrada",
   "falsePositives": [
    "Cambios de DNS planificados por despliegues.",
    "Escáneres autorizados (pentest)."
   ],
   "dataSources": [
    "Cloudflare audit logs y firewall events por zona (collector qapaq-collector-cloudflare, cada 5 min)"
   ]
  },
  {
   "id": "QAPAQ-TUNE-CF-001",
   "title": "Escáneres autorizados, automatización DNS y corroboración por zona crítica",
   "source": "cloudflare",
   "useCase": "noise-tuning",
   "status": "testing",
   "ruleIds": [
    "101741",
    "101742",
    "101743",
    "101744"
   ],
   "mitre": [
    "T1190",
    "T1595"
   ],
   "priorityHint": "P1/P2 solo en zona crítica",
   "falsePositives": [
    "Zona crítica no listada: el ataque quedaría en 7 (cola, sin correo). Revisar la lista con cada alta de zona."
   ],
   "dataSources": [
    "Cloudflare firewall events y audit logs"
   ]
  },
  {
   "id": "QAPAQ-DET-CF-002",
   "title": "Oleada distribuida contra un host del WAF",
   "source": "cloudflare",
   "useCase": "waf-attack-surge",
   "status": "testing",
   "ruleIds": [
    "101740"
   ],
   "mitre": [
    "T1595.002",
    "T1190"
   ],
   "priorityHint": "P2",
   "falsePositives": [
    "Picos de tráfico legítimo que activan desafíos (campañas de marketing, bots verificados mal clasificados)."
   ],
   "dataSources": [
    "Cloudflare firewall events"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-005",
   "title": "Ataques web contra la consola del SOC (edge nginx)",
   "source": "edge",
   "useCase": "http-attacks",
   "status": "testing",
   "ruleIds": [
    "101830",
    "101831",
    "101832",
    "101833",
    "101834",
    "101835",
    "101836",
    "101837",
    "101838",
    "101839",
    "101840",
    "101841"
   ],
   "mitre": [
    "T1190",
    "T1595.002",
    "T1595.003",
    "T1595",
    "T1499"
   ],
   "priorityHint": "P3; P2 si hay campaña o correlación",
   "falsePositives": [
    "URLs del dashboard con rison/KQL que contienen comillas y operadores (se probó el caso de Discover).",
    "Herramientas de monitoreo sintético propias: usar un User-Agent sin nombres de escáner."
   ],
   "dataSources": [
    "bitácora JSON del edge nginx (qapaq-collectors/edge/access.json), IP real vía X-Forwarded-For del ALB"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-006",
   "title": "Inicios de sesión en la consola del SOC por IP",
   "source": "edge",
   "useCase": "soc-authentication",
   "status": "testing",
   "ruleIds": [
    "101842",
    "101843",
    "101844",
    "101845",
    "101846"
   ],
   "mitre": [
    "T1110",
    "T1110.001",
    "T1078",
    "T1110.003"
   ],
   "priorityHint": "P1 para 13; P2 para 9-10",
   "falsePositives": [
    "Usuario que olvidó la contraseña y reintenta (bajo el umbral de 6 en 5 min)."
   ],
   "dataSources": [
    "bitácora JSON del edge: POST /api/auth/password con resultado derivado de Location (authError=)"
   ]
  },
  {
   "id": "QAPAQ-DET-ENTRA-002",
   "title": "Consentimiento OAuth y credenciales nuevas en aplicaciones",
   "source": "entra",
   "useCase": "app-consent-and-credentials",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "100522",
    "100523"
   ],
   "mitre": [
    "T1528",
    "T1098.001"
   ],
   "priorityHint": "P2",
   "falsePositives": [
    "Rotación planificada de secretos de apps internas (ventana de mantenimiento)."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-ENTRA-003",
   "title": "Cambios de MFA, Conditional Access y federación",
   "source": "entra",
   "useCase": "auth-methods-and-federation",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "100524",
    "100525",
    "100526"
   ],
   "mitre": [
    "T1484.002",
    "T1556.009",
    "T1556.006"
   ],
   "priorityHint": "P1 federación; P2 resto",
   "falsePositives": [
    "Registro de MFA de altas nuevas (alto volumen en onboarding).",
    "Cambios de CA del equipo de identidad con cambio aprobado."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-ENTRA-001",
   "title": "Nuevo administrador en Entra (rol privilegiado y tier 0)",
   "source": "entra",
   "useCase": "privileged-role-assignment",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "101704"
   ],
   "mitre": [
    "T1098.003"
   ],
   "priorityHint": "P1 para tier 0",
   "falsePositives": [
    "Activaciones PIM planificadas de los administradores de plataforma (deben venir con ticket).",
    "Altas de onboarding del equipo de identidad: correlacionar con el cambio aprobado."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-LAUNCH-001",
   "title": "Paquete de lanzamiento: Sophos, Cato, Entra, AD, Windows y Linux normalizados",
   "source": "launch",
   "useCase": "normalized-provider-pack",
   "status": "experimental",
   "ruleIds": [
    "101201",
    "101202",
    "101203",
    "101204",
    "101205",
    "101206",
    "101207",
    "101208",
    "101209",
    "101210",
    "101211",
    "101212",
    "101213",
    "101214",
    "101215"
   ],
   "mitre": [
    "T1204",
    "T1059",
    "T1562",
    "T1071",
    "T1078.004",
    "T1098.003",
    "T1098.007",
    "T1070.001",
    "T1562.001",
    "T1059.001",
    "T1027",
    "T1053.005",
    "T1543.003",
    "T1547",
    "T1110.001",
    "T1548.003"
   ],
   "priorityHint": "P1 los marcados P0 en el catálogo de lanzamiento",
   "falsePositives": [
    "Ver el catálogo de lanzamiento por detección."
   ],
   "dataSources": [
    "Eventos JSON normalizados por QAPAQ (qapaq_vendor = sophos, cato, entra, active_directory, windows, linux)"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-004",
   "title": "Ejecución interactiva en contenedores críticos del SOC",
   "source": "linux",
   "useCase": "docker-runtime",
   "status": "testing",
   "ruleIds": [
    "101850",
    "101851",
    "101852"
   ],
   "mitre": [
    "T1609",
    "T1610"
   ],
   "priorityHint": "P3 (P2 fuera de una ventana de cambio)",
   "falsePositives": [
    "Scripts de despliegue y políticas QAPAQ (deploy-detections.sh, apply-*.sh) hacen docker exec en el manager: esperado durante un despliegue."
   ],
   "dataSources": [
    "wodle docker-listener del grupo linux-docker-hosts (agente 001)"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-002",
   "title": "Llamadas de red auditadas (connect/bind/accept) de sesiones interactivas",
   "source": "linux",
   "useCase": "network-auditd",
   "status": "testing",
   "ruleIds": [
    "101810",
    "101812",
    "101813",
    "101814",
    "101815",
    "101816",
    "101818",
    "101811",
    "101817"
   ],
   "mitre": [
    "T1059.004",
    "T1571",
    "T1046",
    "T1040",
    "T1071",
    "T1505.003"
   ],
   "priorityHint": "P2 para 10-12",
   "falsePositives": [
    "Administrador que usa nc/nmap/tcpdump para diagnosticar: confirmar con el ticket de cambio; no se suprime.",
    "IPv6 o claves no enriquecidas (auditd sin log_format ENRICHED): la regla cae a 101810 sin IP."
   ],
   "dataSources": [
    "auditd del host con qapaq-audit-network.rules (distribuido por el grupo linux-servers), log_format audit"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-001",
   "title": "Puertos en escucha y conexiones TCP nuevas del host",
   "source": "linux",
   "useCase": "network-connections",
   "status": "testing",
   "ruleIds": [
    "101800",
    "101801",
    "101802",
    "101803",
    "101804",
    "101805",
    "101806",
    "101807",
    "101808",
    "101809"
   ],
   "mitre": [
    "T1571",
    "T1059.004",
    "T1071",
    "T1133"
   ],
   "priorityHint": "P2 para 10-12; P4 para 3-5 (caza)",
   "falsePositives": [
    "Despliegue o actualización que publica un puerto nuevo: agregarlo por PR a infra/wazuh/network/lists/qapaq-expected-listeners.",
    "Un servicio SaaS nuevo (destino poco común): agregar el prefijo a infra/wazuh/network/lists/qapaq-egress-static.",
    "Conexiones cortas (< 2 min) no se ven en la foto de ss: las cubre auditd (network-auditd) para sesiones interactivas."
   ],
   "dataSources": [
    "command monitoring del grupo linux-servers: qapaq-netconn.sh (ss) cada 2 min (eventos) y 5 min (foto)",
    "agente 001 (qapaq-soc-dev-node)"
   ]
  },
  {
   "id": "QAPAQ-TUNE-LNX-001",
   "title": "Ruido de sesiones administrativas, SSH por contexto y rootcheck en overlay",
   "source": "linux",
   "useCase": "noise-tuning",
   "status": "testing",
   "ruleIds": [
    "101761",
    "101762",
    "101763",
    "101765",
    "101766",
    "101767"
   ],
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "priorityHint": "P3 en horario; P2 fuera de horario (P1 si además hay fuerza bruta: 101750)",
   "falsePositives": [
    "Operador que entra desde una IP nueva (red móvil, viaje): agregar el prefijo por PR a qapaq-admin-ips.",
    "La hora del manager es UTC: el horario QAPAQ se expresa como 01:00–13:00 UTC (20:00–08:00 Lima)."
   ],
   "dataSources": [
    "journald del agente 001 (pam_unix, sshd)",
    "rootcheck del agente"
   ]
  },
  {
   "id": "QAPAQ-DET-LNX-003",
   "title": "Persistencia y debilitamiento de autenticación por FIM en tiempo real",
   "source": "linux",
   "useCase": "persistence-fim",
   "status": "testing",
   "ruleIds": [
    "101755",
    "101756",
    "101757",
    "101758",
    "101759",
    "101760"
   ],
   "mitre": [
    "T1098.004",
    "T1543.002",
    "T1053.006",
    "T1053.003",
    "T1548.003",
    "T1556.003",
    "T1556",
    "T1021.004"
   ],
   "priorityHint": "P2 (P1 fuera de cambio aprobado)",
   "falsePositives": [
    "Despliegues y actualizaciones de paquetes (apt crea unidades y cron); correlacionar con dpkg (2902/2904).",
    "Rotación de llaves por el equipo de plataforma."
   ],
   "dataSources": [
    "FIM realtime del grupo linux-servers (/root/.ssh, /etc/ssh, /etc/sudoers.d, /etc/pam.d, /etc/cron.*, /etc/systemd/system)"
   ]
  },
  {
   "id": "QAPAQ-DET-LNX-002",
   "title": "Usuario agregado a grupo privilegiado en Linux",
   "source": "linux",
   "useCase": "privileged-group-membership",
   "status": "testing",
   "ruleIds": [
    "101752"
   ],
   "mitre": [
    "T1098.007",
    "T1548"
   ],
   "priorityHint": "P2",
   "falsePositives": [
    "Altas de administradores vía gestión de configuración (registrar el cambio)."
   ],
   "dataSources": [
    "journald (gpasswd) del agente"
   ]
  },
  {
   "id": "QAPAQ-DET-LNX-001",
   "title": "Acceso SSH exitoso tras fuerza bruta (30 min)",
   "source": "linux",
   "useCase": "ssh-bruteforce-success",
   "status": "testing",
   "ruleIds": [
    "101750"
   ],
   "mitre": [
    "T1110.001",
    "T1078.003",
    "T1021.004"
   ],
   "priorityHint": "P1",
   "falsePositives": [
    "Administrador que falla la llave y entra con la correcta desde su IP (los fallos de 5710/5712 son de usuarios inexistentes; si la IP es de QAPAQ, confirmar)."
   ],
   "dataSources": [
    "journald/sshd del agente (grupo linux-servers); datos reales en qapaq-soc-dev-node"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-003",
   "title": "Seguimiento de sesiones SSH por cuenta",
   "source": "linux",
   "useCase": "ssh-session-tracking",
   "status": "testing",
   "ruleIds": [
    "101820",
    "101821"
   ],
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "priorityHint": "P2",
   "falsePositives": [
    "Operador que cambia de red (VPN, móvil) varias veces en una hora."
   ],
   "dataSources": [
    "journald/sshd del agente (grupo linux-servers)"
   ]
  },
  {
   "id": "QAPAQ-DET-M365-003",
   "title": "Desactivación de la auditoría de M365",
   "source": "m365",
   "useCase": "audit-tampering",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "100527",
    "100528"
   ],
   "mitre": [
    "T1562.008"
   ],
   "priorityHint": "P1",
   "falsePositives": [
    "Cuentas de servicio de backup con AuditBypass aprobado (registrar en docs/10)."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-M365-002",
   "title": "Persistencia en buzón (BEC): reglas, reenvío y delegación",
   "source": "m365",
   "useCase": "bec-mailbox-persistence",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "100510",
    "100511",
    "100512",
    "100513",
    "100514"
   ],
   "mitre": [
    "T1564.008",
    "T1114.003",
    "T1098.002"
   ],
   "priorityHint": "P2 (P1 si correlaciona con un acceso anómalo)",
   "falsePositives": [
    "Reglas legítimas de organización de correo (mover a carpeta) creadas desde Outlook (100511).",
    "Reenvío aprobado a buzones compartidos internos: documentar excepción por destinatario."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-M365-005",
   "title": "Cadena de compromiso de cuenta M365 (acceso → privilegio/MFA/reenvío)",
   "source": "m365",
   "useCase": "compromise-chain",
   "status": "testing",
   "ruleIds": [
    "101700",
    "101701",
    "101702",
    "101703"
   ],
   "mitre": [
    "T1098.003",
    "T1078.004",
    "T1556.006",
    "T1098.005",
    "T1114.003",
    "T1564.008",
    "T1110.003"
   ],
   "priorityHint": "P1",
   "falsePositives": [
    "Usuario que olvidó su contraseña, la recuperó y configuró MFA nuevo en la misma sesión (101701): confirmar con la persona por un canal fuera de banda.",
    "Spray desde una salida NAT compartida y login legítimo de otra persona detrás de la misma IP (101703)."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-M365-001",
   "title": "Ataques de credenciales contra Microsoft 365",
   "source": "m365",
   "useCase": "credential-attacks",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "100502",
    "100503",
    "100504",
    "100505",
    "100506",
    "100530"
   ],
   "mitre": [
    "T1110.001",
    "T1110.003",
    "T1110",
    "T1078.004"
   ],
   "priorityHint": "P1 para 100505/100530; P2 para 100503/100504",
   "falsePositives": [
    "Usuarios con la contraseña caducada reintentando desde varios dispositivos (100503).",
    "Salidas NAT compartidas (oficina, VPN) que suman fallos de muchas personas (100504).",
    "Pruebas de break-glass planificadas: registrar el ensayo en el cambio antes de hacerlo."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-M365-004",
   "title": "Exfiltración por enlaces anónimos y eDiscovery",
   "source": "m365",
   "useCase": "data-exfiltration",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "100515",
    "100529"
   ],
   "mitre": [
    "T1567",
    "T1114"
   ],
   "priorityHint": "P3 / P2",
   "falsePositives": [
    "Áreas que comparten material público con enlaces anónimos (marketing).",
    "Casos legales en curso con exportación aprobada por Compliance."
   ],
   "dataSources": [
    "Office 365 Management Activity API (módulo office365 de Wazuh): Audit.AzureActiveDirectory, Audit.Exchange, Audit.SharePoint, Audit.General"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-008",
   "title": "Misma IP atacante en Cloudflare WAF, edge del SOC y SSH",
   "source": "network",
   "useCase": "cross-source-correlation",
   "status": "testing",
   "ruleIds": [
    "101870",
    "101871",
    "101872",
    "101873",
    "101874",
    "101875",
    "101876"
   ],
   "mitre": [
    "T1190",
    "T1595",
    "T1078",
    "T1110",
    "T1078.003"
   ],
   "priorityHint": "P1 para 13-14",
   "falsePositives": [
    "IP compartida (CGNAT, proxy corporativo) entre un atacante y un usuario."
   ],
   "dataSources": [
    "Cloudflare firewall events (vía lista diaria qapaq-cf-waf-attackers)",
    "edge nginx",
    "sshd"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-007",
   "title": "Conexiones e inicios de sesión con IPs de reputación pública",
   "source": "network",
   "useCase": "threat-intel",
   "status": "testing",
   "ruleIds": [
    "101860",
    "101861",
    "101865",
    "101868",
    "101862",
    "101863",
    "101864",
    "101867",
    "101866"
   ],
   "mitre": [
    "T1078",
    "T1090.003",
    "T1078.003",
    "T1021.004",
    "T1595",
    "T1071",
    "T1133"
   ],
   "priorityHint": "P1 para 12-13 con éxito; P3 el resto",
   "falsePositives": [
    "Usuario legítimo detrás de Tor o de una red reasignada recientemente: confirmar con la persona."
   ],
   "dataSources": [
    "listas CDB qapaq-ti-blocklist y qapaq-ti-tor (timer diario del host)",
    "SSH, edge, command monitoring y auditd"
   ]
  },
  {
   "id": "QAPAQ-DET-SP-001",
   "title": "Exfiltración desde SharePoint/OneDrive (volumen, horario, red nueva, invitados, cuentas deshabilitadas, IP maliciosa)",
   "source": "sharepoint",
   "useCase": "exfiltration",
   "status": "testing",
   "ruleIds": [
    "101900",
    "101901",
    "101902",
    "101903",
    "101904",
    "101905",
    "101906",
    "101907",
    "101908",
    "101909",
    "101910",
    "101911",
    "101912",
    "101913",
    "101914"
   ],
   "mitre": [
    "T1530",
    "T1213.002",
    "T1078.004",
    "T1090.003"
   ],
   "priorityHint": "P1 (12) / P2 (10–11) / P4 marcas",
   "falsePositives": [
    "Sincronización del cliente OneDrive (FileSyncDownloadedFull): en datos reales fue el 97 % de las descargas y un equipo resincronizó 6449 archivos en 25 h (41 alertas P2 con el umbral común). Ahora tiene marca y umbral propios (101912/101913, 500/10 min, P3).",
    "Migraciones o respaldos con cuenta de servicio: registrarla en qapaq-m365-service-accounts (baja a 2 y no cuenta).",
    "Viajes: red nueva legítima; confirmar con el usuario y con los inicios de sesión de Entra."
   ],
   "dataSources": [
    "Office 365 Management Activity API, Audit.SharePoint (módulo office365 de Wazuh; ActivityFeed.Read)",
    "Microsoft Graph Purview Audit Search /security/auditLog/queries (collector qapaq-sharepoint-audit; AuditLogsQuery-SharePoint.Read.All / AuditLogsQuery-OneDrive.Read.All)"
   ]
  },
  {
   "id": "QAPAQ-DET-SP-003",
   "title": "Uso compartido externo: enlaces anónimos en volumen y correos personales",
   "source": "sharepoint",
   "useCase": "external-sharing",
   "status": "testing",
   "ruleIds": [
    "101925",
    "101926",
    "101927",
    "101928",
    "101929",
    "101930"
   ],
   "mitre": [
    "T1567",
    "T1537"
   ],
   "priorityHint": "P1 (12) / P2 (9–11) / P3 (4)",
   "falsePositives": [
    "Marketing y comunicaciones publican con enlaces anónimos (qapaq-m365-sharing-approved).",
    "Proveedores con correo gratuito (documentar y aprobar por PR)."
   ],
   "dataSources": [
    "Office 365 Management Activity API, Audit.SharePoint (módulo office365 de Wazuh; ActivityFeed.Read)",
    "Microsoft Graph Purview Audit Search /security/auditLog/queries (collector qapaq-sharepoint-audit; AuditLogsQuery-SharePoint.Read.All / AuditLogsQuery-OneDrive.Read.All)"
   ]
  },
  {
   "id": "QAPAQ-DET-SP-005",
   "title": "Etiquetas de confidencialidad quitadas o rebajadas y coincidencias DLP",
   "source": "sharepoint",
   "useCase": "labels-and-dlp",
   "status": "testing",
   "ruleIds": [
    "101945",
    "101946",
    "101947",
    "101948",
    "101949",
    "101950",
    "101951"
   ],
   "mitre": [
    "T1562",
    "T1567",
    "T1213.002"
   ],
   "priorityHint": "P1 (12–13) / P2 (8–11) / P3 (7)",
   "falsePositives": [
    "Reclasificación aprobada con justificación (JustificationText).",
    "Políticas DLP en modo prueba (revisar la severidad en Purview)."
   ],
   "dataSources": [
    "Office 365 Management Activity API, Audit.SharePoint (módulo office365 de Wazuh; ActivityFeed.Read)",
    "Microsoft Graph Purview Audit Search /security/auditLog/queries (collector qapaq-sharepoint-audit; AuditLogsQuery-SharePoint.Read.All / AuditLogsQuery-OneDrive.Read.All)"
   ]
  },
  {
   "id": "QAPAQ-DET-SP-002",
   "title": "Borrado masivo y vaciado de la papelera en SharePoint/OneDrive",
   "source": "sharepoint",
   "useCase": "mass-deletion",
   "status": "testing",
   "ruleIds": [
    "101915",
    "101916",
    "101917",
    "101918",
    "101919",
    "101920"
   ],
   "mitre": [
    "T1485",
    "T1490"
   ],
   "priorityHint": "P1 (12–13) / P2 (10)",
   "falsePositives": [
    "Reorganización de bibliotecas por el dueño del sitio (con aviso previo).",
    "Retención o limpieza automatizada con cuenta de servicio (registrar en la allowlist)."
   ],
   "dataSources": [
    "Office 365 Management Activity API, Audit.SharePoint (módulo office365 de Wazuh; ActivityFeed.Read)",
    "Microsoft Graph Purview Audit Search /security/auditLog/queries (collector qapaq-sharepoint-audit; AuditLogsQuery-SharePoint.Read.All / AuditLogsQuery-OneDrive.Read.All)"
   ]
  },
  {
   "id": "QAPAQ-DET-SP-006",
   "title": "Postura de SharePoint y salud de la fuente",
   "source": "sharepoint",
   "useCase": "posture",
   "status": "pending-provider-evidence",
   "ruleIds": [
    "101960",
    "101961",
    "101962",
    "101963",
    "101964",
    "101965",
    "101966",
    "101967",
    "101968",
    "101969",
    "101970",
    "101971",
    "101972"
   ],
   "mitre": [
    "T1484",
    "T1567",
    "T1537"
   ],
   "priorityHint": "P1 (12) / P2 (8–10) / P3",
   "falsePositives": [
    "Sitios de proyectos con socios: permisos externos esperados (revisión trimestral de accesos)."
   ],
   "dataSources": [
    "Microsoft Graph /admin/sharepoint/settings (SharePointTenantSettings.Read.All)",
    "Microsoft Graph /sites/getAllSites, /drives, /permissions (Sites.Read.All)",
    "Collector qapaq-sharepoint-posture y qapaq-sharepoint-audit (eventos de capacidad)"
   ]
  },
  {
   "id": "QAPAQ-DET-SP-004",
   "title": "Política de uso compartido debilitada y administradores de colección de sitios",
   "source": "sharepoint",
   "useCase": "sharing-policy-and-admins",
   "status": "testing",
   "ruleIds": [
    "101935",
    "101936",
    "101937",
    "101938",
    "101939",
    "101940",
    "101941"
   ],
   "mitre": [
    "T1484",
    "T1098",
    "T1078.004",
    "T1530"
   ],
   "priorityHint": "P1 (12) / P2 (8–11)",
   "falsePositives": [
    "Cambio aprobado por TI (ticket).",
    "Acceso al OneDrive de un empleado que se va (proceso de RR. HH.: documentarlo en el caso)."
   ],
   "dataSources": [
    "Office 365 Management Activity API, Audit.SharePoint (módulo office365 de Wazuh; ActivityFeed.Read)",
    "Microsoft Graph Purview Audit Search /security/auditLog/queries (collector qapaq-sharepoint-audit; AuditLogsQuery-SharePoint.Read.All / AuditLogsQuery-OneDrive.Read.All)"
   ]
  },
  {
   "id": "QAPAQ-DET-SNYK-002",
   "title": "Crítica con exploit maduro en proyecto expuesto por Cloudflare",
   "source": "snyk",
   "useCase": "exposed-critical-exploit",
   "status": "testing",
   "ruleIds": [
    "101730",
    "101731"
   ],
   "mitre": [
    "T1190"
   ],
   "priorityHint": "P1 crítica; P2 alta",
   "falsePositives": [
    "Lista desactualizada: un proyecto que dejó de estar publicado sigue en la lista.",
    "Paquete vulnerable presente pero ruta de código no alcanzable (Snyk reachability)."
   ],
   "dataSources": [
    "Snyk issues",
    "Inventario QAPAQ: lista CDB qapaq-internet-facing-projects (proyecto Snyk → zona/host Cloudflare)"
   ]
  },
  {
   "id": "QAPAQ-TUNE-SNYK-001",
   "title": "Calibración de severidad de Snyk por exposición y explotabilidad",
   "source": "snyk",
   "useCase": "severity-calibration",
   "status": "testing",
   "ruleIds": [
    "101732",
    "101733",
    "101734"
   ],
   "mitre": [
    "T1190"
   ],
   "priorityHint": "P3/P4",
   "falsePositives": [
    "Proyecto expuesto que falta en la lista: quedaría degradado. La lista es parte del cambio de cada servicio publicado."
   ],
   "dataSources": [
    "Snyk issues",
    "Lista qapaq-internet-facing-projects"
   ]
  },
  {
   "id": "QAPAQ-DET-SNYK-001",
   "title": "Vulnerabilidades de código y dependencias (Snyk)",
   "source": "snyk",
   "useCase": "vulnerabilities",
   "status": "production",
   "ruleIds": [
    "101451",
    "101452",
    "101453",
    "101454",
    "101455",
    "101456",
    "101457",
    "101458"
   ],
   "mitre": [
    "T1190"
   ],
   "priorityHint": "P2 crítica; P3 alta",
   "falsePositives": [
    "Dependencias de desarrollo no desplegadas.",
    "Issues ya mitigados por WAF sin marcar en Snyk."
   ],
   "dataSources": [
    "Snyk REST API de issues (collector qapaq-collector-snyk, cada 15 min)"
   ]
  },
  {
   "id": "QAPAQ-DET-NET-009",
   "title": "Conexiones de red de endpoints Windows (Sysmon 3/22, WFP, firewall)",
   "source": "windows",
   "useCase": "network-connections",
   "status": "testing",
   "ruleIds": [
    "101880",
    "101881",
    "101882",
    "101883",
    "101884",
    "101885",
    "101886",
    "101887",
    "101888"
   ],
   "mitre": [
    "T1046",
    "T1071",
    "T1595",
    "T1105",
    "T1572"
   ],
   "priorityHint": "P2 para 10-12",
   "falsePositives": [
    "Instaladores legítimos que usan msiexec/bitsadmin contra CDNs públicas."
   ],
   "dataSources": [
    "grupo opt-in windows-telemetry-extended (gate de privacidad): Sysmon 3/22, Security 5156/5157 y pfirewall.log",
    "sin agentes Windows hoy: fixtures en el manager desechable"
   ]
  },
  {
   "id": "QAPAQ-DET-WIN-001",
   "title": "Outlook lanza un proceso sospechoso (Sysmon 1)",
   "source": "windows",
   "useCase": "outlook-child-process",
   "status": "experimental",
   "ruleIds": [
    "101100"
   ],
   "mitre": [
    "T1204.002"
   ],
   "priorityHint": "P2",
   "falsePositives": [
    "Complementos de Outlook que lanzan procesos auxiliares (inventariar y excluir por hash/firma)."
   ],
   "dataSources": [
    "Sysmon Event ID 1 (grupo windows-telemetry-extended, opt-in con gate de privacidad)"
   ]
  }
 ],
 "rules": {
  "100502": {
   "id": "100502",
   "level": 3,
   "description": "QAPAQ M365: inicio de sesión fallido de $(office365.UserId) desde $(office365.ClientIP).",
   "mitre": [],
   "groups": [
    "authentication_failed",
    "qapaq_credential_access"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100503": {
   "id": "100503",
   "level": 10,
   "description": "QAPAQ M365: fuerza bruta contra $(office365.UserId) (10 fallos en 5 min).",
   "mitre": [
    "T1110.001"
   ],
   "groups": [
    "authentication_failures",
    "qapaq_credential_access"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100504": {
   "id": "100504",
   "level": 12,
   "description": "QAPAQ M365: password spray desde $(office365.ClientIP) contra múltiples cuentas.",
   "mitre": [
    "T1110.003"
   ],
   "groups": [
    "authentication_failures",
    "qapaq_credential_access"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100505": {
   "id": "100505",
   "level": 13,
   "description": "QAPAQ M365: inicio de sesión exitoso de $(office365.UserId) tras fuerza bruta.",
   "mitre": [
    "T1110",
    "T1078.004"
   ],
   "groups": [
    "authentication_success",
    "qapaq_initial_access"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100506": {
   "id": "100506",
   "level": 3,
   "description": "QAPAQ M365: inicio de sesión exitoso de $(office365.UserId) desde $(office365.ClientIP).",
   "mitre": [],
   "groups": [
    "authentication_success",
    "qapaq_initial_access"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100510": {
   "id": "100510",
   "level": 12,
   "description": "QAPAQ M365: $(office365.UserId) creó o modificó una regla de bandeja que reenvía u oculta correo.",
   "mitre": [
    "T1564.008",
    "T1114.003"
   ],
   "groups": [
    "exchange",
    "qapaq_persistence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100511": {
   "id": "100511",
   "level": 8,
   "description": "QAPAQ M365: $(office365.UserId) actualizó reglas de bandeja desde un cliente.",
   "mitre": [
    "T1564.008"
   ],
   "groups": [
    "exchange",
    "qapaq_persistence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100512": {
   "id": "100512",
   "level": 12,
   "description": "QAPAQ M365: reenvío de buzón configurado por $(office365.UserId) sobre $(office365.ObjectId).",
   "mitre": [
    "T1114.003"
   ],
   "groups": [
    "exchange",
    "qapaq_persistence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100513": {
   "id": "100513",
   "level": 10,
   "description": "QAPAQ M365: $(office365.UserId) otorgó SendAs sobre $(office365.ObjectId).",
   "mitre": [
    "T1098.002"
   ],
   "groups": [
    "exchange",
    "qapaq_persistence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100514": {
   "id": "100514",
   "level": 11,
   "description": "QAPAQ M365: $(office365.UserId) creó o modificó una regla de transporte.",
   "mitre": [
    "T1114.003"
   ],
   "groups": [
    "exchange",
    "qapaq_exfiltration"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100515": {
   "id": "100515",
   "level": 7,
   "description": "QAPAQ M365: $(office365.UserId) creó un enlace anónimo a $(office365.ObjectId).",
   "mitre": [
    "T1567"
   ],
   "groups": [
    "sharepoint",
    "qapaq_exfiltration"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-004"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100520": {
   "id": "100520",
   "level": 13,
   "description": "QAPAQ Entra: $(office365.UserId) agregó un miembro a un rol privilegiado de Entra.",
   "mitre": [
    "T1098.003"
   ],
   "groups": [
    "azure_ad",
    "qapaq_privilege_escalation",
    "qapaq_pending_provider_evidence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100521": {
   "id": "100521",
   "level": 9,
   "description": "QAPAQ Entra: $(office365.UserId) agregó un miembro a un rol de Entra.",
   "mitre": [
    "T1098.003"
   ],
   "groups": [
    "azure_ad",
    "qapaq_privilege_escalation",
    "qapaq_pending_provider_evidence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100522": {
   "id": "100522",
   "level": 10,
   "description": "QAPAQ Entra: $(office365.UserId) concedió permisos a una aplicación ($(office365.Operation)).",
   "mitre": [
    "T1528"
   ],
   "groups": [
    "azure_ad",
    "qapaq_persistence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-ENTRA-002"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100523": {
   "id": "100523",
   "level": 10,
   "description": "QAPAQ Entra: credenciales agregadas a una aplicación por $(office365.UserId).",
   "mitre": [
    "T1098.001"
   ],
   "groups": [
    "azure_ad",
    "qapaq_persistence",
    "qapaq_pending_provider_evidence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-ENTRA-002"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100524": {
   "id": "100524",
   "level": 14,
   "description": "QAPAQ Entra: cambio de dominio o federación por $(office365.UserId).",
   "mitre": [
    "T1484.002"
   ],
   "groups": [
    "azure_ad",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-ENTRA-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100525": {
   "id": "100525",
   "level": 10,
   "description": "QAPAQ Entra: $(office365.UserId) modificó una política de Entra ($(office365.Operation)).",
   "mitre": [
    "T1556.009"
   ],
   "groups": [
    "azure_ad",
    "qapaq_defense_evasion",
    "qapaq_pending_provider_evidence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-ENTRA-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100526": {
   "id": "100526",
   "level": 8,
   "description": "QAPAQ Entra: cambio de métodos de autenticación de $(office365.UserId).",
   "mitre": [
    "T1556.006"
   ],
   "groups": [
    "azure_ad",
    "qapaq_persistence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-ENTRA-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "100527": {
   "id": "100527",
   "level": 14,
   "description": "QAPAQ M365: $(office365.UserId) desactivó la auditoría unificada.",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "exchange",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-003"
   ],
   "runbooks": [
    "cloudtrail-y-auditoria"
   ]
  },
  "100528": {
   "id": "100528",
   "level": 12,
   "description": "QAPAQ M365: auditoría de buzón desactivada o eximida por $(office365.UserId).",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "exchange",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-003"
   ],
   "runbooks": [
    "cloudtrail-y-auditoria"
   ]
  },
  "100529": {
   "id": "100529",
   "level": 12,
   "description": "QAPAQ M365: exportación de eDiscovery por $(office365.UserId).",
   "mitre": [
    "T1114"
   ],
   "groups": [
    "compliance",
    "qapaq_exfiltration",
    "qapaq_pending_provider_evidence"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-004"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "100530": {
   "id": "100530",
   "level": 14,
   "description": "QAPAQ M365: actividad de inicio de sesión de la cuenta de emergencia $(office365.UserId).",
   "mitre": [
    "T1078.004"
   ],
   "groups": [
    "authentication",
    "qapaq_initial_access"
   ],
   "file": "wazuh/office365/rules/qapaq_office365_rules.xml",
   "useCases": [
    "QAPAQ-DET-M365-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101100": {
   "id": "101100",
   "level": 8,
   "description": "QAPAQ Windows: Outlook inició un proceso que requiere revisión: $(win.eventdata.image). SigmaHQ 208748f7-881d-47ac-a29c-07ea84bf691d; autores Michael Haag, Florian Roth, Markus Neis, Elastic y FPT.EagleEye Team; DRL-1.1.",
   "mitre": [
    "T1204.002"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_phishing_triage"
   ],
   "file": "infra/wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
   "useCases": [
    "QAPAQ-DET-WIN-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101200": {
   "id": "101200",
   "level": 0,
   "description": "QAPAQ: evento de proveedor normalizado recibido.",
   "mitre": [],
   "groups": [
    "qapaq_provider_base"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml"
  },
  "101201": {
   "id": "101201",
   "level": 15,
   "description": "QAPAQ Sophos: detectó una amenaza alta/crítica activa en endpoint $(qapaq_endpoint_id).",
   "mitre": [
    "T1204",
    "T1059"
   ],
   "groups": [
    "qapaq_malware",
    "qapaq_sophos"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101202": {
   "id": "101202",
   "level": 14,
   "description": "QAPAQ Sophos: no pudo remediar la amenaza en $(qapaq_endpoint_id); requiere respuesta del SOC.",
   "mitre": [
    "T1562"
   ],
   "groups": [
    "qapaq_malware",
    "qapaq_sophos",
    "qapaq_remediation_failed"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101203": {
   "id": "101203",
   "level": 13,
   "description": "QAPAQ Cato: permitió tráfico con veredicto de amenaza alta/crítica desde $(qapaq_source_ip) hacia $(qapaq_destination).",
   "mitre": [
    "T1071"
   ],
   "groups": [
    "qapaq_network",
    "qapaq_cato",
    "qapaq_threat_allowed"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101204": {
   "id": "101204",
   "level": 5,
   "description": "QAPAQ Cato: bloqueó un evento de amenaza; correlacionar antes de elevar prioridad.",
   "mitre": [],
   "groups": [
    "qapaq_network",
    "qapaq_cato",
    "qapaq_blocked"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101205": {
   "id": "101205",
   "level": 13,
   "description": "QAPAQ Entra: informó un inicio de sesión de riesgo alto para $(qapaq_user_id) desde $(qapaq_source_ip).",
   "mitre": [
    "T1078.004"
   ],
   "groups": [
    "qapaq_identity",
    "qapaq_entra",
    "qapaq_risky_signin"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101206": {
   "id": "101206",
   "level": 13,
   "description": "QAPAQ Entra: asignación de rol privilegiado Entra sin cambio aprobado; actor $(qapaq_actor), destino $(qapaq_user_id).",
   "mitre": [
    "T1098.003"
   ],
   "groups": [
    "qapaq_identity",
    "qapaq_entra",
    "qapaq_privilege_escalation"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101207": {
   "id": "101207",
   "level": 13,
   "description": "QAPAQ AD: miembro agregado a grupo privilegiado de AD sin cambio aprobado; host $(qapaq_host), destino $(qapaq_user_id).",
   "mitre": [
    "T1098.007"
   ],
   "groups": [
    "qapaq_identity",
    "qapaq_active_directory",
    "qapaq_privilege_escalation"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101208": {
   "id": "101208",
   "level": 14,
   "description": "QAPAQ Windows: se limpió el registro Security de Windows en $(qapaq_host).",
   "mitre": [
    "T1070.001"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_windows"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101209": {
   "id": "101209",
   "level": 13,
   "description": "QAPAQ Windows: protección antimalware en tiempo real deshabilitada en $(qapaq_host).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_windows"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101210": {
   "id": "101210",
   "level": 10,
   "description": "QAPAQ Windows: PowerShell codificado iniciado por proceso no habitual en $(qapaq_host).",
   "mitre": [
    "T1059.001",
    "T1027"
   ],
   "groups": [
    "qapaq_execution",
    "qapaq_windows"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101211": {
   "id": "101211",
   "level": 10,
   "description": "QAPAQ Windows: nueva tarea o servicio sin cambio aprobado en $(qapaq_host).",
   "mitre": [
    "T1053.005",
    "T1543.003"
   ],
   "groups": [
    "qapaq_persistence",
    "qapaq_windows"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101212": {
   "id": "101212",
   "level": 9,
   "description": "QAPAQ FIM: cambio de archivo bajo ruta de persistencia monitoreada en $(qapaq_host).",
   "mitre": [
    "T1547"
   ],
   "groups": [
    "qapaq_persistence",
    "qapaq_fim"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101213": {
   "id": "101213",
   "level": 12,
   "description": "QAPAQ Linux: ráfaga de fallos SSH desde $(qapaq_source_ip) en cinco minutos.",
   "mitre": [
    "T1110.001"
   ],
   "groups": [
    "qapaq_linux",
    "qapaq_brute_force"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101214": {
   "id": "101214",
   "level": 9,
   "description": "QAPAQ Linux: uso privilegiado de sudo fuera de cambio aprobado en $(qapaq_host).",
   "mitre": [
    "T1548.003"
   ],
   "groups": [
    "qapaq_linux",
    "qapaq_privilege_escalation"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101215": {
   "id": "101215",
   "level": 3,
   "description": "QAPAQ Linux: fallo de autenticación SSH desde $(qapaq_source_ip) en $(qapaq_host).",
   "mitre": [],
   "groups": [
    "qapaq_linux",
    "qapaq_authentication_failed"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
   "useCases": [
    "QAPAQ-DET-LAUNCH-001"
   ]
  },
  "101216": {
   "id": "101216",
   "level": 14,
   "description": "QAPAQ: cambio destructivo en control de seguridad de Cloudflare; verificar actor, recurso y cambio aprobado.",
   "mitre": [
    "T1562.007"
   ],
   "groups": [
    "qapaq_cloudflare",
    "qapaq_defense_evasion"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101217": {
   "id": "101217",
   "level": 8,
   "description": "QAPAQ: cambio administrativo en Cloudflare por $(qapaq_actor) sobre $(qapaq_product): $(qapaq_action).",
   "mitre": [],
   "groups": [
    "qapaq_cloudflare",
    "qapaq_change_monitoring"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101218": {
   "id": "101218",
   "level": 11,
   "description": "QAPAQ: hallazgo alto/crítico activo en Snyk; valorar exposición, entorno productivo y explotabilidad antes de priorizar.",
   "mitre": [
    "T1195"
   ],
   "groups": [
    "qapaq_snyk",
    "qapaq_vulnerability"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101219": {
   "id": "101219",
   "level": 13,
   "description": "QAPAQ: incidente alto/crítico abierto de Bitdefender en endpoint $(qapaq_endpoint_id).",
   "mitre": [
    "T1204",
    "T1059"
   ],
   "groups": [
    "qapaq_bitdefender",
    "qapaq_malware"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101220": {
   "id": "101220",
   "level": 7,
   "description": "QAPAQ: el collector de $(qapaq_vendor) no tiene autorización API (HTTP $(qapaq_http_status)); la fuente está degradada.",
   "mitre": [],
   "groups": [
    "qapaq_source_health",
    "qapaq_authentication_failed"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101221": {
   "id": "101221",
   "level": 5,
   "description": "QAPAQ: error de consulta de $(qapaq_vendor); revisar la salud de la integración.",
   "mitre": [],
   "groups": [
    "qapaq_source_health"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101222": {
   "id": "101222",
   "level": 2,
   "description": "QAPAQ: se restableció la conexión de lectura a $(qapaq_vendor).",
   "mitre": [],
   "groups": [
    "qapaq_source_health",
    "qapaq_provider_recovered"
   ],
   "file": "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml"
  },
  "101300": {
   "id": "101300",
   "level": 12,
   "description": "QAPAQ AD: miembro añadido a un grupo integrado privilegiado de AD; revisar actor, miembro y cambio aprobado.",
   "mitre": [
    "T1098.007"
   ],
   "groups": [
    "qapaq_ad_privilege_change",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-001"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101301": {
   "id": "101301",
   "level": 12,
   "description": "QAPAQ AD: se modificó la política de auditoría; validar el cambio y que la cobertura de registros permanezca activa.",
   "mitre": [
    "T1562.002"
   ],
   "groups": [
    "qapaq_ad_defense_evasion",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-001"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101302": {
   "id": "101302",
   "level": 13,
   "description": "QAPAQ AD: se limpió el registro Security de Windows; preservar evidencia y verificar el actor.",
   "mitre": [
    "T1070.001"
   ],
   "groups": [
    "qapaq_ad_log_tampering",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-001"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101303": {
   "id": "101303",
   "level": 10,
   "description": "QAPAQ AD: cambio en AdminSDHolder o un objeto de Group Policy; validar autor y ticket de cambio.",
   "mitre": [
    "T1484.001"
   ],
   "groups": [
    "qapaq_ad_directory_change",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-001"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101304": {
   "id": "101304",
   "level": 5,
   "description": "QAPAQ AD: ticket Kerberos de servicio emitido con RC4; verificar cuenta de servicio, origen y necesidad de compatibilidad.",
   "mitre": [
    "T1558.003"
   ],
   "groups": [
    "qapaq_ad_kerberos_hunt",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101305": {
   "id": "101305",
   "level": 7,
   "description": "QAPAQ AD: TGT emitido sin preautenticación Kerberos; confirmar cuenta y excepción autorizada.",
   "mitre": [
    "T1558.004"
   ],
   "groups": [
    "qapaq_ad_kerberos_hunt",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101306": {
   "id": "101306",
   "level": 6,
   "description": "QAPAQ AD: candidato a DCSync por acceso de replicación de directorio; comprobar principal, host y permisos legítimos de replicación.",
   "mitre": [
    "T1003.006"
   ],
   "groups": [
    "qapaq_ad_replication_hunt",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101307": {
   "id": "101307",
   "level": 6,
   "description": "QAPAQ AD: fallo de preautenticación Kerberos; agrupar por cuenta, origen y ventana antes de clasificar password spraying.",
   "mitre": [
    "T1110.003"
   ],
   "groups": [
    "qapaq_ad_auth_hunt",
    "qapaq_ad_review"
   ],
   "file": "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
   "useCases": [
    "QAPAQ-DET-AD-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101400": {
   "id": "101400",
   "level": 0,
   "description": "QAPAQ Bitdefender: evento del collector GravityZone.",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml"
  },
  "101401": {
   "id": "101401",
   "level": 2,
   "description": "QAPAQ Bitdefender: estado del endpoint $(bitdefender.endpoint.name) sin hallazgos de protección.",
   "mitre": [],
   "groups": [
    "qapaq_endpoint_status"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101402": {
   "id": "101402",
   "level": 12,
   "description": "QAPAQ Bitdefender: endpoint $(bitdefender.endpoint.name) infectado (malware activo sin remediar).",
   "mitre": [
    "T1204"
   ],
   "groups": [
    "qapaq_malware"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101403": {
   "id": "101403",
   "level": 10,
   "description": "QAPAQ Bitdefender: detección de malware en $(bitdefender.endpoint.name).",
   "mitre": [
    "T1204"
   ],
   "groups": [
    "qapaq_malware"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101404": {
   "id": "101404",
   "level": 10,
   "description": "QAPAQ Bitdefender: endpoint $(bitdefender.endpoint.name) aislado de la red.",
   "mitre": [],
   "groups": [
    "qapaq_containment"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101405": {
   "id": "101405",
   "level": 10,
   "description": "QAPAQ Bitdefender: antimalware deshabilitado en $(bitdefender.endpoint.name).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101406": {
   "id": "101406",
   "level": 7,
   "description": "QAPAQ Bitdefender: Advanced Threat Control deshabilitado en $(bitdefender.endpoint.name).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101407": {
   "id": "101407",
   "level": 5,
   "description": "QAPAQ Bitdefender: firmas desactualizadas en $(bitdefender.endpoint.name).",
   "mitre": [],
   "groups": [
    "qapaq_hygiene"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101408": {
   "id": "101408",
   "level": 4,
   "description": "QAPAQ Bitdefender: agente desactualizado en $(bitdefender.endpoint.name).",
   "mitre": [],
   "groups": [
    "qapaq_hygiene"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101409": {
   "id": "101409",
   "level": 5,
   "description": "QAPAQ Bitdefender: la política $(bitdefender.endpoint.policy_name) no está aplicada en $(bitdefender.endpoint.name).",
   "mitre": [],
   "groups": [
    "qapaq_hygiene"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101410": {
   "id": "101410",
   "level": 10,
   "description": "QAPAQ Bitdefender: amenaza $(bitdefender.quarantine.threat_name) puesta en cuarentena en $(bitdefender.quarantine.endpoint_name).",
   "mitre": [
    "T1204"
   ],
   "groups": [
    "qapaq_malware"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101411": {
   "id": "101411",
   "level": 13,
   "description": "QAPAQ Bitdefender: 3+ amenazas en cuarentena en $(bitdefender.quarantine.endpoint_name) en 1 h; posible infección persistente.",
   "mitre": [
    "T1204"
   ],
   "groups": [
    "qapaq_malware"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
   "useCases": [
    "QAPAQ-DET-BD-001"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101450": {
   "id": "101450",
   "level": 0,
   "description": "QAPAQ Snyk: evento del collector de issues.",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml"
  },
  "101451": {
   "id": "101451",
   "level": 2,
   "description": "QAPAQ Snyk: issue resuelto $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101452": {
   "id": "101452",
   "level": 2,
   "description": "QAPAQ Snyk: issue ignorado $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101453": {
   "id": "101453",
   "level": 3,
   "description": "QAPAQ Snyk: vulnerabilidad baja $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101454": {
   "id": "101454",
   "level": 5,
   "description": "QAPAQ Snyk: vulnerabilidad media $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101455": {
   "id": "101455",
   "level": 10,
   "description": "QAPAQ Snyk: vulnerabilidad ALTA $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101456": {
   "id": "101456",
   "level": 12,
   "description": "QAPAQ Snyk: vulnerabilidad CRÍTICA $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101457": {
   "id": "101457",
   "level": 13,
   "description": "QAPAQ Snyk: vulnerabilidad CRÍTICA con exploit maduro $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101458": {
   "id": "101458",
   "level": 11,
   "description": "QAPAQ Snyk: vulnerabilidad ALTA con exploit maduro $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-001"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101500": {
   "id": "101500",
   "level": 0,
   "description": "QAPAQ Cloudflare: evento del collector.",
   "mitre": [],
   "groups": [],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml"
  },
  "101501": {
   "id": "101501",
   "level": 3,
   "description": "QAPAQ Cloudflare: $(cloudflare.audit.action) sobre $(cloudflare.audit.resource_type) por $(cloudflare.audit.actor_email).",
   "mitre": [],
   "groups": [
    "qapaq_audit"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101502": {
   "id": "101502",
   "level": 5,
   "description": "QAPAQ Cloudflare: acción fallida $(cloudflare.audit.action) sobre $(cloudflare.audit.resource_type) por $(cloudflare.audit.actor_email).",
   "mitre": [],
   "groups": [
    "qapaq_audit"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101503": {
   "id": "101503",
   "level": 5,
   "description": "QAPAQ Cloudflare: cambio DNS ($(cloudflare.audit.action)) en $(cloudflare.audit.zone_name) por $(cloudflare.audit.actor_email).",
   "mitre": [
    "T1584.002"
   ],
   "groups": [
    "qapaq_audit",
    "qapaq_dns_change"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101504": {
   "id": "101504",
   "level": 8,
   "description": "QAPAQ Cloudflare: cambio de control de seguridad ($(cloudflare.audit.action) $(cloudflare.audit.resource_type)) por $(cloudflare.audit.actor_email).",
   "mitre": [
    "T1562"
   ],
   "groups": [
    "qapaq_audit",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101505": {
   "id": "101505",
   "level": 10,
   "description": "QAPAQ Cloudflare: control de seguridad eliminado/deshabilitado ($(cloudflare.audit.resource_type)) por $(cloudflare.audit.actor_email).",
   "mitre": [
    "T1562.007"
   ],
   "groups": [
    "qapaq_audit",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101506": {
   "id": "101506",
   "level": 10,
   "description": "QAPAQ Cloudflare: cambio de identidad/credenciales ($(cloudflare.audit.action) $(cloudflare.audit.resource_type)) por $(cloudflare.audit.actor_email).",
   "mitre": [
    "T1098"
   ],
   "groups": [
    "qapaq_audit",
    "qapaq_persistence"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101507": {
   "id": "101507",
   "level": 12,
   "description": "QAPAQ Cloudflare: zona $(cloudflare.audit.zone_name) eliminada por $(cloudflare.audit.actor_email).",
   "mitre": [
    "T1485"
   ],
   "groups": [
    "qapaq_audit",
    "qapaq_impact"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101510": {
   "id": "101510",
   "level": 3,
   "description": "QAPAQ Cloudflare: $(cloudflare.firewall.action) de $(cloudflare.firewall.client_ip) en $(cloudflare.firewall.host) ($(cloudflare.firewall.source)).",
   "mitre": [],
   "groups": [
    "qapaq_waf"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101511": {
   "id": "101511",
   "level": 5,
   "description": "QAPAQ Cloudflare: regla $(cloudflare.firewall.rule_id) coincidió solo en modo log para $(cloudflare.firewall.client_ip) en $(cloudflare.firewall.host).",
   "mitre": [],
   "groups": [
    "qapaq_waf"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101512": {
   "id": "101512",
   "level": 2,
   "description": "QAPAQ Cloudflare: evento de seguridad $(cloudflare.firewall.action) en $(cloudflare.firewall.host).",
   "mitre": [],
   "groups": [
    "qapaq_waf"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101513": {
   "id": "101513",
   "level": 10,
   "description": "QAPAQ Cloudflare: 20+ bloqueos/desafíos para $(cloudflare.firewall.client_ip) en 5 min; ataque sostenido contra el perímetro.",
   "mitre": [
    "T1190",
    "T1595"
   ],
   "groups": [
    "qapaq_waf",
    "qapaq_attack"
   ],
   "file": "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
   "useCases": [
    "QAPAQ-DET-CF-001"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101600": {
   "id": "101600",
   "level": 0,
   "description": "QAPAQ AWS: evento de EventBridge.",
   "mitre": [],
   "groups": [],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101601": {
   "id": "101601",
   "level": 3,
   "description": "QAPAQ AWS: $(aws.event_name) en consola de $(aws.principal) desde $(aws.source_ip).",
   "mitre": [],
   "groups": [
    "qapaq_aws_signin",
    "authentication"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101602": {
   "id": "101602",
   "level": 3,
   "description": "QAPAQ AWS: $(aws.event_name) ($(aws.event_source)) por $(aws.principal) en $(aws.region).",
   "mitre": [],
   "groups": [
    "qapaq_aws_api",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101603": {
   "id": "101603",
   "level": 3,
   "description": "QAPAQ AWS: evento $(aws.detail_type) de $(aws.source).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101605": {
   "id": "101605",
   "level": 13,
   "description": "QAPAQ AWS: inicio de sesión de la cuenta ROOT ($(aws.event_name)) desde $(aws.source_ip).",
   "mitre": [
    "T1078.004"
   ],
   "groups": [
    "qapaq_aws_root",
    "authentication_success"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101606": {
   "id": "101606",
   "level": 12,
   "description": "QAPAQ AWS: la cuenta ROOT ejecutó $(aws.event_name) ($(aws.event_source)) desde $(aws.source_ip).",
   "mitre": [
    "T1078.004"
   ],
   "groups": [
    "qapaq_aws_root"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101607": {
   "id": "101607",
   "level": 5,
   "description": "QAPAQ AWS: inicio de sesión fallido en consola de $(aws.principal) desde $(aws.source_ip).",
   "mitre": [
    "T1110"
   ],
   "groups": [
    "authentication_failed"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101608": {
   "id": "101608",
   "level": 10,
   "description": "QAPAQ AWS: posible fuerza bruta en consola: 5+ inicios fallidos desde $(aws.source_ip) en 5 min.",
   "mitre": [
    "T1110.001"
   ],
   "groups": [
    "authentication_failures",
    "qapaq_aws_bruteforce"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101609": {
   "id": "101609",
   "level": 8,
   "description": "QAPAQ AWS: usuario IAM $(aws.principal) entró a la consola SIN MFA desde $(aws.source_ip).",
   "mitre": [
    "T1078.004"
   ],
   "groups": [
    "authentication_success",
    "qapaq_aws_no_mfa"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101610": {
   "id": "101610",
   "level": 3,
   "description": "QAPAQ AWS: inicio de sesión en consola de $(aws.principal) desde $(aws.source_ip).",
   "mitre": [],
   "groups": [
    "authentication_success"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101611": {
   "id": "101611",
   "level": 10,
   "description": "QAPAQ AWS: actividad en región no habitual $(aws.region): $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1535"
   ],
   "groups": [
    "qapaq_aws_unusual_region"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101612": {
   "id": "101612",
   "level": 12,
   "description": "QAPAQ AWS: creación de cómputo/red en región no habitual $(aws.region): $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1535",
    "T1496"
   ],
   "groups": [
    "qapaq_aws_unusual_region"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101613": {
   "id": "101613",
   "level": 4,
   "description": "QAPAQ AWS: servicio AWS ($(aws.principal)) activo en región no habitual $(aws.region): $(aws.event_name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101615": {
   "id": "101615",
   "level": 12,
   "description": "QAPAQ AWS: manipulación del pipeline de monitoreo QAPAQ: $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "qapaq_aws_tamper",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101616": {
   "id": "101616",
   "level": 6,
   "description": "QAPAQ AWS: cambio en el pipeline de monitoreo QAPAQ: $(aws.event_name) por $(aws.principal).",
   "mitre": [],
   "groups": [
    "qapaq_aws_pipeline",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101620": {
   "id": "101620",
   "level": 13,
   "description": "QAPAQ AWS: CloudTrail detenido/eliminado ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "qapaq_aws_defense_disabled",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml",
   "runbooks": [
    "cloudtrail-y-auditoria"
   ]
  },
  "101621": {
   "id": "101621",
   "level": 10,
   "description": "QAPAQ AWS: configuración de CloudTrail modificada ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "qapaq_aws_defense_change",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml",
   "runbooks": [
    "cloudtrail-y-auditoria"
   ]
  },
  "101622": {
   "id": "101622",
   "level": 12,
   "description": "QAPAQ AWS: GuardDuty deshabilitado o con supresión ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_aws_defense_disabled",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101623": {
   "id": "101623",
   "level": 12,
   "description": "QAPAQ AWS: Security Hub deshabilitado/reducido ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_aws_defense_disabled",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101624": {
   "id": "101624",
   "level": 12,
   "description": "QAPAQ AWS: AWS Config detenido/eliminado ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_aws_defense_disabled",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101625": {
   "id": "101625",
   "level": 10,
   "description": "QAPAQ AWS: IAM Access Analyzer eliminado o con archivado ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_aws_defense_change",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101630": {
   "id": "101630",
   "level": 8,
   "description": "QAPAQ AWS: cambio IAM $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1098"
   ],
   "groups": [
    "qapaq_aws_iam",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101631": {
   "id": "101631",
   "level": 10,
   "description": "QAPAQ AWS: cambio IAM de alto riesgo $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1098",
    "T1136.003"
   ],
   "groups": [
    "qapaq_aws_iam",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101632": {
   "id": "101632",
   "level": 12,
   "description": "QAPAQ AWS: privilegios administrativos concedidos ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1098.003"
   ],
   "groups": [
    "qapaq_aws_iam",
    "qapaq_privilege_escalation"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101633": {
   "id": "101633",
   "level": 8,
   "description": "QAPAQ AWS: cambio en IAM Identity Center $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1098"
   ],
   "groups": [
    "qapaq_aws_iam",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101634": {
   "id": "101634",
   "level": 10,
   "description": "QAPAQ AWS: Identity Center: permission set o asignación modificada ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1098.003"
   ],
   "groups": [
    "qapaq_aws_iam",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101635": {
   "id": "101635",
   "level": 10,
   "description": "QAPAQ AWS: cambio en AWS Organizations $(aws.event_name) por $(aws.principal).",
   "mitre": [
    "T1484"
   ],
   "groups": [
    "qapaq_aws_org",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101636": {
   "id": "101636",
   "level": 12,
   "description": "QAPAQ AWS: Organizations: salida de cuenta o SCP retirada ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1484",
    "T1562"
   ],
   "groups": [
    "qapaq_aws_org",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101640": {
   "id": "101640",
   "level": 8,
   "description": "QAPAQ AWS: security group modificado ($(aws.event_name)) por $(aws.principal) en $(aws.region).",
   "mitre": [
    "T1562.007"
   ],
   "groups": [
    "qapaq_aws_network",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101641": {
   "id": "101641",
   "level": 10,
   "description": "QAPAQ AWS: security group abierto a Internet (0.0.0.0/0 o ::/0) por $(aws.principal).",
   "mitre": [
    "T1562.007"
   ],
   "groups": [
    "qapaq_aws_network",
    "qapaq_exposure"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101642": {
   "id": "101642",
   "level": 8,
   "description": "QAPAQ AWS: NACL modificada ($(aws.event_name)) por $(aws.principal) en $(aws.region).",
   "mitre": [
    "T1562.007"
   ],
   "groups": [
    "qapaq_aws_network",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101643": {
   "id": "101643",
   "level": 8,
   "description": "QAPAQ AWS: rutas/gateways modificados ($(aws.event_name)) por $(aws.principal) en $(aws.region).",
   "mitre": [
    "T1599"
   ],
   "groups": [
    "qapaq_aws_network",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101644": {
   "id": "101644",
   "level": 10,
   "description": "QAPAQ AWS: VPC Flow Logs eliminados por $(aws.principal) en $(aws.region).",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "qapaq_aws_network",
    "qapaq_defense_evasion"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101645": {
   "id": "101645",
   "level": 10,
   "description": "QAPAQ AWS: snapshot/AMI compartido ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1537"
   ],
   "groups": [
    "qapaq_aws_exfiltration"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101646": {
   "id": "101646",
   "level": 3,
   "description": "QAPAQ AWS: EC2 $(aws.event_name) por $(aws.principal) en $(aws.region).",
   "mitre": [],
   "groups": [
    "qapaq_aws_ec2"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101650": {
   "id": "101650",
   "level": 8,
   "description": "QAPAQ AWS: control de acceso S3 modificado ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1530"
   ],
   "groups": [
    "qapaq_aws_s3",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101651": {
   "id": "101651",
   "level": 10,
   "description": "QAPAQ AWS: bloqueo de acceso público S3 eliminado ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1530"
   ],
   "groups": [
    "qapaq_aws_s3",
    "qapaq_exposure"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101652": {
   "id": "101652",
   "level": 10,
   "description": "QAPAQ AWS: posible exposición pública de S3 ($(aws.event_name)) por $(aws.principal).",
   "mitre": [
    "T1530"
   ],
   "groups": [
    "qapaq_aws_s3",
    "qapaq_exposure"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101655": {
   "id": "101655",
   "level": 8,
   "description": "QAPAQ AWS: política/rotación KMS modificada ($(aws.event_name)) por $(aws.principal).",
   "mitre": [],
   "groups": [
    "qapaq_aws_kms",
    "qapaq_audit"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101656": {
   "id": "101656",
   "level": 10,
   "description": "QAPAQ AWS: clave KMS deshabilitada por $(aws.principal).",
   "mitre": [
    "T1485"
   ],
   "groups": [
    "qapaq_aws_kms",
    "qapaq_impact"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101657": {
   "id": "101657",
   "level": 12,
   "description": "QAPAQ AWS: borrado de clave KMS programado por $(aws.principal).",
   "mitre": [
    "T1485"
   ],
   "groups": [
    "qapaq_aws_kms",
    "qapaq_impact"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101660": {
   "id": "101660",
   "level": 3,
   "description": "QAPAQ AWS GuardDuty: $(aws.finding.type) ($(aws.finding.severity_label)).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "guardduty"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101661": {
   "id": "101661",
   "level": 5,
   "description": "QAPAQ AWS GuardDuty (baja): $(aws.finding.type).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "guardduty"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101662": {
   "id": "101662",
   "level": 8,
   "description": "QAPAQ AWS GuardDuty (media): $(aws.finding.type).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "guardduty"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101663": {
   "id": "101663",
   "level": 12,
   "description": "QAPAQ AWS GuardDuty (alta): $(aws.finding.type).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "guardduty"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101664": {
   "id": "101664",
   "level": 13,
   "description": "QAPAQ AWS GuardDuty (crítica): $(aws.finding.type).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "guardduty"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101670": {
   "id": "101670",
   "level": 3,
   "description": "QAPAQ AWS Security Hub: $(aws.finding.title) ($(aws.finding.severity_label)).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "securityhub"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101671": {
   "id": "101671",
   "level": 8,
   "description": "QAPAQ AWS Security Hub (media): $(aws.finding.title).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "securityhub"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101672": {
   "id": "101672",
   "level": 12,
   "description": "QAPAQ AWS Security Hub (alta): $(aws.finding.title).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "securityhub"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101673": {
   "id": "101673",
   "level": 13,
   "description": "QAPAQ AWS Security Hub (crítica): $(aws.finding.title).",
   "mitre": [],
   "groups": [
    "qapaq_aws_finding",
    "securityhub"
   ],
   "file": "wazuh/aws-events/rules/qapaq_aws_rules.xml"
  },
  "101700": {
   "id": "101700",
   "level": 15,
   "description": "QAPAQ M365: $(office365.UserId) concedió un rol privilegiado de Entra después de entrar tras fuerza bruta (cadena de compromiso).",
   "mitre": [
    "T1098.003",
    "T1078.004"
   ],
   "groups": [
    "azure_ad",
    "qapaq_privilege_escalation",
    "qapaq_attack_chain"
   ],
   "file": "detections/m365/compromise-chain/rule.xml",
   "useCases": [
    "QAPAQ-DET-M365-005"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101701": {
   "id": "101701",
   "level": 14,
   "description": "QAPAQ M365: $(office365.UserId) cambió sus métodos de autenticación después de entrar tras fuerza bruta (persistencia en MFA).",
   "mitre": [
    "T1556.006",
    "T1098.005"
   ],
   "groups": [
    "azure_ad",
    "qapaq_persistence",
    "qapaq_attack_chain"
   ],
   "file": "detections/m365/compromise-chain/rule.xml",
   "useCases": [
    "QAPAQ-DET-M365-005"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101702": {
   "id": "101702",
   "level": 14,
   "description": "QAPAQ M365: $(office365.UserId) creó reenvío u ocultación de correo después de entrar tras fuerza bruta (patrón BEC).",
   "mitre": [
    "T1114.003",
    "T1564.008"
   ],
   "groups": [
    "exchange",
    "qapaq_persistence",
    "qapaq_attack_chain"
   ],
   "file": "detections/m365/compromise-chain/rule.xml",
   "useCases": [
    "QAPAQ-DET-M365-005"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101703": {
   "id": "101703",
   "level": 13,
   "description": "QAPAQ M365: inicio de sesión exitoso de $(office365.UserId) desde $(office365.ClientIP), origen de un password spray en la última hora.",
   "mitre": [
    "T1110.003",
    "T1078.004"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_attack_chain"
   ],
   "file": "detections/m365/compromise-chain/rule.xml",
   "useCases": [
    "QAPAQ-DET-M365-005"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101704": {
   "id": "101704",
   "level": 14,
   "description": "QAPAQ Entra: $(office365.UserId) asignó un rol tier 0 (Global, Privileged Role o Privileged Authentication Administrator) a $(office365.ObjectId).",
   "mitre": [
    "T1098.003"
   ],
   "groups": [
    "azure_ad",
    "qapaq_privilege_escalation",
    "qapaq_tier0",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/entra/privileged-role-assignment/rule.xml",
   "useCases": [
    "QAPAQ-DET-ENTRA-001"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101710": {
   "id": "101710",
   "level": 15,
   "description": "QAPAQ AWS: $(aws.principal) detuvo o borró CloudTrail ($(aws.event_name)) después de cambiar IAM en la última hora (escalada y borrado de rastro).",
   "mitre": [
    "T1562.008",
    "T1098.003"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_attack_chain"
   ],
   "file": "detections/aws/cloudtrail-tampering/rule.xml",
   "useCases": [
    "QAPAQ-DET-AWS-001"
   ],
   "runbooks": [
    "cloudtrail-y-auditoria",
    "escalada-de-privilegios"
   ]
  },
  "101711": {
   "id": "101711",
   "level": 15,
   "description": "QAPAQ AWS: la cuenta ROOT detuvo o borró CloudTrail ($(aws.event_name)) desde $(aws.source_ip).",
   "mitre": [
    "T1562.008",
    "T1078.004"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_attack_chain"
   ],
   "file": "detections/aws/cloudtrail-tampering/rule.xml",
   "useCases": [
    "QAPAQ-DET-AWS-001"
   ],
   "runbooks": [
    "cloudtrail-y-auditoria",
    "escalada-de-privilegios"
   ]
  },
  "101712": {
   "id": "101712",
   "level": 15,
   "description": "QAPAQ AWS: $(aws.principal) deshabilitó varios controles de detección en una hora (último: $(aws.event_name) en $(aws.event_source)).",
   "mitre": [
    "T1562.001",
    "T1562.008"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_attack_chain"
   ],
   "file": "detections/aws/cloudtrail-tampering/rule.xml",
   "useCases": [
    "QAPAQ-DET-AWS-001"
   ],
   "runbooks": [
    "cloudtrail-y-auditoria",
    "escalada-de-privilegios"
   ]
  },
  "101713": {
   "id": "101713",
   "level": 13,
   "description": "QAPAQ AWS: inicio de sesión exitoso en consola de $(aws.principal) desde $(aws.source_ip) tras fuerza bruta desde la misma IP (30 min).",
   "mitre": [
    "T1110.001",
    "T1078.004"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_attack_chain"
   ],
   "file": "detections/aws/console-bruteforce-success/rule.xml",
   "useCases": [
    "QAPAQ-DET-AWS-002"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101714": {
   "id": "101714",
   "level": 3,
   "description": "QAPAQ AWS: cambio en el pipeline de monitoreo QAPAQ por principal de confianza $(aws.principal) ($(aws.event_name)).",
   "mitre": [],
   "groups": [
    "qapaq_aws_api",
    "qapaq_audit",
    "qapaq_trusted_principal"
   ],
   "file": "detections/aws/trusted-principals/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-AWS-001"
   ]
  },
  "101715": {
   "id": "101715",
   "level": 9,
   "description": "QAPAQ AWS: principal de confianza $(aws.principal) modificó de forma destructiva el pipeline de monitoreo ($(aws.event_name)); confirmar el cambio.",
   "mitre": [
    "T1562.008"
   ],
   "groups": [
    "qapaq_audit",
    "qapaq_trusted_principal"
   ],
   "file": "detections/aws/trusted-principals/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-AWS-001"
   ]
  },
  "101716": {
   "id": "101716",
   "level": 5,
   "description": "QAPAQ AWS: security group modificado ($(aws.event_name)) por principal de confianza $(aws.principal) en $(aws.region).",
   "mitre": [],
   "groups": [
    "qapaq_aws_network",
    "qapaq_audit",
    "qapaq_trusted_principal"
   ],
   "file": "detections/aws/trusted-principals/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-AWS-001"
   ]
  },
  "101720": {
   "id": "101720",
   "level": 14,
   "description": "QAPAQ Bitdefender: malware en $(bitdefender.endpoint.name), que tuvo la protección deshabilitada en las últimas 24 h.",
   "mitre": [
    "T1204",
    "T1562.001"
   ],
   "groups": [
    "qapaq_malware",
    "qapaq_attack_chain"
   ],
   "file": "detections/bitdefender/protection-disabled-malware/rule.xml",
   "useCases": [
    "QAPAQ-DET-BD-002"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101721": {
   "id": "101721",
   "level": 14,
   "description": "QAPAQ Bitdefender: protección deshabilitada en $(bitdefender.endpoint.name) después de una detección de malware en 24 h (posible evasión).",
   "mitre": [
    "T1562.001"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_attack_chain"
   ],
   "file": "detections/bitdefender/protection-disabled-malware/rule.xml",
   "useCases": [
    "QAPAQ-DET-BD-002"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101722": {
   "id": "101722",
   "level": 15,
   "description": "QAPAQ Bitdefender: malware en $(bitdefender.endpoint.name) con el antimalware deshabilitado en el mismo estado.",
   "mitre": [
    "T1204",
    "T1562.001"
   ],
   "groups": [
    "qapaq_malware",
    "qapaq_defense_evasion",
    "qapaq_attack_chain"
   ],
   "file": "detections/bitdefender/protection-disabled-malware/rule.xml",
   "useCases": [
    "QAPAQ-DET-BD-002"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101723": {
   "id": "101723",
   "level": 14,
   "description": "QAPAQ Bitdefender: malware en $(bitdefender.endpoint.name) con Advanced Threat Control deshabilitado en el mismo estado.",
   "mitre": [
    "T1204",
    "T1562.001"
   ],
   "groups": [
    "qapaq_malware",
    "qapaq_defense_evasion",
    "qapaq_attack_chain"
   ],
   "file": "detections/bitdefender/protection-disabled-malware/rule.xml",
   "useCases": [
    "QAPAQ-DET-BD-002"
   ],
   "runbooks": [
    "malware-edr"
   ]
  },
  "101730": {
   "id": "101730",
   "level": 14,
   "description": "QAPAQ Snyk: vulnerabilidad CRÍTICA con exploit maduro en $(snyk.project.name), expuesto a Internet por Cloudflare: $(snyk.issue.title).",
   "mitre": [
    "T1190"
   ],
   "groups": [
    "qapaq_exposure"
   ],
   "file": "detections/snyk/exposed-critical-exploit/rule.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-002"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101731": {
   "id": "101731",
   "level": 12,
   "description": "QAPAQ Snyk: vulnerabilidad ALTA con exploit maduro en $(snyk.project.name), expuesto a Internet por Cloudflare: $(snyk.issue.title).",
   "mitre": [
    "T1190"
   ],
   "groups": [
    "qapaq_exposure"
   ],
   "file": "detections/snyk/exposed-critical-exploit/rule.xml",
   "useCases": [
    "QAPAQ-DET-SNYK-002"
   ],
   "runbooks": [
    "vulnerabilidad-expuesta"
   ]
  },
  "101732": {
   "id": "101732",
   "level": 2,
   "description": "QAPAQ Snyk: vulnerabilidad baja sin exploit maduro $(snyk.issue.title) en $(snyk.project.name) (backlog de AppSec).",
   "mitre": [],
   "groups": [],
   "file": "detections/snyk/severity-calibration/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-SNYK-001"
   ]
  },
  "101733": {
   "id": "101733",
   "level": 7,
   "description": "QAPAQ Snyk: vulnerabilidad ALTA sin exposición ni exploit maduro $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "detections/snyk/severity-calibration/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-SNYK-001"
   ]
  },
  "101734": {
   "id": "101734",
   "level": 10,
   "description": "QAPAQ Snyk: vulnerabilidad CRÍTICA sin exposición ni exploit maduro $(snyk.issue.title) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "detections/snyk/severity-calibration/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-SNYK-001"
   ]
  },
  "101740": {
   "id": "101740",
   "level": 12,
   "description": "QAPAQ Cloudflare: oleada distribuida contra $(cloudflare.firewall.host): 50+ bloqueos o desafíos desde IPs distintas en 10 min.",
   "mitre": [
    "T1595.002",
    "T1190"
   ],
   "groups": [
    "qapaq_attack"
   ],
   "file": "detections/cloudflare/waf-attack-surge/rule.xml",
   "useCases": [
    "QAPAQ-DET-CF-002"
   ],
   "runbooks": [
    "oleada-waf"
   ]
  },
  "101741": {
   "id": "101741",
   "level": 11,
   "description": "QAPAQ Cloudflare: ataque sostenido de $(cloudflare.firewall.client_ip) contra la zona crítica $(cloudflare.zone_name).",
   "mitre": [
    "T1190",
    "T1595"
   ],
   "groups": [
    "qapaq_waf",
    "qapaq_attack"
   ],
   "file": "detections/cloudflare/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-CF-001"
   ]
  },
  "101742": {
   "id": "101742",
   "level": 7,
   "description": "QAPAQ Cloudflare: 20+ bloqueos de $(cloudflare.firewall.client_ip) en la zona no crítica $(cloudflare.zone_name); el WAF contuvo el ataque.",
   "mitre": [
    "T1595"
   ],
   "groups": [
    "qapaq_waf"
   ],
   "file": "detections/cloudflare/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-CF-001"
   ]
  },
  "101743": {
   "id": "101743",
   "level": 2,
   "description": "QAPAQ Cloudflare: bloqueo a escáner autorizado $(cloudflare.firewall.client_ip) en $(cloudflare.firewall.host).",
   "mitre": [],
   "groups": [
    "qapaq_waf"
   ],
   "file": "detections/cloudflare/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-CF-001"
   ]
  },
  "101744": {
   "id": "101744",
   "level": 3,
   "description": "QAPAQ Cloudflare: cambio DNS ($(cloudflare.audit.action)) en $(cloudflare.audit.zone_name) por la automatización aprobada $(cloudflare.audit.actor_email).",
   "mitre": [],
   "groups": [
    "qapaq_audit",
    "qapaq_dns_change",
    "qapaq_trusted_principal"
   ],
   "file": "detections/cloudflare/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-CF-001"
   ]
  },
  "101750": {
   "id": "101750",
   "level": 13,
   "description": "QAPAQ Linux: acceso SSH exitoso de $(dstuser) desde $(srcip) tras fuerza bruta desde la misma IP en 30 min.",
   "mitre": [
    "T1110.001",
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_attack_chain"
   ],
   "file": "detections/linux/ssh-bruteforce-success/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-001"
   ],
   "runbooks": [
    "credenciales"
   ]
  },
  "101752": {
   "id": "101752",
   "level": 10,
   "description": "QAPAQ Linux: $(srcuser) agregó a $(dstuser) al grupo privilegiado $(group).",
   "mitre": [
    "T1098.007",
    "T1548"
   ],
   "groups": [
    "qapaq_privilege_escalation"
   ],
   "file": "detections/linux/privileged-group-membership/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-002"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101755": {
   "id": "101755",
   "level": 12,
   "description": "QAPAQ Linux: llaves SSH autorizadas creadas o modificadas en $(file).",
   "mitre": [
    "T1098.004"
   ],
   "groups": [
    "qapaq_persistence"
   ],
   "file": "detections/linux/persistence-fim/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101756": {
   "id": "101756",
   "level": 10,
   "description": "QAPAQ Linux: unidad systemd creada o modificada en $(file).",
   "mitre": [
    "T1543.002",
    "T1053.006"
   ],
   "groups": [
    "qapaq_persistence"
   ],
   "file": "detections/linux/persistence-fim/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101757": {
   "id": "101757",
   "level": 10,
   "description": "QAPAQ Linux: tarea cron creada o modificada en $(file).",
   "mitre": [
    "T1053.003"
   ],
   "groups": [
    "qapaq_persistence"
   ],
   "file": "detections/linux/persistence-fim/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101758": {
   "id": "101758",
   "level": 12,
   "description": "QAPAQ Linux: configuración de sudo creada o modificada en $(file).",
   "mitre": [
    "T1548.003"
   ],
   "groups": [
    "qapaq_privilege_escalation"
   ],
   "file": "detections/linux/persistence-fim/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101759": {
   "id": "101759",
   "level": 12,
   "description": "QAPAQ Linux: pila PAM creada o modificada en $(file).",
   "mitre": [
    "T1556.003"
   ],
   "groups": [
    "qapaq_persistence",
    "qapaq_credential_access"
   ],
   "file": "detections/linux/persistence-fim/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101760": {
   "id": "101760",
   "level": 10,
   "description": "QAPAQ Linux: configuración del servidor SSH modificada en $(file).",
   "mitre": [
    "T1556",
    "T1021.004"
   ],
   "groups": [
    "qapaq_defense_evasion"
   ],
   "file": "detections/linux/persistence-fim/rule.xml",
   "useCases": [
    "QAPAQ-DET-LNX-003"
   ],
   "runbooks": [
    "escalada-de-privilegios"
   ]
  },
  "101761": {
   "id": "101761",
   "level": 8,
   "description": "QAPAQ Linux: acceso SSH exitoso de $(dstuser) desde $(srcip), IP no registrada como administrativa.",
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_initial_access"
   ],
   "file": "detections/linux/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-LNX-001"
   ]
  },
  "101762": {
   "id": "101762",
   "level": 11,
   "description": "QAPAQ Linux: acceso SSH de $(dstuser) desde IP no registrada $(srcip) fuera del horario del SOC.",
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_off_hours"
   ],
   "file": "detections/linux/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-LNX-001"
   ]
  },
  "101763": {
   "id": "101763",
   "level": 11,
   "description": "QAPAQ Linux: acceso SSH de $(dstuser) desde IP no registrada $(srcip) en fin de semana.",
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_off_hours"
   ],
   "file": "detections/linux/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-LNX-001"
   ]
  },
  "101765": {
   "id": "101765",
   "level": 0,
   "description": "QAPAQ Linux: anomalía de rootcheck en capa overlay de contenedores (falso positivo conocido de 521).",
   "mitre": [],
   "groups": [
    "rootcheck"
   ],
   "file": "detections/linux/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-LNX-001"
   ]
  },
  "101766": {
   "id": "101766",
   "level": 0,
   "description": "QAPAQ Linux: sesión PAM de cuenta administrativa ($(srcuser) a $(dstuser)); ya auditada por sudo/SSH.",
   "mitre": [],
   "groups": [],
   "file": "detections/linux/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-LNX-001"
   ]
  },
  "101767": {
   "id": "101767",
   "level": 0,
   "description": "QAPAQ Linux: cierre de sesión PAM de cuenta administrativa $(dstuser).",
   "mitre": [],
   "groups": [],
   "file": "detections/linux/noise-tuning/rule.xml",
   "useCases": [
    "QAPAQ-TUNE-LNX-001"
   ]
  },
  "101800": {
   "id": "101800",
   "level": 7,
   "description": "QAPAQ Linux: cambiaron los puertos en escucha del host (se abrió o se cerró uno).",
   "mitre": [
    "T1571"
   ],
   "groups": [
    "qapaq_listening_ports"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101801": {
   "id": "101801",
   "level": 0,
   "description": "QAPAQ Linux: evento de red del host ($(qapaq.net.type) $(qapaq.net.direction)).",
   "mitre": [],
   "groups": [
    "qapaq_netconn"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101802": {
   "id": "101802",
   "level": 0,
   "description": "QAPAQ Linux: nueva escucha solo en loopback ($(dstip):$(dstport), $(qapaq.net.process)).",
   "mitre": [],
   "groups": [
    "qapaq_netconn"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101803": {
   "id": "101803",
   "level": 12,
   "description": "QAPAQ Linux: shell, netcat o intérprete $(qapaq.net.process) escucha en $(dstip):$(dstport)/$(protocol) (posible bind shell o túnel).",
   "mitre": [
    "T1059.004",
    "T1571"
   ],
   "groups": [
    "qapaq_netconn",
    "qapaq_attack"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101804": {
   "id": "101804",
   "level": 0,
   "description": "QAPAQ Linux: escucha esperada $(dstip):$(dstport)/$(protocol) ($(qapaq.net.process)).",
   "mitre": [],
   "groups": [
    "qapaq_netconn"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101805": {
   "id": "101805",
   "level": 8,
   "description": "QAPAQ Linux: nuevo puerto en escucha no esperado $(dstip):$(dstport)/$(protocol) de $(qapaq.net.process) (uid $(qapaq.net.uid)).",
   "mitre": [
    "T1571"
   ],
   "groups": [
    "qapaq_netconn"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101806": {
   "id": "101806",
   "level": 0,
   "description": "QAPAQ Linux: conexión TCP interna $(qapaq.net.direction) $(srcip) → $(dstip):$(dstport) ($(qapaq.net.process)).",
   "mitre": [],
   "groups": [
    "qapaq_netconn"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101807": {
   "id": "101807",
   "level": 10,
   "description": "QAPAQ Linux: $(qapaq.net.process) abrió conexión saliente a $(dstip):$(dstport) (uid $(qapaq.net.uid)); patrón de reverse shell.",
   "mitre": [
    "T1059.004",
    "T1071"
   ],
   "groups": [
    "qapaq_netconn",
    "qapaq_attack"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101808": {
   "id": "101808",
   "level": 5,
   "description": "QAPAQ Linux: conexión saliente a destino poco común $(dstip):$(dstport) desde $(qapaq.net.process) (uid $(qapaq.net.uid)).",
   "mitre": [
    "T1071"
   ],
   "groups": [
    "qapaq_netconn",
    "qapaq_rare_destination"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101809": {
   "id": "101809",
   "level": 3,
   "description": "QAPAQ Linux: conexión entrante desde $(srcip) al puerto $(dstport) ($(qapaq.net.process)).",
   "mitre": [
    "T1133"
   ],
   "groups": [
    "qapaq_netconn"
   ],
   "file": "detections/linux/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-001"
   ]
  },
  "101810": {
   "id": "101810",
   "level": 0,
   "description": "QAPAQ Linux: llamada de red auditada ($(audit.key)) de $(audit.exe).",
   "mitre": [],
   "groups": [
    "qapaq_audit_net"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101811": {
   "id": "101811",
   "level": 1,
   "description": "QAPAQ Linux: llamada de red de sesión interactiva a destino interno $(dstip):$(dstport) ($(audit.exe)).",
   "mitre": [],
   "groups": [
    "qapaq_audit_net"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101812": {
   "id": "101812",
   "level": 12,
   "description": "QAPAQ Linux: $(audit.exe) de una sesión interactiva (auid $(audit.auid)) abrió o aceptó una escucha de red (posible bind shell).",
   "mitre": [
    "T1059.004",
    "T1571"
   ],
   "groups": [
    "qapaq_audit_net",
    "qapaq_attack"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101813": {
   "id": "101813",
   "level": 10,
   "description": "QAPAQ Linux: ejecución de herramienta de red o captura $(audit.exe) por auid $(audit.auid) (uid $(audit.uid)).",
   "mitre": [
    "T1046",
    "T1040"
   ],
   "groups": [
    "qapaq_audit_net"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101814": {
   "id": "101814",
   "level": 12,
   "description": "QAPAQ Linux: $(audit.exe) (auid $(audit.auid)) se conectó a $(dstip):$(dstport); patrón de reverse shell.",
   "mitre": [
    "T1059.004",
    "T1071"
   ],
   "groups": [
    "qapaq_audit_net",
    "qapaq_attack"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101815": {
   "id": "101815",
   "level": 10,
   "description": "QAPAQ Linux: escáner de red $(audit.exe) (auid $(audit.auid)) conectando a $(dstip):$(dstport).",
   "mitre": [
    "T1046"
   ],
   "groups": [
    "qapaq_audit_net",
    "qapaq_attack"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101816": {
   "id": "101816",
   "level": 10,
   "description": "QAPAQ Linux: la cuenta de servicio web (uid $(audit.uid), $(audit.exe)) abrió conexión a $(dstip):$(dstport) (posible webshell o C2).",
   "mitre": [
    "T1505.003",
    "T1071"
   ],
   "groups": [
    "qapaq_audit_net",
    "qapaq_attack"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101817": {
   "id": "101817",
   "level": 3,
   "description": "QAPAQ Linux: $(audit.exe) de una sesión interactiva (auid $(audit.auid)) se conectó a $(dstip):$(dstport).",
   "mitre": [],
   "groups": [
    "qapaq_audit_net"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101818": {
   "id": "101818",
   "level": 5,
   "description": "QAPAQ Linux: proceso de sesión interactiva $(audit.exe) (auid $(audit.auid)) abrió o aceptó una escucha de red en $(dstip):$(dstport).",
   "mitre": [
    "T1571"
   ],
   "groups": [
    "qapaq_audit_net"
   ],
   "file": "detections/linux/network-auditd/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-002"
   ]
  },
  "101819": {
   "id": "101819",
   "level": 8,
   "description": "QAPAQ Plataforma: recursos del host. $(qapaq.health.summary)",
   "mitre": [],
   "groups": [
    "qapaq_host"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml"
  },
  "101820": {
   "id": "101820",
   "level": 10,
   "description": "QAPAQ Linux: la cuenta $(dstuser) inició sesión SSH desde 3 o más IPs no administrativas distintas en 1 h (última: $(srcip)).",
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_ssh_session"
   ],
   "file": "detections/linux/ssh-session-tracking/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-003"
   ]
  },
  "101821": {
   "id": "101821",
   "level": 12,
   "description": "QAPAQ Linux: inicio de sesión SSH directo como root desde $(srcip) (la política QAPAQ exige cuenta nominal + sudo).",
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_ssh_session"
   ],
   "file": "detections/linux/ssh-session-tracking/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-003"
   ]
  },
  "101822": {
   "id": "101822",
   "level": 10,
   "description": "QAPAQ Canario: el evento sintético de $(qapaq.health.source) no completó el recorrido. $(qapaq.health.summary)",
   "mitre": [],
   "groups": [
    "qapaq_canary"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml"
  },
  "101823": {
   "id": "101823",
   "level": 7,
   "description": "QAPAQ Plataforma: suscripción SNS sin confirmar. $(qapaq.health.summary)",
   "mitre": [],
   "groups": [
    "qapaq_aws"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml"
  },
  "101824": {
   "id": "101824",
   "level": 5,
   "description": "QAPAQ Plataforma: chequeo del monitor sin ejecutar. $(qapaq.health.summary)",
   "mitre": [],
   "groups": [
    "qapaq_monitor"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml"
  },
  "101825": {
   "id": "101825",
   "level": 10,
   "description": "QAPAQ Plataforma: el monitor de salud no corre. $(qapaq.health.summary)",
   "mitre": [],
   "groups": [
    "qapaq_monitor"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml"
  },
  "101829": {
   "id": "101829",
   "level": 5,
   "description": "QAPAQ Plataforma: problema de salud $(qapaq.health.check). $(qapaq.health.summary)",
   "mitre": [],
   "groups": [],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml"
  },
  "101830": {
   "id": "101830",
   "level": 0,
   "description": "QAPAQ Edge: $(method) $(url) → $(http_status) desde $(srcip).",
   "mitre": [],
   "groups": [],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101831": {
   "id": "101831",
   "level": 8,
   "description": "QAPAQ Edge: intento de inyección SQL contra la consola del SOC desde $(srcip): $(url).",
   "mitre": [
    "T1190"
   ],
   "groups": [
    "qapaq_edge_attack",
    "attack",
    "sql_injection"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101832": {
   "id": "101832",
   "level": 8,
   "description": "QAPAQ Edge: intento de XSS contra la consola del SOC desde $(srcip): $(url).",
   "mitre": [
    "T1190"
   ],
   "groups": [
    "qapaq_edge_attack",
    "attack"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101833": {
   "id": "101833",
   "level": 8,
   "description": "QAPAQ Edge: path traversal / lectura de archivos locales contra la consola del SOC desde $(srcip): $(url).",
   "mitre": [
    "T1190"
   ],
   "groups": [
    "qapaq_edge_attack",
    "attack"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101834": {
   "id": "101834",
   "level": 10,
   "description": "QAPAQ Edge: intento de ejecución remota de comandos (RCE/inyección/Log4Shell) desde $(srcip): $(url).",
   "mitre": [
    "T1190"
   ],
   "groups": [
    "qapaq_edge_attack",
    "attack"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101835": {
   "id": "101835",
   "level": 6,
   "description": "QAPAQ Edge: escáner de vulnerabilidades ($(user_agent)) contra la consola del SOC desde $(srcip).",
   "mitre": [
    "T1595.002"
   ],
   "groups": [
    "qapaq_edge_attack",
    "recon"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101836": {
   "id": "101836",
   "level": 5,
   "description": "QAPAQ Edge: sondeo de rutas sensibles o de tecnologías ajenas a la consola del SOC desde $(srcip): $(url) → $(http_status).",
   "mitre": [
    "T1595.003"
   ],
   "groups": [
    "qapaq_edge_attack",
    "recon"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101837": {
   "id": "101837",
   "level": 10,
   "description": "QAPAQ Edge: campaña de ataque/escaneo contra la consola del SOC: 10+ peticiones maliciosas desde $(srcip) en 5 min.",
   "mitre": [
    "T1595",
    "T1190"
   ],
   "groups": [
    "qapaq_edge_campaign",
    "attack"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101838": {
   "id": "101838",
   "level": 1,
   "description": "QAPAQ Edge: respuesta $(http_status) a $(srcip) para $(url).",
   "mitre": [],
   "groups": [
    "qapaq_edge_4xx"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101839": {
   "id": "101839",
   "level": 1,
   "description": "QAPAQ Edge: error $(http_status) del backend para $(url).",
   "mitre": [],
   "groups": [
    "qapaq_edge_5xx"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101840": {
   "id": "101840",
   "level": 7,
   "description": "QAPAQ Edge: pico de respuestas 4xx para $(srcip): 40+ en 2 min (enumeración o cliente roto).",
   "mitre": [
    "T1595.003"
   ],
   "groups": [
    "qapaq_edge_spike"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101841": {
   "id": "101841",
   "level": 9,
   "description": "QAPAQ Edge: pico de errores 5xx en la consola del SOC: 30+ en 2 min (caída de un backend o denegación de servicio).",
   "mitre": [
    "T1499"
   ],
   "groups": [
    "qapaq_edge_spike",
    "service_availability"
   ],
   "file": "detections/edge/http-attacks/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-005"
   ]
  },
  "101842": {
   "id": "101842",
   "level": 5,
   "description": "QAPAQ Edge: inicio de sesión fallido en la consola del SOC desde $(srcip).",
   "mitre": [
    "T1110"
   ],
   "groups": [
    "qapaq_edge_auth_failure"
   ],
   "file": "detections/edge/soc-authentication/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-006"
   ]
  },
  "101843": {
   "id": "101843",
   "level": 3,
   "description": "QAPAQ Edge: inicio de sesión exitoso en la consola del SOC desde $(srcip).",
   "mitre": [],
   "groups": [
    "authentication_success",
    "qapaq_edge_auth_success"
   ],
   "file": "detections/edge/soc-authentication/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-006"
   ]
  },
  "101844": {
   "id": "101844",
   "level": 10,
   "description": "QAPAQ Edge: fuerza bruta contra el login de la consola del SOC: 6+ fallos desde $(srcip) en 5 min.",
   "mitre": [
    "T1110.001"
   ],
   "groups": [
    "qapaq_edge_auth_failure",
    "qapaq_attack"
   ],
   "file": "detections/edge/soc-authentication/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-006"
   ]
  },
  "101845": {
   "id": "101845",
   "level": 13,
   "description": "QAPAQ Edge: inicio de sesión exitoso en la consola del SOC desde $(srcip) tras fuerza bruta desde la misma IP.",
   "mitre": [
    "T1110.001",
    "T1078"
   ],
   "groups": [
    "qapaq_attack_chain",
    "qapaq_attack"
   ],
   "file": "detections/edge/soc-authentication/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-006"
   ]
  },
  "101846": {
   "id": "101846",
   "level": 9,
   "description": "QAPAQ Edge: 20+ inicios de sesión fallidos en la consola del SOC desde IPs distintas en 10 min (password spraying distribuido).",
   "mitre": [
    "T1110.003"
   ],
   "groups": [
    "qapaq_edge_auth_failure",
    "qapaq_attack"
   ],
   "file": "detections/edge/soc-authentication/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-006"
   ]
  },
  "101850": {
   "id": "101850",
   "level": 10,
   "description": "QAPAQ Linux: shell interactiva abierta dentro del contenedor crítico del SOC $(docker.Actor.Attributes.name).",
   "mitre": [
    "T1609"
   ],
   "groups": [
    "qapaq_container"
   ],
   "file": "detections/linux/docker-runtime/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-004"
   ]
  },
  "101851": {
   "id": "101851",
   "level": 6,
   "description": "QAPAQ Linux: comando ejecutado dentro del contenedor crítico del SOC $(docker.Actor.Attributes.name): $(docker.Action).",
   "mitre": [
    "T1609"
   ],
   "groups": [
    "qapaq_container"
   ],
   "file": "detections/linux/docker-runtime/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-004"
   ]
  },
  "101852": {
   "id": "101852",
   "level": 8,
   "description": "QAPAQ Linux: se creó un contenedor de propósito general o de herramientas ($(docker.Actor.Attributes.image)) en el nodo del SOC: $(docker.Actor.Attributes.name).",
   "mitre": [
    "T1610"
   ],
   "groups": [
    "qapaq_container"
   ],
   "file": "detections/linux/docker-runtime/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-004"
   ]
  },
  "101853": {
   "id": "101853",
   "level": 13,
   "description": "QAPAQ Snyk: vulnerabilidad ALTA con exploit maduro priorizada P1 ($(qapaq.vuln.reason)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101854": {
   "id": "101854",
   "level": 12,
   "description": "QAPAQ Snyk: vulnerabilidad media elevada a P1 ($(qapaq.vuln.reason); KEV=$(qapaq.vuln.kev), EPSS=$(qapaq.vuln.epss)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101855": {
   "id": "101855",
   "level": 12,
   "description": "QAPAQ Snyk: vulnerabilidad baja elevada a P1 ($(qapaq.vuln.reason); KEV=$(qapaq.vuln.kev), EPSS=$(qapaq.vuln.epss)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [
    "T1190"
   ],
   "groups": [],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101856": {
   "id": "101856",
   "level": 11,
   "description": "QAPAQ Snyk: vulnerabilidad ALTA priorizada P2 ($(qapaq.vuln.reason); EPSS=$(qapaq.vuln.epss)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101857": {
   "id": "101857",
   "level": 10,
   "description": "QAPAQ Snyk: vulnerabilidad media elevada a P2 ($(qapaq.vuln.reason); EPSS=$(qapaq.vuln.epss)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [],
   "groups": [],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101858": {
   "id": "101858",
   "level": 6,
   "description": "QAPAQ Snyk: vulnerabilidad crítica de baja prioridad P4 ($(qapaq.vuln.reason); EPSS=$(qapaq.vuln.epss)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [],
   "groups": [
    "qapaq_deprioritized"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101859": {
   "id": "101859",
   "level": 6,
   "description": "QAPAQ Snyk: vulnerabilidad alta de baja prioridad P4 ($(qapaq.vuln.reason); EPSS=$(qapaq.vuln.epss)) $(qapaq.vuln.cve) en $(snyk.project.name).",
   "mitre": [],
   "groups": [
    "qapaq_deprioritized"
   ],
   "file": "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml"
  },
  "101860": {
   "id": "101860",
   "level": 12,
   "description": "QAPAQ Red: inicio de sesión exitoso desde $(srcip), IP en listas de reputación (Spamhaus DROP / abuse.ch).",
   "mitre": [
    "T1078"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101861": {
   "id": "101861",
   "level": 12,
   "description": "QAPAQ Red: inicio de sesión exitoso desde $(srcip), nodo de salida de Tor.",
   "mitre": [
    "T1090.003",
    "T1078"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101862": {
   "id": "101862",
   "level": 8,
   "description": "QAPAQ Red: petición a la consola del SOC desde $(srcip), IP en listas de reputación: $(method) $(url) → $(http_status).",
   "mitre": [
    "T1595"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101863": {
   "id": "101863",
   "level": 6,
   "description": "QAPAQ Red: petición a la consola del SOC desde un nodo de salida de Tor ($(srcip)): $(method) $(url).",
   "mitre": [
    "T1090.003"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101864": {
   "id": "101864",
   "level": 12,
   "description": "QAPAQ Red: el host abrió una conexión a $(dstip):$(dstport) ($(qapaq.net.process)), IP en listas de reputación (posible C2).",
   "mitre": [
    "T1071"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101865": {
   "id": "101865",
   "level": 13,
   "description": "QAPAQ Red: acceso SSH exitoso de $(dstuser) desde $(srcip), IP en listas de reputación.",
   "mitre": [
    "T1078.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101866": {
   "id": "101866",
   "level": 12,
   "description": "QAPAQ Red: $(audit.exe) (auid $(audit.auid)) se conectó a $(dstip):$(dstport), IP en listas de reputación.",
   "mitre": [
    "T1071"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101867": {
   "id": "101867",
   "level": 10,
   "description": "QAPAQ Red: conexión TCP establecida desde $(srcip) (listas de reputación) al puerto $(dstport) del host.",
   "mitre": [
    "T1133"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101868": {
   "id": "101868",
   "level": 13,
   "description": "QAPAQ Red: acceso SSH exitoso de $(dstuser) desde $(srcip), nodo de salida de Tor.",
   "mitre": [
    "T1090.003",
    "T1021.004"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/network/threat-intel/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-007"
   ]
  },
  "101870": {
   "id": "101870",
   "level": 12,
   "description": "QAPAQ Red: $(srcip), ya bloqueada por el WAF de Cloudflare, ataca ahora la consola del SOC: $(url).",
   "mitre": [
    "T1190",
    "T1595"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101871": {
   "id": "101871",
   "level": 13,
   "description": "QAPAQ Red: inicio de sesión exitoso desde $(srcip), IP que el WAF de Cloudflare bloqueó en los últimos 7 días.",
   "mitre": [
    "T1078",
    "T1190"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101872": {
   "id": "101872",
   "level": 8,
   "description": "QAPAQ Red: $(srcip), bloqueada por el WAF de Cloudflare, intenta autenticarse en el SOC (SSH).",
   "mitre": [
    "T1110"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101873": {
   "id": "101873",
   "level": 10,
   "description": "QAPAQ Red: $(srcip) atacó la consola web del SOC y ahora intenta SSH al mismo nodo (1 h).",
   "mitre": [
    "T1110",
    "T1190"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101874": {
   "id": "101874",
   "level": 14,
   "description": "QAPAQ Red: acceso SSH exitoso de $(dstuser) desde $(srcip), que atacó la consola web del SOC en la última hora.",
   "mitre": [
    "T1078.003",
    "T1190"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101875": {
   "id": "101875",
   "level": 12,
   "description": "QAPAQ Red: inicio de sesión en la consola del SOC desde $(srcip), que intentó SSH con usuarios inexistentes en la última hora.",
   "mitre": [
    "T1110",
    "T1078"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101876": {
   "id": "101876",
   "level": 12,
   "description": "QAPAQ Red: inicio de sesión en la consola del SOC desde $(srcip), que falló contraseñas SSH de una cuenta real en la última hora.",
   "mitre": [
    "T1110",
    "T1078"
   ],
   "groups": [
    "qapaq_attack_chain"
   ],
   "file": "detections/network/cross-source-correlation/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-008"
   ]
  },
  "101880": {
   "id": "101880",
   "level": 0,
   "description": "QAPAQ Windows: WFP permitió $(win.eventdata.application) → $(win.eventdata.destAddress):$(win.eventdata.destPort).",
   "mitre": [],
   "groups": [
    "qapaq_wfp"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101881": {
   "id": "101881",
   "level": 1,
   "description": "QAPAQ Windows: WFP bloqueó $(win.eventdata.sourceAddress) → $(win.eventdata.destAddress):$(win.eventdata.destPort).",
   "mitre": [],
   "groups": [
    "qapaq_wfp"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101882": {
   "id": "101882",
   "level": 10,
   "description": "QAPAQ Windows: 20+ conexiones bloqueadas desde $(win.eventdata.sourceAddress) a puertos distintos en 2 min (escaneo de puertos).",
   "mitre": [
    "T1046"
   ],
   "groups": [
    "qapaq_wfp"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101883": {
   "id": "101883",
   "level": 12,
   "description": "QAPAQ Windows: $(win.eventdata.application) se conectó a $(win.eventdata.destAddress):$(win.eventdata.destPort), IP en listas de reputación.",
   "mitre": [
    "T1071"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101884": {
   "id": "101884",
   "level": 6,
   "description": "QAPAQ Windows: WFP bloqueó a $(win.eventdata.sourceAddress) (listas de reputación) hacia el puerto $(win.eventdata.destPort).",
   "mitre": [
    "T1595"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101885": {
   "id": "101885",
   "level": 12,
   "description": "QAPAQ Windows: $(win.eventdata.image) se conectó a $(win.eventdata.destinationIp):$(win.eventdata.destinationPort), IP en listas de reputación.",
   "mitre": [
    "T1071"
   ],
   "groups": [
    "qapaq_ti_hit"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101886": {
   "id": "101886",
   "level": 8,
   "description": "QAPAQ Windows: binario del sistema abusable $(win.eventdata.image) se conectó a $(win.eventdata.destinationIp):$(win.eventdata.destinationPort) (descarga o C2 con LOLBin).",
   "mitre": [
    "T1105"
   ],
   "groups": [
    "qapaq_attack"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101887": {
   "id": "101887",
   "level": 6,
   "description": "QAPAQ Windows: $(win.eventdata.image) resolvió $(win.eventdata.queryName) (DNS dinámico o túnel inverso).",
   "mitre": [
    "T1071",
    "T1572"
   ],
   "groups": [
    "qapaq_dns"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101888": {
   "id": "101888",
   "level": 10,
   "description": "QAPAQ Windows: el firewall descartó tráfico de $(srcip) (listas de reputación) hacia $(dstip):$(dstport).",
   "mitre": [
    "T1595"
   ],
   "groups": [
    "qapaq_ti_hit",
    "firewall_drop"
   ],
   "file": "detections/windows/network-connections/rule.xml",
   "useCases": [
    "QAPAQ-DET-NET-009"
   ]
  },
  "101900": {
   "id": "101900",
   "level": 3,
   "description": "QAPAQ SharePoint: $(office365.UserId) descargó $(office365.SourceFileName).",
   "mitre": [],
   "groups": [
    "qapaq_download"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101901": {
   "id": "101901",
   "level": 2,
   "description": "QAPAQ SharePoint: descarga de la cuenta de servicio/sincronización aprobada $(office365.UserId).",
   "mitre": [],
   "groups": [
    "qapaq_tuning"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101902": {
   "id": "101902",
   "level": 10,
   "description": "QAPAQ SharePoint: descarga masiva de $(office365.UserId) (150 archivos en 10 min por web o API).",
   "mitre": [
    "T1530",
    "T1213.002"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_exfiltration"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101903": {
   "id": "101903",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) descargó 40 archivos en 30 min fuera del horario QAPAQ (hora local $(qapaq.local_hour)).",
   "mitre": [
    "T1530",
    "T1213.002"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_exfiltration",
    "qapaq_off_hours"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101904": {
   "id": "101904",
   "level": 12,
   "description": "QAPAQ SharePoint: descarga masiva de $(office365.UserId) desde una red nueva para el usuario ($(office365.ClientIP)).",
   "mitre": [
    "T1530",
    "T1078.004"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_exfiltration"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101905": {
   "id": "101905",
   "level": 3,
   "description": "QAPAQ SharePoint: el invitado $(office365.UserId) accedió a $(office365.SourceFileName).",
   "mitre": [],
   "groups": [
    "qapaq_guest_access"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101906": {
   "id": "101906",
   "level": 10,
   "description": "QAPAQ SharePoint: el invitado $(office365.UserId) accedió o descargó 30 archivos en 10 min.",
   "mitre": [
    "T1530",
    "T1078.004"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_guest_access"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101907": {
   "id": "101907",
   "level": 10,
   "description": "QAPAQ SharePoint: actividad de archivos de la cuenta deshabilitada $(office365.UserId) ($(office365.Operation) en $(office365.ObjectId)).",
   "mitre": [
    "T1078.004"
   ],
   "groups": [
    "qapaq_initial_access"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101908": {
   "id": "101908",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) hizo $(office365.Operation) desde $(office365.ClientIP), IP en listas de amenazas (Spamhaus DROP/Feodo).",
   "mitre": [
    "T1078.004",
    "T1213.002"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_threat_intel"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101909": {
   "id": "101909",
   "level": 11,
   "description": "QAPAQ SharePoint: $(office365.UserId) hizo $(office365.Operation) desde $(office365.ClientIP), nodo de salida de Tor.",
   "mitre": [
    "T1090.003",
    "T1078.004"
   ],
   "groups": [
    "qapaq_initial_access",
    "qapaq_threat_intel"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101910": {
   "id": "101910",
   "level": 3,
   "description": "QAPAQ SharePoint: enlace anónimo usado desde $(office365.ClientIP) sobre $(office365.ObjectId).",
   "mitre": [],
   "groups": [
    "qapaq_anonymous_link"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101911": {
   "id": "101911",
   "level": 10,
   "description": "QAPAQ SharePoint: 50 usos de enlaces anónimos desde $(office365.ClientIP) en 10 min (descarga masiva sin identidad).",
   "mitre": [
    "T1530"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_anonymous_link"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101912": {
   "id": "101912",
   "level": 3,
   "description": "QAPAQ SharePoint: el cliente de sincronización de $(office365.UserId) descargó $(office365.SourceFileName).",
   "mitre": [],
   "groups": [
    "qapaq_sync"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101913": {
   "id": "101913",
   "level": 7,
   "description": "QAPAQ SharePoint: sincronización masiva de $(office365.UserId) (500 archivos en 10 min, cliente OneDrive).",
   "mitre": [
    "T1530"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_sync"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101914": {
   "id": "101914",
   "level": 11,
   "description": "QAPAQ SharePoint: sincronización masiva de $(office365.UserId) desde una red nueva para el usuario ($(office365.ClientIP)).",
   "mitre": [
    "T1530",
    "T1078.004"
   ],
   "groups": [
    "qapaq_collection",
    "qapaq_sync"
   ],
   "file": "detections/sharepoint/exfiltration/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-001"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101915": {
   "id": "101915",
   "level": 3,
   "description": "QAPAQ SharePoint: $(office365.UserId) borró $(office365.ObjectId).",
   "mitre": [],
   "groups": [
    "qapaq_deletion"
   ],
   "file": "detections/sharepoint/mass-deletion/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-002"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101916": {
   "id": "101916",
   "level": 2,
   "description": "QAPAQ SharePoint: borrado de la cuenta de servicio aprobada $(office365.UserId).",
   "mitre": [],
   "groups": [
    "qapaq_tuning"
   ],
   "file": "detections/sharepoint/mass-deletion/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-002"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101917": {
   "id": "101917",
   "level": 10,
   "description": "QAPAQ SharePoint: borrado masivo, $(office365.UserId) borró 100 archivos o carpetas en 10 min.",
   "mitre": [
    "T1485"
   ],
   "groups": [
    "qapaq_impact"
   ],
   "file": "detections/sharepoint/mass-deletion/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-002"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101918": {
   "id": "101918",
   "level": 13,
   "description": "QAPAQ SharePoint: destrucción masiva, $(office365.UserId) borró 300 archivos o carpetas en 15 min.",
   "mitre": [
    "T1485"
   ],
   "groups": [
    "qapaq_impact"
   ],
   "file": "detections/sharepoint/mass-deletion/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-002"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101919": {
   "id": "101919",
   "level": 3,
   "description": "QAPAQ SharePoint: $(office365.UserId) eliminó de la papelera de segunda etapa $(office365.ObjectId).",
   "mitre": [],
   "groups": [
    "qapaq_deletion"
   ],
   "file": "detections/sharepoint/mass-deletion/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-002"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101920": {
   "id": "101920",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) vació 25 elementos de la papelera de segunda etapa en 15 min (impide la recuperación).",
   "mitre": [
    "T1490",
    "T1485"
   ],
   "groups": [
    "qapaq_impact"
   ],
   "file": "detections/sharepoint/mass-deletion/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-002"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101925": {
   "id": "101925",
   "level": 3,
   "description": "QAPAQ SharePoint: enlace anónimo de la cuenta aprobada para publicar $(office365.UserId).",
   "mitre": [],
   "groups": [
    "qapaq_tuning",
    "qapaq_anonymous_link"
   ],
   "file": "detections/sharepoint/external-sharing/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-003"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101926": {
   "id": "101926",
   "level": 11,
   "description": "QAPAQ SharePoint: $(office365.UserId) creó 10 enlaces anónimos en 1 h.",
   "mitre": [
    "T1567"
   ],
   "groups": [
    "qapaq_exfiltration",
    "qapaq_anonymous_link"
   ],
   "file": "detections/sharepoint/external-sharing/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-003"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101927": {
   "id": "101927",
   "level": 9,
   "description": "QAPAQ SharePoint: $(office365.UserId) compartió $(office365.ObjectId) con el correo personal $(office365.TargetUserOrGroupName).",
   "mitre": [
    "T1537"
   ],
   "groups": [
    "qapaq_exfiltration",
    "qapaq_external_sharing",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/external-sharing/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-003"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101928": {
   "id": "101928",
   "level": 4,
   "description": "QAPAQ SharePoint: $(office365.UserId) compartió $(office365.ObjectId) con el externo $(office365.TargetUserOrGroupName).",
   "mitre": [
    "T1537"
   ],
   "groups": [
    "qapaq_external_sharing",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/external-sharing/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-003"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101929": {
   "id": "101929",
   "level": 2,
   "description": "QAPAQ SharePoint: compartición externa de la cuenta aprobada $(office365.UserId).",
   "mitre": [],
   "groups": [
    "qapaq_tuning",
    "qapaq_external_sharing"
   ],
   "file": "detections/sharepoint/external-sharing/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-003"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101930": {
   "id": "101930",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) compartió 5 elementos con correos personales en 1 h.",
   "mitre": [
    "T1537"
   ],
   "groups": [
    "qapaq_exfiltration",
    "qapaq_external_sharing"
   ],
   "file": "detections/sharepoint/external-sharing/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-003"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101935": {
   "id": "101935",
   "level": 8,
   "description": "QAPAQ SharePoint: $(office365.UserId) cambió la política de uso compartido o de acceso ($(office365.Operation)) en $(office365.ObjectId).",
   "mitre": [
    "T1484"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_sharing_policy",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101936": {
   "id": "101936",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) habilitó el uso compartido con cualquier persona en $(office365.ObjectId).",
   "mitre": [
    "T1484"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_sharing_policy",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101937": {
   "id": "101937",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) habilitó el uso compartido con cualquier persona en $(office365.ObjectId).",
   "mitre": [
    "T1484"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_sharing_policy",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101938": {
   "id": "101938",
   "level": 10,
   "description": "QAPAQ SharePoint: $(office365.UserId) agregó un administrador de colección de sitios en $(office365.ObjectId).",
   "mitre": [
    "T1098"
   ],
   "groups": [
    "qapaq_privilege_escalation",
    "qapaq_site_admin",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101939": {
   "id": "101939",
   "level": 3,
   "description": "QAPAQ SharePoint: alta de administrador de sitio por la cuenta del sistema $(office365.UserId) (aprovisionamiento).",
   "mitre": [],
   "groups": [
    "qapaq_tuning",
    "qapaq_site_admin"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101940": {
   "id": "101940",
   "level": 11,
   "description": "QAPAQ SharePoint: $(office365.UserId) se agregó o agregó un administrador al OneDrive de otra persona ($(office365.ObjectId)).",
   "mitre": [
    "T1098",
    "T1530"
   ],
   "groups": [
    "qapaq_privilege_escalation",
    "qapaq_site_admin",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101941": {
   "id": "101941",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) hizo administrador de $(office365.ObjectId) al invitado $(office365.TargetUserOrGroupName).",
   "mitre": [
    "T1098",
    "T1078.004"
   ],
   "groups": [
    "qapaq_privilege_escalation",
    "qapaq_site_admin",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/sharing-policy-and-admins/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-004"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101945": {
   "id": "101945",
   "level": 8,
   "description": "QAPAQ SharePoint: $(office365.UserId) quitó la etiqueta de confidencialidad de $(office365.ObjectId).",
   "mitre": [
    "T1562"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_sensitivity_label",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101946": {
   "id": "101946",
   "level": 8,
   "description": "QAPAQ SharePoint: $(office365.UserId) rebajó o quitó la etiqueta de confidencialidad de $(office365.ObjectId) ($(office365.Operation)).",
   "mitre": [
    "T1562"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_sensitivity_label",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101947": {
   "id": "101947",
   "level": 12,
   "description": "QAPAQ SharePoint: $(office365.UserId) quitó la etiqueta de confidencialidad de 10 archivos en 1 h.",
   "mitre": [
    "T1562"
   ],
   "groups": [
    "qapaq_defense_evasion",
    "qapaq_sensitivity_label"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101948": {
   "id": "101948",
   "level": 13,
   "description": "QAPAQ SharePoint: $(office365.UserId) compartió fuera de QAPAQ $(office365.ObjectId) después de quitarle la etiqueta de confidencialidad.",
   "mitre": [
    "T1562",
    "T1567"
   ],
   "groups": [
    "qapaq_exfiltration",
    "qapaq_sensitivity_label",
    "qapaq_attack_chain"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101949": {
   "id": "101949",
   "level": 7,
   "description": "QAPAQ SharePoint: DLP detectó información sensible en $(office365.ObjectId) ($(office365.UserId)).",
   "mitre": [
    "T1213.002"
   ],
   "groups": [
    "qapaq_dlp"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101950": {
   "id": "101950",
   "level": 11,
   "description": "QAPAQ SharePoint: DLP de severidad alta en $(office365.ObjectId) ($(office365.UserId)).",
   "mitre": [
    "T1213.002"
   ],
   "groups": [
    "qapaq_dlp"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101951": {
   "id": "101951",
   "level": 9,
   "description": "QAPAQ SharePoint: $(office365.UserId) anuló la política DLP sobre $(office365.ObjectId).",
   "mitre": [
    "T1562",
    "T1213.002"
   ],
   "groups": [
    "qapaq_dlp",
    "qapaq_pending_provider_evidence"
   ],
   "file": "detections/sharepoint/labels-and-dlp/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-005"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101960": {
   "id": "101960",
   "level": 0,
   "description": "QAPAQ SharePoint: evento del collector de postura y salud.",
   "mitre": [],
   "groups": [],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101961": {
   "id": "101961",
   "level": 3,
   "description": "QAPAQ SharePoint: foto de la configuración de uso compartido del tenant ($(sharepoint.tenant.sharing_capability)).",
   "mitre": [],
   "groups": [
    "qapaq_posture"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101962": {
   "id": "101962",
   "level": 8,
   "description": "QAPAQ SharePoint: cambió $(sharepoint.change.setting) del tenant: $(sharepoint.change.old) → $(sharepoint.change.new).",
   "mitre": [
    "T1484"
   ],
   "groups": [
    "qapaq_posture",
    "qapaq_sharing_policy"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101963": {
   "id": "101963",
   "level": 12,
   "description": "QAPAQ SharePoint: se debilitó $(sharepoint.change.setting) del tenant: $(sharepoint.change.old) → $(sharepoint.change.new).",
   "mitre": [
    "T1484"
   ],
   "groups": [
    "qapaq_posture",
    "qapaq_sharing_policy",
    "qapaq_defense_evasion"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101964": {
   "id": "101964",
   "level": 5,
   "description": "QAPAQ SharePoint: sitio nuevo $(sharepoint.site.url) (creado $(sharepoint.site.created)).",
   "mitre": [],
   "groups": [
    "qapaq_posture"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101965": {
   "id": "101965",
   "level": 10,
   "description": "QAPAQ SharePoint: el sitio reciente $(sharepoint.site.url) ya tiene enlaces anónimos o permisos externos.",
   "mitre": [
    "T1567",
    "T1537"
   ],
   "groups": [
    "qapaq_posture",
    "qapaq_external_sharing"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101966": {
   "id": "101966",
   "level": 7,
   "description": "QAPAQ SharePoint: enlace anónimo ($(sharepoint.link.type)) sobre $(sharepoint.item.url).",
   "mitre": [
    "T1567"
   ],
   "groups": [
    "qapaq_posture",
    "qapaq_anonymous_link"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101967": {
   "id": "101967",
   "level": 10,
   "description": "QAPAQ SharePoint: enlace anónimo con edición sobre $(sharepoint.item.url) (cualquiera puede modificar o reemplazar el contenido).",
   "mitre": [
    "T1567"
   ],
   "groups": [
    "qapaq_posture",
    "qapaq_anonymous_link"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101968": {
   "id": "101968",
   "level": 5,
   "description": "QAPAQ SharePoint: $(sharepoint.grantee.email) (externo) tiene acceso a $(sharepoint.item.url).",
   "mitre": [
    "T1537"
   ],
   "groups": [
    "qapaq_posture",
    "qapaq_external_sharing"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101969": {
   "id": "101969",
   "level": 3,
   "description": "QAPAQ SharePoint: función $(qapaq.capability.feature) $(qapaq.capability.status) (falta: $(qapaq.capability.missing)).",
   "mitre": [],
   "groups": [
    "qapaq_source_health"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101970": {
   "id": "101970",
   "level": 7,
   "description": "QAPAQ SharePoint: la función $(qapaq.capability.feature) dejó de estar disponible (permiso revocado o credencial vencida; falta $(qapaq.capability.missing)).",
   "mitre": [],
   "groups": [
    "qapaq_source_health"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101971": {
   "id": "101971",
   "level": 2,
   "description": "QAPAQ SharePoint: inventario de sitios ($(sharepoint.inventory.sites) sitios, $(sharepoint.inventory.known_findings) hallazgos de uso compartido).",
   "mitre": [],
   "groups": [
    "qapaq_posture"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "101972": {
   "id": "101972",
   "level": 6,
   "description": "QAPAQ SharePoint: el tenant permite enlaces \"Cualquier persona\" (sharingCapability=externalUserAndGuestSharing).",
   "mitre": [
    "T1567"
   ],
   "groups": [
    "qapaq_posture"
   ],
   "file": "detections/sharepoint/posture/rule.xml",
   "useCases": [
    "QAPAQ-DET-SP-006"
   ],
   "runbooks": [
    "exfiltracion-sharepoint"
   ]
  },
  "19003": {
   "id": "19003",
   "level": 5,
   "description": "SCA summary: $(sca.policy): Score less than 80% ($(sca.score))",
   "mitre": [],
   "groups": [
    "sca"
   ],
   "file": "wazuh-ruleset/0570-sca_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-005"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "19007": {
   "id": "19007",
   "level": 7,
   "description": "$(sca.policy): $(sca.check.title)",
   "mitre": [],
   "groups": [
    "sca"
   ],
   "file": "wazuh-ruleset/0570-sca_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-005"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "220": {
   "id": "220",
   "level": 7,
   "description": "The agent could not restart due to a $(module) failure in the remote configuration",
   "mitre": [],
   "groups": [
    "wazuh",
    "agent_restarting",
    "configuration_failure"
   ],
   "file": "wazuh-ruleset/0016-wazuh_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-WAZUH-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "2902": {
   "id": "2902",
   "level": 7,
   "description": "New dpkg (Debian Package) installed.",
   "mitre": [],
   "groups": [
    "syslog",
    "dpkg",
    "config_changed"
   ],
   "file": "wazuh-ruleset/0020-syslog_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-002"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "2904": {
   "id": "2904",
   "level": 7,
   "description": "Dpkg (Debian Package) half configured.",
   "mitre": [],
   "groups": [
    "syslog",
    "dpkg",
    "config_changed"
   ],
   "file": "wazuh-ruleset/0020-syslog_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-002"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "510": {
   "id": "510",
   "level": 7,
   "description": "Host-based anomaly detection event (rootcheck).",
   "mitre": [],
   "groups": [
    "ossec",
    "rootcheck"
   ],
   "file": "wazuh-ruleset/0015-ossec_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-003"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "521": {
   "id": "521",
   "level": 11,
   "description": "Possible kernel level rootkit",
   "mitre": [
    "T1014"
   ],
   "groups": [
    "ossec",
    "rootcheck"
   ],
   "file": "wazuh-ruleset/0015-ossec_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-003"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "550": {
   "id": "550",
   "level": 7,
   "description": "Integrity checksum changed.",
   "mitre": [
    "T1565.001"
   ],
   "groups": [
    "ossec",
    "syscheck",
    "syscheck_entry_modified"
   ],
   "file": "wazuh-ruleset/0015-ossec_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "553": {
   "id": "553",
   "level": 7,
   "description": "File deleted.",
   "mitre": [
    "T1070.004",
    "T1485"
   ],
   "groups": [
    "ossec",
    "syscheck",
    "syscheck_entry_deleted"
   ],
   "file": "wazuh-ruleset/0015-ossec_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "554": {
   "id": "554",
   "level": 5,
   "description": "File added to the system.",
   "mitre": [],
   "groups": [
    "ossec",
    "syscheck",
    "syscheck_entry_added"
   ],
   "file": "wazuh-ruleset/0015-ossec_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "5710": {
   "id": "5710",
   "level": 5,
   "description": "sshd: Attempt to login using a non-existent user",
   "mitre": [
    "T1110.001",
    "T1021.004"
   ],
   "groups": [
    "syslog",
    "sshd",
    "authentication_failed",
    "invalid_login"
   ],
   "file": "wazuh-ruleset/0095-sshd_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-004"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "5762": {
   "id": "5762",
   "level": 4,
   "description": "sshd: connection reset",
   "mitre": [],
   "groups": [
    "syslog",
    "sshd"
   ],
   "file": "wazuh-ruleset/0095-sshd_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-HOST-004"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91533": {
   "id": "91533",
   "level": 3,
   "description": "Office 365: Events from the Exchange admin audit log.",
   "mitre": [],
   "groups": [
    "office365",
    "ExchangeAdmin"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-003"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91548": {
   "id": "91548",
   "level": 5,
   "description": "Office 365: Admin actions from the Security and Compliance Center.",
   "mitre": [],
   "groups": [
    "office365",
    "SecurityComplianceCenterEOPCmdlet"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-003"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91578": {
   "id": "91578",
   "level": 5,
   "description": "Office 365: Events related to the MailItemsAccessed mailbox auditing action.",
   "mitre": [
    "T1114.002"
   ],
   "groups": [
    "office365",
    "ExchangeItemAggregated"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91702": {
   "id": "91702",
   "level": 4,
   "description": "Office 365: User downloads a file.",
   "mitre": [
    "T1530"
   ],
   "groups": [
    "office365",
    "OneDrive",
    "SharePoint"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-002"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91703": {
   "id": "91703",
   "level": 6,
   "description": "Office 365: A permission level was added to a site collection.",
   "mitre": [
    "T1098"
   ],
   "groups": [
    "office365",
    "OneDrive",
    "SharePoint"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-002"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91707": {
   "id": "91707",
   "level": 4,
   "description": "Office 365: Sent message",
   "mitre": [
    "T1114.003"
   ],
   "groups": [
    "office365",
    "Exchange"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91708": {
   "id": "91708",
   "level": 6,
   "description": "Office 365: Sent message using different permissions",
   "mitre": [
    "T1114.003"
   ],
   "groups": [
    "office365",
    "Exchange"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-001"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91712": {
   "id": "91712",
   "level": 6,
   "description": "Office 365: Added group",
   "mitre": [
    "T1098"
   ],
   "groups": [
    "office365",
    "AzureActiveDirectory"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-003"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  },
  "91713": {
   "id": "91713",
   "level": 6,
   "description": "Office 365: Added member to group",
   "mitre": [
    "T1098.007"
   ],
   "groups": [
    "office365",
    "AzureActiveDirectory"
   ],
   "file": "wazuh-ruleset/0755-office365_rules.xml (wazuh-4.14.8)",
   "useCases": [
    "QAPAQ-STOCK-M365-003"
   ],
   "runbooks": [
    "reglas-estandar-wazuh"
   ]
  }
 },
 "techniques": {
  "T1003.006": {
   "name": "OS Credential Dumping: DCSync",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1014": {
   "name": "Rootkit",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1021.004": {
   "name": "Remote Services: SSH",
   "tactics": [
    {
     "id": "TA0008",
     "name": "Movimiento lateral"
    }
   ]
  },
  "T1027": {
   "name": "Obfuscated Files or Information",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1040": {
   "name": "Network Sniffing",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    },
    {
     "id": "TA0007",
     "name": "Descubrimiento"
    }
   ]
  },
  "T1046": {
   "name": "Network Service Discovery",
   "tactics": [
    {
     "id": "TA0007",
     "name": "Descubrimiento"
    }
   ]
  },
  "T1053.003": {
   "name": "Scheduled Task/Job: Cron",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1053.005": {
   "name": "Scheduled Task/Job: Scheduled Task",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1053.006": {
   "name": "Scheduled Task/Job: Systemd Timers",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1059": {
   "name": "Command and Scripting Interpreter",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  },
  "T1059.001": {
   "name": "Command and Scripting Interpreter: PowerShell",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  },
  "T1059.004": {
   "name": "Command and Scripting Interpreter: Unix Shell",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  },
  "T1070.001": {
   "name": "Indicator Removal: Clear Windows Event Logs",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1070.004": {
   "name": "Indicator Removal: File Deletion",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1071": {
   "name": "Application Layer Protocol",
   "tactics": [
    {
     "id": "TA0011",
     "name": "Comando y control"
    }
   ]
  },
  "T1078": {
   "name": "Valid Accounts",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    },
    {
     "id": "TA0001",
     "name": "Acceso inicial"
    }
   ]
  },
  "T1078.003": {
   "name": "Valid Accounts: Local Accounts",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    },
    {
     "id": "TA0001",
     "name": "Acceso inicial"
    }
   ]
  },
  "T1078.004": {
   "name": "Valid Accounts: Cloud Accounts",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    },
    {
     "id": "TA0001",
     "name": "Acceso inicial"
    }
   ]
  },
  "T1090.003": {
   "name": "Proxy: Multi-hop Proxy",
   "tactics": [
    {
     "id": "TA0011",
     "name": "Comando y control"
    }
   ]
  },
  "T1098": {
   "name": "Account Manipulation",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1098.001": {
   "name": "Account Manipulation: Additional Cloud Credentials",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1098.002": {
   "name": "Account Manipulation: Additional Email Delegate Permissions",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1098.003": {
   "name": "Account Manipulation: Additional Cloud Roles",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1098.004": {
   "name": "Account Manipulation: SSH Authorized Keys",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1098.005": {
   "name": "Account Manipulation: Device Registration",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1098.007": {
   "name": "Account Manipulation: Additional Local or Domain Groups",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1105": {
   "name": "Ingress Tool Transfer",
   "tactics": [
    {
     "id": "TA0011",
     "name": "Comando y control"
    }
   ]
  },
  "T1110": {
   "name": "Brute Force",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1110.001": {
   "name": "Brute Force: Password Guessing",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1110.003": {
   "name": "Brute Force: Password Spraying",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1114": {
   "name": "Email Collection",
   "tactics": [
    {
     "id": "TA0009",
     "name": "Recolección"
    }
   ]
  },
  "T1114.002": {
   "name": "Email Collection: Remote Email Collection",
   "tactics": [
    {
     "id": "TA0009",
     "name": "Recolección"
    }
   ]
  },
  "T1114.003": {
   "name": "Email Collection: Email Forwarding Rule",
   "tactics": [
    {
     "id": "TA0009",
     "name": "Recolección"
    }
   ]
  },
  "T1133": {
   "name": "External Remote Services",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0001",
     "name": "Acceso inicial"
    }
   ]
  },
  "T1136.003": {
   "name": "Create Account: Cloud Account",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    }
   ]
  },
  "T1190": {
   "name": "Exploit Public-Facing Application",
   "tactics": [
    {
     "id": "TA0001",
     "name": "Acceso inicial"
    }
   ]
  },
  "T1195": {
   "name": "Supply Chain Compromise",
   "tactics": [
    {
     "id": "TA0001",
     "name": "Acceso inicial"
    }
   ]
  },
  "T1204": {
   "name": "User Execution",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  },
  "T1204.002": {
   "name": "User Execution: Malicious File",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  },
  "T1213.002": {
   "name": "Data from Information Repositories: Sharepoint",
   "tactics": [
    {
     "id": "TA0009",
     "name": "Recolección"
    }
   ]
  },
  "T1484": {
   "name": "Domain or Tenant Policy Modification",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1484.001": {
   "name": "Domain or Tenant Policy Modification: Group Policy Modification",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1484.002": {
   "name": "Domain or Tenant Policy Modification: Trust Modification",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1485": {
   "name": "Data Destruction",
   "tactics": [
    {
     "id": "TA0040",
     "name": "Impacto"
    }
   ]
  },
  "T1490": {
   "name": "Inhibit System Recovery",
   "tactics": [
    {
     "id": "TA0040",
     "name": "Impacto"
    }
   ]
  },
  "T1496": {
   "name": "Resource Hijacking",
   "tactics": [
    {
     "id": "TA0040",
     "name": "Impacto"
    }
   ]
  },
  "T1499": {
   "name": "Endpoint Denial of Service",
   "tactics": [
    {
     "id": "TA0040",
     "name": "Impacto"
    }
   ]
  },
  "T1505.003": {
   "name": "Server Software Component: Web Shell",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    }
   ]
  },
  "T1528": {
   "name": "Steal Application Access Token",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1530": {
   "name": "Data from Cloud Storage",
   "tactics": [
    {
     "id": "TA0009",
     "name": "Recolección"
    }
   ]
  },
  "T1535": {
   "name": "Unused/Unsupported Cloud Regions",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1537": {
   "name": "Transfer Data to Cloud Account",
   "tactics": [
    {
     "id": "TA0010",
     "name": "Exfiltración"
    }
   ]
  },
  "T1543.002": {
   "name": "Create or Modify System Process: Systemd Service",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1543.003": {
   "name": "Create or Modify System Process: Windows Service",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1547": {
   "name": "Boot or Logon Autostart Execution",
   "tactics": [
    {
     "id": "TA0003",
     "name": "Persistencia"
    },
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    }
   ]
  },
  "T1548": {
   "name": "Abuse Elevation Control Mechanism",
   "tactics": [
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    },
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1548.003": {
   "name": "Abuse Elevation Control Mechanism: Sudo and Sudo Caching",
   "tactics": [
    {
     "id": "TA0004",
     "name": "Escalada de privilegios"
    },
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1556": {
   "name": "Modify Authentication Process",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    },
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    }
   ]
  },
  "T1556.003": {
   "name": "Modify Authentication Process: Pluggable Authentication Modules",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    },
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    }
   ]
  },
  "T1556.006": {
   "name": "Modify Authentication Process: Multi-Factor Authentication",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    },
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    }
   ]
  },
  "T1556.009": {
   "name": "Modify Authentication Process: Conditional Access Policies",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    },
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0003",
     "name": "Persistencia"
    }
   ]
  },
  "T1558.003": {
   "name": "Steal or Forge Kerberos Tickets: Kerberoasting",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1558.004": {
   "name": "Steal or Forge Kerberos Tickets: AS-REP Roasting",
   "tactics": [
    {
     "id": "TA0006",
     "name": "Acceso a credenciales"
    }
   ]
  },
  "T1562": {
   "name": "Impair Defenses",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1562.001": {
   "name": "Impair Defenses: Disable or Modify Tools",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1562.002": {
   "name": "Impair Defenses: Disable Windows Event Logging",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1562.007": {
   "name": "Impair Defenses: Disable or Modify Cloud Firewall",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1562.008": {
   "name": "Impair Defenses: Disable or Modify Cloud Logs",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1564.008": {
   "name": "Hide Artifacts: Email Hiding Rules",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1565.001": {
   "name": "Data Manipulation: Stored Data Manipulation",
   "tactics": [
    {
     "id": "TA0040",
     "name": "Impacto"
    }
   ]
  },
  "T1567": {
   "name": "Exfiltration Over Web Service",
   "tactics": [
    {
     "id": "TA0010",
     "name": "Exfiltración"
    }
   ]
  },
  "T1571": {
   "name": "Non-Standard Port",
   "tactics": [
    {
     "id": "TA0011",
     "name": "Comando y control"
    }
   ]
  },
  "T1572": {
   "name": "Protocol Tunneling",
   "tactics": [
    {
     "id": "TA0011",
     "name": "Comando y control"
    }
   ]
  },
  "T1584.002": {
   "name": "Compromise Infrastructure: DNS Server",
   "tactics": [
    {
     "id": "TA0042",
     "name": "Desarrollo de recursos"
    }
   ]
  },
  "T1595": {
   "name": "Active Scanning",
   "tactics": [
    {
     "id": "TA0043",
     "name": "Reconocimiento"
    }
   ]
  },
  "T1595.002": {
   "name": "Active Scanning: Vulnerability Scanning",
   "tactics": [
    {
     "id": "TA0043",
     "name": "Reconocimiento"
    }
   ]
  },
  "T1595.003": {
   "name": "Active Scanning: Wordlist Scanning",
   "tactics": [
    {
     "id": "TA0043",
     "name": "Reconocimiento"
    }
   ]
  },
  "T1599": {
   "name": "Network Boundary Bridging",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    }
   ]
  },
  "T1609": {
   "name": "Container Administration Command",
   "tactics": [
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  },
  "T1610": {
   "name": "Deploy Container",
   "tactics": [
    {
     "id": "TA0005",
     "name": "Evasión de defensas"
    },
    {
     "id": "TA0002",
     "name": "Ejecución"
    }
   ]
  }
 }
};
