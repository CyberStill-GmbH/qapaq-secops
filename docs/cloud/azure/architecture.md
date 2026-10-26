# Arquitectura cloud propuesta — QAPAQ SecOps en Azure

**Estado verificado al 2026-10-26:** Terraform aplicó únicamente la fundación aislada `demo-eus2`. El run [40421595800](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40421595800) terminó correctamente con 3 altas y cero destrucciones: PostgreSQL Flexible Server y las bases `qapaq_secops`/`qapaq_jobs`. Azure confirma PostgreSQL 16, `Standard_D2s_v3`, estado `Ready`. El SOC sigue sin desplegar: `siem_host=null`, `ankay_host=null`, runtime deshabilitado, ACR sin repositorios, sin referencias de secretos configuradas y sin corte DNS. Las PR [#131](https://github.com/CyberStill-GmbH/qapaq-secops/pull/131) y [#132](https://github.com/CyberStill-GmbH/qapaq-secops/pull/132) integraron el ingreso Azure con Firewall/DNAT, Load Balancer interno, NSG compatible con SNAT y auditoría NAT en Log Analytics; esos recursos de edge no fueron habilitados en el apply de fundación.
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

El plan protegido posterior a PR #115 ([39829577577](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39829577577)) confirmó `0 add, 1 change, 0 destroy`, solo para reglas de red del Storage `siem-release`; su apply fue omitido. La regla planeada usa `default_action=Allow` y `AzureServices` bypass, por lo que el endpoint Blob sería accesible desde cualquier red con autorización OAuth/RBAC; no equivale a una allowlist de red. El módulo de Firewall Standard vive en el root Terraform y crea egress solo cuando `siem_host` deja de ser `null`. En consecuencia, el plan actual no aprovisiona firewall, VM SIEM, Ankay, balanceador ni edge.

La estimación de lista documentada para Wazuh + PostgreSQL + Azure Firewall Standard es de al menos USD 1,155.01/mes,
antes de Ankay, discos, tráfico y otros componentes; no es cotización del tenant. Firewall Basic bajaría el piso estimado a USD 530.86/mes, pero ofrece menos controles. Los USD 200 son crédito promocional y umbral de aviso,
no límite de facturación. Recalcular costo y acciones de cada plan antes de ampliar la infraestructura.

## Objetivo y estado real

QAPAQ SecOps es la distribución oficial de Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6 con el overlay versionado de QAPAQ en `wazuh/dashboard/`. No es una aplicación web nueva ni un fork de Manager o Indexer. La UI incluye los plugins QAPAQ `qapaq_ops` y `qapaq_i18n`; el login del Dashboard sigue la sesión QAPAQ protegida por el edge existente.

Este Dashboard Wazuh modificado es el único frontend del SOC. Vercel y una web
Container Apps separada quedan fuera de la topología objetivo; `enable_runtime`
permanece apagado y no se debe tratar como publicación de la UI QAPAQ.

El destino de la opción B es un host SIEM Azure que ejecuta Manager, Indexer, Dashboard QAPAQ y `qapaq-core` (API más worker, Node 24). `qapaq-core` escucha solo en loopback; PostgreSQL conserva el estado durable y Valkey aporta sesión, caché y cola BullMQ. KrakenD permanece en la ruta de ingesta API → Indexer conforme a A8; se retira solo cuando se implemente y valide lectura equivalente a través del proxy Nginx. `apps/api` y `apps/worker` siguen siendo fuentes vigentes hasta que se cumplan las pruebas de paridad de `docs/12`.

Ankay Qapaq es Shuffle completo fijado en `ankay/upstream.lock`, con el overlay de marca QAPAQ. Corre en un host Linux privado separado con Compose, Orborus, workers, backend y OpenSearch propios. El edge del SIEM expone `/ankay/*` reutilizando la sesión y autorización QAPAQ actuales; no se publica Ankay directamente. A13 lo ubica después del lanzamiento del SIEM.

A18 registró inicialmente la simplificación de lanzamiento sin colas nuevas; A9, decisión posterior, actualiza el objetivo e incorpora Valkey/BullMQ para sesiones, caché y jobs. Esa parte se habilita por fases, cuando exista un consumidor real probado y esté definido el comportamiento ante caída de Valkey.

**La arquitectura anterior describe el destino, no evidencia de operación.** El root `infra/azure` crea una fundación de red/datos/identidad y Container Apps opcionales genéricas. El apply EUS2 no incluyó `siem_host` ni `ankay_host`; el bundle publicado en otra ejecución/entorno no acredita que esté en el Storage de EUS2 ni instalado allí. Al habilitar `siem_host`, el root crea Azure Firewall Standard, su policy y el Load Balancer interno. Ankay no está iniciado en Azure. Faltan los artefactos fijados, el perfil SIEM/Ankay, referencias a secretos existentes de Key Vault, planes con costo y cambios revisados, y pruebas de salud. El root todavía no aprovisiona Valkey.

## Traducción Azure del diseño

| Capacidad objetivo | Traducción Azure | Estado / gate |
| --- | --- | --- |
| Manager, Indexer y Dashboard QAPAQ | VM Linux SIEM con artefactos fijados por versión/digest, disco de datos y recuperación probada | Bundle publicado y verificado; `siem_host` sigue apagado porque falta su perfil de red/VM/SSH y referencias Key Vault. El nuevo módulo crea Azure Firewall Standard y la policy de salida al habilitarlo. Aún debe generarse/revisarse el plan y verificarse la instalación. Mantener Indexer, Manager y Dashboard privados; solo edge y puertos de agentes aprobados pueden alcanzar el host. |
| Edge QAPAQ | Nginx en el host SIEM tras Firewall DNAT y Load Balancer interno; TLS en Nginx; proxy al Dashboard y API local | Terraform ya prepara DNAT 80/443, LB interno y NSG. El plan vigente no crea estos recursos porque falta `siem_host`. El bundle/runtime todavía debe instalar y comprobar Nginx, TLS y `auth_request`; el cutover DNS queda fuera hasta pasar las pruebas. |
| API gateway de ingesta | KrakenD interno entre `qapaq-core` y Wazuh Indexer mientras A8 lo requiera | El root y `siem_host` todavía no instalan KrakenD en el host SIEM. Debe integrarse conforme A8; no afirmar que una ruta alternativa ya reemplaza su contrato. |
| Núcleo QAPAQ | API y worker Node 24 como servicios systemd en el host SIEM; API en `127.0.0.1:3000` | El bundle Azure incluye `apply-core-azure.sh` y resuelve referencias Key Vault por Managed Identity; no llama AWS SSM/Secrets Manager y usa el trust store del sistema para TLS. Falta instalar el release y probar conexión PostgreSQL/migraciones en Azure. |
| Estado durable | Azure Database for PostgreSQL Flexible Server privado, TLS, base/rol de aplicación mínimo y migraciones versionadas | El root crea servidor y bases, pero falta identidad runtime/migrator Azure comprobado. El password administrador queda en Terraform state: usar state remoto cifrado/versionado, container privado y RBAC/OIDC. El endpoint de Storage será público para runners GitHub-hosted; shared keys y acceso anónimo permanecen deshabilitados. |
| Sesiones, cache-aside y jobs | Servicio Redis-compatible privado con TLS, autenticación, HA y política `noeviction` requerida por BullMQ | Azure Managed Redis es candidato, no Valkey: Microsoft documenta Redis 7.4.x, Private Link/TLS, autenticación Entra y HA. Aún debe verificarse región/SKU exacta, compatibilidad de BullMQ 5.81.5+ioredis 6, política de memoria y costo. El worker actual es lifecycle-only y no consume BullMQ; no provisionar el servicio hasta que exista un consumidor probado. ADR-AZ-001 PostgreSQL sigue siendo una propuesta y no reemplaza A9. |
| Ankay Qapaq | VM Linux privada separada, Compose y discos persistentes; frontend Ankay + servicios upstream Shuffle completos y OpenSearch propio | `modules/ankay_host` permanece apagado por defecto. `main` solo prepara host/disco. La rama de trabajo añade automatización de instalación/arranque, pero requiere seis imágenes por digest, Compose con health/restart policies, paquetes fijos, secretos Key Vault ya cargados, egress validado, backup/restore y pruebas; aún no está desplegada. |
| Secretos | Key Vault con RBAC mínimo, acceso privado y Managed Identity por runtime | El bootstrap SIEM lee Key Vault mediante Managed Identity y Terraform limita RBAC a los nombres configurados. Falta verificar referencias existentes en el vault; no copiar valores a Git, tfvars o logs. |
| Artefactos | ACR para OCI/imágenes y cuenta de Blob dedicada para bundle de SIEM, con contenedor privado y acceso de red autenticado por OIDC/RBAC | El canal dedicado se aplicó en run [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034); el cambio de red de publicación se aplicó en [39820862018](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39820862018), y el bundle con SHA-256 `3045155b53ff736bdcb157cdea6022b2931b1d4781d89c74ed1a497f38dc8f4e` se publicó y verificó en [39823003732](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39823003732). Blob sigue privado, sin acceso anónimo ni shared keys. |
| Logs operativos | Azure Monitor/Log Analytics solo para salud y plataforma, sujeto al control de residencia/retención | Separar de eventos de seguridad y evidencia mantenidos en Wazuh/OpenSearch. No está demostrado que el código Azure emita logs de aplicación hacia Log Analytics ni hacia Wazuh. |
| DNS y certificado | Solo `app.jappi.net.pe` después de TLS, endpoint y pruebas; Route 53 mantiene state independiente | El destino será la IP pública del Azure Firewall cuando el host y DNAT estén aplicados y probados. El Terraform Azure no gestiona DNS. No hacer corte ni borrar registros antes de las verificaciones. |

## Flujo de tráfico

1. Navegador → edge Nginx QAPAQ por HTTPS. El edge valida/reutiliza la sesión QAPAQ y enruta UI y API según configuración aprobada.
2. Edge → Dashboard local y `qapaq-core` en loopback. La ruta `/ankay/*` pasa por el mismo control de sesión y autorización y luego por red privada al host Ankay.
3. `qapaq-core` → PostgreSQL privado para casos, auditoría, outbox y estado durable. Valkey aporta sesiones/caché/jobs cuando su servicio y el consumidor real existan.
4. Para la ingesta definida por A8, KrakenD → Indexer privado bajo contrato de lectura aprobado. El acceso de Manager/Indexer/API no se publica a Internet.
5. Agentes → Manager por TCP 1514; enrolamiento TCP 1515 solo desde redes/cidrs autorizados. Wazuh API 55000 e Indexer 9200 permanecen privados.
6. Ankay mantiene su OpenSearch y almacenamiento separados. El diseño de integración Wazuh → Shuffle y los playbooks son gates hasta comprobar el webhook y la autorización de cada acción.

Los eventos de seguridad, los logs operativos y los datos crudos de proveedor tienen retenciones y permisos distintos. Mantener eventos de seguridad y alertas en Wazuh/OpenSearch; logs de host/plataforma en la solución Azure aprobada. A11 fija snapshots y evidencia en S3 y excluye Azure: no usar Blob para ese fin hasta aprobar una decisión nueva que resuelva residencia, Object Lock y retención. La base de jobs contiene referencias/estado, nunca secretos ni cuerpos crudos.

## Disponibilidad, resiliencia y costos

El primer despliegue en un único host SIEM es una demo con punto único de falla, aun con PostgreSQL administrado. La VM separada de Ankay evita compartir su socket Docker y superficie de ejecución con el SIEM, pero agrega costo y operación. El objetivo productivo requeriría estrategia de recuperación del host, replicación/restore de datos, pruebas de fallas y cotización de alta disponibilidad; no se declara HA por tener un balanceador.

Valkey es degradable: PostgreSQL continúa como fuente de verdad; sesiones, cache y jobs requieren comportamiento explícito ante su caída, reintentos, idempotencia y reconciliación. Azure Managed Redis sería una implementación Redis-compatible del rol en Azure, no una instancia Valkey ni una decisión aprobada. El código actual no demuestra ese worker ni procesamiento de M365, Sophos o Cato en Azure.

El módulo crea Azure Firewall Standard al habilitar el SIEM. La estimación previa de Chile Central agrega cerca de USD 912.50/mes fijos más procesamiento y no describe el costo de EUS2. El documento de fundación estima el cómputo PostgreSQL `Standard_D2s_v3` en USD 124.83/mes Pay-as-you-go antes de almacenamiento, backup y los demás recursos; el costo total de EUS2 aún no está cotizado. Confirmar disponibilidad exacta de cada SKU y volver a cotizar antes de ampliar el apply. Standard admite threat intelligence en modo deny y DNS proxy; el precio varía por contrato y consumo. Ver [`cost-feasibility-2026-10-20.md`](cost-feasibility-2026-10-20.md), [`cost-review-demo-eus2-2026-10-26.md`](cost-review-demo-eus2-2026-10-26.md) y la [matriz oficial de capacidades por SKU](https://learn.microsoft.com/en-us/azure/firewall/features-by-sku). El budget actual genera avisos solamente.

## Gaps que bloquean afirmar “operativo”

- `siem_host` y `ankay_host` siguen apagados; `enable_runtime=false`. La fundación aplicada no crea Firewall, policy, DNAT, LB, VM SIEM ni Ankay. ACR no contiene imágenes y `AZURE_EUS2_KEY_VAULT_SECRET_IDS_JSON` permanece vacío. Faltan los perfiles Azure, referencias a secretos, artefactos de release, plan/costo revisados para runtime, apply y evidencia de salud.
- El instalador Azure de Wazuh/Core usa Managed Identity y Key Vault; AWS no es requisito para ese despliegue. Office 365 sigue necesitando adaptación Azure para su conector y pruebas reales contra Microsoft Graph.
- No hay Valkey en Terraform Azure ni prueba de TLS/auth, disponibilidad, no-eviction, backup o recuperación. El worker visible no crea consumidor BullMQ; `qapaq_jobs` no prueba cola activa.
- La integración M365 y sus reglas/configuración necesitan instalarse en Manager y comprobarse con eventos sintéticos/lecturas reales. Eso no prueba retención retroactiva ni ingestión actual.
- El overlay Wazuh incluye conectores opcionales para Sophos Central SIEM API y Cato `eventsFeed`, empaquetados con hashes y apagados por defecto. Aún faltan nombres/acceso Key Vault, configuración de tenant/región/account, permisos de API, allowlist final, apply y pruebas sintéticas/reales; por ello no se declara ingestión activa.
- Teams tiene código preparado para Wazuh 4.x y QAPAQ, pero no está instalado en Manager Azure ni validado con un webhook real.
- Ankay tiene overlay y upstream fijado; el módulo de host existe fuera del root. Falta integrar el módulo y desplegar backend/Orborus/workers/OpenSearch, persistencia, ruta protegida y playbooks con callbacks/SoD comprobados. El workflow de publicación no constituye despliegue.
- El role de aplicación PostgreSQL, migraciones Azure, identidad/runner OIDC, estado remoto y costo total requieren evidencia antes de activar IaC.
- Región/residencia de datos, DNS/TLS/cutover, agentes autorizados, restauración, carga y operación de incidentes requieren validación con el dueño.

## Secuencia de implementación revisable

1. Cerrar compatibilidad de artefactos Wazuh 4.14.8 / OSD 2.19.6, bootstrap Azure y permisos de managed identity; preparar state remoto seguro.
2. Proveer plan de VM, discos, red privada, agent ports permitidos, ACR y Key Vault. No exponer 9200/55000.
3. Adaptar e instalar `qapaq-core` en Node 24, KrakenD y M365 desde Azure sin rotar secretos; crear rol PostgreSQL de aplicación y ejecutar migraciones controladas.
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
