# QAPAQ SecOps en Azure

Este root es independiente de `infra/aws`: usa una suscripción, state, identidad,
red y secretos propios. No importa ni cambia recursos AWS o DNS. La arquitectura
documentada para el destino Azure se rige por [`docs/cloud/azure/architecture.md`](../../docs/cloud/azure/architecture.md),
con `docs/10-decisiones.md` y `docs/12-backend-en-el-siem.md` como fuentes de producto.

## Estado real del root

**Fundación IaC; no equivale a un SOC operativo.** El root puede crear red,
PostgreSQL Flexible Server y sus bases, Key Vault, Blob privado, Log Analytics,
Container Apps Environment, ACR e identidad/federación OIDC, sujeto a bootstrap,
state, permisos, cuotas y revisión de plan. `enable_runtime` está apagado por
defecto.

El único frontend previsto para QAPAQ SecOps es el Wazuh Dashboard modificado de
`wazuh/dashboard/`, servido por el host SIEM detrás del edge QAPAQ. No se despliega
Vercel ni una aplicación web separada para el SOC. El runtime genérico de Container
Apps no es el frontend oficial y debe permanecer desactivado mientras se completa
la integración del host SIEM y `qapaq-core`.

El runtime opcional existente es genérico: `edge`, `web`, `gateway`, `api` y
`worker` en Container Apps. No representa el destino de A6/A8/A9/A13/A22 y no
se debe activar como sustituto del SIEM. En particular, este root no crea ni
instala Manager/Indexer/Dashboard Wazuh, `qapaq-core`, KrakenD en el host SIEM,
Valkey ni Ankay/Shuffle. Tampoco cambia DNS.

El diseño objetivo se traduce a Azure así:

- VM SIEM con Manager, Indexer y Dashboard 4.14.8 / OSD 2.19.6 y overlay QAPAQ.
- Nginx edge QAPAQ en el host SIEM; `qapaq-core` API+worker Node 24 como servicios
  locales y KrakenD para la ingesta mientras lo requiera A8.
- Azure PostgreSQL privado como persistencia durable; Valkey compatible pendiente
  de SKU/compatibilidad y de un consumidor BullMQ funcional.
- VM Linux privada separada para Ankay, con Shuffle completo, Orborus, workers,
  OpenSearch y persistencia. `/ankay/*` atraviesa el edge QAPAQ con la sesión y
  autorización existentes.

Estos son objetivos de diseño, no componentes desplegados por este root. El código
actual de `qapaq-core`/Office 365 usa AWS SSM, Secrets Manager y la CA de RDS; su
instalación requiere adaptación Azure con Managed Identity/Key Vault y PostgreSQL
Azure. El worker actual es lifecycle-only y no consume BullMQ. No hay evidencia de
conectores Sophos o Cato operativos; Teams y M365 deben probarse en los servicios
reales antes de declarar cobertura.

## Módulos que sí están en Terraform

| Módulo                      | Alcance actual                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/network`           | VNet, subnets delegadas y DNS privado para servicios con endpoint privado.                                                                        |
| `modules/observability`     | Log Analytics y Container Apps Environment.                                                                                                       |
| `modules/data`              | PostgreSQL, bases `qapaq_secops` y `qapaq_jobs`, Storage/Blob con contenedores privados separados `security-event-raw` y `siem-release`, Key Vault y endpoints privados. La base `qapaq_jobs` no demuestra una cola activa. |
| `modules/identity_registry` | Identidades, federación GitHub OIDC, ACR y RBAC. La identidad runtime escribe solo en `security-event-raw`; no recibe acceso a los artefactos de `siem-release`. |
| `modules/runtime`           | Cinco Container Apps genéricas opcionales; no son la topología objetivo ni despliegan Wazuh, `qapaq-core` o Ankay.                                |

`moved.tf` preserva direcciones anteriores durante migraciones de state. Los
bloqueos `prevent_destroy` protegen recursos definidos, pero no sustituyen un
state remoto seguro, backups verificados ni una revisión del plan.

## Presupuesto y datos

USD 200/mes es un umbral de alertas, **no** un tope de facturación ni una regla de
apagado o `destroy`. La estimación vigente de cómputo Wazuh + PostgreSQL supera
ese umbral y no incluye todos los discos, backup, Valkey, red, observabilidad,
ACR ni la VM/almacenamiento de Ankay. Revisar
[viabilidad de costo](../../docs/cloud/azure/cost-feasibility-2026-10-20.md)
y cotizar la arquitectura completa antes del plan.

La decisión A11 fija snapshots y evidencia en S3 y excluye Azure. No usar Blob
como archivo SOC hasta aprobar una decisión nueva sobre residencia, Object Lock
y retención. Separar eventos de
seguridad en Wazuh/OpenSearch, logs operativos en el destino de observabilidad
aprobado y referencias/estado de jobs en la cola. No guardar secretos ni payloads
crudos en la cola.

`postgres_admin_password` es sensible y Terraform lo conserva en state. Usar
backend remoto cifrado, versionado y acceso mínimo antes de operar el root; nunca
cargar el valor a Git o a un archivo versionado. El rol runtime de PostgreSQL y
las migraciones Azure aún necesitan implementarse y validarse. Terraform crea el
Key Vault, no los valores de secretos.

## Requisitos antes de un plan remoto

- Confirmar suscripción, tenant, región y residencia autorizada para eventos y
  evidencia; validar cuota y disponibilidad de SKU.
- Bootstrap de grupo, state Azure Storage remoto, versionado/soft delete, locking,
  OIDC de GitHub y RBAC mínimo. Usar runner con conectividad privada si se requieren
  endpoints privados.
- Acordar el diseño de host SIEM, edge/TLS, discos, backup/restore, firewall y
  allowlist de agentes. No publicar Manager API 55000, Indexer 9200 ni Dashboard
  interno.
- Integrar y revisar los módulos de host SIEM y Ankay que están en elaboración; añadir/validar bootstrap Azure para Wazuh, `qapaq-core`, KrakenD y Ankay, más
  adaptación de secretos AWS→Key Vault y creación del rol PostgreSQL mínimo.
- Validar el backend de jobs aprobado: A9 indica Valkey/BullMQ; el worker debe
  consumir realmente la cola y pasar pruebas de caída/reintento/idempotencia antes
  de habilitarlo. No presentar PostgreSQL como backend BullMQ por configuración.
- Fijar artefactos e imágenes por digest, escaneos, SBOM/procedencia y permisos de
  publicación/lectura ACR. Las pipelines de publicación no instalan el runtime ni
  aplican Terraform.
- Validar M365 en Wazuh con eventos sintéticos y alertas; establecer contrato
  Sophos/Cato y verificar Teams con endpoint de prueba. Los nombres de secretos o
  reglas no acreditan conexión.
- Aprobar costo completo y conservar USD 200 como alerta solamente; revisar el
  plan exacto, reemplazos/destrucciones, `prevent_destroy`, red, rollback y backups.

## Secuencia propuesta

1. Revisar [`arquitectura Azure`](../../docs/cloud/azure/architecture.md),
   [`paridad IaC`](../../docs/cloud/azure/terraform-parity-review-2026-10-19.md)
   y [`costo`](../../docs/cloud/azure/cost-feasibility-2026-10-20.md).
2. Preparar el bootstrap y state backend; confirmar identidad OIDC, acceso al
   state y permisos acotados. Generar plan remoto nuevo y revisar cada cambio.
3. Completar módulos/instalación del host SIEM, `qapaq-core`, KrakenD, Valkey y
   Ankay con almacenamiento y recuperación; adaptar Key Vault/Managed Identity.
4. Publicar/instalar artefactos fijados, ejecutar migraciones y configurar fuentes
   solo tras verificar contratos y secretos por canales seguros.
5. Probar paridad descrita en `docs/12-backend-en-el-siem.md`, agentes de prueba,
   ingestión, reglas, sesiones, recuperación, playbooks read-only y notificaciones.
6. Revisar costos, residencia, TLS, exposición y rollback. El cutover de
   `app.jappi.net.pe` se trata por separado; este root no gestiona DNS.

## Protecciones y límites

PostgreSQL, Key Vault, Log Analytics y Storage usan `prevent_destroy` donde lo
define el código. Key Vault tiene soft delete/purge protection; Blob cuenta con
versionado/recuperación según el módulo. Confirmar política y restore efectivo
antes de almacenar datos reales. Un retiro intencional requiere un cambio revisado
de esas protecciones y aprobación separada.

Los logs operativos de plataforma se separan de eventos y evidencia SOC. El diseño
Azure todavía debe decidir destino/retención conforme a residencia. No afirmar que
Log Analytics recibe logs de aplicación ni que Wazuh procesa conectores hasta ver
una prueba real.

Ver el [diagrama de destino Azure](../../docs/cloud/azure/diagrams/qapaq-azure.mmd)
y el [runbook Azure](../../docs/cloud/azure/runbook-preparacion-y-corte.md).
