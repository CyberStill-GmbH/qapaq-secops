# QAPAQ SOC · Cobertura MITRE ATT&CK

> Generado por `python3 detections/tools/qapaq_detections.py coverage` con el ruleset oficial de Wazuh 4.14.8 (`--official`). No editar a mano. Fuente: el XML de las reglas QAPAQ (`<mitre><id>`), no las intenciones.

## Resumen

| Métrica | Antes del programa | Con el programa |
| --- | ---: | ---: |
| Reglas QAPAQ | 137 | 161 |
| Reglas con técnica MITRE | 93 | 117 |
| Técnicas y subtécnicas cubiertas | 49 | 60 |
| Técnicas padre cubiertas | 32 | 33 |
| Tácticas con al menos una técnica | 12/14 | 13/14 |

Técnicas nuevas con el programa: `T1021.004`, `T1053.003`, `T1053.006`, `T1078.003`, `T1098.004`, `T1098.005`, `T1543.002`, `T1548`, `T1556`, `T1556.003`, `T1595.002`.

## Matriz por táctica

| Táctica | Técnicas | Detalle (técnica → reglas QAPAQ) |
| --- | ---: | --- |
| Reconocimiento (TA0043) | 2 | `T1595` Active Scanning → 101513<br>`T1595.002` Active Scanning: Vulnerability Scanning → 101740 |
| Desarrollo de recursos (TA0042) | 1 | `T1584.002` Compromise Infrastructure: DNS Server → 101503 |
| Acceso inicial (TA0001) | 4 | `T1078.003` Valid Accounts: Local Accounts → 101750<br>`T1078.004` Valid Accounts: Cloud Accounts → 100505, 100530, 101205, 101605, 101606, 101609, 101700, 101703 …<br>`T1190` Exploit Public-Facing Application → 101455, 101456, 101457, 101458, 101513, 101730, 101731, 101740<br>`T1195` Supply Chain Compromise → 101218 |
| Ejecución (TA0002) | 7 | `T1053.003` Scheduled Task/Job: Cron → 101757<br>`T1053.005` Scheduled Task/Job: Scheduled Task → 101211<br>`T1053.006` Scheduled Task/Job: Systemd Timers → 101756<br>`T1059` Command and Scripting Interpreter → 101201, 101219<br>`T1059.001` Command and Scripting Interpreter: PowerShell → 101210<br>`T1204` User Execution → 101201, 101219, 101402, 101403, 101410, 101411, 101720, 101722 …<br>`T1204.002` User Execution: Malicious File → 101100 |
| Persistencia (TA0003) | 20 | `T1053.003` Scheduled Task/Job: Cron → 101757<br>`T1053.005` Scheduled Task/Job: Scheduled Task → 101211<br>`T1053.006` Scheduled Task/Job: Systemd Timers → 101756<br>`T1078.003` Valid Accounts: Local Accounts → 101750<br>`T1078.004` Valid Accounts: Cloud Accounts → 100505, 100530, 101205, 101605, 101606, 101609, 101700, 101703 …<br>`T1098` Account Manipulation → 101506, 101630, 101631, 101633<br>`T1098.001` Account Manipulation: Additional Cloud Credentials → 100523<br>`T1098.002` Account Manipulation: Additional Email Delegate Permissions → 100513<br>`T1098.003` Account Manipulation: Additional Cloud Roles → 100520, 100521, 101206, 101632, 101634, 101700, 101704, 101710<br>`T1098.004` Account Manipulation: SSH Authorized Keys → 101755<br>`T1098.005` Account Manipulation: Device Registration → 101701<br>`T1098.007` Account Manipulation: Additional Local or Domain Groups → 101207, 101300, 101752<br>`T1136.003` Create Account: Cloud Account → 101631<br>`T1543.002` Create or Modify System Process: Systemd Service → 101756<br>`T1543.003` Create or Modify System Process: Windows Service → 101211<br>`T1547` Boot or Logon Autostart Execution → 101212<br>`T1556` Modify Authentication Process → 101760<br>`T1556.003` Modify Authentication Process: Pluggable Authentication Modules → 101759<br>`T1556.006` Modify Authentication Process: Multi-Factor Authentication → 100526, 101701<br>`T1556.009` Modify Authentication Process: Conditional Access Policies → 100525 |
| Escalada de privilegios (TA0004) | 20 | `T1053.003` Scheduled Task/Job: Cron → 101757<br>`T1053.005` Scheduled Task/Job: Scheduled Task → 101211<br>`T1053.006` Scheduled Task/Job: Systemd Timers → 101756<br>`T1078.003` Valid Accounts: Local Accounts → 101750<br>`T1078.004` Valid Accounts: Cloud Accounts → 100505, 100530, 101205, 101605, 101606, 101609, 101700, 101703 …<br>`T1098` Account Manipulation → 101506, 101630, 101631, 101633<br>`T1098.001` Account Manipulation: Additional Cloud Credentials → 100523<br>`T1098.002` Account Manipulation: Additional Email Delegate Permissions → 100513<br>`T1098.003` Account Manipulation: Additional Cloud Roles → 100520, 100521, 101206, 101632, 101634, 101700, 101704, 101710<br>`T1098.004` Account Manipulation: SSH Authorized Keys → 101755<br>`T1098.005` Account Manipulation: Device Registration → 101701<br>`T1098.007` Account Manipulation: Additional Local or Domain Groups → 101207, 101300, 101752<br>`T1484` Domain or Tenant Policy Modification → 101635, 101636<br>`T1484.001` Domain or Tenant Policy Modification: Group Policy Modification → 101303<br>`T1484.002` Domain or Tenant Policy Modification: Trust Modification → 100524<br>`T1543.002` Create or Modify System Process: Systemd Service → 101756<br>`T1543.003` Create or Modify System Process: Windows Service → 101211<br>`T1547` Boot or Logon Autostart Execution → 101212<br>`T1548` Abuse Elevation Control Mechanism → 101752<br>`T1548.003` Abuse Elevation Control Mechanism: Sudo and Sudo Caching → 101214, 101758 |
| Evasión de defensas (TA0005) | 21 | `T1027` Obfuscated Files or Information → 101210<br>`T1070.001` Indicator Removal: Clear Windows Event Logs → 101208, 101302<br>`T1078.003` Valid Accounts: Local Accounts → 101750<br>`T1078.004` Valid Accounts: Cloud Accounts → 100505, 100530, 101205, 101605, 101606, 101609, 101700, 101703 …<br>`T1484` Domain or Tenant Policy Modification → 101635, 101636<br>`T1484.001` Domain or Tenant Policy Modification: Group Policy Modification → 101303<br>`T1484.002` Domain or Tenant Policy Modification: Trust Modification → 100524<br>`T1535` Unused/Unsupported Cloud Regions → 101611, 101612<br>`T1548` Abuse Elevation Control Mechanism → 101752<br>`T1548.003` Abuse Elevation Control Mechanism: Sudo and Sudo Caching → 101214, 101758<br>`T1556` Modify Authentication Process → 101760<br>`T1556.003` Modify Authentication Process: Pluggable Authentication Modules → 101759<br>`T1556.006` Modify Authentication Process: Multi-Factor Authentication → 100526, 101701<br>`T1556.009` Modify Authentication Process: Conditional Access Policies → 100525<br>`T1562` Impair Defenses → 101202, 101504, 101636<br>`T1562.001` Impair Defenses: Disable or Modify Tools → 101209, 101405, 101406, 101622, 101623, 101624, 101625, 101712 …<br>`T1562.002` Impair Defenses: Disable Windows Event Logging → 101301<br>`T1562.007` Impair Defenses: Disable or Modify Cloud Firewall → 101216, 101505, 101640, 101641, 101642<br>`T1562.008` Impair Defenses: Disable or Modify Cloud Logs → 100527, 100528, 101615, 101620, 101621, 101644, 101710, 101711 …<br>`T1564.008` Hide Artifacts: Email Hiding Rules → 100510, 100511, 101702<br>`T1599` Network Boundary Bridging → 101643 |
| Acceso a credenciales (TA0006) | 11 | `T1003.006` OS Credential Dumping: DCSync → 101306<br>`T1110` Brute Force → 100505, 101607<br>`T1110.001` Brute Force: Password Guessing → 100503, 101213, 101608, 101713, 101750<br>`T1110.003` Brute Force: Password Spraying → 100504, 101307, 101703<br>`T1528` Steal Application Access Token → 100522<br>`T1556` Modify Authentication Process → 101760<br>`T1556.003` Modify Authentication Process: Pluggable Authentication Modules → 101759<br>`T1556.006` Modify Authentication Process: Multi-Factor Authentication → 100526, 101701<br>`T1556.009` Modify Authentication Process: Conditional Access Policies → 100525<br>`T1558.003` Steal or Forge Kerberos Tickets: Kerberoasting → 101304<br>`T1558.004` Steal or Forge Kerberos Tickets: AS-REP Roasting → 101305 |
| Descubrimiento (TA0007) | 0 | — |
| Movimiento lateral (TA0008) | 1 | `T1021.004` Remote Services: SSH → 101750, 101760 |
| Recolección (TA0009) | 3 | `T1114` Email Collection → 100529<br>`T1114.003` Email Collection: Email Forwarding Rule → 100510, 100512, 100514, 101702<br>`T1530` Data from Cloud Storage → 101650, 101651, 101652 |
| Comando y control (TA0011) | 1 | `T1071` Application Layer Protocol → 101203 |
| Exfiltración (TA0010) | 2 | `T1537` Transfer Data to Cloud Account → 101645<br>`T1567` Exfiltration Over Web Service → 100515 |
| Impacto (TA0040) | 2 | `T1485` Data Destruction → 101507, 101656, 101657<br>`T1496` Resource Hijacking → 101612 |

## Brechas priorizadas para el entorno QAPAQ

Prioridad según el entorno (M365/Entra, AWS, Linux, Windows/AD, SaaS). «Parcial» = solo la técnica padre o
una subtécnica hermana. «Bloqueo» dice qué hace falta para cerrarla (ver backlog en docs/17).

| Prioridad | Cubiertas | Parciales | Brechas |
| --- | ---: | ---: | ---: |
| Alta | 20 | 0 | 8 |
| Media | 14 | 1 | 10 |
| Baja | 3 | 0 | 4 |

| Prio. | Técnica | Estado | Entorno | Reglas QAPAQ | Reglas oficiales | Bloqueo | Datos necesarios |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| Alta | `T1003.001` OS Credential Dumping: LSASS Memory | brecha | windows | — | 1 | Agentes en endpoints | Sysmon 10 sobre lsass |
| Alta | `T1003.006` OS Credential Dumping: DCSync | cubierta | ad | 101306 | 0 | Agentes en endpoints | 4662 en DC |
| Alta | `T1059.001` Command and Scripting Interpreter: PowerShell | cubierta | windows | 101210 | 19 | Agentes en endpoints | PowerShell 4104 (opt-in con gate de privacidad) |
| Alta | `T1078.004` Valid Accounts: Cloud Accounts | cubierta | m365, entra, aws | 100505, 100530, 101205, 101605, 101606, 101609 | 6 | Hay datos hoy | Sign-ins de Entra/O365 y ConsoleLogin de AWS |
| Alta | `T1098.001` Account Manipulation: Additional Cloud Credentials | cubierta | entra, aws | 100523 | 4 | Hay datos hoy | Credenciales en app/SP (O365) y CreateAccessKey (AWS) |
| Alta | `T1098.003` Account Manipulation: Additional Cloud Roles | cubierta | entra, aws | 100520, 100521, 101206, 101632, 101634, 101700 | 6 | Hay datos hoy | Add member to role (O365) y IAM/Identity Center (AWS) |
| Alta | `T1098.004` Account Manipulation: SSH Authorized Keys | cubierta | linux | 101755 | 0 | Hay datos hoy | FIM realtime /root/.ssh |
| Alta | `T1110.001` Brute Force: Password Guessing | cubierta | m365, linux, aws | 100503, 101213, 101608, 101713, 101750 | 5 | Hay datos hoy | sshd del agente 001; ConsoleLogin AWS |
| Alta | `T1110.003` Brute Force: Password Spraying | cubierta | m365, entra | 100504, 101307, 101703 | 0 | Permiso de Entra | UserLoginFailed (Audit.AzureActiveDirectory); hoy bloqueado por ActivityFeed.Read |
| Alta | `T1114.003` Email Collection: Email Forwarding Rule | cubierta | m365 | 100510, 100512, 100514, 101702 | 2 | Hay datos hoy | Reglas de bandeja/transporte |
| Alta | `T1136.003` Create Account: Cloud Account | cubierta | aws, entra | 101631 | 1 | Hay datos hoy | CreateUser IAM; Add user (Entra) |
| Alta | `T1190` Exploit Public-Facing Application | cubierta | saas, aws | 101455, 101456, 101457, 101458, 101513, 101730 | 18 | Hay datos hoy | Snyk + WAF de Cloudflare |
| Alta | `T1204.002` User Execution: Malicious File | cubierta | windows | 101100 | 7 | Agentes en endpoints | Sysmon 1 en estaciones (grupo windows-telemetry-extended, gate de privacidad) |
| Alta | `T1484.002` Domain or Tenant Policy Modification: Trust Modification | cubierta | entra | 100524 | 0 | Hay datos hoy | Federación de dominio |
| Alta | `T1486` Data Encrypted for Impact | brecha | windows, linux | — | 2 | Agentes en endpoints | EDR (Bitdefender) + FIM de alto volumen |
| Alta | `T1490` Inhibit System Recovery | brecha | windows, aws | — | 0 | Agentes en endpoints | vssadmin/wbadmin (Sysmon 1); DeleteSnapshot/DeleteBackupVault en AWS |
| Alta | `T1528` Steal Application Access Token | cubierta | entra | 100522 | 0 | Hay datos hoy | Consent to application (O365) |
| Alta | `T1539` Steal Web Session Cookie | brecha | entra | — | 0 | Permiso de Entra | Reuso de token/sesión: Identity Protection (anomalousToken) |
| Alta | `T1548.003` Abuse Elevation Control Mechanism: Sudo and Sudo Caching | cubierta | linux | 101214, 101758 | 9 | Hay datos hoy | sudo y FIM de sudoers.d |
| Alta | `T1556.006` Modify Authentication Process: Multi-Factor Authentication | cubierta | entra | 100526, 101701 | 2 | Hay datos hoy | User registered security info |
| Alta | `T1556.009` Modify Authentication Process: Conditional Access Policies | cubierta | entra | 100525 | 0 | Hay datos hoy | Cambios de Conditional Access |
| Alta | `T1557` Adversary-in-the-Middle | brecha | entra | — | 0 | Permiso de Entra | Riesgo de sign-in (Identity Protection, P2) y token issuer anómalo |
| Alta | `T1562.001` Impair Defenses: Disable or Modify Tools | cubierta | aws, windows | 101209, 101405, 101406, 101622, 101623, 101624 | 16 | Hay datos hoy | GuardDuty/Config/SecurityHub; Bitdefender antimalware |
| Alta | `T1562.008` Impair Defenses: Disable or Modify Cloud Logs | cubierta | aws, m365 | 100527, 100528, 101615, 101620, 101621, 101644 | 3 | Hay datos hoy | StopLogging/DeleteTrail; Set-AdminAuditLogConfig |
| Alta | `T1564.008` Hide Artifacts: Email Hiding Rules | cubierta | m365 | 100510, 100511, 101702 | 0 | Hay datos hoy | Reglas de ocultación |
| Alta | `T1566.001` Phishing: Spearphishing Attachment | brecha | m365 | — | 0 | Presupuesto/licencia | Defender for Office 365 P2 |
| Alta | `T1566.002` Phishing: Spearphishing Link | brecha | m365 | — | 0 | Presupuesto/licencia | Defender for Office 365 (AlertInfo/ClickEvents) requiere licencia P2 |
| Alta | `T1621` Multi-Factor Authentication Request Generation | brecha | entra | — | 0 | Permiso de Entra | Logs de sign-in de Entra (Graph AuditLog.Read.All); el feed de O365 no trae la denegación MFA |
| Media | `T1021.001` Remote Services: Remote Desktop Protocol | brecha | windows | — | 8 | Agentes en endpoints | 4624 tipo 10 |
| Media | `T1021.004` Remote Services: SSH | cubierta | linux | 101750, 101760 | 8 | Hay datos hoy | sshd |
| Media | `T1053.003` Scheduled Task/Job: Cron | cubierta | linux | 101757 | 1 | Hay datos hoy | FIM realtime de cron |
| Media | `T1070.001` Indicator Removal: Clear Windows Event Logs | cubierta | windows, ad | 101208, 101302 | 2 | Agentes en endpoints | 1102 |
| Media | `T1087.004` Account Discovery: Cloud Account | brecha | entra, aws | — | 0 | Presupuesto/licencia | Lecturas masivas de Graph/IAM (read-only) |
| Media | `T1098.007` Account Manipulation: Additional Local or Domain Groups | cubierta | linux, ad | 101207, 101300, 101752 | 0 | Hay datos hoy | gpasswd y 4728/4732/4756 |
| Media | `T1195.001` Supply Chain Compromise: Compromise Software Dependencies and Development Tools | parcial | saas | — | 0 | Hay datos hoy | Snyk (paquetes maliciosos) |
| Media | `T1213.002` Data from Information Repositories: Sharepoint | brecha | m365 | — | 4 | Permiso de Entra | Audit.SharePoint (FileAccessed masivo) |
| Media | `T1219` Remote Access Software | brecha | windows | — | 0 | Agentes en endpoints | Inventario de software (syscollector) + Sysmon 3 |
| Media | `T1484.001` Domain or Tenant Policy Modification: Group Policy Modification | cubierta | ad | 101303 | 8 | Agentes en endpoints | 5136 GPO |
| Media | `T1496` Resource Hijacking | cubierta | aws | 101612 | 0 | Hay datos hoy | RunInstances en región no habitual, GuardDuty CryptoCurrency |
| Media | `T1505.003` Server Software Component: Web Shell | brecha | linux | — | 4 | Configuración | FIM de raíces web (no hay servidores web con agente aún) |
| Media | `T1530` Data from Cloud Storage | cubierta | aws, m365 | 101650, 101651, 101652 | 6 | Presupuesto/licencia | S3 data events (costo CloudTrail) y FileDownloaded de SharePoint |
| Media | `T1535` Unused/Unsupported Cloud Regions | cubierta | aws | 101611, 101612 | 0 | Hay datos hoy | Región no habitual |
| Media | `T1537` Transfer Data to Cloud Account | cubierta | aws | 101645 | 1 | Hay datos hoy | ModifySnapshotAttribute/PutBucketPolicy |
| Media | `T1543.002` Create or Modify System Process: Systemd Service | cubierta | linux | 101756 | 0 | Hay datos hoy | FIM realtime de systemd/system |
| Media | `T1552.005` Unsecured Credentials: Cloud Instance Metadata API | brecha | aws | — | 0 | Hay datos hoy | GuardDuty InstanceCredentialExfiltration |
| Media | `T1556.003` Modify Authentication Process: Pluggable Authentication Modules | cubierta | linux | 101759 | 0 | Hay datos hoy | FIM realtime de pam.d |
| Media | `T1558.003` Steal or Forge Kerberos Tickets: Kerberoasting | cubierta | ad | 101304 | 0 | Agentes en endpoints | 4769 RC4 en DC |
| Media | `T1562.007` Impair Defenses: Disable or Modify Cloud Firewall | cubierta | aws, saas | 101216, 101505, 101640, 101641, 101642 | 3 | Hay datos hoy | Security groups y WAF de Cloudflare |
| Media | `T1567` Exfiltration Over Web Service | cubierta | m365 | 100515 | 1 | Hay datos hoy | AnonymousLinkCreated |
| Media | `T1580` Cloud Infrastructure Discovery | brecha | aws | — | 0 | Presupuesto/licencia | Volumen de Describe*/List* (eventos read-only en CloudTrail: costo) |
| Media | `T1609` Container Administration Command | brecha | linux | — | 0 | Configuración | Auditoría de docker exec (auditd en el nodo) |
| Media | `T1610` Deploy Container | brecha | linux | — | 0 | Configuración | Eventos del daemon de Docker |
| Media | `T1611` Escape to Host | brecha | linux | — | 0 | Configuración | auditd + Falco/Tetragon (presupuesto de tiempo) |
| Baja | `T1485` Data Destruction | cubierta | aws, saas | 101507, 101656, 101657 | 11 | Hay datos hoy | DeleteBucket/DeleteZone |
| Baja | `T1498` Network Denial of Service | brecha | saas | — | 15 | Presupuesto/licencia | Analytics DDoS de Cloudflare (plan Enterprise para logs completos) |
| Baja | `T1531` Account Access Removal | brecha | entra, linux | — | 25 | Hay datos hoy | Borrado de usuarios |
| Baja | `T1584.002` Compromise Infrastructure: DNS Server | cubierta | saas | 101503 | 3 | Hay datos hoy | Auditoría DNS de Cloudflare |
| Baja | `T1595.002` Active Scanning: Vulnerability Scanning | cubierta | saas | 101740 | 2 | Hay datos hoy | WAF de Cloudflare |
| Baja | `T1648` Serverless Execution | brecha | aws | — | 0 | Hay datos hoy | CreateFunction/UpdateFunctionCode |
| Baja | `T1651` Cloud Administration Command | brecha | aws | — | 0 | Hay datos hoy | ssm:SendCommand |

## Reglas por técnica

| Técnica | Reglas QAPAQ (nivel) |
| --- | --- |
| `T1003.006` OS Credential Dumping: DCSync | 101306 (6) |
| `T1021.004` Remote Services: SSH | 101750 (13), 101760 (10) |
| `T1027` Obfuscated Files or Information | 101210 (10) |
| `T1053.003` Scheduled Task/Job: Cron | 101757 (10) |
| `T1053.005` Scheduled Task/Job: Scheduled Task | 101211 (10) |
| `T1053.006` Scheduled Task/Job: Systemd Timers | 101756 (10) |
| `T1059` Command and Scripting Interpreter | 101201 (15), 101219 (13) |
| `T1059.001` Command and Scripting Interpreter: PowerShell | 101210 (10) |
| `T1070.001` Indicator Removal: Clear Windows Event Logs | 101208 (14), 101302 (13) |
| `T1071` Application Layer Protocol | 101203 (13) |
| `T1078.003` Valid Accounts: Local Accounts | 101750 (13) |
| `T1078.004` Valid Accounts: Cloud Accounts | 100505 (13), 100530 (14), 101205 (13), 101605 (13), 101606 (12), 101609 (8), 101700 (15), 101703 (13), 101711 (15), 101713 (13) |
| `T1098` Account Manipulation | 101506 (10), 101630 (8), 101631 (10), 101633 (8) |
| `T1098.001` Account Manipulation: Additional Cloud Credentials | 100523 (10) |
| `T1098.002` Account Manipulation: Additional Email Delegate Permissions | 100513 (10) |
| `T1098.003` Account Manipulation: Additional Cloud Roles | 100520 (13), 100521 (9), 101206 (13), 101632 (12), 101634 (10), 101700 (15), 101704 (14), 101710 (15) |
| `T1098.004` Account Manipulation: SSH Authorized Keys | 101755 (12) |
| `T1098.005` Account Manipulation: Device Registration | 101701 (14) |
| `T1098.007` Account Manipulation: Additional Local or Domain Groups | 101207 (13), 101300 (12), 101752 (10) |
| `T1110` Brute Force | 100505 (13), 101607 (5) |
| `T1110.001` Brute Force: Password Guessing | 100503 (10), 101213 (12), 101608 (10), 101713 (13), 101750 (13) |
| `T1110.003` Brute Force: Password Spraying | 100504 (12), 101307 (6), 101703 (13) |
| `T1114` Email Collection | 100529 (12) |
| `T1114.003` Email Collection: Email Forwarding Rule | 100510 (12), 100512 (12), 100514 (11), 101702 (14) |
| `T1136.003` Create Account: Cloud Account | 101631 (10) |
| `T1190` Exploit Public-Facing Application | 101455 (10), 101456 (12), 101457 (13), 101458 (11), 101513 (10), 101730 (14), 101731 (12), 101740 (12) |
| `T1195` Supply Chain Compromise | 101218 (11) |
| `T1204` User Execution | 101201 (15), 101219 (13), 101402 (12), 101403 (10), 101410 (10), 101411 (13), 101720 (14), 101722 (15), 101723 (14) |
| `T1204.002` User Execution: Malicious File | 101100 (8) |
| `T1484` Domain or Tenant Policy Modification | 101635 (10), 101636 (12) |
| `T1484.001` Domain or Tenant Policy Modification: Group Policy Modification | 101303 (10) |
| `T1484.002` Domain or Tenant Policy Modification: Trust Modification | 100524 (14) |
| `T1485` Data Destruction | 101507 (12), 101656 (10), 101657 (12) |
| `T1496` Resource Hijacking | 101612 (12) |
| `T1528` Steal Application Access Token | 100522 (10) |
| `T1530` Data from Cloud Storage | 101650 (8), 101651 (10), 101652 (10) |
| `T1535` Unused/Unsupported Cloud Regions | 101611 (10), 101612 (12) |
| `T1537` Transfer Data to Cloud Account | 101645 (10) |
| `T1543.002` Create or Modify System Process: Systemd Service | 101756 (10) |
| `T1543.003` Create or Modify System Process: Windows Service | 101211 (10) |
| `T1547` Boot or Logon Autostart Execution | 101212 (9) |
| `T1548` Abuse Elevation Control Mechanism | 101752 (10) |
| `T1548.003` Abuse Elevation Control Mechanism: Sudo and Sudo Caching | 101214 (9), 101758 (12) |
| `T1556` Modify Authentication Process | 101760 (10) |
| `T1556.003` Modify Authentication Process: Pluggable Authentication Modules | 101759 (12) |
| `T1556.006` Modify Authentication Process: Multi-Factor Authentication | 100526 (8), 101701 (14) |
| `T1556.009` Modify Authentication Process: Conditional Access Policies | 100525 (10) |
| `T1558.003` Steal or Forge Kerberos Tickets: Kerberoasting | 101304 (5) |
| `T1558.004` Steal or Forge Kerberos Tickets: AS-REP Roasting | 101305 (7) |
| `T1562` Impair Defenses | 101202 (14), 101504 (8), 101636 (12) |
| `T1562.001` Impair Defenses: Disable or Modify Tools | 101209 (13), 101405 (10), 101406 (7), 101622 (12), 101623 (12), 101624 (12), 101625 (10), 101712 (15), 101720 (14), 101721 (14), 101722 (15), 101723 (14) |
| `T1562.002` Impair Defenses: Disable Windows Event Logging | 101301 (12) |
| `T1562.007` Impair Defenses: Disable or Modify Cloud Firewall | 101216 (14), 101505 (10), 101640 (8), 101641 (10), 101642 (8) |
| `T1562.008` Impair Defenses: Disable or Modify Cloud Logs | 100527 (14), 100528 (12), 101615 (12), 101620 (13), 101621 (10), 101644 (10), 101710 (15), 101711 (15), 101712 (15) |
| `T1564.008` Hide Artifacts: Email Hiding Rules | 100510 (12), 100511 (8), 101702 (14) |
| `T1567` Exfiltration Over Web Service | 100515 (7) |
| `T1584.002` Compromise Infrastructure: DNS Server | 101503 (5) |
| `T1595` Active Scanning | 101513 (10) |
| `T1595.002` Active Scanning: Vulnerability Scanning | 101740 (12) |
| `T1599` Network Boundary Bridging | 101643 (8) |
