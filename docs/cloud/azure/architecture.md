# Arquitectura cloud propuesta — QAPAQ SecOps en Azure

**Última evidencia de despliegue:** lectura de estado fechada 2026-10-26; revisión documental 2026-10-27. El apply `foundation` EUS2 ([run 40421595800](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40421595800)) creó PostgreSQL Flexible Server 16 (`Standard_D2s_v3`) y las bases `qapaq_secops`/`qapaq_jobs`. No desplegó el SOC: `siem_host=null`, `ankay_host=null`, `enable_runtime=false`; no hay VM SIEM/Core, Manager, Indexer, Dashboard QAPAQ ni runtime Ankay. El perfil aplicado no tiene referencias de secretos configuradas y no se hizo cambio DNS. La presencia de `qapaq_jobs` no demuestra una cola ni un worker.

El candidato Wazuh/QAPAQ para EUS2 se publicó en Blob privado el 2026-10-27 (bundle [40445959714](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40445959714), publicación [40453658942](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40453658942), SHA-256 `89040cb69535da6b7b6b763b77fa0bdb3e15c2089481d139fa9cd2f23c7e5472`). Es un artefacto de instalación, no evidencia de que haya una VM instalada, servicios saludables o ingesta probada. El adaptador y las reglas M365 existen en código; Microsoft Graph todavía no se ha validado en Azure. Sophos/Cato siguen opcionales y apagados. Las reglas AD están en el candidato, pero no hay agentes de DC desplegados ni GPO aplicada. Ankay es una fase posterior y su runtime aún no está endurecido.

La traducción Azure de la cola/Valkey no está decidida ni provisionada; la demo de una sola VM será un punto único de falla, no HA. A11 conserva snapshots/evidencia en S3 y no hay una política Azure de backup/restore aprobada. Residencia, costo total EUS2 y restauración siguen pendientes; el umbral de gasto configura avisos, no apagado. No se leyeron valores de Key Vault. Véanse el [registro operativo 2026-10-26](operational-readiness-2026-10-26.md), la [guía de readiness y acceptance EUS2](eus2-siem-profile-readiness.md#acceptance-evidence-required-after-deployment), el [runbook EUS2](runbook-demo-eus2.md) y el [estado del bundle](siem-release-bundle.md).

Las PR [#131](https://github.com/CyberStill-GmbH/qapaq-secops/pull/131) y [#132](https://github.com/CyberStill-GmbH/qapaq-secops/pull/132) integraron el ingreso Azure con Firewall/DNAT, Load Balancer interno, NSG compatible con SNAT y auditoría NAT en Log Analytics. Ese edge está definido en IaC, pero no formó parte del apply `foundation`.
**Fuente de producto:** `docs/10-decisiones.md` (A5–A9, A13, A18, A20, A22, ADR-030) y `docs/12-backend-en-el-siem.md` (opción B).
**Región de la demo actual:** East US 2 (`eastus2`), elegida para este state por disponibilidad de recursos de PostgreSQL en la suscripción. No constituye aún una decisión de residencia de producción; requiere revisión de latencia desde QAPAQ, residencia de datos y costo.
**Costo:** USD 200/mes es un umbral de alertas. No configura apagado ni `destroy`; el costo de este objetivo completo no está cotizado. Las cifras indicadas son estimaciones de lista, no una cotización del tenant.

**Ingreso y telemetría integrados en `main` (PR #131 y #132):** el SIEM conserva una VM privada detrás de un
Azure Standard Load Balancer interno. La IP pública estática del Azure Firewall
recibe DNAT TCP/80 solo para ACME/redirección y TCP/443 desde CIDR aprobados; luego
envía a la IP privada del Load Balancer y al edge QAPAQ. El TLS termina en Nginx.
Esto elimina la dependencia de AWS y evita asignar IP pública a la VM. No habilita
el runtime por sí solo: faltan el perfil `siem_host`, CIDR de usuarios, bootstrap del
edge/certificado y un apply revisado. El Firewall SNATea DNAT; el NSG acepta esos flujos
solo desde la IP privada del Firewall y la lista original de clientes se aplica en el DNAT.
PR #132 agrega los eventos `AZFWNatRule` a Log Analytics en tabla resource-specific para
auditar la IP de origen, separados de los índices Wazuh; su ingesta añade costo. Un backend
único tampoco representa HA.

## Snapshot anterior de Azure — 2026-10-22 (no inventario actual)

La observación de portal previa al último apply reportó USD 200 de crédito promocional con vencimiento el 18 de noviembre de 2026. Antes de ese apply, el grupo
`rg-qapaqsecopsdemo-66f8c73b` tenía 15 recursos de fundación en Chile Central: dos identidades administradas,
Key Vault, Log Analytics, PostgreSQL Flexible Server y sus bases, Container Registry, Storage, VNet,
endpoints privados, interfaces de red y zonas DNS privadas. PostgreSQL figura `Ready`, SKU Burstable B2s,
32 GiB y sin alta disponibilidad. Esta lectura no accedió a valores de secretos.

El workflow Terraform [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034)
añadió cuatro recursos para el Storage dedicado de releases, su contenedor privado,
private endpoint y permiso de publicación. El apply no modificó ni destruyó recursos.
El posterior plan [39768505115](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39768505115)
propuso 0 altas, 1 cambio in-place y 0 destrucciones para reglas de red; su apply fue
omitido. La corrida [39771791770](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39771791770)
espera aprobación de `azure-demo` y aún no produjo un plan. No se ha refrescado el
inventario ARM después del apply; este texto conserva un snapshot histórico, no afirma
el recuento actual de recursos.

El snapshot de portal anterior no mostraba host Wazuh, host Ankay, Azure Firewall, balanceador/edge público ni cambio DNS para
`app.jappi.net.pe`; tampoco hay servicios SIEM/Ankay desplegados. `siem_host`, `ankay_host` y el runtime
genérico permanecen deshabilitados en Terraform. La ejecución [39751334214](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39751334214)
fue un plan de solo lectura con cero cambios, no un apply operativo. El apply anterior [39649721166](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39649721166)
falló al asignar roles de Storage (403 `roleAssignments/write`) y al crear Container Apps por falta de registro
de `Microsoft.App`; no se debe usar esa ejecución como evidencia de disponibilidad.

El plan protegido posterior a PR #115 ([39829577577](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39829577577)) confirmó `0 add, 1 change, 0 destroy`, solo para reglas de red del Storage `siem-release`; su apply fue omitido. La regla planeada usa `default_action=Allow` y `AzureServices` bypass, por lo que el endpoint Blob sería accesible desde cualquier red con autorización OAuth/RBAC; no equivale a una allowlist de red. Es un snapshot histórico de ese plan, no la configuración a usar como evidencia actual. El módulo de Firewall Standard vive en el root Terraform y crea egress solo cuando `siem_host` deja de ser `null`.

Las estimaciones publicadas para Chile Central (Standard desde USD 1,155.01/mes; Basic desde USD 530.86/mes) son históricas y no representan EUS2 ni una cotización del tenant. El costo total EUS2 permanece pendiente de cotización. Los USD 200 son un umbral de aviso, no un límite de facturación ni apagado automático. Revisar la residencia de datos y el costo antes de ampliar la infraestructura.

## Objetivo de diseño y estado de implementación

QAPAQ SecOps es la distribución oficial de Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6 con el overlay versionado de QAPAQ en `wazuh/dashboard/`. No es una aplicación web nueva ni un fork de Manager o Indexer. La UI incluye los plugins QAPAQ `qapaq_ops` y `qapaq_i18n`; en el diseño objetivo el edge protege el Dashboard con la sesión QAPAQ. Ese stack todavía no está desplegado en Azure.

Este Dashboard Wazuh modificado es el único frontend previsto para el SOC. Vercel y una web
Container Apps separada quedan fuera de la topología objetivo; `enable_runtime`
permanece apagado y no se debe tratar como publicación de la UI QAPAQ.

El destino de la opción B es un host SIEM Azure que ejecuta Manager, Indexer, Dashboard QAPAQ y `qapaq-core` (API más worker, Node 24). `qapaq-core` escucha solo en loopback y PostgreSQL conserva el estado durable. A9 registra Valkey para el diseño del sistema, pero la implementación Azure de Valkey/cola no está decidida ni provisionada; el worker todavía requiere aceptación de procesamiento real. KrakenD permanece en la ruta de ingesta API → Indexer conforme a A8; solo se sustituye después de validar lectura equivalente por el proxy Nginx. `apps/api` y `apps/worker` siguen siendo fuentes vigentes hasta que se cumplan las pruebas de paridad de `docs/12`.

Ankay Qapaq es Shuffle fijado en `ankay/upstream.lock`, con el overlay de marca QAPAQ. El objetivo es un host Linux privado separado con Compose, Orborus, workers, backend y OpenSearch propios. A13 lo ubica después del lanzamiento del SIEM. Hoy `ankay_host=null`; el runtime no está instalado ni endurecido y `/ankay/*` no está desplegado.

A18 registró inicialmente la simplificación de lanzamiento sin colas nuevas; A9, decisión posterior, incorpora Valkey/BullMQ al diseño general. La traducción Azure sigue abierta: no hay servicio Redis-compatible/Valkey ni cola desplegados, y el backend/worker de Azure debe demostrar productor, consumidor, recuperación e idempotencia antes de habilitarlos.

**La arquitectura describe el destino, no evidencia de operación.** El root `infra/azure` crea la fundación de red/datos/identidad y deja Container Apps genéricas optativas. El bundle EUS2 está publicado y verificado por digest, pero no instalado. `siem_host`, `ankay_host` y `enable_runtime` siguen desactivados en el state aplicado; Azure Firewall, policy, Load Balancer, DNAT y edge están definidos en IaC pero no se crearon con el apply de fundación. Faltan inputs revisados del SIEM, referencias de secretos verificadas por metadatos, apply específico y evidencia de salud e ingesta. El root no aprovisiona Valkey.

## Traducción Azure del diseño

| Capacidad objetivo | Traducción Azure | Estado / gate |
| --- | --- | --- |
| Manager, Indexer y Dashboard QAPAQ | VM Linux SIEM con artefactos fijados por versión/digest, disco de datos y recuperación probada | Candidato EUS2 publicado en Blob privado y verificado por digest ([runbook del bundle](siem-release-bundle.md)); no está instalado ni hay healthcheck de servicios. `siem_host` sigue apagado y faltan inputs revisados. Mantener Indexer, Manager y Dashboard privados; solo edge y puertos de agentes aprobados pueden alcanzar el host. |
| Edge QAPAQ | Nginx en el host SIEM tras Firewall DNAT y Load Balancer interno; TLS en Nginx; proxy al Dashboard y API local | Terraform ya prepara DNAT 80/443, LB interno y NSG. El plan vigente no crea estos recursos porque falta `siem_host`. El bundle/runtime todavía debe instalar y comprobar Nginx, TLS y `auth_request`; el cutover DNS queda fuera hasta pasar las pruebas. |
| API gateway de ingesta | KrakenD privado en ACA entre `qapaq-core` y proxy TLS del Indexer mientras A8 lo requiera | El módulo `krakend_gateway` exige app role `Qapaq.Wazuh.Read` y caller `appid`/`azp` acotado al Core; sigue apagado y no desplegado. El proxy Indexer/seed de secretos aún no tiene ruta Azure; no declarar operativa la ingesta. Access log CE permanece apagado por incluir query strings. |
| Núcleo QAPAQ | API y worker Node 24 como servicios systemd en el host SIEM; API en `127.0.0.1:3000` | El bundle contiene el Core empaquetado, pero no se ha instalado ni conectado a PostgreSQL en Azure. En `main`, el bootstrap lee referencias Wazuh desde Key Vault; el proveedor runtime del Core no está integrado. PR [#184](https://github.com/CyberStill-GmbH/qapaq-secops/pull/184) propone ese soporte, pero debe integrarse y probarse antes de afirmar aceptación. Faltan además migraciones y health del Core. |
| Estado durable | Azure Database for PostgreSQL Flexible Server privado, TLS, base/rol de aplicación mínimo y migraciones versionadas | El servidor y las bases existen; el rol mínimo de aplicación y el migrator Azure aún no están probados. El state remoto EUS2 ya existe y requiere conservarse; su endpoint admite acceso de red público autenticado por Entra/RBAC, con acceso anónimo y shared keys deshabilitados. Revisar el tratamiento del password administrador en state antes de habilitar el runtime. |
| Sesiones, cache-aside y jobs | Servicio Redis-compatible privado con TLS, autenticación, HA y política `noeviction` requerida por BullMQ | La traducción Azure de A9 no está decidida. No se ha desplegado Valkey ni un servicio Redis-compatible y no hay aceptación de una cola BullMQ en Azure. `qapaq_jobs` es una base PostgreSQL y no un consumidor. El worker actual no prueba procesamiento BullMQ; no provisionar ni declarar una cola hasta decidir el servicio y validar productor, consumidor, reintentos, idempotencia y recuperación. |
| Ankay Qapaq | VM Linux privada separada, Compose y discos persistentes; frontend Ankay + servicios upstream Shuffle completos y OpenSearch propio | `ankay_host=null`; no se instaló ni desplegó. El módulo conectado al root prepara el host, no inicia Shuffle. Faltan digests de todas las imágenes, Compose validado, hardening, persistencia/restore, egress, ruta protegida y E2E de playbooks/SoD (véase [`docs/13`](../../13-ankay-qapaq.md)). |
| Secretos | Key Vault con RBAC mínimo, acceso privado y Managed Identity por runtime | Key Vault está en la fundación privada. El inventario operativo no verificó sus valores; el perfil EUS2 no tiene refs completas. Bootstrap puede leer referencias necesarias para Wazuh, pero eso no prueba que Core las resuelva en runtime. No copiar valores a Git, tfvars o logs. |
| Artefactos | ACR para OCI/imágenes y cuenta de Blob dedicada para bundle de SIEM, con contenedor privado y acceso de red autenticado por OIDC/RBAC | ACR no tenía imágenes runtime en la última lectura. El bundle EUS2 actual se publicó en Blob privado en [40453658942](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40453658942), con SHA-256 `89040cb69535da6b7b6b763b77fa0bdb3e15c2089481d139fa9cd2f23c7e5472`; es candidato de instalación, no prueba de una VM ni de servicios operativos. |
| Logs operativos | Azure Monitor/Log Analytics solo para salud y plataforma, sujeto al control de residencia/retención | Separar de eventos de seguridad y evidencia mantenidos en Wazuh/OpenSearch. No está demostrado que el código Azure emita logs de aplicación hacia Log Analytics ni hacia Wazuh. |
| DNS y certificado | Solo `app.jappi.net.pe` después de TLS, endpoint y pruebas | DNS permanece sin cambios bajo administración de Punto.pe; el Terraform Azure no gestiona DNS. No hay corte. Solo preparar cambio tras endpoint, TLS, auth, ingesta y rollback aceptados. |

## Flujo de tráfico

1. Navegador → edge Nginx QAPAQ por HTTPS. El edge valida/reutiliza la sesión QAPAQ y enruta UI y API según configuración aprobada.
2. Edge → Dashboard local y `qapaq-core` en loopback. La ruta `/ankay/*` pasa por el mismo control de sesión y autorización y luego por red privada al host Ankay.
3. `qapaq-core` → PostgreSQL privado para casos, auditoría, outbox y estado durable. Valkey/caché/jobs solo aplican al destino cuando el servicio Azure y su contrato de consumidor estén decididos y probados.
4. Para la ingesta definida por A8, KrakenD → Indexer privado bajo contrato de lectura aprobado. El acceso de Manager/Indexer/API no se publica a Internet.
5. Agentes → Manager por TCP 1514; enrolamiento TCP 1515 solo desde redes/cidrs autorizados. Wazuh API 55000 e Indexer 9200 permanecen privados.
6. Ankay mantiene su OpenSearch y almacenamiento separados. El diseño de integración Wazuh → Shuffle y los playbooks son gates hasta comprobar el webhook y la autorización de cada acción.

Los eventos de seguridad, los logs operativos y los datos crudos de proveedor tienen retenciones y permisos distintos. Mantener eventos de seguridad y alertas en Wazuh/OpenSearch; logs de host/plataforma en la solución Azure aprobada. A11 fija snapshots y evidencia en S3 y excluye Azure: no usar Blob para ese fin hasta aprobar una decisión nueva que resuelva residencia, Object Lock y retención. La base de jobs contiene referencias/estado, nunca secretos ni cuerpos crudos.

## Disponibilidad, resiliencia y costos

El primer despliegue previsto en un único host SIEM sería una demo con punto único de falla, aun con PostgreSQL administrado; hoy ni siquiera ese host está desplegado. La VM separada de Ankay evita compartir su socket Docker y superficie de ejecución con el SIEM, pero agrega costo y operación. El objetivo productivo requeriría estrategia de recuperación del host, replicación/restore de datos, pruebas de fallas y cotización de alta disponibilidad; no se declara HA por tener un balanceador.

La decisión general de Valkey no selecciona automáticamente un servicio Azure. PostgreSQL continúa como fuente de verdad; cualquier servicio para sesiones, caché o jobs requiere comportamiento explícito ante caída, reintentos, idempotencia y reconciliación. Azure Managed Redis sería un candidato Redis-compatible, no Valkey ni una decisión aprobada. No hay worker de cola ni procesamiento Azure de M365, Sophos o Cato demostrado.

El módulo crea Azure Firewall Standard al habilitar el SIEM. Las estimaciones publicadas para Chile Central no describen el costo EUS2; el costo total de EUS2 aún no está cotizado. La fuente de costo PostgreSQL y los precios de Firewall son estimaciones de lista, no una cotización del tenant. Confirmar disponibilidad exacta de cada SKU y revisar presupuesto/residencia antes de ampliar el apply. Ver [`cost-feasibility-2026-10-20.md`](cost-feasibility-2026-10-20.md), [`cost-review-demo-eus2-2026-10-26.md`](cost-review-demo-eus2-2026-10-26.md) y la [matriz oficial de capacidades por SKU](https://learn.microsoft.com/en-us/azure/firewall/features-by-sku). El budget actual solo genera avisos.

## Gaps que bloquean afirmar “operativo”

- `siem_host` y `ankay_host` siguen apagados; `enable_runtime=false`. La fundación aplicada no creó Firewall, policy, DNAT, LB, VM SIEM ni Ankay. ACR no contiene imágenes y el mapa de refs EUS2 estaba vacío en la última evidencia disponible. El módulo KrakenD está opt-in y no desplegado; faltan digest ACR, proxy Indexer y sus refs, inputs completos y plan revisado.
- El adaptador Office 365/Graph está versionado y empaquetado, pero no probado contra Graph desde un SIEM Azure; no hay evidencia de eventos indexados. El Core no se ha instalado; el bundle no prueba la resolución runtime de Key Vault.
- No hay Valkey ni cola Azure desplegados, ni prueba de TLS/auth, disponibilidad, no-eviction, backup o recuperación. `qapaq_jobs` no prueba cola activa. La elección del proveedor Azure y el contrato de worker siguen pendientes.
- La integración M365 y sus reglas/configuración están en el candidato, pero deben instalarse en un Manager y comprobarse con permisos Graph aceptados, eventos sintéticos y lectura/indexación reales. Eso tampoco prueba retención retroactiva.
- El overlay Wazuh incluye conectores opcionales para Sophos Central SIEM API y Cato `eventsFeed`, empaquetados con hashes y apagados por defecto. Aún faltan nombres/acceso Key Vault, configuración de tenant/región/account, permisos de API, allowlist final, apply y pruebas sintéticas/reales; por ello no se declara ingestión activa.
- Teams tiene código preparado para Wazuh 4.x y QAPAQ, pero no está instalado en Manager Azure ni validado con un webhook real.
- Ankay tiene overlay y upstream fijado; el módulo opcional no lo instala ni lo endurece. Faltan los digests runtime, Compose probado, OpenSearch/persistencia, ruta protegida y playbooks con callbacks/SoD. El workflow de publicación no constituye despliegue.
- El role de aplicación PostgreSQL, migraciones Azure, referencias Core y costo total requieren evidencia antes de activar el runtime. La fundación EUS2 ya tiene state remoto e identidades OIDC; ello no equivale a un SIEM aplicado.
- Región/residencia de datos, DNS/TLS/cutover, agentes autorizados, snapshots/restauración, carga y operación de incidentes requieren validación del dueño. No existe aceptación de HA.

## Secuencia de implementación revisable

1. Cerrar compatibilidad de artefactos Wazuh 4.14.8 / OSD 2.19.6, bootstrap Azure y permisos de managed identity; conservar y validar el state remoto EUS2 existente.
2. Proveer plan de VM, discos, red privada, agent ports permitidos, ACR y Key Vault. No exponer 9200/55000.
3. Adaptar e instalar `qapaq-core` en Node 24, cerrar el aprovisionamiento Azure del proxy/secretos Indexer, publicar KrakenD por digest y probar M365; crear rol PostgreSQL de aplicación y ejecutar migraciones controladas.
4. Provisionar Valkey compatible y verificar degradación; implementar y probar el worker/cola real antes de habilitar procesos.
5. Provisionar Ankay en VM privada separada, con persistencia/backups; probar `/ankay/*` con la sesión y rol actuales, y ejercicios sin acciones automáticas.
6. Probar paridad de `docs/12`, fuentes sintéticas y restore; revisar costo total, exposición y rollback.
7. Solo tras aprobación operativa, preparar cambio DNS limitado, verificar TLS, acceso, ingestión y alertas. Registrar evidencias redactadas y digests.

## Fuentes de diseño

- [`docs/10-decisiones.md`](../../10-decisiones.md): A5–A9, A13, A18, A20, A22 y ADR-030.
- [`docs/12-backend-en-el-siem.md`](../../12-backend-en-el-siem.md): opción B, implementación y pruebas de paridad.
- [`docs/11-cache-y-colas.md`](../../11-cache-y-colas.md): rol previsto para Valkey y BullMQ.
- [`docs/14-ankay-conexion-qapaq.md`](../../14-ankay-conexion-qapaq.md): integración y gates de Ankay.
- [`infra/azure/README.md`](../../../infra/azure/README.md): alcance real de IaC Azure.
