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

El costo fijo más claro de esta fase es PostgreSQL Flexible Server Burstable
`B_Standard_B2s`: la página de precios de Microsoft muestra USD 49.64/mes para
B2s. El servidor incluye 32 GiB iniciales y 14 días de backup configurado; el
almacenamiento y backup adicional, dos Storage Accounts (ZRS para eventos y LRS
para releases), Private Endpoints, Key Vault, Log Analytics, operaciones y
transferencia pueden agregar cargos.
El total de la fundación no es una cotización y no se puede fijar con precisión
sin consumo real y el contrato de esta suscripción.

El presupuesto Terraform de USD 200/mes solo genera avisos; **no limita ni
detiene el gasto y no ejecuta destroy**. El plan de fundación no aprovisiona
Azure Firewall. El costo de SIEM/Ankay se evaluará por separado: no se debe
interpretar este documento como autorización de gasto para el SOC completo.

Fuentes oficiales:

- [Precios de Azure Database for PostgreSQL Flexible Server](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)
- [Precios de Azure Firewall](https://azure.microsoft.com/en-us/pricing/details/azure-firewall/)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
