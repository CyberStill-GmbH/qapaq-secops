# Cloud architecture — Azure

Esta documentación describe solo el destino Azure. No es una traducción literal
de la arquitectura AWS y no modifica la documentación/demo AWS.

- [Arquitectura y límites](architecture.md)
- [ADR Azure: BullMQ sobre PostgreSQL](decisions/adr-azure-queue-postgres.md)
- [Diagrama de despliegue](diagrams/qapaq-azure.mmd)
- [Runbook de secretos, notificaciones y DNS](runbook-preparacion-y-corte.md)
- [Viabilidad de costos en Chile Central, revalidada 2026-10-20](cost-feasibility-2026-10-20.md)
- [Terraform Azure](../../../infra/azure/README.md)

Estado: **preparación local; despliegue sin verificar**. No se ejecutó `plan`
remoto, `apply` ni cutover DNS, y no hay evidencia actual del state remoto o del
inventario Azure. La región base es **Chile Central** (`chilecentral`), seleccionada
por proximidad geográfica a Perú. La revalidación oficial del 2026-10-20 mide un
piso de USD 242.51/mes por cómputo de Wazuh recomendado y PostgreSQL B2S, antes del
resto del SOC; excede el límite mensual de USD 200. Por ello, el diseño no está
listo para `apply` con ese presupuesto. Antes de hacerlo se deben resolver alcance
y presupuesto, verificar state/recursos, residencia, SKU/cuotas, costo completo y
latencia real desde la red de QAPAQ. Imágenes publicadas, restore y conectores
probados también son gates de producción.
