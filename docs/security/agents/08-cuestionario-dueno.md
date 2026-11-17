# Cuestionario para el dueño: datos de red y decisiones pendientes

Ningún valor real de la red de QAPAQ está en el repositorio. Todo lo marcado `TO_BE_PROVIDED`
en este paquete se resuelve con las respuestas de abajo. Las respuestas con datos internos
(rangos, nombres de equipos, cuentas) **no** se versionan: se cargan en el inventario del
manager, en Key Vault o en las variables del núcleo. Solo se versiona la decisión.

## R · Red y asignación de grupos

| # | Pregunta | Dónde se usa |
|---|---|---|
| R1 | IP públicas de salida (por sede, VPN y SASE Cato) desde las que los agentes llegarán a `app.jappi.net.pe`. | `siem_host.agent_public_cidrs` (Terraform, fuera de este PR) |
| R2 | OU de AD de: servidores del core/créditos, bases de datos, DMZ/web, estaciones de tesorería, operaciones, créditos, TI privilegiado y portátiles. Si no hay OU, patrón de nombre de equipo. | `group-mapping.json` |
| R3 | ¿Hay estaciones de trabajo fuera del dominio? ¿Cómo se gestionan (Intune, manual)? | Método de despliegue (§7 de 04) |
| R4 | Equipos piloto por perfil (1–2 por grupo; para DC, uno que no sea PDC). | Piloto (04 §6) |
| R5 | ¿Los portátiles remotos salen siempre por Cato/VPN? ¿Con qué IP? | R1, perfil `qapaq-laptop-remote` |
| R6 | Rangos internos (RFC 1918) por sede y segmento (servidores, estaciones, DMZ). | Contexto de origen interno/externo en investigaciones |

## S · Activos y aplicaciones

| # | Pregunta | Dónde se usa |
|---|---|---|
| S1 | Lista de servidores críticos con su clase: DC, core, BD, pagos, respaldo, PAW. | `qapaq-critical-assets`, `QAPAQ_DETECTION_CRITICAL_ASSETS` |
| S2 | Servidores expuestos a Internet (web, VPN, correo, API, SFTP). | `qapaq-internet-facing`, `QAPAQ_DETECTION_INTERNET_FACING_ASSETS` |
| S3 | Rutas de instalación y configuración de la aplicación del core financiero y de créditos (Windows y/o Linux). | FIM del perfil `qapaq-srv-core` |
| S4 | Motores de base de datos y versiones (SQL Server, PostgreSQL, Oracle); instancia nombrada de SQL. | Canal Application y logs de BD |
| S5 | Producto y versión de Sophos en endpoints (nombres de proveedor en Application). | XPath de Application |
| S6 | ¿IIS, nginx o Apache en los servidores web? ¿Qué sitios (W3SVC n)? | Logs web del perfil `qapaq-srv-web` |

## I · Identidades

| # | Pregunta | Dónde se usa |
|---|---|---|
| I1 | Cuentas tier 0 (Domain/Enterprise Admins, cuentas de servicio con privilegio de dominio). | `qapaq-privileged-identities` (valor `tier0`) |
| I2 | Administradores tier 1 (servidores) y administradores de Entra/M365. | `tier1`, `cloud-admin` |
| I3 | Personas que aprueban pagos o transferencias (objetivo de BEC). | `payment-approver` |
| I4 | Cuentas break-glass. | `QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES`, `qapaq-break-glass` |

## N · Notificación y SLA

| # | Pregunta | Dónde se usa |
|---|---|---|
| N1 | Horario laboral y horario de guardia del SOC (¿24×7 para P1?). | SLA de 03 §5; regla 101645 (`<time>`) |
| N2 | Contactos nominales: líder SOC, Oficial de Seguridad de la Información, dueños de activos críticos, Oficial de datos personales. | Escalamiento (04 §11, 05 §7) |
| N3 | ¿Avisar P2 por Teams además de P1? | Nueva ruta en `modules/soar` (no incluida) |
| N4 | Aprobar la propuesta de SLA de 03 §5. | Matriz |

## L · Legal y privacidad

| # | Pregunta | Dónde se usa |
|---|---|---|
| L1 | Aceptación de los Sysinternals Software License Terms para Sysmon. | `Install-QapaqSysmon.ps1` (`-accepteula`) |
| L2 | Validación legal de distribuir Sysmon desde un recurso interno. | 04 §4 |
| L3 | Aprobación de recoger línea de comandos (Sysmon 1) y script blocks (4104), con su retención. | Perfiles con Sysmon/PowerShell |

## K · Plataforma

| # | Pregunta | Dónde se usa |
|---|---|---|
| K1 | Key Vault y nombre del secreto de inscripción; identidad administrada de servidores Azure/Arc. | Instaladores |
| K2 | Recurso compartido de solo lectura para el paquete (`\\<srv>\wazuh\4.14.8`). | GPO/Intune |
| K3 | Quién ejecuta la construcción del paquete y aprueba el PR del manifiesto. | 04 §3 |
