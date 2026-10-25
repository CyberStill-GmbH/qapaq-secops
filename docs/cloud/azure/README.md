# Cloud architecture — Azure

Esta documentación describe solo el destino Azure. No es una traducción literal
de la arquitectura AWS y no modifica la documentación/demo AWS.

- [Arquitectura y límites](architecture.md)
- [ADR Azure: BullMQ sobre PostgreSQL](decisions/adr-azure-queue-postgres.md)
- [Diagrama de despliegue](diagrams/qapaq-azure.mmd)
- [Runbook de secretos, notificaciones y DNS](runbook-preparacion-y-corte.md)
- [Estimación vigente de costos en Chile Central, consulta 2026-10-22](cost-feasibility-2026-10-22.md)
- [Estimación anterior del piso Wazuh + PostgreSQL, consulta 2026-10-20](cost-feasibility-2026-10-20.md)
- [Terraform Azure](../../../infra/azure/README.md)

Estado al **2026-10-22**: **canal privado de artefactos aplicado; runtime no desplegado**.
La validación más reciente de código corresponde a PR
[#100](https://github.com/CyberStill-GmbH/qapaq-secops/pull/100), integrado en
`main` (`048716ada8e3e5e077b044888b1291ec101506d4`). Añadió únicamente validación
de referencia Key Vault y pruebas Terraform; no modifica infraestructura. La
validación Azure Terraform [39773533408](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533408)
está verde; CI Security [39773533266](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533266)
seguía en progreso al redactar.

El estado de infraestructura confirmado por Actions es:

- [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034)
  aplicó únicamente cuatro recursos del canal de releases: Storage dedicado,
  contenedor privado, private endpoint y permiso RBAC de publicación; el plan fue
  **4 altas, 0 cambios, 0 destrucciones**.
- [39768505115](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39768505115)
  generó un plan **0 altas, 1 cambio in-place, 0 destrucciones** para las reglas de
  red del Storage (`default_action=Allow` y `AzureServices`); el paso `apply` fue
  omitido. Ese cambio no está aplicado.
- [39771791770](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39771791770)
  está esperando aprobación del environment protegido `azure-demo`; todavía no
  ejecutó un plan y no es evidencia de un cambio de infraestructura.

No hay evidencia de un runtime Wazuh/QAPAQ o Ankay desplegado, saludable o listo
para usar. DNS permanece sin corte. El run 39766635034 acredita solo el apply del
canal de releases, no el despliegue del producto. La región base es **Chile Central** (`chilecentral`), seleccionada
por proximidad geográfica a Perú. La estimación vigente consultó la Retail Prices API
el 2026-10-22: el modelo completo descrito allí suma **USD 1,106.93/mes con Firewall
Basic** o **USD 1,726.18/mes con Standard**, antes de costos omitidos y sin ser una
cotización del tenant. La estimación del 2026-10-20 se conserva como un cálculo
anterior y acotado de Wazuh + PostgreSQL. USD 200/mes es un umbral de aviso: no
limita la facturación, no apaga recursos y no activa `destroy`. Antes de `apply`
se deben revisar el costo completo, el plan exacto, state/recursos, residencia,
SKU/cuotas y latencia real desde la red de QAPAQ. Imágenes publicadas, restore y
conectores probados también son gates de producción.
