# Revisión de costo — SIEM QAPAQ, East US 2

**Fecha:** 2026-10-30

**Alcance:** apply `siem` del state aislado `demo-eus2` con el plan remoto del run [41146741360](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/41146741360).

**Commit del plan:** `bedd9cbb53c7f02c3ac7a3de67d0bd4375dad6ee`.

## Plan revisado

Terraform planificó **3 recursos con cambios, 0 destrucciones y 0 reemplazos**:

- Actualización de la colección de reglas de egreso de Azure Firewall.
- Alta de una asignación RBAC de mínimo privilegio para que la identidad administrada del SIEM lea únicamente el secreto de API de Claude previsto para Qapaqzito.
- Actualización de la extensión de bootstrap de la VM SIEM existente. La VM y su disco de datos permanecen protegidos y no se reemplazan.

El plan no crea una segunda VM ni incorpora Ankay; el alcance seleccionado es `siem`.

## Estimación mensual de referencia

La consulta del **Azure Retail Prices API** del 2026-10-30, para East US 2 y consumo PAYG, devolvió:

| Recurso existente requerido por el SIEM | Precio unitario | Referencia mensual (730 h) |
| --- | ---: | ---: |
| VM Linux `Standard_E4bds_v5` | USD 0.334/h | USD 243.82 |
| Azure Firewall Basic — deployment | USD 0.395/h | USD 288.35 |
| **Piso de cómputo y firewall** |  | **USD 532.17/mes** |

El firewall Basic añade USD 0.065 por GB procesado. La estimación no incluye procesamiento de firewall, disco administrado de 128 GB, IP pública, transferencia, Log Analytics, backup, PostgreSQL ni otros servicios y consumo variable. Las tres acciones del plan son cambios sobre recursos existentes más una asignación de identidad; los precios de arriba son el piso mensual de la infraestructura SIEM requerida, **no el costo incremental** de esas tres acciones ni una cotización de la suscripción. Descuentos del contrato, impuestos y consumo real pueden cambiar la factura.

El presupuesto configurado de USD 200/mes genera alertas; no limita ni detiene el gasto.

## Fuentes de precio

- [Azure Retail Prices API — VM Linux E4bds v5 en East US 2](https://prices.azure.com/api/retail/prices?%24filter=armRegionName%20eq%20%27eastus2%27%20and%20armSkuName%20eq%20%27Standard_E4bds_v5%27%20and%20priceType%20eq%20%27Consumption%27)
- [Azure Retail Prices API — Azure Firewall en East US 2](https://prices.azure.com/api/retail/prices?%24filter=armRegionName%20eq%20%27eastus2%27%20and%20serviceName%20eq%20%27Azure%20Firewall%27%20and%20priceType%20eq%20%27Consumption%27)
- [Documentación oficial del Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- [Precios oficiales de Azure Firewall](https://azure.microsoft.com/en-us/pricing/details/azure-firewall/)
