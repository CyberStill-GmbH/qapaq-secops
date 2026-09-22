# C-06 — entorno real de integración

Estado actual: **PARCIALMENTE VERIFICADO**.

| Servicio | Harness | Preflight | Arranque real | Health/operación | Teardown | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL | Implementado con Testcontainers | BLOCKED en host sin Docker | NOT_RUN | NOT_RUN | Implementado | BLOCKED BY INFRASTRUCTURE |
| Redis | Implementado con Testcontainers | BLOCKED en host sin Docker | NOT_RUN | NOT_RUN | Implementado | BLOCKED BY INFRASTRUCTURE |
| MinIO | Runtime y health HTTP implementados | BLOCKED en host sin Docker | NOT_RUN | NOT_RUN | Implementado | BLOCKED BY INFRASTRUCTURE |
| OpenSearch QAPAQ | Runtime separado y bloqueo explícito | Requiere TLS aprobado | NOT_RUN | NOT_RUN | Implementado | BLOCKED |
| Wazuh Manager | Perfil reservado para Compose oficial | Requiere 16 GiB y Docker | NOT_RUN | NOT_RUN | Perfil documentado | BLOCKED BY INFRASTRUCTURE |
| Wazuh Indexer | Perfil reservado para Compose oficial | Requiere 16 GiB y Docker | NOT_RUN | NOT_RUN | Perfil documentado | BLOCKED BY INFRASTRUCTURE |
| Wazuh E2E | Smoke pendiente de topología oficial | BLOCKED | NOT_RUN | NOT_RUN | NOT_RUN | BLOCKED |

OpenSearch de QAPAQ y Wazuh Indexer permanecen separados. No se comparten
credenciales, índices, certificados ni puertos por inferencia. El perfil Wazuh
usa el checkout oficial fijado por `scripts/dev/setup-wazuh.ps1` y no sustituye
Manager → pipeline → Indexer por una llamada directa.

El host actual reportó que Docker Desktop no expone el daemon
`dockerDesktopLinuxEngine`; por eso no se descargaron imágenes ni se intentó un
arranque condenado a fallar. Para desbloquear la ejecución base se necesita un
daemon accesible con al menos 4 GiB para PostgreSQL/Redis/MinIO. Para `search` se
requieren al menos 8 GiB y para `wazuh`/`full`, al menos 16 GiB y el Compose
oficial de Wazuh v4.14.7. La referencia de capacidad completa es 12 vCPU, 32
GiB RAM y 200 GiB NVMe/SSD.

La evidencia sanitizada se escribe en
`artifacts/integration/<runId>/environment-evidence.json`; los digests quedan
pendientes hasta que el preflight tenga acceso al registry. Un digest ausente
impide declarar reproducibilidad de CI.
