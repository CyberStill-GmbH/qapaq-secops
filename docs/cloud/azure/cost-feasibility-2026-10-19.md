# Viabilidad de costo Azure — Chile Central

**Revalidación:** 2026-10-19 (America/Lima)
**Moneda:** USD, tarifa pública retail sin descuentos/beneficios de la suscripción
**Límite vigente del diseño:** USD 200 por mes
**Estado:** cotización incompleta; no se debe aplicar hasta revalidar todos los componentes.

Una nota de sesión anterior registró **USD 200 en créditos** con vencimiento el
18 de noviembre de 2026 y cero recursos en Cloud Shell. No se revalidaron hoy el
saldo, la fecha de vencimiento ni el inventario de recursos; por eso no se usan
como estado actual de la suscripción. Los créditos tampoco equivalen a un límite
mensual de facturación.

## Evidencia y método

Se consultó la [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices), filtrada por `armRegionName = chilecentral` y `priceType = Consumption`. La conversión mensual usa 730 horas; el precio final de la cuenta puede diferir por descuentos, contrato, moneda de facturación o impuestos. La región `chilecentral` corresponde a Santiago según la [lista oficial de regiones](https://learn.microsoft.com/en-us/azure/reliability/regions-list).

Filtros reproducibles usados:

- VM: `armRegionName eq 'chilecentral' and serviceName eq 'Virtual Machines' and armSkuName eq 'Standard_F4s_v2' and priceType eq 'Consumption'`; se tomó el medidor Linux `F4s v2`, no Windows, Spot ni Low Priority.
- PostgreSQL: `armRegionName eq 'chilecentral' and serviceName eq 'Azure Database for PostgreSQL' and armSkuName eq 'B2S' and priceType eq 'Consumption'`.
- Managed Redis (alternativa, no desplegada): `armRegionName eq 'chilecentral' and serviceName eq 'Redis Cache' and priceType eq 'Consumption'`; se seleccionó `Azure Managed Redis - Balanced`, SKU B0.

El [quickstart de Wazuh](https://documentation.wazuh.com/current/quickstart.html) recomienda para 1–25 agentes **4 vCPU, 8 GiB y 50 GB para 90 días** en un despliegue all-in-one. `Standard_F4s_v2` proporciona 4 vCPU y 8 GiB según [la especificación oficial de Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/compute-optimized/fsv2-series).

## Costo mínimo medible y revalidación

- **Wazuh all-in-one:** la consulta actual a Azure Retail Prices API para `chilecentral`,
  `Standard_F4s_v2`, Linux y consumo devolvió USD 0.237/h. A 730 h son **USD 173.01/mes
  solo cómputo**.
- **PostgreSQL Flexible Server:** el valor de USD 0.0952/h para `B2S` que figuraba en la
  revisión anterior no se pudo revalidar hoy: Retail Prices API respondió con limitación
  temporal de solicitudes. Tratar los USD 69.50/mes como **dato provisional**, no como
  tarifa verificada para esta fecha o para la suscripción.
- **Subtotal previo, aún no confirmado:** USD 242.51/mes usando ese valor provisional de
  PostgreSQL; incluye solo cómputo Wazuh y PostgreSQL, antes de discos, copias,
  almacenamiento de evidencia, Container Apps, registro, red, monitorización y salida.
- **Margen dentro del tope de USD 200:** tras el cómputo Wazuh quedarían USD 26.99/mes
  para PostgreSQL y todos los demás componentes. No hay una cotización completa que pruebe
  que ese margen sea suficiente.
- **Cola opcional Azure Managed Redis B0:** USD 0.0224/h × 730 = USD 16.35/mes adicionales; no está implementada en IaC ni conectada al worker. No se suma al subtotal porque ADR-AZ-001 propone PostgreSQL, pero muestra el costo si se elige ese servicio administrado.

El precio de PostgreSQL debe revalidarse con la lista retail regional y la cotización de
la suscripción antes de crear recursos. Las tarifas públicas no sustituyen el estimador
de costo del tenant ni incluyen descuentos.

## Piso para resiliencia zonal

El subtotal previo era un **piso sin HA**: Wazuh es un nodo all-in-one y PostgreSQL usa Burstable `B2S`. Azure documenta que PostgreSQL HA no admite el tier Burstable; Chile Central sí soporta zone-redundant HA ([matriz de región](https://learn.microsoft.com/en-us/azure/postgresql/overview), [requisitos y costo HA](https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql)). Los importes previos para PostgreSQL General Purpose `Standard_D2ads_v5` (USD 0.2492/h) y su standby no se revalidaron el 2026-10-19; los cálculos siguientes son ilustrativos y no una cotización actual:

- PostgreSQL `D2ads_v5` primary + standby: USD 0.2492 × 2 × 730 = **USD 363.83/mes** solo cómputo.
- Más el mínimo Wazuh all-in-one calculado arriba: **USD 536.84/mes**, todavía sin discos, backup, red, Container Apps, Ankay ni alta disponibilidad del propio Wazuh.

La [oferta gratuita de Azure](https://azure.microsoft.com/en-us/pricing/free-services/) anuncia PostgreSQL B1MS por 750 h/mes, 32 GB de storage y 32 GB de backup durante 12 meses; requiere una suscripción elegible de Azure Free y no cubre la configuración General Purpose HA. No pude comprobar la elegibilidad de esta suscripción. No la descuento del piso ni la trato como financiación recurrente.

## Conclusión de viabilidad

La revalidación confirma que el cómputo Wazuh recomendado consume USD 173.01/mes,
pero no revalidó PostgreSQL ni el costo total de la cuenta. El subtotal previo de
USD 242.51 y el escenario PostgreSQL HA de USD 536.84 quedan como estimaciones de
trabajo hasta recalcularlos con precios actuales y la cotización del tenant. Ninguno
incluye discos, backups, tráfico, Container Apps, Ankay, Log Analytics, ACR ni el
Wazuh distribuido que exigiría un objetivo real de alta disponibilidad y estrés. El
root actual además crea cinco Container Apps con `min_replicas = 1` al activar
`enable_runtime`; Wazuh y Ankay todavía no están incluidos en esa IaC. Encender ese
runtime no produciría el SOC solicitado y el presupuesto configurado solo envía
avisos; no corta consumo.

No reduciré Wazuh por debajo del tamaño recomendado, co-localizaré datos confidenciales
y runtime para simular ahorro, ni desplegaré un stack parcial como si fuera resiliente.
Para conservar Wazuh/M365 activo 24/7, QAPAQ, persistencia, Ankay y conectores, el gate
de presupuesto requiere una cotización completa por SKU, datos/retención y tráfico.
**No se debe aplicar el stack** hasta revalidar PostgreSQL, almacenamiento, red,
observabilidad, Ankay y cargos de la suscripción y compararlos con el límite de USD 200.

## Implicaciones para Terraform

1. No habilitar `enable_runtime` ni crear el primer state hasta tener el estimado completo y el presupuesto aprobado.
2. Obtener la cotización del tenant/contrato y calcular al menos Wazuh + disco de datos + backups, PostgreSQL, Container Apps, Log Analytics, ACR, Key Vault, IP/egress, storage/retención y Ankay.
3. Reconciliar costo y disponibilidad con el contrato real de cola; actualmente `apps/worker` no consume BullMQ y Terraform no puede declarar ese costo como funcionalidad entregada.
4. Mantener cualquier plan/apply separado para que el delta de recursos, costo, `prevent_destroy`, DNS y referencias de Key Vault se pueda revisar antes de ejecución.

Esta nota es una estimación de viabilidad, no una cotización contractual ni autorización
de despliegue. La última consulta confirmada de precio se realizó el 2026-10-19; el
valor de PostgreSQL requiere repetirse cuando la API deje de limitar solicitudes.
