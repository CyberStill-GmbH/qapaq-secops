# Revisión de costo — demo EUS2, fundación

**Fecha:** 2026-10-26

**Alcance:** primer apply `foundation` del state independiente `demo-eus2`.
**No cubre:** VM Wazuh QAPAQ, Azure Firewall, edge público, Ankay/Shuffle,
ingesta de telemetría, agentes, DNS ni servicios de integración. Esos perfiles
siguen apagados y requieren otro plan.

## Resultado revisado

El plan preliminar local para la fundación indicó **34 altas, 0 cambios y 0
destrucciones**. El plan definitivo será el artifact del workflow de GitHub
Actions; no aplicar si sus recursos o conteos difieren sin revisión. El state de
bootstrap vive en otra key y no se modifica.

El plan inicial intentó PostgreSQL Flexible Server Burstable
`B_Standard_B2s`, pero Azure devolvió `SkuNotAvailable` al provisionarlo en
East US 2. El siguiente plan usa `B_Standard_B1ms`, sujeto a que Azure confirme
su disponibilidad efectiva al crear el servidor. No se debe tratar la tarifa
anterior de B2s como costo aplicable al SKU alternativo. El servidor incluye
32 GiB iniciales y 14 días de backup configurado; el almacenamiento y backup
adicional, dos Storage Accounts (ZRS para eventos y LRS para releases), Private
Endpoints, Key Vault, Log Analytics, operaciones y transferencia pueden agregar
cargos.
El total de la fundación no es una cotización y no se puede fijar con precisión
sin consumo real y el contrato de esta suscripción.

## Resultado del primer apply

El run `40418606971` pasó la validación de plan y su control contra
destrucciones. El apply creó parte de la base (Storage de evidencia/releases,
contenedores, endpoints privados y permisos) y falló solo al crear PostgreSQL
con B2s por `SkuNotAvailable`. Terraform registró el estado parcial en el
backend remoto. El nuevo plan debe refrescar ese state antes de reintentar; no
se debe volver a inicializar ni limpiar el backend.

El presupuesto Terraform de USD 200/mes solo genera avisos; **no limita ni
detiene el gasto y no ejecuta destroy**. El plan de fundación no aprovisiona
Azure Firewall. El costo de SIEM/Ankay se evaluará por separado: no se debe
interpretar este documento como autorización de gasto para el SOC completo.

Fuentes oficiales:

- [Precios de Azure Database for PostgreSQL Flexible Server](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)
- [Precios de Azure Firewall](https://azure.microsoft.com/en-us/pricing/details/azure-firewall/)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
