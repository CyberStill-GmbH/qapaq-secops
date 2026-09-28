# Connectors

Ownership: inventario de fuentes, ports, adapters, health, cobertura y checkpoint
de lectura. El primer adapter real usa el cliente OpenSearch para consultar el
Wazuh Indexer en C-08/C-10. El Dashboard pertenece al stack Wazuh y no es una API
de ingesta para QAPAQ.

El puerto neutral `SecurityEventProvider` y el provider Wazuh de C-08 están en
`src/application` y `src/infrastructure/wazuh`. La composición se realiza con
`createWazuhSecurityEventProvider`, pasando los secretos resueltos por C-03. El
cliente Indexer conserva HTTPS y CA explícita; Manager usa HTTPS, JWT en memoria
y un CA separado. Los DTO de ambos servicios permanecen dentro de infraestructura.

El estado de aceptación y los bloqueos reales están en
[`C-08 — contrato operativo y probe Wazuh`](../../docs/project-management/c-08/README.md).
