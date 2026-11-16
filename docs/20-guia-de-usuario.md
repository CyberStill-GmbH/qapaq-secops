# 20 · Guía de usuario (analistas, líderes y auditores)

> Estado (base desplegada 2026-11-08): describe la consola de `https://dev.security.qapaq.pe` en esa
> fecha. Las mejoras locales de investigación progresiva, grupos de actividad, exportación CSV/XLSX,
> impresión PDF, cambios en vivo y cancelación de Qapaqzito se documentan en [08](08-frontend-unificado.md)
> y [15](15-qapaqzito-asistente.md), pero no se presentan aquí como desplegadas. Esta guía no contiene
> credenciales.

## Entrar

1. Abrir `https://dev.security.qapaq.pe`. Sin sesión, el edge redirige a la pantalla **QAPAQ**
   (`/qapaq/login`).
2. Usuario y contraseña de **tu** cuenta demo. Entra a «Resumen del SOC».
3. La sesión dura como máximo 8 h y se cierra tras 30 min sin actividad. «Cerrar sesión» está en el
   menú de ayuda (arriba a la derecha) y cierra también Ankay.

**Cuentas demo por rol.** El despliegue no usa Entra todavía: hay una cuenta administradora y hasta
8 cuentas sintéticas, cada una con **un** rol. Las contraseñas no están en la documentación: las
entrega el administrador de plataforma desde `/opt/qapaq/secrets/` del nodo
(`demo-admin-password.txt`, `demo-accounts.txt`) por un canal seguro. Límites:

- **Una cuenta, una persona.** La sesión es única por cuenta: si alguien entra con tu cuenta en
  otro navegador, tu sesión se cierra («entraste desde otro lugar»), en la consola y en el SIEM.
- Las cuentas demo vencen con la excepción demo (≤ 30 días; se renueva en cada despliegue) y no
  tienen MFA. No reutilizar esas contraseñas en ningún otro sistema.
- Ninguna cuenta demo puede aprobar cambios de rol.

## Qué puede hacer cada rol

| Rol | Puede | No puede |
| --- | --- | --- |
| Analista SOC (`qapaq.soc.analyst`) | Ver eventos y alertas, clasificar, asignar, crear y trabajar incidentes (tareas, notas), ver notificaciones, Qapaqzito, Ankay (como usuario) | Cerrar incidentes, ver eventos crudos, ver auditoría, administrar usuarios |
| Líder SOC (`qapaq.soc.lead`) | Todo lo del analista, más cerrar incidentes, eventos crudos, enviar avisos, salud de fuentes y operativa, leer auditoría | Administrar usuarios y sesiones |
| Auditor (`qapaq.auditor`) | Auditoría (incluida la sensible) y verificación de la cadena, leer incidentes, salud de fuentes; en el SIEM, lectura sin exportar | Ver la cola de alertas, modificar nada, abrir Ankay desde el menú |
| Administrador de plataforma (`qapaq.platform.admin`) | Todo lo anterior, usuarios, sesiones (revocar), salud de plataforma, secretos | Aprobar su propio cambio de rol |

Capacidades exactas: `modules/access/src/capabilities.ts`. Separación de funciones en
[04](04-identidad-y-acceso.md).

## Menú QAPAQ SOC

| Página | Para qué |
| --- | --- |
| **Resumen del SOC** | Portada: alertas de las últimas 24 h por severidad, tendencia, estado de cada integración (eventos 24 h, último evento) y accesos a los dashboards por proveedor |
| **Monitoreo › Cola de alertas** | La vigilancia en vivo. Estados: Nueva → Reconocida → Triada → Escalada → Cerrada. «Registrar triaje» exige veredicto (verdadero positivo, falso positivo, benigna, duplicada) y nota; un verdadero positivo se puede convertir en incidente. «Ver eventos en Discover (±1 h)» abre la búsqueda por usuario, IP o agente |
| **Investigar alerta o entidad** | Abre el evento de origen, pivotes por entidad, MITRE, el riesgo disponible y eventos relacionados. «Exportar Excel (CSV)» descarga la alerta y los eventos devueltos por la línea de tiempo; «Guardar como PDF» abre la impresión del navegador con formato para papel. El CSV no incluye páginas adicionales de resultados ni mensajes de correo de buzón. |
| **Incidentes** | Casos: estado (Abierto, Contenido, Erradicado, Resuelto, Cerrado), severidad, alertas vinculadas, tareas, notas y línea de tiempo. Cerrar exige rol Líder |
| **Notificaciones** | Historial de avisos y acuses. La política agrupa repeticiones P1/P2; P3/P4 y P2 antiguos se incorporan a resúmenes. Revisa el estado del canal y el motivo de entrega antes de interpretar la ausencia de una tarjeta como pérdida del evento. |
| **Integraciones** | Una tarjeta por fuente: qué recoge, cada cuánto, reglas, permisos que faltan y siguiente paso. Detalle en [18](18-integraciones.md) |
| **Políticas** | Políticas vigentes por grupo de agentes, del manager (vulnerabilidades, SCA, Active Response apagada, umbral de correo) y retención (alertas 90 d, monitoreo 15 d, archivos 7 d). Detalle en [16](16-politicas.md) |
| **Auditoría e integridad** | Quién hizo qué y cuándo; «Verificar» comprueba la cadena hash completa. Solo Líder, Auditor y Admin |
| **Usuarios y sesiones** | Padrón, sesiones activas y revocación. Solo Admin |
| **Salud de fuentes** | Estado de la ingesta (p. ej. «Wazuh Indexer · alertas») y salud operativa |
| **Mi sesión** | Tu usuario, rol, capacidades y vencimiento de la sesión |
| **SOAR** | Ankay embebido (ver abajo) |

La política predeterminada (puede cambiar por configuración de despliegue) envía P1 al instante, salvo
que el mismo grupo ya tenga un aviso dentro de 30 minutos; para P2 el período de agrupación es de 2 horas,
los eventos con más de 1 hora de atraso pasan al resumen y hay un tope de 12 tarjetas P2 por hora. P3/P4
se resumen cada 6 horas; los avisos suprimidos se agregan al digest con una espera de hasta 15 minutos.
La política vive en `modules/soar/src/notification-policy.ts`. Para diagnosticar una alerta faltante,
consulta Salud de fuentes/Operaciones, la pestaña Canales y el historial de notificaciones; el resumen no
sustituye la evidencia del proveedor ni confirma que el canal externo haya entregado un mensaje.

Severidad de las alertas (escala QAPAQ sobre el nivel Wazuh): baja 0–3, media 4–7, alta 8–11, crítica
12–15. Las reglas, runbooks y el modelo operativo (turnos, SLA por prioridad) están en
[17](17-ingenieria-de-deteccion.md) y en [detection-engineering/](detection-engineering/03-modelo-operativo.md).

## Qapaqzito

El botón de Qapaqzito está en la esquina superior derecha. Abre un panel lateral que entiende la página
en la que estás. Ejemplos: «¿qué alertas P1 hay abiertas?», «resume el incidente», «busca inicios de
sesión fallidos en 24 h», «¿hay fuentes degradadas?».

- Usa **Claude** (Anthropic) y consulta el SOC **con tus permisos**: no ve más que tú.
- **Solo lectura:** no ejecuta acciones. Cada respuesta muestra qué consultó y cita alertas e
  incidentes.
- Correos e IPv4 se seudonimizan antes de enviarse al modelo. No pegar secretos en el chat.
- Las respuestas pueden equivocarse: verificar antes de decidir. Detalle en
  [15](15-qapaqzito-asistente.md). La calidad de respuesta la está mejorando otro agente.

## Ankay

Ankay es la consola de playbooks de respuesta (basada en Shuffle, AGPL-3.0).

- Se abre desde **SOAR** en el menú, o en pestaña aparte con «Abrir en pestaña». Entra con tu
  sesión QAPAQ (**SSO**, sin segundo login). El menú lo muestra a quien tiene `incidents.write`.
- Rol en Respond: Admin de plataforma → admin; Líder y Analista → usuario; Auditor → solo lectura
  (no ejecuta ni edita) si entra por la URL directa.
- **«Volver al SIEM»** está en todas sus páginas y lleva a la cola de alertas.
- Toda acción con efectos (bloquear, deshabilitar, aislar) exige aprobación del Líder SOC. Los
  playbooks de contención se exportan con `qapaq_contencion_habilitada=false`: hoy ningún playbook
  contiene sin una decisión registrada en [10](10-decisiones.md) (B12). Catálogo en
  [detection-engineering/04](detection-engineering/04-playbooks-ankay.md).
- El cierre del ciclo Respond ↔ incidentes (que la ejecución quede en el incidente) es una brecha
  abierta ([19 #11](19-brechas-y-roadmap.md)).

## Módulos nativos de Wazuh

Debajo del menú QAPAQ siguen los módulos de Wazuh, en español (`qapaq_i18n`). Los roles SOC los usan en
lectura:

| Módulo | Uso |
| --- | --- |
| Discover | Búsqueda libre en `wazuh-alerts-*` |
| Dashboards | Paneles QAPAQ por proveedor (Microsoft 365, Bitdefender, Snyk, Cloudflare, AWS) y vistas de detección (MITRE, vulnerabilidades, identidad, integridad, caza, calidad) |
| Vulnerabilidades | Estado por agente a partir del inventario |
| Evaluación de configuración (SCA) | Cumplimiento CIS por agente |
| Integridad de archivos (FIM) | Cambios en rutas vigiladas |
| Detección de malware / rootcheck | Hallazgos de rootcheck |
| Inventario (IT Hygiene) | Paquetes, puertos, procesos, usuarios |
| Office 365 | Actividad de M365 mediante el feed de auditoria; confirma salud y ultimo evento en Fuentes antes de interpretar ausencia de alertas |
| MITRE ATT&CK y caza de amenazas | Alertas por técnica y búsqueda |
| Agentes | Estado de los agentes (hoy solo el nodo del SOC) |

Los enlaces de ayuda dentro de los módulos apuntan a la documentación pública de Wazuh.
