# 08 · Frontend unificado

## Decisión

El **dashboard de Wazuh es el shell**. Lo que ya hace bien no se rehace: Discover, dashboards,
agentes, vulnerabilidades, FIM, MITRE, reglas y gestión de índices. QAPAQ aporta casos,
gobierno y cambios en vivo, y aparece **dentro** del mismo shell.

## Tres niveles de integración

| Nivel | Fase | Cómo | Esfuerzo |
| --- | --- | --- | --- |
| **A. Marca** | 1 | `opensearchDashboards.branding` (logo, marca, favicon, título "QAPAQ SecOps") en `wazuh/dashboard/opensearch_dashboards.qapaq.yml`. Sin build | Horas |
| **B. Plugin `qapaq-ops`** | 2 | Plugin OSD que registra la categoría **QAPAQ** en la navegación (Alertas, Incidentes, Auditoría, Mi sesión) y monta `/soc/*` como app embebida del mismo origen. Añade al header un contador de alertas nuevas que se alimenta de `/api/changes` | Días |
| **C. Tema y vistas nativas** | 4 | Fork `qapaq-dashboard` sobre Wazuh 5.x GA: tema OUI con los tokens QAPAQ (`#080808`, ámbar `#c49a5a`) y vistas QAPAQ migradas a componentes OUI | Semanas |

**¿Por qué embebido en el nivel B y no React nativo dentro de OSD?** `apps/web` usa React 19 y
OSD trae su propia versión de React (anterior a 19; verificar en el build), con su propio router, i18n y estilos OUI. Portar 11k líneas es el nivel C.
Montar `/soc` del mismo origen da una sola sesión y una sola URL desde el día 1. Además el plugin
se recompila en minutos para OSD 3.6 al migrar a Wazuh 5.

## Qué se queda en `apps/web` (servido en `/soc`)

| Vista | Motivo |
| --- | --- |
| Cola de alertas QAPAQ (triaje, toma, prioridad P1–P4 con razones) | Wazuh no tiene estados de trabajo |
| Incidentes: tareas, bitácora append-only, timeline | No existe en Wazuh |
| Notificaciones y acuses, avisos push | No existe en Wazuh |
| Auditoría e integridad | No existe en Wazuh |
| Usuarios SOC, sesiones y Mi sesión | Gobierno de identidad QAPAQ |
| Salud operativa (cursores de ingesta) | Complementa la vista de agentes de Wazuh |

## Qué se retira de `apps/web`

| Vista | La reemplaza |
| --- | --- |
| Eventos de seguridad (`/events`, búsqueda acotada) | Discover y Threat Hunting de Wazuh. Desde un incidente se llega con un deep link `app/data-explorer/discover#?_q=(query:'data.office365.UserId:"…"')` |
| Salud de fuentes de agentes | Vista de agentes de Wazuh |
| Prototipo SuperAdminConsole y `mock-admin.ts` | — |

Los vínculos van en las dos direcciones. Desde una alerta Wazuh (documento en Discover), un
*field formatter* o un link del plugin abre `/soc/alerts?wazuhId=<_id>`. Desde un incidente
QAPAQ se abre Discover filtrado por entidad y ventana.

## Cambios en vivo

- **Hoy:** long-poll `GET /api/changes?after=<cursor>` (2,5 s, por secuencia de auditoría). Es lo
  que permite que la cola y los casos se actualicen sin recargar.
- **Fase 2:** al salir KrakenD (que cortaba a 4 s), `GET /api/changes/stream` como **SSE**, con
  fallback al long-poll. El plugin lo usa para el contador del header y para mostrar avisos de
  OUI (`core.notifications.toasts`) con las alertas P1 nuevas, en cualquier pantalla del dashboard.
- OSD por sí mismo solo tiene *auto-refresh* por intervalo en Discover y en los dashboards.
