# Cloud architecture — Azure

Esta documentación describe solo el destino Azure. No es una traducción literal
de la arquitectura AWS y no modifica la documentación/demo AWS.

- [Arquitectura y límites](architecture.md)
- [ADR Azure: BullMQ sobre PostgreSQL](decisions/adr-azure-queue-postgres.md)
- [Diagrama de despliegue](diagrams/qapaq-azure.mmd)
- [Runbook de secretos, notificaciones y DNS](runbook-preparacion-y-corte.md)
- [Viabilidad de costos en Chile Central, revalidada 2026-10-20](cost-feasibility-2026-10-20.md)
- [Terraform Azure](../../../infra/azure/README.md)

Estado al **2026-10-24**: **canal privado de artefactos aplicado; runtime no desplegado**.
La [auditoría de disponibilidad](operational-readiness-2026-10-24.md) registra
la evidencia más reciente de CI, configuración de runtime, runner y Key Vault.
El workflow de `main` [#40065066444](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40065066444)
terminó sus 14 jobs correctamente; esto valida el código, no el despliegue Azure.
No hay perfil SOC habilitado ni evidencia de Wazuh/Ankay operativo.

Como antecedente del bootstrap, PR [#100](https://github.com/CyberStill-GmbH/qapaq-secops/pull/100),
integrado en `main` (`048716ada8e3e5e077b044888b1291ec101506d4`), añadió validación
de referencias Key Vault y pruebas Terraform sin modificar infraestructura. Sus runs
[39773533408](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533408)
y [39773533266](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533266)
son evidencia histórica; para el estado actual, consultar la auditoría enlazada arriba.

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
por proximidad geográfica a Perú. La revalidación oficial del 2026-10-20 mide un
piso de lista estimado de USD 242.51/mes por cómputo de Wazuh recomendado y PostgreSQL B2S.
No es una cotización del tenant. Al sumar el egress firewall requerido por los módulos host, el piso sube a USD
530.86/mes con Firewall Basic o USD 1,155.01/mes con Standard, antes del
procesamiento, discos y demás servicios. Ambos exceden el umbral de alertas de
USD 200, que no es un límite de facturación ni apaga recursos. Antes de `apply`
se deben revisar el costo completo, el plan exacto, state/recursos, residencia,
SKU/cuotas y latencia real desde la red de QAPAQ. Imágenes publicadas, restore y
conectores probados también son gates de producción.
