# Arquitectura cloud propuesta — QAPAQ SecOps en Azure

**Estado:** arquitectura objetivo documentada; Terraform Azure actual no la despliega completa y no se ha aplicado desde esta rama.
**Fuente de producto:** `docs/10-decisiones.md` (A5–A9, A13, A18, A20, A22, ADR-030) y `docs/12-backend-en-el-siem.md` (opción B).
**Región de referencia:** Chile Central (`chilecentral`), sujeto a disponibilidad de SKU, cuota, residencia aprobada y medición de latencia desde las redes usuarias.
**Costo:** USD 200/mes es un umbral de alertas. No configura apagado ni `destroy`; el costo de este objetivo completo no está cotizado.

## Objetivo y estado real

QAPAQ SecOps es la distribución oficial de Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6 con el overlay versionado de QAPAQ en `wazuh/dashboard/`. No es una aplicación web nueva ni un fork de Manager o Indexer. La UI incluye los plugins QAPAQ `qapaq_ops` y `qapaq_i18n`; el login del Dashboard sigue la sesión QAPAQ protegida por el edge existente.

Este Dashboard Wazuh modificado es el único frontend del SOC. Vercel y una web
Container Apps separada quedan fuera de la topología objetivo; `enable_runtime`
permanece apagado y no se debe tratar como publicación de la UI QAPAQ.

El destino de la opción B es un host SIEM Azure que ejecuta Manager, Indexer, Dashboard QAPAQ y `qapaq-core` (API más worker, Node 24). `qapaq-core` escucha solo en loopback; PostgreSQL conserva el estado durable y Valkey aporta sesión, caché y cola BullMQ. KrakenD permanece en la ruta de ingesta API → Indexer conforme a A8; se retira solo cuando se implemente y valide lectura equivalente a través del proxy Nginx. `apps/api` y `apps/worker` siguen siendo fuentes vigentes hasta que se cumplan las pruebas de paridad de `docs/12`.

Ankay Qapaq es Shuffle completo fijado en `ankay/upstream.lock`, con el overlay de marca QAPAQ. Corre en un host Linux privado separado con Compose, Orborus, workers, backend y OpenSearch propios. El edge del SIEM expone `/ankay/*` reutilizando la sesión y autorización QAPAQ actuales; no se publica Ankay directamente. A13 lo ubica después del lanzamiento del SIEM.

A18 registró inicialmente la simplificación de lanzamiento sin colas nuevas; A9, decisión posterior, actualiza el objetivo e incorpora Valkey/BullMQ para sesiones, caché y jobs. Esa parte se habilita por fases, cuando exista un consumidor real probado y esté definido el comportamiento ante caída de Valkey.

**La arquitectura anterior describe el destino, no evidencia de operación.** El root `infra/azure` actual crea una fundación de red/datos/identidad y Container Apps opcionales genéricas. No crea un host Wazuh, instala el `.deb`, despliega `qapaq-core`, aprovisiona Valkey, ni crea la VM/Compose de Ankay. Los módulos `siem_host` y `ankay_host` existen y pasan validación Terraform sin credenciales, pero siguen aislados: no están conectados al root ni validados con un plan Azure. No se debe activar el runtime genérico como sustituto de estos componentes.

## Traducción Azure del diseño

| Capacidad objetivo | Traducción Azure | Estado / gate |
| --- | --- | --- |
| Manager, Indexer y Dashboard QAPAQ | VM Linux SIEM con artefactos fijados por versión/digest, disco de datos y recuperación probada | `modules/siem_host` está implementado y validado de forma aislada, pero no está integrado al root ni es desplegable todavía. Falta construir/publicar el bundle instalable y revisar un plan Azure. Mantener Indexer, Manager y Dashboard privados; solo edge y puertos de agentes aprobados pueden alcanzar el host. |
| Edge QAPAQ | Nginx en el host SIEM, TLS en la entrada pública elegida; proxy al Dashboard y API local | Reutilizar `wazuh/edge`; falta IaC/bootstrap Azure y prueba end-to-end. El cutover DNS queda fuera hasta aprobar destino, TLS y pruebas. |
| API gateway de ingesta | KrakenD interno entre `qapaq-core` y Wazuh Indexer mientras A8 lo requiera | El root y `siem_host` todavía no instalan KrakenD en el host SIEM. Debe integrarse conforme A8; no afirmar que una ruta alternativa ya reemplaza su contrato. |
| Núcleo QAPAQ | API y worker Node 24 como servicios systemd en el host SIEM; API en `127.0.0.1:3000` | El código/instalador actual usa AWS SSM, Secrets Manager y CA RDS. Se requiere un bootstrap Azure con Managed Identity/Key Vault y PostgreSQL privado, sin modificar o rotar secretos de AWS. |
| Estado durable | Azure Database for PostgreSQL Flexible Server privado, TLS, base/rol de aplicación mínimo y migraciones versionadas | El root crea servidor y bases, pero falta identidad runtime/migrator Azure comprobado. El password administrador queda en Terraform state: usar state remoto cifrado/versionado, container privado y RBAC/OIDC. El endpoint de Storage será público para runners GitHub-hosted; shared keys y acceso anónimo permanecen deshabilitados. |
| Sesiones, cache-aside y jobs | servicio Redis/Valkey privado elegido tras verificar disponibilidad Azure, compatibilidad, TLS, auth, persistencia y política `noeviction` requerida por BullMQ | No existe provisionamiento Valkey en el root. A9 define BullMQ sobre Valkey; el worker actual es lifecycle-only y no consume BullMQ. No declarar colas, conectores ni procesamiento operativo hasta implementar y probar. No sustituirlo por BullMQ/PostgreSQL sin decisión revisada. |
| Ankay Qapaq | VM Linux privada separada, Compose y discos persistentes; frontend Ankay + servicios upstream Shuffle completos y OpenSearch propio | `modules/ankay_host` está implementado y validado de forma aislada, pero no está integrado al root. El workflow construye el overlay frontend; no aprovisiona backend, Orborus, workers u OpenSearch. Faltan Compose Azure revisado, integración al root, backup/restore y prueba de carga. |
| Secretos | Key Vault con RBAC mínimo, acceso privado y Managed Identity por runtime | Terraform crea el vault, no secretos. Faltan los adaptadores del instalador para leer Key Vault. No copiar valores a Git, tfvars o logs; AWS sigue siendo otra cuenta/state. |
| Artefactos | ACR para OCI/imágenes y, si se aprueba el contrato, artefactos versionados por digest | Workflows de build/publicación no instalan en VM ni aplican Terraform. Fijar procedencia, SBOM, digest y permisos antes de bootstrap. |
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

Valkey es degradable: PostgreSQL continúa como fuente de verdad; sesiones, cache y jobs requieren comportamiento explícito ante su caída, reintentos, idempotencia y reconciliación. El código actual no demuestra ese worker ni procesamiento de M365, Sophos o Cato en Azure.

El módulo de host requiere Azure Firewall, que no existe en el root actual. En Chile Central, el precio de lista observado agrega USD 288.35/mes fijos con Basic o USD 912.50/mes con Standard, más procesamiento. El piso combinado Wazuh + PostgreSQL + Firewall sube a USD 530.86 o USD 1,155.01/mes, respectivamente, antes de los demás servicios. Basic limita throughput a 250 Mbps y solo alerta sobre threat intelligence; Standard admite modo deny. Ver [`cost-feasibility-2026-10-20.md`](cost-feasibility-2026-10-20.md) y la [matriz oficial de capacidades por SKU](https://learn.microsoft.com/en-us/azure/firewall/features-by-sku). USD 200 genera avisos solamente: no es tope de facturación y no apaga ni destruye recursos. Recalcular con SKU y volumen reales antes de cualquier plan/apply.

## Gaps que bloquean afirmar “operativo”

- Los módulos `siem_host` y `ankay_host` pasan validación aislada, pero ninguno está integrado al root. `siem_host` tampoco instala KrakenD ni dispone del bundle QAPAQ completo; se requieren integración, CI, plan remoto y evidencia de runtime antes de declarar despliegue Azure.
- El instalador `wazuh/core` y Office 365 está acoplado a SSM/Secrets Manager/CA RDS de AWS. Falta adaptación equivalente a Managed Identity/Key Vault y a PostgreSQL Azure, con permisos mínimos.
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
