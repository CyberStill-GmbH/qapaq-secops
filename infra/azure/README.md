# QAPAQ SecOps en Azure

Este root es independiente de `infra/aws`: usa otra suscripción, state backend,
identidades, red, secretos y recursos. Ninguna zona DNS ni recurso AWS se importa
ni se modifica aquí.

## Estado

**Preparación IaC — no aplicada, no lista para recibir datos reales.** La
infraestructura incluye red privada, Azure Database for PostgreSQL Flexible
Server con bases separadas para aplicación y jobs, Key Vault, Blob privado para
raw/evidencia, Log Analytics, Container Apps, ACR y federación OIDC de GitHub.
Los Container Apps no se crean por defecto (`enable_runtime = false`) hasta
publicar y revisar las cinco imágenes fijadas por digest.

## Módulos del root

El root ahora separa responsabilidades y conserva bloqueos `prevent_destroy` en
datos y observabilidad:

| Módulo                      | Responsabilidad                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `modules/network`           | VNet, subnets delegadas y DNS privado para PostgreSQL, Key Vault y Blob.                                                       |
| `modules/observability`     | Log Analytics y Container Apps Environment.                                                                                    |
| `modules/data`              | PostgreSQL, bases separadas, Storage de evidencia, Key Vault y endpoints privados.                                             |
| `modules/identity_registry` | Identidades administradas, federación GitHub OIDC, ACR y asignaciones RBAC mínimas.                                            |
| `modules/runtime`           | Edge, web, KrakenD, API y worker genéricos, desactivados hasta recibir digests verificados. No despliega Wazuh QAPAQ ni Ankay. |

`moved.tf` preserva las direcciones anteriores del root al migrar cualquier state
existente. Aun así, inicializa el backend remoto y revisa el plan exacto antes de
aplicar: los bloques `moved` no reemplazan el respaldo ni la revisión del state.
La modularización mejora la separación de cambios; no agrega por sí sola
Wazuh/Indexer/Dashboard, Ankay/Shuffle, conectores Sophos/Cato, DNS ni un worker
operativo. Ankay es Shuffle v2.3.0 con overlay de marca/CSP solo en el frontend;
backend, Orborus, workers y OpenSearch propios siguen siendo los componentes fijados
por el upstream. Como Orborus necesita el socket Docker, su destino previsto es
una VM Linux privada dedicada con Compose y almacenamiento persistente, no uno de
los Container Apps genéricos de `modules/runtime`.

La comparación de cobertura con AWS confirma que este root sigue siendo una
fundación, no una traducción completa del despliegue. Ver
[`revisión de paridad y plan de cierre`](../../docs/cloud/azure/terraform-parity-review-2026-10-19.md)
antes de preparar el primer plan remoto.

La revalidación oficial del 2026-10-20 confirma USD 173.01/mes por el cómputo del
Wazuh all-in-one recomendado y USD 69.50/mes por PostgreSQL B2S: piso de USD
242.51/mes sin el resto del SOC. Supera el límite mensual de USD 200. Ver
[viabilidad de costo](../../docs/cloud/azure/cost-feasibility-2026-10-20.md);
no habilitar runtime ni aplicar este stack hasta acordar alcance y presupuesto y
cotizar los demás componentes.

El stack no incluye todavía el nodo/instalador de Wazuh, Ankay ni cambios DNS.
El paquete actual de Wazuh y sus overlays se deben validar para Azure, y la
instalación del runtime de BullMQ con backend PostgreSQL requiere cambio y
verificación de aplicación antes de habilitar `enable_runtime`.

Se incluye un presupuesto Azure de USD 200/mes con notificaciones de costo real
al 50/75/90/100% y costo proyectado al 100%. Es una alerta, no un límite de
consumo; confirmar moneda/alcance de facturación y verificar que los correos
lleguen después de aplicarlo.

## Requisitos previos

- Región aprobada por residencia de datos para M365/Sophos/Cato y evidencia SOC.
- Suscripción Azure, tenant Entra y permisos para Resource Groups, VNet, PostgreSQL,
  Key Vault, Storage, ACR, Container Apps, identidades y role assignments.
- Backend remoto Terraform en Azure Storage dedicado, con versionado, acceso RBAC
  mínimo, soft delete y locking. El backend no forma parte de este root.
- Runner Terraform dentro de la VNet (self-hosted o red equivalente): Key Vault,
  Blob y PostgreSQL son privados, y el provider usa Microsoft Entra para el
  recurso Blob. Un GitHub-hosted runner público no puede administrar el contenedor
  raw por su endpoint privado. La identidad del runner requiere contributor del
  plano de control y `Storage Blob Data Contributor` limitado al storage de state
  y al storage de evidencia según cada operación.
- Publicador GitHub Actions con environment `azure-demo` y federación OIDC. La
  identidad tiene `AcrPush`; el runtime tiene `AcrPull`, lectura de Key Vault y
  escritura Blob. No hay credenciales de registry estáticas.
- `.github/workflows/qapaq-dashboard-azure.yml` puede publicar el `.deb` QAPAQ
  como OCI artifact a ACR, pero solo por despacho manual desde `main`. El build
  de PR no tiene OIDC. El workflow está propuesto en PR #75; aún no está en
  `main` y no instala Wazuh:
  falta aplicar el registry, configurar environment/variables y añadir el host
  Wazuh con identidad de solo lectura.
- Las imágenes `edge`, `web`, `gateway`, `api` y `worker` deben existir en ACR y
  apuntar a digests SHA-256 aprobados. No usar tags `latest`.
- Crear fuera de Terraform los secretos de runtime en Key Vault y proveer solo
  sus URIs versionados, nunca los valores.

`postgres_admin_password` es una variable sensible necesaria para crear el
servidor. Terraform la conserva en state; por eso no debe usarse este root sin
state remoto cifrado, versionado y de acceso restringido. Cargarla por una
variable de entorno temporal o el secret store del runner; nunca desde un
archivo versionado.

## Secuencia propuesta

1. Revisar [arquitectura Azure](../../docs/cloud/azure/architecture.md), el ADR
   Azure específico y los costos de la región escogida.
2. Crear el backend remoto por un stack de bootstrap separado y restringirlo.
3. Configurar `subscription_id`, `tenant_id`, región y password vía variables
   seguras; no completar DNS todavía.
4. Ejecutar `terraform fmt -check`, `terraform init` con el backend Azure y
   `terraform validate`; generar un plan nuevo y revisar cada recurso, costo y
   destrucción antes de solicitar autorización de apply.
5. Aplicar primero la base de datos/red/Key Vault/ACR. Publicar las imágenes por
   CI con OIDC y reemplazar variables vacías por digests verificados.
6. Completar las migraciones del código/queue y secretos en Key Vault. Solo
   entonces activar runtime, ejecutar plan nuevo y evaluar el diff.
7. Agregar Wazuh y la ruta pública en una fase posterior con artefactos, TLS,
   recuperación y presupuesto revisados. La ruta DNS se prepara aparte y requiere
   una decisión de cutover.

## Protección de datos

PostgreSQL, bases, Key Vault, Log Analytics, Storage Account y contenedor raw usan
`prevent_destroy`. Key Vault tiene soft-delete y purge protection; Blob tiene
versionado y recuperación por borrado. Esto no sustituye backup/restore probado.
Un operador tendrá que retirar esas protecciones con un cambio revisado antes de
cualquier retiro intencional de datos.

Los logs operativos de API/workers y plataforma van a Log Analytics. Los eventos
de seguridad, raw de proveedor, alertas y evidencia permanecen en sus stores SOC
separados; el queue backend conserva únicamente estado/referencias de jobs, no
payloads crudos ni secretos. Ver el [diagrama Azure](../../docs/cloud/azure/diagrams/qapaq-azure.mmd).

## Componentes fuera de este root

- Wazuh manager/indexer/dashboard con branding QAPAQ: requiere un build/paquete
  Azure publicado con `.github/workflows/qapaq-dashboard-azure.yml` y un host
  Azure con `AcrPull`; el `bootstrap.sh.tftpl` AWS usa IAM/SSM y no es portable.
- Ankay Qapaq (Shuffle modificado): desplegar frontend overlay y servicios backend
  de Shuffle en host privado dedicado, con persistencia, ruta `/ankay/*` protegida
  y egress restringido; el menú no debe indicar disponibilidad antes del smoke.
- Dominio `app.jappi.net.pe`, TLS y cutover: este root solo expone el FQDN Azure
  de prueba del edge cuando el runtime se active. No escribe DNS.
- `.github/workflows/azure-terraform-validate.yml` verifica fmt/init/validate sin
  credenciales cloud. `.github/workflows/qapaq-dashboard-azure.yml` contiene el
  build PR y publicación manual del `.deb` a ACR mediante OIDC/ORAS. Ninguno se
  ha publicado ni ejecutado desde GitHub en esta rama. No existe aún workflow de
  plan/apply/despliegue; el environment `azure-demo`, el backend remoto y la
  federación Azure siguen pendientes de crear y probar.
