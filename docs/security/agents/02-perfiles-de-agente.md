# Perfiles de agente por clase de activo

**Estado:** candidatos. Validados con `verify-agent-conf` de Wazuh 4.14.8 en CI; no están
instalados en el manager ni observados en equipos reales de QAPAQ. Cada perfil se activa con un
piloto (ver [04-despliegue.md](04-despliegue.md) §6).

Archivos: `infra/wazuh/agents/shared/<grupo>/agent.conf` (misma estructura que
`/var/ossec/etc/shared/` del manager) y catálogo `infra/wazuh/agents/profile-catalog.json`.

## 1. Principios de diseño

1. **Un agente, un perfil.** Cada grupo es autocontenido. Wazuh no fusiona dos `<localfile>`
   sobre el mismo canal; con grupos superpuestos un canal podría duplicarse (doble costo) o
   quedar con la consulta equivocada. La prueba `test_each_os_block_has_one_localfile_per_location`
   lo impide.
2. **Canales con consulta cerrada.** Ningún canal de Windows va sin XPath. Se recoge lo que una
   regla consume o lo que una investigación necesita; el resto se queda en el equipo.
3. **Los canales los define el grupo, no el ossec.conf local.** El instalador retira los
   `eventchannel` por defecto del agente (Application, Security, System sin filtro). En Linux se
   conserva el ossec.conf por defecto porque ya elige el log de autenticación correcto por
   distribución (`/var/log/auth.log` o `/var/log/secure`, journald).
4. **Monitor-only.** `active-response` deshabilitado en todos los perfiles y `remote_commands=0`
   en `local_internal_options.conf`: ningún `agent.conf` puede ordenar ejecutar comandos.
5. **Privacidad (Ley 29733).** Sin inventario de procesos (puede revelar actividad personal),
   sin `report_changes` sobre archivos que pueden guardar credenciales, y Sysmon Event 1
   (línea de comandos) sujeto a aprobación de retención.

## 2. Resumen por perfil

| Grupo | Activo | Lista CDB | Security | PowerShell 4104 | Sysmon | Application | Otros | EPS estimado* |
|---|---|---|---|---|---|---|---|---|
| `qapaq-dc` | Controladores de dominio (tier 0) | `critical-assets:dc` | Conjunto DC | Completo | Completo | Sophos | SYSVOL en FIM | 5–30 |
| `qapaq-srv-core` | Core financiero y créditos | `critical-assets:core` | Servidor | Warning | Completo | Sophos | auditd (Linux) | 1–8 |
| `qapaq-srv-db` | Bases de datos | `critical-assets:db` | Servidor | Warning | Completo | Sophos + SQL 18456/33205 | PostgreSQL, auditd | 1–8 |
| `qapaq-srv-web` | Web y expuestos | `internet-facing` | Servidor | Warning | Completo | Sophos | IIS / nginx / Apache | 3–40 |
| `qapaq-ws-sensitive` | Tesorería, operaciones, créditos, TI privilegiado | `sensitive-workstations` | Estación + 4648 + USB 6416 | Completo | Completo | Sophos | `C:\Users\Public` | 0,3–2 |
| `qapaq-ws-general` | Estaciones generales | — | Estación | Warning | Sin red | Sophos | — | 0,1–0,8 |
| `qapaq-linux-server` | Linux general | — | — | — | — | — | auditd + auth por defecto | 0,5–5 |
| `qapaq-laptop-remote` | Portátiles fuera de la red | — | Estación | Warning | Sin red | Sophos | buffer 20 000 | 0,1–0,8 |

\* Estimaciones para dimensionar, no mediciones. Se reemplazan por el EPS medido en el piloto
(`/var/ossec/var/run/wazuh-logcollector.state` y `wazuh-agentd.state`; ver
[05-operacion.md](05-operacion.md) §3). El costo de ingesta del SIEM es proporcional al EPS que
llega al indexer: las estaciones generales son pocas EPS por equipo pero muchos equipos, por eso
llevan el perfil más estrecho.

## 3. Justificación de cada canal

### Windows Security

| Conjunto | Eventos | Por qué |
|---|---|---|
| **DC** | 1102, 4625, 4697, 4698, 4706/4707 (confianzas), 4713 (política Kerberos), 4719, 4739 (política de dominio), 4771, 4780 (AdminSDHolder), 4794 (DSRM), 4720–4767 (cuentas, grupos, bloqueo 4740, SID history), 5136–5141 (cambios de directorio) | Reglas QAPAQ 101300–101307 y oficiales 601xx. Cambios de directorio y confianzas son la superficie de persistencia de dominio. |
| | 4624 solo tipo 2 (interactivo) y 10 (RDP) | Tiering (regla 101606). El tipo 3 (red) es el mayor volumen de un DC y no tiene consumidor. |
| | 4662 solo con `AccessMask=0x100` | DCSync (101306/101603). Sin el filtro, 4662 es inmanejable. |
| | 4768 solo `PreAuthType=0`; 4769 solo `TicketEncryptionType=0x17` | AS-REP roasting (101305/101605) y RC4/Kerberoasting (101304). Cada inicio de sesión del dominio genera 4768/4769: sin filtro serían la mitad del volumen. |
| **Servidor** | 1102, 4625, 4648, 4697, 4698, 4702, 4719, 4720, 4722, 4724, 4726, 4732, 4738, 4740 + 4624 tipos 2/10 | Cuentas y grupos locales, servicios y tareas nuevas, credenciales explícitas (movimiento lateral). |
| **Estación sensible** | Servidor + 6416 | 6416 (dispositivo externo) para fuga por USB en tesorería y créditos. |
| **Estación general / portátil** | Servidor sin 4648 | 4648 es ruidoso en estaciones (unidades mapeadas, RunAs) y su valor está en servidores. |

Excluidos a propósito en todos: 4634/4647 (cierre de sesión), 4656/4658/4663 (handles), 5156/5158
(filtrado WFP), 4672 (privilegios especiales en cada logon de servicio), 4688 (lo cubre Sysmon 1
con más contexto).

Requisito: la **política de auditoría avanzada** por GPO debe generar estos eventos (detalle en
[04-despliegue.md](04-despliegue.md) §2). Sin ella, el canal llega vacío y la detección no existe
aunque la regla esté.

### Windows System

7045 (servicio instalado), 7040 (tipo de inicio cambiado: desactivar Sophos o el agente), 104 (log
System borrado). El resto del canal es operativo y no tiene consumidor de seguridad.

### PowerShell/Operational (4104)

- **Completo** en DC y estaciones sensibles: script blocks de quien administra el dominio o
  mueve dinero. Requiere GPO *Turn on PowerShell Script Block Logging*.
- **Solo nivel Warning** en el resto: Windows marca como Warning los bloques con contenido
  sospechoso aunque el registro completo esté apagado. Captura lo relevante a una fracción del
  volumen.

### Sysmon

Configuración en `infra/wazuh/agents/deploy/windows/sysmon/qapaq-sysmon.xml` (los eventos de alto
volumen son por inclusión). El agente filtra además por Event ID para que una configuración
Sysmon local distinta no dispare el costo:

- **Completo** (servidores, DC, estaciones sensibles): 1, 3, 8, 10, 11, 12, 13, 25.
- **Sin red** (estaciones generales y portátiles): 1, 8, 10, 11, 13, 25. La red de estaciones la
  ve Cato.
- Siempre fuera: 7 (carga de imagen, volumen) y 22 (DNS, lo cubre Cato).

### Application

Solo eventos de error/aviso de los proveedores Sophos locales: si un atacante corta la
comunicación con Sophos Central, la evidencia local llega igual. Las alertas principales de
Sophos entran por la API de Sophos Central (`infra/wazuh/launch-detections`). En bases de datos
SQL Server se añaden 18456 (login fallido) y 33205 (SQL Audit). Los nombres de proveedor Sophos
y la instancia SQL (`MSSQLSERVER` o `MSSQL$<instancia>`) se confirman en el piloto (cuestionario
S5 y S6).

### Linux

`/var/log/audit/audit.log` con las reglas `deploy/linux/audit/qapaq.rules`: identidad, sudo, PAM,
SSH, persistencia, ejecución como root de usuarios con sesión (no de demonios), módulos de kernel
y cambio de hora. Web: access/error de nginx y Apache. BD: log de PostgreSQL.

## 4. FIM (integridad de archivos)

| Ruta | Perfiles | Modo | Valor |
|---|---|---|---|
| `C:\Windows\System32\Tasks`, carpeta Startup | Windows | tiempo real | Persistencia (T1053, T1547) |
| `drivers\etc` (hosts) | Windows | programado + diff | Redirección hacia banca/proveedores |
| `profile.ps1` global | Windows | tiempo real | Persistencia en cada sesión PowerShell |
| `ossec.conf`, `local_internal_options.conf` | Todos | tiempo real | Autoprotección del agente |
| Registro: Run/RunOnce, IFEO, Winlogon, LSA, WDigest | Windows | programado | Persistencia y habilitar credenciales en claro (WDigest `UseLogonCredential`) |
| `C:\Windows\SYSVOL\domain` (scripts y GPO) | DC | tiempo real, filtrado por extensión | Un cambio se propaga a todo el dominio |
| Copias `*.dit` en Temp/Public/PerfLogs | DC | programado | Extracción de NTDS (IFM/ntdsutil) |
| `C:\inetpub\wwwroot`, `inetsrv\config` | Web | tiempo real, filtrado | Webshells |
| Binarios de SQL Server | BD | programado, `.dll/.exe` | Implantes CLR/XP |
| `C:\Users\Public` | Estación sensible | tiempo real, ejecutables y scripts | Staging de phishing |
| `/etc/passwd`, `shadow`, `group`, `sudoers`, `pam.d`, `ssh`, `/root/.ssh` | Linux | **whodata** | Atribución del usuario que cambió la identidad |
| cron, systemd, `profile.d`, `ld.so.preload` | Linux | tiempo real | Persistencia y rootkits de usuario |
| `/var/www`, configuración nginx/Apache | Web Linux | tiempo real | Webshells y redirecciones |
| Rutas de la aplicación del core | Core | plantilla comentada | TO_BE_PROVIDED (cuestionario S3) |

Exclusiones: `.log`, `.tmp`, `.etl`, `.swp`. Los datos de bases de datos y logs de aplicación
nunca se monitorizan: cambian siempre y solo producen ruido y costo. `max_eps` limita el I/O del
escaneo (100 servidores, 50 estaciones, 25 portátiles).

## 5. SCA, syscollector, rootcheck

- **SCA** cada 24 h con las políticas CIS que trae el agente para su sistema operativo.
  Alimenta cumplimiento y no genera volumen relevante.
- **Syscollector** cada 6 h en servidores y 12 h en estaciones: hardware, SO, red, paquetes,
  hotfixes y puertos en escucha (solo servidores). Sin procesos. Es la base de la detección de
  vulnerabilidades del manager y del contexto de activo.
- **Rootcheck** solo en Linux (rootkits, procesos/puertos ocultos, `/dev`). En Windows queda
  deshabilitado: sus políticas `rcl` están obsoletas, SCA las reemplaza y solo suman falsos
  positivos.

## 6. Portátiles remotos

- `client_buffer` de 20 000 eventos y 100 EPS: absorbe horas sin conexión y evita saturar
  enlaces domésticos al reconectar.
- FIM cada 24 h sin escaneo al arranque (`scan_on_start=no`) para no penalizar el inicio.
- La conexión 1514/1515 solo funciona desde IP aprobadas (`siem_host.agent_public_cidrs`): un
  portátil en casa necesita salir por la VPN/SASE de Cato. Si esa salida no está en la lista
  aprobada, el agente queda desconectado (cuestionario R5).

## 7. Etiquetas

Cada perfil añade `qapaq_profile`, `qapaq_criticality` y `qapaq_tier`. Aparecen en las alertas
como `agent.labels.*` y permiten filtrar en el dashboard sin depender del nombre del equipo.
