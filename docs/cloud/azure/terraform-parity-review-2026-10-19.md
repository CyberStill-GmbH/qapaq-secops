# Revisión de paridad Terraform AWS ↔ Azure

**Fecha:** 2026-10-19 (America/Lima)
**Estado:** auditoría y plan de cierre; no se aplicaron recursos ni se modificó DNS.
**Destino revisado:** suscripción Azure `Azure subscription 1`, tenant QAPAQ,
región `chilecentral`.

## Resumen ejecutivo

La observación fue correcta al iniciar la revisión: `infra/azure` era una base
inicial y no tenía paridad operativa con `infra/aws`. Durante el cierre de esta
revisión, el root se separó en módulos de red, observabilidad, datos/evidencia,
identidad/registro y runtime, con bloques `moved` para conservar direcciones de
state. La estructura ahora es más revisable, pero todavía habilita solo
foundations por defecto y no despliega Wazuh QAPAQ, OpenSearch ni Ankay/Shuffle.
No es un stack listo para lanzar el SOC ni para declarar el servicio operativo.

AWS contiene módulos separados de networking, security, database, cache,
private endpoints, application foundations, runtime y Wazuh, además de
bootstrap/ingesta Wazuh. Eso lo hace más completo como IaC, pero no significa
que todo el runtime AWS sea evidencia de operación: el README de AWS señala que
el worker sigue siendo lifecycle stub y que todavía no consume BullMQ. La
paridad debe copiar capacidades demostradas, no trasladar declaraciones que
aún no tienen consumidor o artefacto comprobado.

## Evidencia observada

- Cloud Shell autenticado como `cguevara@qapaq.pe`; `az account show` devolvió
  suscripción habilitada. `az group list` y `az resource list` no devolvieron
  recursos. La consulta de ubicaciones confirmó `chilecentral` como **Chile
  Central**.
- En la primera inspección `infra/azure` contenía seis archivos de configuración
  y un root Terraform sin módulos locales; véase la actualización al final.
- `infra/azure/versions.tf` deja un backend `azurerm` vacío que requiere
  configuración externa. Terraform no pudo listar state: exige inicializar el
  backend. No existe evidencia de state Azure conectado a este checkout.
- `enable_runtime` es `false`; `container_images` está vacío y exige cinco
  digests SHA-256 para `edge`, `web`, `gateway`, `api` y `worker`.
- `.github/workflows/azure-terraform-validate.yml` ahora ejecuta fmt/init/validate
  sin credenciales cloud. El Terraform declara una federación OIDC de GitHub,
  pero el environment `azure-demo`, el workflow OIDC de publicación/plan y las
  imágenes por digest siguen pendientes; esta CI no despliega recursos.
- El Terraform define PostgreSQL, Blob privado, Key Vault, ACR, identidades,
  VNet, private DNS, Log Analytics y Container Apps Environment. No define
  Wazuh Manager/Indexer/Dashboard, el artefacto QAPAQ de Dashboard, Ankay/
  Shuffle, listener/ingesta de agentes ni las políticas de M365.
- La configuración de `qapaq_jobs` y `QAPAQ_QUEUE_BACKEND=postgres` no demuestra
  un backend de cola funcional. ADR-006 aún fija BullMQ 5/Redis; el ADR Azure
  propone BullMQ 6/PostgreSQL sin aprobarlo, y `apps/worker` es un proceso de
  ciclo de vida en espera según `infra/aws/README.md`.
- `postgres_admin_password` es `sensitive`, pero Terraform puede persistirlo en
  el state. Marcar una variable como sensible solo la oculta en salidas; no
  sustituye un backend remoto cifrado, control de acceso ni un diseño de
  autenticación sin contraseña.
- El root inicial no tenía budget. En esta revisión agregué `cost-governance.tf`
  con presupuesto mensual de 200 (moneda de facturación Azure), alertas de costo
  real al 50/75/90/100% y forecast al 100%, enviadas a `cguevara@qapaq.pe`.
  Sigue sin aplicarse. Un budget envía alertas, pero no detiene el consumo; no
  representa un tope mensual duro.
- La red Azure crea subnets/delegaciones y endpoints privados, pero carece de
  un modelo explícito de NSG/egress e inspección. No se debe añadir reglas
  copiadas de AWS sin validar primero requisitos de Azure Container Apps y
  PostgreSQL.
- DNS y custom domain están fuera del root. `app.jappi.net.pe` debe conservar
  el flujo de corte independiente y con rollback descrito en el runbook; no
  hay target Azure para publicarlo todavía.

## Matriz de cobertura

| Capacidad | AWS actual | Azure actual | Estado para el objetivo |
|---|---|---|---|
| Estado remoto y bloqueo de Terraform | S3/DynamoDB configurados en AWS | Backend `azurerm` sin datos de init | **Bloqueante**: aprovisionar backend dedicado y probar lock/restore |
| Red privada y segmentación | VPC, subnets por tier, route tables y SGs por servicio | VNet/subnets; sin NSG/egress explícito | **Parcial**: definir flujo por servicio y controles Azure compatibles |
| Entrada HTTPS y balanceo | ALB/target group/listeners y edge público | Ingress administrado por Container Apps para edge; runtime apagado | **Parcial**: requiere imágenes, dominios/certificados y health comprobado |
| API gateway KrakenD | Servicio separado detrás del ALB | Container App interna prevista | **No desplegado**; image digest y contrato de health pendientes |
| API y workers QAPAQ | ECS, pero worker sin consumo real de BullMQ | Container Apps apagadas; cinco digests ausentes | **No listo**: runtime de worker/cola no validado |
| Cola e idempotencia | Valkey privado; integración de app aún debe demostrar consumo | DB `qapaq_jobs`, sin consumer probado | **Decisión abierta**: ADR-006 contra propuesta BullMQ 6/Postgres |
| Datos SOC | RDS privado, backup y protección de borrado | PostgreSQL privado con `prevent_destroy`, backup configurado | **Parcial**: identidad runtime/credenciales, restore y costo pendientes |
| Evidencia cruda | S3 cifrado, versionado, lifecycle, bucket policy y KMS | Storage privado, ZRS, versioning y retención | **Parcial**: probar restore/retención y evaluar costo ZRS |
| Secretos | Secrets Manager y permisos por workload | Vault protegido y secret IDs externos, sin valores cargados | **No migrado**: inventariar referencias y ejecutar copia segura sin exponer valores |
| Registro de imágenes | ECR por servicio y GitHub OIDC | ACR Basic y OIDC declarado | **No listo**: workflow, environment, role assignments y digests inexistentes |
| Wazuh QAPAQ / OpenSearch | VM Wazuh con bootstrap, SSM y secretos | No existen recursos ni publicación/deploy Azure; el build QAPAQ 4.14.8/OSD 2.19.6 sí pasó en `QAPAQ SIEM` run [38883516883](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/38883516883) y publicó el `.deb` en S3 AWS | **Bloqueante** para dashboard SOC y M365 en Azure |
| Ankay / Shuffle | No hay evidencia de stack en esta plantilla | Sin servicios ni workflow de SOAR | **Bloqueante** para SOAR desde Dashboard |
| M365 / Sophos / Cato | Config parcial de M365 en Manager AWS; Sophos/Cato faltan contratos | No hay secret refs ni worker operativo | **No certificable** hasta adapters, credenciales y eventos sintéticos reales |
| Agentes y reglas | Bootstrap del manager y reglas M365 en AWS | Sin Manager ni enrolamiento | **No desplegado** |
| Observabilidad y alertas | CloudWatch/log groups por servicio | Workspace Log Analytics sin alert rules/action group | **Parcial** |
| Costos | Recursos medibles en AWS, historial previo de gasto | Budget de 200 y alertas definidos en IaC, aún no aplicados | **Parcial**: confirmar moneda, alcance, entrega de alertas y estimar SKU/retención |
| DNS y TLS | Route 53 en state AWS | Fuera del Terraform Azure | **No tocar** hasta tener ingress y probar HTTPS temporal |

## Plan de fortalecimiento

### Fase 0 — Contratos y guardrails, sin recursos de runtime

1. Confirmar la suscripción por ID desde Azure CLI y verificar que el usuario
   tiene permisos de crear recursos, role assignments y presupuestos. No usar
   claves persistentes de service principal.
2. Configurar state remoto dedicado en Azure Storage, separado de AWS, con
   versionado, acceso Entra, RBAC mínimo, cifrado y restore documentado. Hacer
   bootstrap en una cuenta/state independiente y probar el lock antes de init.
3. Revisar el budget incluido: confirmar moneda y destinatarios; desplegarlo junto
   con el primer stack y verificar las notificaciones. Añadir estimación por
   SKU/retención y procedimiento de apagar workloads. Un budget no es hard cap.
4. Fijar compatibilidad de runtime: imágenes OCI por digest, Wazuh 4.14.x / OSD
   2.x ya modificados, versión de KrakenD, Shuffle/Ankay y requisitos de disco.
5. Resolver por ADR si Azure usará Redis/Valkey con BullMQ 5, BullMQ 6/Postgres
   u otra cola. No desplegar una variable que el runtime no consuma.

### Fase 1 — Convertir IaC base en módulos revisables

Separar el root en módulos `network`, `observability`, `data`, `evidence`,
`identity-registry` y `runtime`. Conservar direcciones de recursos estables o
usar `moved` blocks antes de cualquier state real. Añadir NSGs/egress solo con
matriz de flujos probada; añadir alertas de PostgreSQL, Container Apps y estado
de ingesta con action group autorizado. Incluir validaciones de nombres,
CIDRs, digest, TLS y retención.

### Fase 2 — Wazuh/Ankay y conectores

Definir módulo de Wazuh QAPAQ con VM, managed identity, discos persistentes,
NSG por puerto, diagnósticos y acceso al Dashboard únicamente por el edge
protegido. Ankay debe ir como backend aparte, con ruta `/ankay/*` tras la sesión
QAPAQ y datos/credenciales cifrados. No copiar el paquete AWS/SSM sin adaptar
bootstrap, identidad, endpoints y recuperación Azure.

Agregar Key Vault secret references por componente, con permisos mínimos y
valores migrados directamente desde la fuente autorizada. Confirmar una sola
ruta de notificación Teams y demostrar ingestión M365, Sophos y Cato con eventos
sintéticos contra sus APIs reales. No cargar claves en `tfvars`, logs o CI.

### Fase 3 — CI/CD y activación gradual

Crear GitHub Environment con aprobadores y OIDC restringido al repo/branch;
pipeline de build/scan/SBOM, push a ACR, plan guardado y publicación del plan
para revisión humana. Aplicar primero foundations tras aprobar costo y plan; luego
artefactos de runtime; finalmente prueba con hostname Azure temporal. DNS queda
separado y se cambia solo después de probar health, auth, Wazuh, M365 y rollback.

## Decisión operativa

**No ejecutar `terraform apply` con la configuración actual.** El root no tiene
backend inicializado, runtime/secretos/imágenes ausentes y tampoco crea Wazuh o
Ankay; el apply no levantaría el SOC solicitado. Aún no hay un plan exacto que
permita comparar altas, cambios, destrucciones, permisos y costo. La autorización
previa de despliegue no sustituye esos gates ni convierte componentes pendientes
en operativos.

El primer entregable de código debería ser la **Fase 0** y los contratos de la
**Fase 1**, no un apply parcial que deje infraestructura con costo sin el SOC.

## Fuentes

- [Terraform AWS root](../../../infra/aws/main.tf) y módulos de networking,
  security, database, cache, private endpoints, runtime y Wazuh.
- [Terraform Azure root](../../../infra/azure/main.tf), variables, versiones y
  README.
- [Arquitectura Azure](architecture.md), [runbook de corte](runbook-preparacion-y-corte.md)
  y [ADR Azure de cola](decisions/adr-azure-queue-postgres.md).
- [Decisiones técnicas vigentes](../../10-decisiones.md) (A9/A18) y
  [modelo de caché y colas](../../11-cache-y-colas.md), consolidación de los ADR históricos, y
  [README AWS](../../../infra/aws/README.md).
- [Azure Cost Management budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets):
  los umbrales de presupuesto generan avisos, pero no afectan los recursos ni
  detienen el consumo.
- [Azure PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/azure/postgresql/overview):
  el servicio ofrece backups y opciones de HA/monitorización, cuya disponibilidad
  varía por región y SKU.

## Actualización de cierre — 2026-10-19 (America/Lima)

La Fase 1 estructural quedó implementada localmente en `infra/azure`: los 29
recursos que estaban declarados bajo el root se movieron a cinco módulos locales
(`network`, `observability`, `data`, `identity_registry`, `runtime`). El grupo de
recursos y el budget siguen en el root. `moved.tf` contiene 29 transiciones, una
por cada dirección anterior; un chequeo de inventario encontró 30 recursos en el
root original, 29 transiciones y 29 recursos destino, sin direcciones omitidas o
sin destino. Se verificó `terraform fmt -check -recursive`, `terraform init
-backend=false -input=false`, `terraform validate` y `git diff --check`.

Esta comprobación valida estructura y referencias HCL, no consulta el state
remoto ni calcula el diff Azure. El stack no se aplicó. La ausencia de backend
inicializado y el inventario Cloud Shell pendiente siguen impidiendo afirmar que
las 29 transiciones se ejecutaron o que el SOC está desplegado. Permanecen los
gaps de Wazuh/Indexer/Dashboard, Ankay, publicación/plan OIDC, workers/conectores
y DNS descritos arriba. La CI Azure local cubre únicamente validación estática.

## Revalidación de runtime de cola — 2026-10-19 (America/Lima)

La lectura directa de `apps/worker/package.json` confirma BullMQ `5.81.5` e ioredis `6.0.0`, pero `apps/worker/src/composition-root.ts` crea únicamente `WorkerRuntime`; `apps/worker/src/lifecycle/worker-runtime.ts` implementa ciclo de vida y drenaje, no construye un `Queue`/`Worker` de BullMQ ni conecta Redis. Tampoco aparece `QAPAQ_QUEUE_BACKEND` en el runtime API/worker fuera de la IaC Azure.

Por tanto, `QAPAQ_QUEUE_BACKEND=postgres` y las variables `QAPAQ_QUEUE_POSTGRES_*` que Terraform inyectaría no activan una cola PostgreSQL. ADR-AZ-001 permanece `Proposed`; no hay código BullMQ v6/PostgreSQL, migración ni pruebas de enqueue/consume. No habilitar Container Apps por la sola disponibilidad de cinco imágenes. Para continuar, el owner backend debe elegir/implementar un adapter Azure verificable (PostgreSQL BullMQ 6 o Redis-compatible BullMQ 5) conservando el default AWS, y publicar los contratos de API/worker; después se alinea Terraform con ese contrato y se mide costo/capacidad en Chile Central.

## Revisión de perímetro ACA — 2026-10-20

El root configura `internal_load_balancer_enabled = false` para el entorno de
Container Apps y `external = true` para `edge`. Por tanto, el único servicio
público previsto es el edge QAPAQ. La guía oficial de Microsoft indica que, en un
workload-profile environment externo, el tráfico público llega por una IP del
managed resource group y **no se puede restringir ese ingreso con NSG o firewall
en la subnet**. Una NSG de la VNet no reemplaza WAF ni control de ingreso para
ese endpoint ([guía de NSG de Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration),
[red de Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/networking)).

El endpoint mantiene TLS gestionado por ACA y la autorización de la aplicación
debe seguir en el edge con el mecanismo de sesión QAPAQ existente. Antes del DNS
`app.jappi.net.pe` se debe decidir y cotizar el perímetro público: aceptar ACA
external con controles de aplicación y restricciones admitidas por ingress, o
adoptar un entorno interno detrás de una capa WAF/LB que soporte el flujo y TLS.
No se deben declarar KrakenD ni los backends públicos: solo `edge` debe aceptar
ingreso externo. Cambiar a una capa WAF/LB añade costo y requisitos de routing,
certificado y health check; no se incluye ni se aplica en esta IaC.

La selección del tipo de entorno y su subnet es una decisión temprana: Microsoft
advierte que no se puede cambiar el tipo de red del entorno después de crearlo.
La subnet `/27` del Terraform corresponde al mínimo de workload profiles; si se
elige entorno de consumo heredado, el mínimo documentado es `/23`. Esta revisión
no cambia la configuración de red ni afirma que se haya probado el ingress en
Azure. El costo estimado permanece por encima del saldo disponible, así que no
se prepara ni ejecuta un plan de creación todavía.

## Actualización de contrato de entorno · 2026-10-20

Se retiraron de Terraform las variables `QAPAQ_QUEUE_*` que la configuración de aplicación rechazaba. El workflow Azure ahora compara las variables QAPAQ explícitas de API/worker con `KNOWN_QAPAQ_VARIABLES` mediante `scripts/check-azure-runtime-env.mjs`. La cola no quedó implementada: `qapaq_jobs` sigue sin consumidor y el worker continúa siendo lifecycle-only. Esta corrección elimina una causa concreta de reinicio, pero no resuelve credenciales/rol PostgreSQL ni migraciones y no autoriza `enable_runtime`.

## Revisión de pin de Wazuh QAPAQ · 2026-10-20

El `bootstrap.sh.tftpl` de AWS descarga `wazuh-install.sh` desde la ruta de
serie (`${WAZUH_VERSION%.*}`), no desde un artefacto fijado al patch. Por eso,
`wazuh_version = 4.14.8` no garantiza que el instalador despliegue exactamente
4.14.8. El overlay QAPAQ actual fija Wazuh 4.14.8 y OSD 2.19.6; la lista oficial
consultada ya publica paquetes 4.14.9. No se debe copiar ese bootstrap a Azure
ni considerar compatible el paquete del Dashboard con un manager/indexer de
patch distinto sin una prueba de compatibilidad.

El módulo Azure de Wazuh debe fijar versiones exactas de manager, Filebeat,
indexer y Dashboard; verificar hashes/firma del artefacto; instalar el `.deb`
QAPAQ construido para la misma versión; y no actualizar automáticamente por la
ruta móvil de la serie. La documentación oficial describe la instalación
asistida y los puertos de agente 1514/TCP y enrolamiento 1515/TCP:
[installation assistant](https://documentation.wazuh.com/current/installation-guide/wazuh-server/installation-assistant.html),
[agent enrollment troubleshooting](https://documentation.wazuh.com/current/user-manual/agent/agent-enrollment/troubleshooting.html),
[package list](https://documentation.wazuh.com/current/installation-guide/packages-list.html).
La verificación de compatibilidad y el módulo Azure de Wazuh/Ankay siguen
pendientes; ningún manager, agente o playbook está desplegado por este PR.
