# Mapa de capacidades

La clasificación indica compromiso del producto, no estado de implementación.
Todas las capacidades están **NO IMPLEMENTADAS** en la rama inspeccionada.

| Capacidad | Clasificación | Justificación y fuente |
| --- | --- | --- |
| Autenticación humana Entra/BFF | MVP | U-003 / ADR-017; gate de federación pendiente |
| Autorización por capability, recurso y scope | MVP | U-003 / ADR-017; catálogo final por endpoint pendiente |
| Catálogo y configuración lógica de fuentes | MVP | U-001/005; valores reales pendientes |
| Gateway on-premises de APIs de proveedores | MVP | ADR-026; KrakenD CE, HA/BOM/rutas y E2E pendientes |
| Adquisición Microsoft 365 mediante Wazuh | MVP | ADR-024; piloto autorizado bloquea operación |
| ACK, checkpoint, retry y replay | MVP | ADR-019; garantía solo desde adquisición durable |
| Custodia de raw y manifests | MVP | ADR-018/019; WORM y retención condicionados |
| Cuarentena y reprocesamiento | MVP | ADR-011/019 |
| Normalización SecurityEvent 1.0.0 | MVP | U-010 / ADR-011; schema aún no materializado |
| Mapping de severidad versionado | MVP | ADR-011; mapping real Wazuh pendiente |
| Priorización y deduplicación de alertas | MVP | ADR-024 y Product Backlog |
| Investigación y búsqueda | MVP | U-001; OpenSearch QAPAQ es proyección derivada |
| Alertas, incidentes y casos mínimos | MVP | U-001 / ADR-015 |
| Dashboard de cobertura y salud | MVP | ADR-020/021; PBI-017 es P1 dentro del timebox |
| Notificación crítica por Teams | MVP | U-012 / ADR-022; datos operativos pendientes |
| Administración auditada | MVP | ADR-017/021 |
| Audit trail y exportación controlada | MVP | ADR-021; archivo firmado productivo bloqueado |
| Continuidad y modos degradados | MVP | U-009 / ADR-020; objetivos requieren pruebas |
| Reglas QAPAQ complementarias | MVP acotado | ADR-024; no duplica el ruleset base Wazuh |
| Cato y Sophos | Posterior | ADR-024; edición/API/licencia desconocidas |
| CTI/MISP | Posterior | U-001; sin fuente autorizada para MVP |
| SOAR con acciones externas | Pendiente/posterior | U-008; guardas, aprobación e idempotencia abiertas |
| Antifraude completo | Posterior | U-001; bounded context aceptado, sin vertical MVP |
| Analítica Python | Pendiente/posterior | U-007; capacidad dormante hasta gate |
| Publicación y despliegue | Pendiente | U-011 / ADR-023; contrato de Infraestructura ausente |

## Cobertura exigida para capacidades MVP

Cada capacidad MVP debe vincularse con al menos un RF, un control de autorización
cuando exponga datos o mutaciones, un `AuditEvent` cuando sea sensible, criterios
Dado/Cuando/Entonces y una prueba. La [matriz de trazabilidad](06-traceability-matrix.md)
registra esa cobertura. Un PBI sin estos vínculos no está listo para Sprint Planning.
