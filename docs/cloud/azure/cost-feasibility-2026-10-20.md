# Viabilidad de costo Azure — Chile Central

**Revalidación:** 2026-10-20 (America/Lima)  
**Moneda:** USD, precios retail públicos sin descuentos ni beneficios de suscripción  
**Límite mensual de referencia:** USD 200  
**Estado:** el tamaño recomendado para Wazuh más PostgreSQL ya excede el límite antes de los demás servicios; no aplicar con este alcance.

## Método y fuentes

Se consultó la [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) para `armRegionName = chilecentral`, `priceType = Consumption`, con tarifas por hora. Los valores mensuales multiplican la tarifa por 730 horas. Son precios de lista, no una cotización de la suscripción; impuestos, descuentos, almacenamiento, tráfico y otros medidores pueden cambiar el total.

Filtros reproducibles:

- VM Wazuh: `armRegionName eq 'chilecentral' and serviceName eq 'Virtual Machines' and armSkuName eq 'Standard_F4s_v2' and priceType eq 'Consumption'`; medidor Linux de consumo regular, excluyendo Windows, Spot y Low Priority.
- PostgreSQL: `armRegionName eq 'chilecentral' and serviceName eq 'Azure Database for PostgreSQL' and priceType eq 'Consumption'`; producto `Flexible Server Burstable BS Series Compute`, SKU `B2S`.
- Alternativa VM reducida: mismo filtro de VM, SKU `Standard_B2ms`, medidor Linux de consumo regular.

La documentación oficial de [Wazuh Quickstart](https://documentation.wazuh.com/current/quickstart.html) recomienda **4 vCPU, 8 GiB y 50 GB** para 1–25 agentes en all-in-one. `Standard_F4s_v2` entrega 4 vCPU y 8 GiB según la [especificación de Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/compute-optimized/fsv2-series).

## Resultado

| Componente | SKU y tarifa observada | 730 h | Alcance incluido |
| --- | ---: | ---: | --- |
| Wazuh all-in-one | `Standard_F4s_v2`, USD 0.237/h | **USD 173.01/mes** | Solo cómputo Linux |
| PostgreSQL Flexible Server | `B2S`, USD 0.0952/h | **USD 69.50/mes** | Solo cómputo Burstable |
| **Piso de cómputo** |  | **USD 242.51/mes** | Sin discos, backups, Container Apps, Ankay, ACR, Key Vault, red, logs ni salida |

El piso supera el límite de referencia de USD 200 en **USD 42.51/mes** antes de sumar cualquiera de los servicios restantes. Los dos valores fueron consultados en la API el 2026-10-20 y tienen `effectiveStartDate` 2025-10-01 para la VM y 2025-04-01 para PostgreSQL.

Una VM `Standard_B2ms` cuesta USD 0.116/h, o **USD 84.68/mes**. Junto con PostgreSQL B2S sumaría **USD 154.18/mes** de cómputo. B2ms entrega 2 vCPU y 8 GiB: no cumple la recomendación de 4 vCPU de Wazuh y deja apenas USD 45.82 para todos los recursos faltantes. No se considera una configuración resiliente ni apta para cargas de estrés; solo puede evaluarse como demo limitada, aceptando menor capacidad y sin objetivo de HA.

La suscripción mostró anteriormente USD 200 de créditos promocionales con vencimiento el 18 de noviembre de 2026. Ese saldo no limita el consumo mensual ni cubre costos después del vencimiento. No se descontó del cálculo.

## Decisión operativa

Con el tope mensual de USD 200, no hay un perfil que a la vez mantenga Wazuh al tamaño recomendado, PostgreSQL, QAPAQ/Ankay, colas, conectores M365/Sophos/Cato, persistencia, observabilidad y la resiliencia solicitada. No se debe presentar una VM subdimensionada como “lista para producción” ni ejecutar `apply` con el alcance actual.

Antes de aplicar, se requiere una de estas decisiones de alcance/costo: aumentar el presupuesto; reducir formalmente la demo y aceptar las limitaciones de B2ms; o mantener los datos y servicios críticos detenidos hasta financiar un perfil operativo. En cualquiera de los casos hay que presupuestar el resto del stack y revisar el plan exacto, almacenamiento/retención, HA y restore. El presupuesto de Terraform solo genera alertas: no impone un tope de gasto.

Este cálculo es un control de viabilidad, no una cotización contractual. La estimación del tenant y el plan Terraform siguen siendo gates previos al despliegue.
