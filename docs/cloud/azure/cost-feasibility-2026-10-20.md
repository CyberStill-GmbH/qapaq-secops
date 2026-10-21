# Viabilidad de costo Azure — Chile Central

**Revalidación:** 2026-10-20 (America/Lima)  
**Moneda:** USD, precios retail públicos sin descuentos ni beneficios de suscripción  
**Umbral mensual de alertas:** USD 200 (no es un tope de gasto)
**Estado:** el piso de cómputo supera el umbral antes de los demás servicios; la cotización total y el plan exacto siguen pendientes de revisión antes del apply.

## Método y fuentes

Se consultó la [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) para `armRegionName = chilecentral`, `priceType = Consumption`, con tarifas por hora. Los valores mensuales multiplican la tarifa por 730 horas. Son precios de lista, no una cotización de la suscripción; impuestos, descuentos, almacenamiento, tráfico y otros medidores pueden cambiar el total.

Filtros reproducibles:

- VM Wazuh: `armRegionName eq 'chilecentral' and serviceName eq 'Virtual Machines' and armSkuName eq 'Standard_F4s_v2' and priceType eq 'Consumption'`; medidor Linux de consumo regular, excluyendo Windows, Spot y Low Priority.
- PostgreSQL: `armRegionName eq 'chilecentral' and serviceName eq 'Azure Database for PostgreSQL' and priceType eq 'Consumption'`; producto `Flexible Server Burstable BS Series Compute`, SKU `B2S`.
- Alternativa VM reducida: mismo filtro de VM, SKU `Standard_B2ms`, medidor Linux de consumo regular.
- Azure Firewall: `armRegionName eq 'chilecentral' and serviceName eq 'Azure Firewall' and priceType eq 'Consumption'`; medidores `Basic Deployment`, `Basic Data Processed`, `Standard Deployment` y `Standard Data Processed`. La consulta puede reproducirse en la [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?%24filter=armRegionName%20eq%20%27chilecentral%27%20and%20serviceName%20eq%20%27Azure%20Firewall%27%20and%20priceType%20eq%20%27Consumption%27).

La documentación oficial de [Wazuh Quickstart](https://documentation.wazuh.com/current/quickstart.html) recomienda **4 vCPU, 8 GiB y 50 GB** para 1–25 agentes en all-in-one. `Standard_F4s_v2` entrega 4 vCPU y 8 GiB según la [especificación de Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/compute-optimized/fsv2-series).

## Resultado

| Componente | SKU y tarifa observada | 730 h | Alcance incluido |
| --- | ---: | ---: | --- |
| Wazuh all-in-one | `Standard_F4s_v2`, USD 0.237/h | **USD 173.01/mes** | Solo cómputo Linux |
| PostgreSQL Flexible Server | `B2S`, USD 0.0952/h | **USD 69.50/mes** | Solo cómputo Burstable |
| **Piso de cómputo** |  | **USD 242.51/mes** | Sin discos, backups, Container Apps, Ankay, ACR, Key Vault, red, logs ni salida |

El módulo `siem_host` requiere egress controlado a través de Azure Firewall. La consulta de precios del mismo día devuelve Basic a USD 0.395/h más USD 0.065/GB procesado y Standard a USD 1.25/h más USD 0.016/GB procesado. Con 730 horas al mes, el fijo de Firewall es USD 288.35 para Basic y USD 912.50 para Standard, antes del procesamiento y de IP pública. El piso combinado Wazuh + PostgreSQL + Firewall queda, por tanto, en **USD 530.86/mes con Basic** o **USD 1,155.01/mes con Standard**, sin el resto del SOC.

Basic admite filtrado FQDN para HTTP/S, pero limita el throughput a 250 Mbps, no tiene DNS proxy y deja la inteligencia de amenazas en modo alerta. Standard ofrece filtrado de inteligencia de amenazas en modo deny y DNS proxy, con un costo fijo sustancialmente superior. Si la política de la financiera exige bloquear por threat intelligence en el firewall, Basic no la satisface; la decisión de SKU debe quedar explícita en el modelo de amenazas y ser aceptada por el responsable antes de plan/apply. Consultar la [matriz oficial de capacidades por SKU](https://learn.microsoft.com/en-us/azure/firewall/features-by-sku).

El piso de Wazuh + PostgreSQL, sin firewall, supera el umbral de alertas de USD 200 en **USD 42.51/mes** antes de sumar cualquiera de los servicios restantes. Las tarifas de cómputo base fueron consultadas en la API el 2026-10-20 y tienen `effectiveStartDate` 2025-10-01 para la VM y 2025-04-01 para PostgreSQL.

Una VM `Standard_B2ms` cuesta USD 0.116/h, o **USD 84.68/mes**. Junto con PostgreSQL B2S sumaría **USD 154.18/mes** de cómputo. B2ms entrega 2 vCPU y 8 GiB: no cumple la recomendación de 4 vCPU de Wazuh y deja apenas USD 45.82 para todos los recursos faltantes. No se considera una configuración resiliente ni apta para cargas de estrés; solo puede evaluarse como demo limitada, aceptando menor capacidad y sin objetivo de HA.

La suscripción mostró USD 200 de créditos promocionales con vencimiento el 18 de noviembre de 2026. Ese saldo no limita el consumo mensual y puede agotarse antes de que termine el mes; los cargos posteriores podrían facturarse según las condiciones de la suscripción. No se descontó del cálculo.

## Decisión operativa

El piso medido de USD 242.51/mes supera el umbral de notificación de USD 200, y aún faltan cómputo, almacenamiento, respaldo, observabilidad, Ankay y egreso. El dueño del proyecto decidió usar USD 200 como umbral de aviso, sin apagado ni destrucción automática; por tanto, la cifra no es un límite de facturación. No se debe presentar una VM subdimensionada como “lista para producción”.

Antes de aplicar, completar la cotización del stack y registrar la proyección, los posibles cargos por encima de los créditos y los efectos de cada recurso. Mantener el presupuesto Terraform de USD 200 como alerta solamente; no incorporar apagado ni `destroy` automático. Revisar el plan exacto, almacenamiento/retención, HA y restore antes de ejecutar.

Este cálculo es un control de viabilidad, no una cotización contractual. La estimación del tenant y el plan Terraform siguen siendo gates previos al despliegue.

## Reconciliación con el diseño Azure QAPAQ vigente

La cifra de este informe cubre únicamente los SKU explicitados en cada escenario.
El objetivo A22 añade `qapaq-core` al host SIEM y no requiere una VM de API/worker
separada; sí requiere dimensionamiento de memoria/CPU y PostgreSQL privado. A9
requiere además Valkey compatible con Valkey, TLS, auth y capacidad persistente, y
A13 requiere una VM privada separada para Ankay/Shuffle completo y su OpenSearch.
No se ha cotizado ninguno de estos componentes adicionales ni los discos de datos,
backups, egreso, Key Vault, ACR, reglas de red y observabilidad.

Por ello, el piso de los escenarios de Wazuh + PostgreSQL no equivale al precio
final del objetivo y no permite asegurar que el stack completo quede bajo USD 200
ni bajo un crédito promocional. USD 200 permanece configurado como umbral de
alerta, sin apagado ni `destroy`; calcular el costo restante con precios de la
suscripción, SKU disponibles, capacidad y retención elegidas antes de aprobar un
plan. El documento no constituye una cotización contractual.
