# Cloud architecture — Azure

Esta documentación describe solo el destino Azure. No es una traducción literal
de la arquitectura AWS y no modifica la documentación/demo AWS.

- [Arquitectura y límites](architecture.md)
- [Arquitectura objetivo EUS2 y perfil de despliegue](target-architecture-demo-eus2.md)
- [ADR Azure: BullMQ sobre PostgreSQL](decisions/adr-azure-queue-postgres.md)
- [Diagrama de despliegue](diagrams/qapaq-azure.mmd)
- [Runbook de secretos, notificaciones y DNS](runbook-preparacion-y-corte.md)
- [Bootstrap aislado EUS: identidad OIDC y Terraform state](bootstrap-eus.md)
- [Runbook Terraform de East US 2](runbook-demo-eus2.md)
- [Revisión de costo de la fundación demo EUS2](cost-review-demo-eus2-2026-10-26.md)
- [Revisión de costo del SIEM QAPAQ EUS2](cost-review-siem-eus2-2026-10-30.md)
- [Readiness operativa verificada 2026-10-26](operational-readiness-2026-10-26.md)
- [Viabilidad de costos en Chile Central, revalidada 2026-10-20](cost-feasibility-2026-10-20.md)
- [Terraform Azure](../../../infra/azure/README.md)

Estado al **2026-10-27**: la fundación aislada de East US 2 está aplicada; el runtime SOC
continúa sin desplegar. El run [40421595800](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40421595800)
completó PostgreSQL Flexible Server 16 y las bases `qapaq_secops`/`qapaq_jobs` con
`Standard_D2s_v3`, sin destrucciones. La región de este demo es East US 2; la residencia
productiva sigue pendiente de aprobación.

El run [40453658942](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40453658942)
publicó y verificó el bundle QAPAQ SIEM fijado por SHA en el Blob privado de EUS2. El
workflow impide sobrescribir un blob existente con bytes distintos. Esto
deja listo un artefacto versionado para el bootstrap; no instaló el SIEM ni habilitó el
host, firewall, Ankay o DNS. El perfil común no secreto y el workflow que lo consume
están descritos en la [arquitectura objetivo EUS2](target-architecture-demo-eus2.md).

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
para usar. DNS permanece sin corte. La estimación de Chile Central y su piso de costo
se conservan como análisis histórico, no como precio de esta demo EUS2; revisar
[`cost-review-demo-eus2-2026-10-26.md`](cost-review-demo-eus2-2026-10-26.md).
USD 200/mes es solo umbral de alertas, no límite de facturación ni apagado. Antes de
ampliar la fundación se deben revisar el costo total, el plan exacto, state/recursos,
residencia, SKU/cuota y latencia real desde la red de QAPAQ. Imágenes publicadas,
restore y conectores probados también son gates de producción.
