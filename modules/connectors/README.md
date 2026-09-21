# Connectors

Ownership: inventario de fuentes, ports, adapters, health, cobertura y checkpoint
de lectura. El primer adapter real usa el cliente OpenSearch para consultar el
Wazuh Indexer en C-08/C-10. El Dashboard pertenece al stack Wazuh y no es una API
de ingesta para QAPAQ.

`src/infrastructure/wazuh-indexer-client.ts` materializa la conexión TLS y el health
del Indexer sin filtrar tipos OpenSearch fuera de infraestructura. Las credenciales
y CA se suministran por configuración/secretRef; nunca se desactiva la validación
TLS.
