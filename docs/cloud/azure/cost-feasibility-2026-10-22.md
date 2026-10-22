# Viabilidad de costo Azure — Chile Central

**Consulta:** 2026-10-22 (America/Lima)  
**Moneda:** USD, precio retail público, sin descuentos, impuestos ni crédito promocional  
**Región:** `chilecentral` (Santiago)  
**Presupuesto de referencia:** USD 200/mes como umbral de aviso; no es límite de gasto  
**Estado de infraestructura:** estimación documental; **no se aplicó ni desplegó** esta arquitectura

## Resumen

El costo orientativo del objetivo Azure 24/7 queda en **USD 1,110.58/mes** con Azure Firewall Basic y en **USD 1,729.83/mes** con Standard, antes del egress de Internet, Log Analytics, crecimiento de datos y servicios de proveedores. Ambos casos mantienen Wazuh y Ankay como hosts únicos; el PostgreSQL y el Redis-compatible se modelan con HA, pero eso **no convierte el SOC completo en HA**.

El presupuesto de USD 200 no alcanza para el objetivo completo. Una demo recortada con Wazuh/QAPAQ en una VM, persistencia local y controles de red acotados puede acercarse al umbral, pero excluye Ankay, firewall administrado, base de datos/cache administradas, backups y observabilidad facturada. No debe presentarse como arquitectura resiliente ni como despliegue productivo.

## Método y supuestos

Se consultó la [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices), filtrada por `armRegionName=chilecentral` y `priceType=Consumption`, el 2026-10-22. La conversión mensual usa 730 horas. Se seleccionaron medidores Linux de consumo normal; se excluyeron Windows, Spot, Low Priority y descuentos. Son tarifas de lista, no una cotización de esta suscripción.

La arquitectura de cálculo representa el diseño documentado de Wazuh/QAPAQ con un host SIEM, PostgreSQL privado y caché compatible con Redis, ambos con alta disponibilidad. Ankay/Shuffle se ejecuta en un host privado separado. El modelo también incluye ACR, firewall de salida y una IP pública estática para el edge. Se incluye Firewall Basic como variante más barata, aunque solo opera threat intelligence en modo alerta; la variante Standard habilita deny. El IP público es una aproximación de entrada al edge; no incluye un Load Balancer ni Application Gateway. El Terraform actual no despliega el SOC completo, el Firewall, DNS/TLS ni el flujo de BullMQ en Azure.

Supuestos de tamaño:

- Wazuh all-in-one: `Standard_F4s_v2`, Linux, 4 vCPU y 8 GiB, **USD 0.237/h**. Wazuh Quickstart recomienda 4 vCPU, 8 GiB y 50 GB para 1–25 agentes; la cifra no garantiza capacidad para cualquier volumen de índices o retención.
- Ankay separado: `Standard_D4as_v5`, Linux, 4 vCPU y 16 GiB, **USD 0.242/h**. Es una hipótesis de sizing, no una recomendación oficial ni un tamaño validado con Shuffle/OpenSearch bajo carga.
- PostgreSQL Flexible Server HA: `Standard_D2ads_v5` General Purpose, **USD 0.2492/h por nodo**, dos nodos; storage de 32 GiB a **USD 0.161/GiB-mes**. No se modelan crecimiento de datos ni IOPS adicionales.
- Azure Managed Redis Balanced B0 HA: **USD 26.28/mes**, estimado como dos nodos al precio público de USD 13.14/nodo-mes. No se considera implementación de Valkey ni se afirma compatibilidad operativa con BullMQ; SKU, memoria y comportamiento deben probarse antes de elegirlo.
- Discos Linux: SIEM Premium SSD LRS P6 (64 GiB) para SO y P10 (128 GiB) para datos; Ankay Standard SSD LRS E6 (64 GiB) para SO y E10 (128 GiB) para datos. El sizing de los discos es un supuesto de esta estimación; imágenes, crecimiento y backups pueden exigir más.
- Azure Firewall procesa 100 GB/mes en cada variante; egress de Internet no supera los primeros 100 GB/mes del medidor consultado.
- ACR Basic todo el mes, IP pública estática Standard todo el mes. No se incluyen cobros de transferencia o almacenamiento adicionales del registry.
- PostgreSQL conserva 14 días de backup. Se presupone que backup almacenado no excede la cuota incluida equivalente al storage aprovisionado; cualquier exceso se cobra aparte.

## Estimado 24/7 por recurso

| Recurso | SKU / supuesto | Cálculo mensual | USD/mes |
| --- | --- | ---: | ---: |
| Host Wazuh QAPAQ | F4s v2 Linux | 0.237 × 730 h | 173.01 |
| Disco SO Wazuh | Premium SSD P6 LRS, 64 GiB | precio mensual del medidor | 13.02 |
| Disco datos Wazuh | Premium SSD P10 LRS, 128 GiB | precio mensual del medidor | 25.15 |
| PostgreSQL HA | D2ads v5, primary + standby | 0.2492 × 2 × 730 h | 363.83 |
| Storage PostgreSQL | 32 GiB | 0.161 × 32 | 5.15 |
| Backup PostgreSQL | Hasta cuota incluida | Sin exceso supuesto | 0.00* |
| Host Ankay | D4as v5 Linux | 0.242 × 730 h | 176.66 |
| Disco SO Ankay | Standard SSD E6 LRS, 64 GiB | precio mensual del medidor | 6.72 |
| Disco datos Ankay | Standard SSD E10 LRS, 128 GiB | precio mensual del medidor | 13.44 |
| Azure Firewall Basic | fijo | 0.395 × 730 h | 288.35 |
| Procesamiento Firewall Basic | 100 GB/mes | 0.065 × 100 | 6.50 |
| Managed Redis B0 HA | dos nodos, sujeto a validar SKU | precio publicado estimado | 26.28 |
| ACR Basic | Registry Unit | 0.17 × 30.4167 días | 5.17 |
| IP pública estática Standard | un IP | 0.01 × 730 h | 7.30 |
| Egress de Internet | hasta 100 GB/mes | primer tramo observado a USD 0 | 0.00* |
| **Subtotal Basic** | **componentes enumerados** |  | **1,110.58** |

La variante Firewall Standard cuesta USD 912.50/mes fijo y USD 0.016/GB procesado. Para los mismos 100 GB, el total estimado pasa a **USD 1,729.83/mes**. El total Standard es más alto pese a su menor precio por GB, por el cargo fijo del servicio.

`*` No significa costo garantizado cero: backup por encima de la cuota, egress sobre el tramo incluido y otros medidores añaden cargos. Una salida de 1,000 GB/mes, con 100 GB en tramo gratuito y 900 GB a USD 0.08/GB, añade aproximadamente **USD 72/mes**. Firewall procesa datos con un medidor distinto.

El total no incluye Application Gateway/WAF, balanceador, Log Analytics, Key Vault, DNS/registro de dominio, almacenamiento de evidencia, copias de discos, métricas/alertas adicionales, ACR más allá de Basic, ni licencias o cuotas de Sophos, Cato, Microsoft 365 y VirusTotal. Tampoco incluye una segunda VM Wazuh, redundancia de Ankay, réplica multi-región o un plan de recuperación regional. La región Chile Central tiene tres zonas, pero una región zonal no hace automáticamente redundantes las VMs ni todos los servicios.

### Firewall recomendado y delta

| Variante | Fijo 730 h | Procesamiento 100 GB | Delta frente a Basic total |
| --- | ---: | ---: | ---: |
| Basic | 288.35 | 6.50 | — |
| Standard | 912.50 | 1.60 | +619.25/mes |

Basic es el menor precio publicado, pero Azure documenta límite de 250 Mbps y threat intelligence solo en modo alerta; Standard soporta deny y mayor rendimiento. Si la política requiere bloquear destinos de threat intelligence en Azure Firewall, Basic no cumple. NSG por sí solo no sustituye un firewall de salida con inspección.

## Costo marginal de una demo de 4 horas

Estimación de arranque durante 4 horas del escenario Basic, suponiendo 10 GB procesados por Firewall en ese intervalo, 4 GB de salida a Internet que todavía estén dentro de la cuota mensual y cuatro horas efectivas de recursos encendidos:

| Concepto | Estimado de 4 h |
| --- | ---: |
| VMs Wazuh, Ankay y PostgreSQL HA | 3.91 |
| Firewall Basic fijo | 1.58 |
| Redis HA e IP estática | 0.18 |
| Discos y storage PostgreSQL prorrateados | 0.35 |
| ACR Basic: un día de registry | 0.17 |
| Firewall: 10 GB procesados | 0.65 |
| Egress: 4 GB bajo el tramo incluido | 0.00* |
| **Marginal estimado por 4 h** | **6.84** |

Los costos se calculan con los mismos medidores mensuales prorrateados por 4/730 h; el ACR usa el medidor de precio diario. La estimación excluye creación/carga inicial, imágenes, backup, logs y transferencia de evidencia. Si Firewall procesa 100 GB durante esas cuatro horas, añade USD 6.50; al superar los primeros 100 GB de Internet del mes, egress se añade según la tarifa regional. No equivale al costo de una demo completa ni a un presupuesto máximo.

## Opción demo con aviso de USD 200

El siguiente recorte se acerca al umbral, **no conserva el alcance completo**:

| Recurso mantenido | SKU / modo | USD/mes |
| --- | --- | ---: |
| Wazuh y QAPAQ Core juntos | D4as v5 Linux 4 vCPU/16 GiB, una VM | 176.66 |
| Disco SO | Standard HDD S6 LRS, 64 GiB | 4.21 |
| Disco de datos | Standard HDD S10 LRS, 128 GiB | 8.24 |
| Edge mínimo | un IP público estático Standard | 7.30 |
| **Subtotal aproximado** |  | **196.41** |

El subtotal queda bajo USD 200 solo con **menos de 100 GB/mes de egress**, sin registry incremental, backup, Log Analytics, Firewall Azure, PostgreSQL/Redis administrados, DNS, almacenamiento de evidencias, costes de proveedor ni crecimiento. Puede exceder el aviso con un solo medidor adicional. El host corre Postgres/Valkey local solo para demo y no ofrece HA; Standard HDD puede degradar indexación. Hay un único nodo de SIEM, sin réplica ni failover. Las reglas NSG y host firewall limitan exposición, pero no reemplazan inspección de salida; el uso de Cato depende de un túnel, licencias y configuración validados.

**Ankay se deja apagado/no desplegado en esta opción.** Mantenerlo separado con discos persistentes añade USD 20.16/mes aun detenido (sin contar otros recursos), por lo que el total excede el aviso. Si se lanza una VM de Ankay solo bajo demanda, se añade aproximadamente USD 0.97 de cómputo por 4 h, además de almacenamiento, registry, transferencia y estado persistente; el margen de USD 3.59 no basta para certificar que el consumo total quede por debajo de USD 200. No se propone co-localizar Shuffle/OpenSearch con Wazuh: compartiría memoria y dominio de falla y aumentaría el impacto de compromiso. Apagar Ankay reduce costo de VM, pero no apaga automáticamente discos u otros recursos.

Esta opción es un experimento de duración limitada, no una alternativa equivalente ni aprobada para producción. La retención de seguridad, recuperación, concurrencia y cargas reales requieren más almacenamiento y capacidad. La arquitectura de resiliencia completa necesita un presupuesto distinto o reducir explícitamente el alcance.

## Qué es real y qué no está aplicado

- Este archivo es una estimación; **no ejecuté Terraform, apply, DNS, creación/apagado de recursos ni cambios en Azure**.
- El `enable_runtime` de Container Apps permanece genérico y no sustituye la UI de Wazuh QAPAQ.
- El módulo opcional SIEM necesita Azure Firewall existente y un bundle aprobado; el root no crea por sí solo esa dependencia.
- PostgreSQL de IaC tiene por defecto B2S, que no permite HA. La cifra HA arriba es otra SKU y requeriría plan explícito; no se cambió Terraform.
- El diseño de Ankay tiene host separado, pero los workflows de build no demuestran servicio publicado y encendido. Su persistencia y arranque bajo demanda no se configuran aquí.
- Managed Redis es una opción Redis-compatible, no Valkey. Azure documenta HA en zonas para regiones/SKU compatibles; BullMQ, TLS, política de memoria y degradación requieren pruebas antes de que se pueda presupuestar como cola operativa. El worker actual no demuestra consumo de BullMQ en Azure.
- El Terraform no crea DNS público, TLS, Load Balancer ni Application Gateway. El monto de IP es solo una línea de referencia, no una arquitectura edge aprobada.
- Azure Budgets envía avisos; no impone un techo ni detiene o destruye recursos al alcanzar USD 200.

## Fuentes y reproducción

Precios primarios consultados el 2026-10-22; API en USD, región `chilecentral`:

- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices). Filtros: `armRegionName eq 'chilecentral' and serviceName eq 'Virtual Machines' and armSkuName eq '<SKU>' and priceType eq 'Consumption'`; PostgreSQL `serviceName eq 'Azure Database for PostgreSQL'`; Firewall `serviceName eq 'Azure Firewall'`; Storage `serviceName eq 'Storage'`; IP `serviceName eq 'Virtual Network'`; egress `serviceName eq 'Bandwidth'`; ACR `serviceName eq 'Container Registry'`.
- [Wazuh Quickstart](https://documentation.wazuh.com/current/quickstart.html) y [VM Fsv2](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/compute-optimized/fsv2-series): sizing inicial de 1–25 agentes.
- [PostgreSQL Flexible Server pricing](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/) y [precios/costos de HA](https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql): tier Burstable no da HA y standby cambia costo.
- [Azure Firewall pricing](https://azure.microsoft.com/en-us/pricing/details/azure-firewall/) y [capabilities por SKU](https://learn.microsoft.com/en-us/azure/firewall/features-by-sku).
- [Managed disk pricing](https://azure.microsoft.com/en-us/pricing/details/managed-disks/), [Public IP pricing](https://azure.microsoft.com/en-us/pricing/details/ip-addresses/), [Bandwidth pricing](https://azure.microsoft.com/en-us/pricing/details/bandwidth/) y [ACR pricing](https://azure.microsoft.com/en-us/pricing/details/container-registry/).
- [Azure Managed Redis pricing](https://azure.microsoft.com/en-us/pricing/details/managed-redis/), [reliability/HA](https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis) y [regiones de Azure](https://learn.microsoft.com/en-us/azure/reliability/regions-list). La disponibilidad final de servicio/SKU se debe confirmar antes de plan.

Los precios de VM, PostgreSQL, Firewall, managed disks, IP, bandwidth y ACR se identificaron por los medidores y SKUs descritos. El precio de Redis HA B0 se deriva de la página pública (dos nodos) y requiere confirmación para el tenant. Revisar de nuevo la API/estimador de Azure, cuotas regionales, moneda contractual y el plan exacto inmediatamente antes de autorizar despliegue.

## Decisión

No afirmar que la arquitectura completa cabe en USD 200/mes ni habilitar `apply` basándose en este cálculo. Antes de producción se requiere cotización completa por volumen de logs, retención, picos, recuperación, egress y licencias; definir el alcance de alta disponibilidad de cada capa; comprobar SKU/cuotas/región; y obtener aceptación del costo y del plan revisado. La elección entre Basic y Standard firewall debe responder a política de seguridad documentada, no solo al precio.
