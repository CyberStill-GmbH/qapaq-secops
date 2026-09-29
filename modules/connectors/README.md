# Connectors

Ownership: inventario de fuentes, ports, adapters, health, cobertura y checkpoint
de lectura. El adapter Wazuh consulta el Indexer exclusivamente mediante el gateway
KrakenD de C-28. El Dashboard pertenece al stack Wazuh y no es una API de ingesta.

El puerto neutral `SecurityEventProvider` y el provider Wazuh de C-08 están en
`src/application` y `src/infrastructure/wazuh`. La composición se realiza con
`createWazuhSecurityEventProvider`, pasando la URL y el bearer token de C-28
resueltos por C-03. El adapter solo conoce las rutas allowlisted del gateway; no
contiene SDK, host, credenciales ni fallback del Indexer.

La arquitectura, migración, fallos y pruebas están en
[`C-10 — Wazuh adapter hardening`](../../docs/project-management/c-10/README.md).
