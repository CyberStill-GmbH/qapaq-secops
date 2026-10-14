# 03 · Evaluación de componentes

Inventario hecho sobre el código real (HEAD `050f9fa`), no sobre la documentación previa.
"Diferencial" significa que Wazuh, OpenSearch o un OSS maduro no lo dan listo.

## 1. ¿Fork de Wazuh? Decisión por repositorio

| Repo upstream | Licencia | ¿Fork? | Razón |
| --- | --- | --- | --- |
| `wazuh/wazuh` (manager, C/C++/Python) | GPLv2 (reglas y decoders incluidos) | **No** | Todo lo que necesitamos se hace por configuración: reglas, decoders, integraciones, Active Response y wodles. Además Wazuh 5.0 (RC1, 5-oct-2026) reemplaza `analysisd` por un motor nuevo basado en Sigma. Un fork de 4.x heredaría una arquitectura que el upstream descarta, y redistribuir binarios modificados nos obligaría a publicar fuentes GPL |
| `wazuh/wazuh-indexer` (OpenSearch) | Apache-2.0 | **No** | ISM, snapshots S3, Anomaly Detection, Security Analytics y Alerting ya vienen como plugins. Se configuran con JSON versionado |
| `wazuh/wazuh-dashboard` (OSD) | Apache-2.0 | **Sí: fork `qapaq_ops-dashboard`, en curso** | Se hace fork porque el tema, el login propio (`/qapaq/login`) y las vistas nativas tocan el núcleo de OSD. Está en `../wazuh-dashboard-src`, rama `qapaq/identity`. Debe fijarse a un tag GA de Wazuh 5.0.x ([08](08-frontend-unificado.md#riesgos-detectados)) |
| `wazuh/wazuh-dashboard-plugins` | Apache-2.0 (verificar LICENSE) | **No** | Nuestro plugin es independiente y se instala con `opensearch-dashboards-plugin install` |

**Qué significa "poner el backend de Wazuh en qapaq-secops":** el directorio `wazuh/` en la raíz
del repo es el **overlay QAPAQ de Wazuh**. Versiona todo lo que cambiamos de Wazuh (reglas,
decoders, `ossec.conf`, seguridad del Indexer, ISM, detectores ML, integraciones, plugin y edge)
y lo aplica con scripts idempotentes sobre la versión oficial fijada en `wazuh/VERSION`. Se
comporta como un fork, pero se puede rebasear en minutos cuando sale un parche de Wazuh.

> **Desalineación detectada:** el fork parte de `main` = Wazuh 5.1.0 / OSD 3.6.0, pero la demo corre
> **Wazuh 4.14.8 (OSD 2.19.6)**. Un dashboard o plugin compilado para 3.6 no funciona con un Indexer
> 2.19. Recomendación: fijar el fork a un tag 5.0.x GA y desplegar un cluster Wazuh 5 nuevo para la
> plataforma unificada.

## 2. Componentes QAPAQ: conservar, migrar o retirar

| Componente | Madurez real | ¿Diferencial? | Decisión |
| --- | --- | --- | --- |
| **Login Entra** (`modules/access`: PKCE, nonce, `amr`, passkey fuera de la red, lockout, sesiones con hash) | Real, 79 tests, sin librerías de terceros, sin framework | **Sí**. OSD con OIDC nativo no exige passkey por ubicación, no revoca al salir del grupo y no audita | **Conservar en TS** y ponerlo delante del dashboard vía `auth_request` y proxy auth ([04](04-identidad-y-acceso.md)). No migrarlo a OIDC nativo de OSD |
| **Sincronización Graph del grupo SOC** (delta, owners, revocación) | Real | **Sí** | Conservar |
| **RBAC por capacidades** (25 × 4 roles) | Real | **Sí**. Mapea a `backend_roles` del Security plugin | Conservar. Los roles Entra se pasan al dashboard en `x-proxy-roles` |
| **Casos**: alertas, incidentes, tareas, notas append-only, timeline | Real con Postgres, 64 tests | **Sí**. Wazuh no tiene casos. TheHive es propietario y la edición Community está limitada | Conservar. Es el corazón del producto |
| **Correlación y prioridad** (`modules/detection`: entidad, cadena M365, P1–P4) | Real, determinista, 40 tests | **Sí** en la agrupación a incidente | Conservar. Mover a reglas Wazuh lo que sea detección pura (secuencias `if_matched_sid`/`same_field`) y dejar en TS la agrupación y la prioridad |
| **Auditoría con cadena hash** | Real, trigger append-only | **Sí** (evidencia SBS art. 12.6.g) | Conservar. Activar el archivo WORM a S3 con Object Lock en fase 3 |
| **Notificaciones** (Teams Workflows, push VAPID, outbox con reintentos) | Real, 29 tests | **Sí**. El Integrator de Wazuh manda a Slack o PagerDuty, pero sin acuse humano ni idempotencia | Conservar. Añadir el fencing token al outbox (gate P0) |
| **Cambios en vivo** (`/api/changes`, long-poll de 2,5 s) | Real | **Sí**. OSD solo refresca por intervalo y Live Tail también hace polling | Conservar. Sin KrakenD se puede pasar a SSE y llevarlo al plugin como contador en el header |
| **Salud de fuentes** | Real | Parcial (Wazuh muestra el estado de los agentes, no el de los cursores de ingesta) | Conservar |
| **Lectura Wazuh por KrakenD** (`modules/connectors`) | Real, pero falla en la demo | No | **Migrar**: la API apunta al proxy nginx del Indexer con el usuario `qapaq_reader` (la ruta `/wazuh/_search` no cambia de forma) |
| **Ingesta por polling** | Real | No | Conservar como **reconciliación** y añadir **push** vía la integración `custom-qapaq` de Wazuh para bajar la latencia ([07](07-deteccion-ml-y-soar.md)) |
| **Control plane de secretos write-only** (`platform/configuration`) | Real, 68 tests | Medio | Conservar |
| **KrakenD** (`platform/gateway`) | Config real | No | **Retirar del runtime** (ver [02](02-arquitectura.md)) |
| **Valkey/Redis y BullMQ** | Provisionado sin uso | No | **Retirar** |
| **`apps/worker`** | Stub | No | **Retirar** |
| **Grafana, Loki y Prometheus** | Solo local, sin consumidores | No | **Retirado en esta rama.** El fin regulatorio lo cubre Wazuh ([06](06-operacion.md)) |
| **Admisión C-04 y raw en S3** (`modules/telemetry/admission`) | Testeado, no conectado | No | Congelar (sin borrar en esta rama). Se retira si en fase 2 nadie lo conecta |
| **Prototipo SuperAdminConsole** (`apps/web/src/components/admin`, mock) | Huérfano, unas 3k líneas | No | Retirar (dominio frontend) |
| **Python analytics** | Inexistente | No | Retirar la decisión. El ML lo pone OpenSearch AD |
| **Specs de pantallas 03–18** | Docs | — | Sustituidas por [08](08-frontend-unificado.md). Las vistas SIEM son las de Wazuh |

## 3. Lo nuevo que se incorpora, todo OSS

| Capacidad | Pieza | Licencia | Integración |
| --- | --- | --- | --- |
| Login único | nginx `auth_request` y Security plugin `proxy` | BSD / Apache-2.0 | `wazuh/edge/`, `wazuh/indexer/security/` |
| Hot/warm/cold | OpenSearch ISM y `repository-s3` | Apache-2.0 | `wazuh/indexer/ism/` |
| ML de anomalías | OpenSearch Anomaly Detection (Random Cut Forest) | Apache-2.0 | `wazuh/indexer/anomaly-detection/`, leído por `modules/detection` |
| Detección Sigma y correlación de hallazgos | OpenSearch Security Analytics (nativo en Wazuh 5) | Apache-2.0 | Fase 4 |
| Respuesta en endpoint | Wazuh Active Response vía Wazuh API | GPLv2 (sin modificar) | `modules/soar` con aprobación |
| Playbooks multi-herramienta | **Ankay Qapaq** = Shuffle v2.3.0 (AGPL-3.0; apps y workflows MIT) | AGPL | Servicio separado con el **frontend modificado** (rebrand, `ankay/`). QAPAQ lo invoca por webhook después de aprobar. AGPL §13: el código fuente modificado se sirve en `/source/` de Ankay. QAPAQ no queda bajo AGPL porque se comunica por red y no enlaza código de Shuffle. Confirmarlo con Legal (U-022) |
| Shell visual | Plugin OSD `qapaq-ops` | Propio | `wazuh/dashboard/plugins/qapaq-ops` |

**Descartados:** TheHive 5 (licencia propietaria de StrangeBee y Community limitada a 2 usuarios),
n8n (licencia Sustainable Use, no OSI), Tracecat (AGPL con módulo enterprise propietario y sin
integración Wazuh), Catalyst (sin actividad desde 2024) y StackStorm (Apache-2.0 pero genérico y
sin integración Wazuh: queda como plan B si Legal rechaza AGPL).
