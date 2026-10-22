# Arquitectura cloud propuesta — QAPAQ SecOps en Azure

**Estado:** arquitectura objetivo documentada; Terraform Azure actual no la despliega completa y no se ha aplicado desde esta rama.
**Fuente de producto:** `docs/10-decisiones.md` (A5–A9, A13, A18, A20, A22, ADR-030) y `docs/12-backend-en-el-siem.md` (opción B).
**Región de referencia:** Chile Central (`chilecentral`), sujeto a disponibilidad de SKU, cuota, residencia aprobada y medición de latencia desde las redes usuarias.
**Costo:** USD 200/mes es un umbral de alertas. No configura apagado ni `destroy`; el costo de este objetivo completo no está cotizado.

## Estado observado de Azure — 2026-10-22

La cuenta muestra USD 200 de crédito promocional con vencimiento el 18 de noviembre de 2026. El grupo
`rg-qapaqsecopsdemo-66f8c73b` tiene 15 recursos de fundación en Chile Central: dos identidades administradas,
Key Vault, Log Analytics, PostgreSQL Flexible Server y sus bases, Container Registry, Storage, VNet,
endpoints privados, interfaces de red y zonas DNS privadas. PostgreSQL figura `Ready`, SKU Burstable B2s,
32 GiB y sin alta disponibilidad. Esta lectura no accedió a valores de secretos.

Todavía no hay host Wazuh, host Ankay, Azure Firewall, balanceador/edge público ni cambio DNS para
`app.jappi.net.pe`; tampoco hay servicios SIEM/Ankay desplegados. `siem_host`, `ankay_host` y el runtime
genérico permanecen deshabilitados en Terraform. La ejecución [39751334214](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39751334214)
fue un plan de solo lectura con cero cambios, no un apply operativo. El apply anterior [39649721166](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39649721166)
falló al asignar roles de Storage (403 `roleAssignments/write`) y al crear Container Apps por falta de registro
de `Microsoft.App`; no se debe usar esa ejecución como evidencia de disponibilidad.

La estimación documentada para Wazuh + PostgreSQL + Azure Firewall Basic es de al menos USD 530.86/mes,
antes de Ankay, discos, tráfico y otros componentes. Los USD 200 son crédito promocional y umbral de aviso,
no límite de facturación. Recalcular costo y acciones de cada plan antes de ampliar la infraestructura.

## Objetivo y estado real

QAPAQ SecOps es la distribución oficial de Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6 con el overlay versionado de QAPAQ en `wazuh/dashboard/`. No es una aplicación web nueva ni un fork de Manager o Indexer. La UI incluye los plugins QAPAQ `qapaq_ops` y `qapaq_i18n`; el login del Dashboard sigue la sesión QAPAQ protegida por el edge existente.

Este Dashboard Wazuh modificado es el único frontend del SOC. Vercel y una web
Container Apps separada quedan fuera de la topología objetivo; `enable_runtime`
permanece apagado y no se debe tratar como publicación de la UI QAPAQ.

El destino de la opción B es un host SIEM Azure que ejecuta Manager, Indexer, Dashboard QAPAQ y `qapaq-core` (API más worker, Node 24). `qapaq-core` escucha solo en loopback; PostgreSQL conserva el estado durable y Valkey aporta sesión, caché y cola BullMQ. KrakenD permanece en la ruta de ingesta API → Indexer conforme a A8; se retira solo cuando se implemente y valide lectura equivalente a través del proxy Nginx. `apps/api` y `apps/worker` siguen siendo fuentes vigentes hasta que se cumplan las pruebas de paridad de `docs/12`.

Ankay Qapaq es Shuffle completo fijado en `ankay/upstream.lock`, con el overlay de marca QAPAQ. Corre en un host Linux privado separado con Compose, Orborus, workers, backend y OpenSearch propios. El edge del SIEM expone `/ankay/*` reutilizando la sesión y autorización QAPAQ actuales; no se publica Ankay directamente. A13 lo ubica después del lanzamiento del SIEM.

A18 registró inicialmente la simplificación de lanzamiento sin colas nuevas; A9, decisión posterior, actualiza el objetivo e incorpora Valkey/BullMQ para sesiones, caché y jobs. Esa parte se habilita por fases, cuando exista un consumidor real probado y esté definido el comportamiento ante caída de Valkey.

**La arquitectura anterior describe el destino, no evidencia de operación.** El root `infra/azure` crea una fundación de red/datos/identidad y Container Apps opcionales genéricas. El módulo `siem_host` está conectado al root mediante el objeto opcional `siem_host`, apagado cuando es `null`; esto prepara el cableado, pero no instala el `.deb` ni despliega hasta proporcionar un bundle válido y las dependencias auditadas. `ankay_host` también tiene cableado opcional en la rama de preparación, con subnet dedicada y la VM/disco aislados, pero permanece apagado por defecto y no instala Docker ni arranca Shuffle. El root todavía no aprovisiona Valkey. No se debe activar el runtime genérico como sustituto de estos componentes.

## Traducción Azure del diseño

| Capacidad objetivo | Traducción Azure | Estado / gate |
| --- | --- | --- |
| Manager, Indexer y Dashboard QAPAQ | VM Linux SIEM con artefactos fijados por versión/digest, disco de datos y recuperación probada | `modules/siem_host` está conectado al root detrás del objeto opcional `siem_host` y validado. Sigue apagado por defecto. Falta construir/publicar el bundle instalable, proporcionar firewall/red/secretos revisados y analizar un plan Azure. Mantener Indexer, Manager y Dashboard privados; solo edge y puertos de agentes aprobados pueden alcanzar el host. |
| Edge QAPAQ | Nginx en el host SIEM, TLS en la entrada pública elegida; proxy al Dashboard y API local | Reutilizar `wazuh/edge`; falta IaC/bootstrap Azure y prueba end-to-end. El cutover DNS queda fuera hasta aprobar destino, TLS y pruebas. |
| API gateway de ingesta | KrakenD interno entre `qapaq-core` y Wazuh Indexer mientras A8 lo requiera | El root y `siem_host` todavía no instalan KrakenD en el host SIEM. Debe integrarse conforme A8; no afirmar que una ruta alternativa ya reemplaza su contrato. |
| Núcleo QAPAQ | API y worker Node 24 como servicios systemd en el host SIEM; API en `127.0.0.1:3000` | El código/instalador actual usa AWS SSM, Secrets Manager y CA RDS. Se requiere un bootstrap Azure con Managed Identity/Key Vault y PostgreSQL privado, sin modificar o rotar secretos de AWS. |
| Estado durable | Azure Database for PostgreSQL Flexible Server privado, TLS, base/rol de aplicación mínimo y migraciones versionadas | El root crea servidor y bases, pero falta identidad runtime/migrator Azure comprobado. El password administrador queda en Terraform state: usar state remoto cifrado/versionado, container privado y RBAC/OIDC. El endpoint de Storage será público para runners GitHub-hosted; shared keys y acceso anónimo permanecen deshabilitados. |
| Sesiones, cache-aside y jobs | Servicio Redis-compatible privado con TLS, autenticación, HA y política `noeviction` requerida por BullMQ | Azure Managed Redis es candidato, no Valkey: Microsoft documenta Redis 7.4.x, Private Link/TLS, autenticación Entra y HA. Aún debe verificarse región/SKU exacta, compatibilidad de BullMQ 5.81.5+ioredis 6, política de memoria y costo. El worker actual es lifecycle-only y no consume BullMQ; no provisionar el servicio hasta que exista un consumidor probado. ADR-AZ-001 PostgreSQL sigue siendo una propuesta y no reemplaza A9. |
| Ankay Qapaq | VM Linux privada separada, Compose y discos persistentes; frontend Ankay + servicios upstream Shuffle completos y OpenSearch propio | `modules/ankay_host` tiene cableado opcional desde el root en la rama de preparación y crea host/disco en subnet dedicada; sigue apagado por defecto, no instala Docker ni inicia Compose. El workflow construye una imagen frontend; falta verificar/publicar el backend, Orborus, workers y OpenSearch, además de Compose Azure, backup/restore y pruebas de carga. |
| Secretos | Key Vault con RBAC mínimo, acceso privado y Managed Identity por runtime | Terraform crea el vault, no secretos. Faltan los adaptadores del instalador para leer Key Vault. No copiar valores a Git, tfvars o logs; AWS sigue siendo otra cuenta/state. |
| Artefactos | ACR para OCI/imágenes y cuenta de Blob dedicada para bundle de SIEM, con contenedor privado y acceso de red autenticado por OIDC/RBAC | La cuenta `evidence` de eventos permanece privada. El host SIEM descarga el bundle mediante identidad administrada por private endpoint; GitHub publica por OIDC. Sin claves compartidas ni acceso anónimo. El canal dedicado está preparado en Terraform, aún no aplicado. Fijar procedencia, SBOM, digest y permisos antes de bootstrap. |
| Logs operativos | Azure Monitor/Log Analytics solo para salud y plataforma, sujeto al control de residencia/retención | Separar de eventos de seguridad y evidencia mantenidos en Wazuh/OpenSearch. No está demostrado que el código Azure emita logs de aplicación hacia Log Analytics ni hacia Wazuh. |
| DNS y certificado | Solo `app.jappi.net.pe` después de TLS, endpoint y pruebas; Route 53 mantiene state independiente | El Terraform Azure no gestiona DNS. No hacer corte ni borrar registros como parte de esta arquitectura documental. |

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

El módulo de host requiere Azure Firewall, que no existe en el root actual. En Chile Central, el precio de lista observado agrega USD 288.35/mes fijos con Basic o USD 912.50/mes con Standard, más procesamiento. El piso combinado Wazuh + PostgreSQL + Firewall sube a USD 530.86 o USD 1,155.01/mes, respectivamente, antes de los demás servicios. Basic limita throughput a 250 Mbps y solo alerta sobre threat intelligence; Standard admite modo deny. Ver [`cost-feasibility-2026-10-20.md`](cost-feasibility-2026-10-20.md) y la [matriz oficial de capacidades por SKU](https://learn.microsoft.com/en-us/azure/firewall/features-by-sku). USD 200 genera avisos solamente: no es tope de facturación y no apaga ni destruye recursos. Recalcular con SKU y volumen reales antes de cualquier plan/apply.

## Gaps que bloquean afirmar “operativo”

- `siem_host` está integrado al root detrás de un gate opcional, pero sigue sin bundle instalable, configuración aprobada ni plan Azure. `ankay_host` está conectado de forma opcional desde la rama de preparación, pero aún no está activado, no inicia Docker/Shuffle y depende de todas las imágenes y el Compose verificados. El host SIEM tampoco instala KrakenD; se requieren artefactos, CI, plan remoto y evidencia de runtime antes de declarar despliegue Azure.
- El instalador `wazuh/core` y Office 365 sigue acoplado a SSM/Secrets Manager de AWS. Se añadió `wazuh/core/build-azure.sh` para compilar el core usando el almacén de CA del runner en lugar del bundle RDS; aún falta el bootstrap Azure de secretos/Office 365 con Managed Identity/Key Vault, permisos mínimos y validación de TLS contra PostgreSQL Azure. Este helper no equivale a un release bundle instalado.
- No hay Valkey en Terraform Azure ni prueba de TLS/auth, disponibilidad, no-eviction, backup o recuperación. El worker visible no crea consumidor BullMQ; `qapaq_jobs` no prueba cola activa.
- La integración M365 y sus reglas/configuración necesitan instalarse en Manager y comprobarse con eventos sintéticos/lecturas reales. Eso no prueba retención retroactiva ni ingestión actual.
- Sophos y Cato figuran sin contratos de fuente validados. No se declara API, polling, agent, política o alerta conectada por la presencia de nombres o secretos.
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
