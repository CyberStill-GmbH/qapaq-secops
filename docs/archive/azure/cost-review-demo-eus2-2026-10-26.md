# Revisión de costo — demo EUS2, fundación

**Fecha:** 2026-10-26

**Alcance:** apply `foundation` del state independiente `demo-eus2`.
**No cubre:** VM Wazuh QAPAQ, Azure Firewall, edge público, Ankay/Shuffle,
ingesta de telemetría, agentes, DNS ni servicios de integración. Esos perfiles
siguen apagados y requieren otro plan.

## Costo de referencia y SKU

El plan preliminar local para la fundación indicó 34 altas, pero el plan remoto
posterior al apply parcial debe usarse para cada cambio. El state de bootstrap
vive en otra key y no se modifica.

Azure rechazó dos tamaños Burstable al provisionarlos: `B_Standard_B2s` y
`B_Standard_B1ms`, ambos con `SkuNotAvailable`. El catálogo de capacidades de
East US 2 incluye General Purpose `Standard_D2s_v3`; el siguiente plan lo
selecciona solo para EUS2 (`GP_Standard_D2s_v3` en AzureRM). Es un cambio de
familia y tamaño, no una garantía de cuota/capacidad para esta suscripción.
Microsoft publica D2s v3 a USD 124.83/mes por cómputo Pay-as-you-go en su página
de precios; contrato, región, almacenamiento y uso pueden cambiar el total.
El servidor incluye 32 GiB iniciales y 14 días de backup configurado; el
almacenamiento/backup adicional, dos Storage Accounts, Private Endpoints, Key
Vault, Log Analytics, operaciones y transferencia agregan cargos.
El total de la fundación no es una cotización y no se puede fijar con precisión
sin consumo real y el contrato de esta suscripción.

## Aplicación y verificación del 2026-10-26

Los runs `40418606971` (B2s) y `40420111921` (B1ms) pasaron la validación de plan
y el control contra destrucciones; ambos fallaron al crear PostgreSQL con
`SkuNotAvailable`. El run `40421595800` regeneró el plan contra el state remoto
parcial, verificó el checksum del plan guardado y pasó el control de
destrucciones. El plan exacto tenía **3 altas, 0 destrucciones y 0
reemplazos**: PostgreSQL Flexible Server (`module.data.azurerm_postgresql_flexible_server.this`)
y las bases `qapaq_secops` y `qapaq_jobs`. El apply terminó correctamente.

La consulta ARM posterior confirma PostgreSQL 16 `Standard_D2s_v3` en estado
`Ready` y ambas bases creadas. Key Vault continúa con acceso público deshabilitado.
No se cambió DNS. El apply fue solo de la fundación: `siem_host`, `ankay_host` y
`enable_runtime` siguen deshabilitados; no se publicaron imágenes en ACR ni se
instalaron Wazuh, QAPAQ Core, Ankay, agentes o conectores.

La selección de D2s v3 es EUS2-only; el default compartido de otros entornos
vuelve a B2s. El state remoto se conserva y no se reimportó ni limpió.

El presupuesto Terraform de USD 200/mes solo genera avisos; **no limita ni
detiene el gasto y no ejecuta destroy**. El plan de fundación no aprovisiona
Azure Firewall. El costo de SIEM/Ankay se evaluará por separado: no se debe
interpretar este documento como autorización de gasto para el SOC completo.

Fuentes oficiales:

- [Precios de Azure Database for PostgreSQL Flexible Server](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)
- [Precios de Azure Firewall](https://azure.microsoft.com/en-us/pricing/details/azure-firewall/)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
