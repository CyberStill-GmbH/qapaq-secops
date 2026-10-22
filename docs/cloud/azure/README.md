# Cloud architecture — Azure

Esta documentación describe solo el destino Azure. No es una traducción literal
de la arquitectura AWS y no modifica la documentación/demo AWS.

- [Arquitectura y límites](architecture.md)
- [ADR Azure: BullMQ sobre PostgreSQL](decisions/adr-azure-queue-postgres.md)
- [Diagrama de despliegue](diagrams/qapaq-azure.mmd)
- [Runbook de secretos, notificaciones y DNS](runbook-preparacion-y-corte.md)
- [Viabilidad de costos en Chile Central, revalidada 2026-10-20](cost-feasibility-2026-10-20.md)
- [Terraform Azure](../../../infra/azure/README.md)

Estado: **canal de artefactos aplicado; runtime sin desplegar**. El workflow
[39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034)
aplicó cuatro altas y cero cambios o destrucciones para el Storage de releases,
su contenedor privado, private endpoint y permiso OIDC de publicación. No se hizo
cutover DNS. El runtime Wazuh y Ankay sigue apagado/no verificado. La región base es
**Chile Central** (`chilecentral`), seleccionada
por proximidad geográfica a Perú. La revalidación oficial del 2026-10-20 mide un
piso de USD 242.51/mes por cómputo de Wazuh recomendado y PostgreSQL B2S. Al
sumar el egress firewall requerido por los módulos host, el piso sube a USD
530.86/mes con Firewall Basic o USD 1,155.01/mes con Standard, antes del
procesamiento, discos y demás servicios. Ambos exceden el umbral de alertas de
USD 200, que no es un límite de facturación ni apaga recursos. Antes de `apply`
se deben revisar el costo completo, el plan exacto, state/recursos, residencia,
SKU/cuotas y latencia real desde la red de QAPAQ. Imágenes publicadas, restore y
conectores probados también son gates de producción.
