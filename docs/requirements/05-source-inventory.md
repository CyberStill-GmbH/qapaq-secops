# Matriz de fuentes y dependencias externas

Ninguna fila está implementada o habilitada. Los valores reales permanecen en
[`source-inventory.yaml`](../integrations/source-inventory.yaml); este documento
explica el contrato requerido sin copiar secretos.

| Sistema | Dataset/finalidad | Método de adquisición | Dueño | Autenticación requerida | Límites conocidos | Validación/prioridad |
| --- | --- | --- | --- | --- | --- | --- |
| Microsoft 365 | actividad Office 365 por seleccionar | integración nativa Office 365 de Wazuh | Infraestructura + dueño M365 | identidad/app/scopes `TO_BE_PROVIDED` | licencia, dataset, cuota, retención, ID/tiempo y ventana replay desconocidos | `planned`; MVP; gate ADR-024 |
| Wazuh Indexer | alertas derivadas Microsoft 365 (`wazuh-alerts-*` esperado, patrón por confirmar) | consulta incremental read-only | Infraestructura opera; Security/SOC dueño funcional | usuario/rol técnico y TLS `TO_BE_PROVIDED` | versión, API, page size, carga compartida, cursor y retención desconocidos | `planned`; MVP; provider spec requerida |
| Microsoft Entra ID | identidad humana/grupos de admisión | OIDC Authorization Code + PKCE; sincronización autorizada cuando aplique | Identity/Infraestructura | app registration, backend credential, CA/MFA | tenant, licencias PIM/CA, grupos, redirects y revocación por confirmar | gate U-003; MVP |
| Microsoft Teams Workflows | salida de alertas críticas | webhook de Workflow mediante adapter/outbox | Infraestructura/M365; SOC dueño del canal | URL vía `secretRef` | Team/canal, owners, licencia, rate limit, retención, acuse y fallback pendientes | gate U-012; MVP |
| PostgreSQL | estado operacional/audit local/outbox | driver/Prisma en infraestructura | Infraestructura/Platform | identidad runtime mínima | topología, HA, sizing, backup y RPO/RTO pendientes | dependencia MVP |
| Redis/BullMQ | jobs, locks y sesiones según diseño | protocolo Redis/BullMQ | Infraestructura/Platform | identidad/TLS por confirmar | memoria, eviction, HA, concurrencia pendientes | dependencia MVP |
| OpenSearch QAPAQ | proyección SecurityEvent/búsqueda | port de indexación/consulta | Infraestructura/Platform | identidad mínima | si comparte o no cluster, mappings, cuota y sizing pendientes | dependencia MVP; no source of truth |
| Object storage | raw, manifests, evidencia, exports y archive | port de objetos | Infraestructura + custodios | identidad por función | producto, WORM, región, versionado, hold, cuotas y retención pendientes | gate U-004/U-006 |
| OpenTelemetry Collector | señales operacionales | OTLP | Infraestructura | endpoint/certificado por confirmar | buffer, cuota y pipeline pendientes | gate U-006/U-020 |
| Grafana OSS + Loki + Prometheus | observabilidad interna SOC autogestionada | Grafana consulta Loki/Prometheus; Collector entrega logs | Infraestructura/Platform; SOC consumidor | Entra, red QAPAQ, proxy/mTLS e identities `TO_BE_PROVIDED` | versiones, sizing, retención, HA, storage, backup/restore y guardia pendientes | MVP; ADR-025; gate U-020 |
| KrakenD CE on-premises | gateway de egress API y webhook ingress; no almacena raw/checkpoint | LB interno + rutas declarativas + OAuth/API key runtime | Infraestructura/Platform/Security | versión/digest, rutas, CA/certificados e identities `TO_BE_PROVIDED` | HA, cuotas por réplica, timeouts, egress, benchmark y recovery pendientes | MVP; ADR-026; gate U-019 |
| SecretProvider | custodia y resolución runtime de credenciales write-only | create/rotate/revoke + `secretRef`; materialización protegida | Infraestructura/Platform/Security | producto, workload identities y namespaces `TO_BE_PROVIDED` | IAM, HA, audit, rotación y recovery pendientes | MVP; ADR-013/025/026; gate U-019 |
| Signing service | firma de manifests audit | API corporativa por definir | Infraestructura + Security | identidad QAPAQ sin acceso a llave | algoritmo/servicio/rotación/SLA pendientes | gate U-006 |
| Cato | dataset `TO_BE_PROVIDED` | API/EventsFeed por validar | Infraestructura + dueño fuente | `TO_BE_PROVIDED` | edición, licencia, API, cuota, cursor, retención desconocidos | post-MVP; no adapter aún |
| Sophos | producto/dataset `TO_BE_PROVIDED` | API por validar | Infraestructura + dueño fuente | `TO_BE_PROVIDED` | producto, edición, licencia, scopes, cuota, replay desconocidos | post-MVP; no adapter aún |
| MISP/CTI | indicadores/contexto | adapter futuro | Security/SOC | `TO_BE_PROVIDED` | instancia, taxonomía, confianza, expiración pendientes | post-MVP/propuesta |

## Evidencia para habilitar una fuente

Inventario aprobado, owner, versión/edición, dataset y finalidad; endpoint/región;
identidad/scopes mínimos y ticket; límites/paginación/cursor; IDs y campos de
tiempo; errores/throttling; clasificación de replay; retención; conectividad;
prueba sintética real; revocación; degradación; ausencia de secretos y PII en la
evidencia. Solo después puede transicionar `planned → configured → validated → enabled`.

La documentación oficial del fabricante demuestra que un mecanismo existe, pero
no demuestra que la licencia, edición o configuración QAPAQ lo permita.
