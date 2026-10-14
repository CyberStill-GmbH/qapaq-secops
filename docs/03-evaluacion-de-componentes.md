# 03 · Evaluación de componentes

Este inventario refleja la dirección de la rama unificada. **El frontend propio se elimina; el
backend QAPAQ TypeScript se conserva** porque el plugin dentro del Dashboard lo consume.

## 1. Wazuh y el overlay QAPAQ

| Componente upstream | Decisión | Razón |
| --- | --- | --- |
| Wazuh Manager | Sin fork; configuración versionada | Reglas, decoders, integraciones y Active Response se mantienen en `wazuh/manager/` |
| Wazuh Indexer | Sin fork; configuración versionada | Retención, seguridad e índices se configuran desde `wazuh/indexer/` |
| Wazuh Dashboard | Mantener modificaciones como overlay en `wazuh/dashboard/` | El branding y el plugin `qapaq_ops` entregan la interfaz QAPAQ dentro del Dashboard modificado |
| Plugin QAPAQ | Mantener como plugin independiente | La UI de casos, auditoría, administración y login se integra con OpenSearch Dashboards y la API TypeScript |

El repositorio contiene el **overlay QAPAQ de Wazuh**: configura Manager, Indexer, Dashboard,
plugin y dominio sobre la versión de Wazuh fijada en `wazuh/VERSION`. El endpoint público
planificado para Dashboard e interfaz QAPAQ es `https://qapaq-secops.jappi.net.pe`.

## 2. Componentes QAPAQ: conservar, integrar o retirar

| Componente | Responsabilidad diferencial | Decisión |
| --- | --- | --- |
| Login Entra (`modules/access`) | PKCE, nonce, validación de claims, sesión única, sesión revocable y auditoría | **Conservar en `apps/api`/`modules`**. El plugin usa esa API para login y control de sesión; no reemplazar por OIDC nativo de OSD |
| Sincronización de grupo SOC | Delta Graph y revocación por cambios de pertenencia | Conservar en backend TypeScript |
| RBAC por capacidades | Permisos de QAPAQ y mapeo a roles del Dashboard | Conservar en `modules/access`; propagar roles al proxy de identidad |
| Casos Ayni Qapaq | Alertas, incidentes, tareas, notas y timeline | Conservar en `modules/soc` y PostgreSQL; Wazuh no sustituye el flujo de casos |
| Correlación y prioridad | Agrupar eventos y asignar prioridades de caso | Conservar en `modules/detection`; detección de bajo nivel también puede implementarse en reglas Wazuh |
| Auditoría de cadena hash | Registro append-only verificable | Conservar en `platform/audit` y PostgreSQL |
| Notificaciones Teams | Outbox, reintentos, acuse humano e idempotencia | Conservar en el backend. PostgreSQL es durable; BullMQ despierta al worker para drenar el outbox |
| Caché de eventos | Acelerar lecturas repetidas con expiración breve | Valkey HA como caché recuperable; fallo de caché no bloquea la lectura desde la fuente durable |
| Worker | Consumir señales y procesar el outbox | Servicio ECS con BullMQ; el API mantiene polling de respaldo |
| Lectura/ingesta QAPAQ ↔ Wazuh Indexer | Gateway de integración | **Conservar KrakenD** mientras la API dependa de él para ingesta hacia el Indexer |
| `apps/web` y Vercel | Frontend QAPAQ separado | **Retirar**: las vistas se sirven desde el plugin Wazuh en `qapaq-secops.jappi.net.pe` |
| Grafana, Loki y Prometheus | Observabilidad separada | Retirados de la arquitectura; CloudWatch cubre métricas de AWS y Wazuh recibe telemetría operativa |
| Admisión C-04 y raw propio en S3 | Flujo no conectado al producto actual | Mantener congelado hasta decisión específica; no es parte de este cambio de frontend |
| Python analytics | No hay diferencial medido | OpenSearch Anomaly Detection cubre la necesidad actual |

La llamada del plugin al backend usa el origen Wazuh por `/qapaq-api/`. El destino previsto del
callback es `https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback`; el alta de esa URI
exacta en Microsoft Entra es un gate previo al login. No se debe rotar el client secret para
realizar este cambio.

## 3. Componentes integrados

| Capacidad | Pieza | Ubicación |
| --- | --- | --- |
| Interfaz SIEM y espacio de casos | Wazuh Dashboard + plugin `qapaq_ops` | `wazuh/dashboard/` |
| Login de origen único | Plugin QAPAQ, API TypeScript y proxy del host Dashboard | `wazuh/dashboard/`, `apps/api`, `infra/aws/scripts/` |
| Persistencia durable | PostgreSQL | `platform/database` |
| Caché y señalización de jobs | Valkey y BullMQ | `apps/api`, `apps/worker`, `infra/aws/modules/cache` |
| Almacenamiento y detección | OpenSearch ISM, snapshots S3 y Anomaly Detection | `wazuh/indexer/` |
| Acciones SOAR | Wazuh Active Response y Ankay Qapaq (Shuffle, scope posterior) | `modules/soar`, `wazuh/integrations/shuffle/` |

**Fuera del diseño final:** Vercel y `apps/web`. **Conservados del backend:** `apps/api`,
`modules/*`, `platform/*`, PostgreSQL y KrakenD.

Entre las alternativas no adoptadas están TheHive (licencia y límites de edición), n8n (licencia
no OSI), Tracecat (AGPL y funciones propietarias) y StackStorm (sin integración específica con
Wazuh). La elección de Shuffle para Ankay Qapaq sigue sujeta al gate de Legal documentado en
[10 · Decisiones](10-decisiones.md).
