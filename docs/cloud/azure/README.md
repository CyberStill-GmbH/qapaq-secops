# Cloud architecture — Azure

Esta documentación describe solo el destino Azure. No es una traducción literal
de la arquitectura AWS y no modifica la documentación/demo AWS.

- [Arquitectura y límites](architecture.md)
- [ADR Azure: BullMQ sobre PostgreSQL](decisions/adr-azure-queue-postgres.md)
- [Diagrama de despliegue](diagrams/qapaq-azure.mmd)
- [Runbook de secretos, notificaciones y DNS](runbook-preparacion-y-corte.md)
- [Viabilidad de costos en Chile Central](cost-feasibility-2026-10-19.md)
- [Terraform Azure](../../../infra/azure/README.md)

Estado: **preparación local; despliegue sin verificar**. En esta sesión no se
ejecutó `plan` remoto, `apply` ni cutover DNS, y no hay evidencia actual del state
remoto o del inventario Azure. La región base es **Chile Central** (`chilecentral`),
seleccionada por proximidad geográfica a Perú. La consulta de precios detecta que
el piso Wazuh all-in-one + PostgreSQL sin HA supera USD 200/mes; el piso con
PostgreSQL HA es USD 536.84 y Wazuh sigue siendo un solo nodo. Son costos de
cómputo antes del resto del SOC. Antes del apply se deben verificar state, recursos existentes, residencia,
SKU/cuotas, costos completos y latencia real desde la red de QAPAQ. Imágenes
publicadas, restore y ejecución real de conectores también son gates previos a
producción.
