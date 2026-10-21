# Runbook Azure: secretos, publicación y corte

## Alineación vigente de arquitectura

Este runbook conserva abajo observaciones fechadas del 2026-10-20. Para el diseño objetivo prevalece [`architecture.md`](architecture.md), basado en `docs/10-decisiones.md` A5–A9/A13/A18/A20/A22 y `docs/12-backend-en-el-siem.md`.

El destino Azure es Wazuh QAPAQ 4.14.8 / OSD 2.19.6 con edge Nginx QAPAQ en el host SIEM; `qapaq-core` API+worker Node 24 junto al SIEM; PostgreSQL durable; Valkey para sesiones, cache-aside y BullMQ; KrakenD para ingesta según A8; y Ankay como Shuffle completo en un host privado separado, tras `/ankay/*` con la sesión/autorización QAPAQ actual. `siem_host` ya está conectado al root detrás del objeto opcional `siem_host`, desactivado por defecto; `ankay_host` sigue aislado. CI, bundle, plan y apply siguen pendientes; este diseño no certifica un despliegue.

Antes de usar este runbook, tener presentes estos gates:

- `enable_runtime` crea cinco Container Apps genéricas; no sustituye Wazuh ni representa A22. Una base `qapaq_jobs` tampoco acredita una cola activa. A9 define Valkey/BullMQ, pero el worker actual es lifecycle-only y no consume BullMQ.
- `wazuh/core` y Office 365 aún dependen de AWS SSM, Secrets Manager y la CA RDS. Se requiere una adaptación Azure con Managed Identity/Key Vault y PostgreSQL Azure. No rotar los secretos AWS existentes.
- No afirmar M365, Sophos, Cato, Teams, agentes o playbooks operativos sin pruebas contra los servicios Azure. El workflow Ankay publica el overlay de frontend; no instala backend, Orborus, workers ni OpenSearch.
- A11 fija snapshots/evidencia en S3 y excluye Azure. No usar Blob para esos datos hasta que una decisión revisada defina residencia, Object Lock y retención.
- USD 200/mes es un umbral de alertas, sin apagado ni `destroy`. La estimación actual ya supera ese importe antes de los componentes restantes.
- No aplicar el paso DNS de abajo como si el destino fuera Container Apps. Primero debe existir el edge del host SIEM con TLS y hostname probado. El Terraform Azure no administra Route 53.
**Estado:** preparación; no hay recursos Azure aplicados ni DNS cambiado.
**Región configurada:** Chile Central (`chilecentral`).
**Umbral de alerta de presupuesto:** USD 200/mes; no es un tope ni apaga recursos.
**Crédito de cuenta observado:** USD 200 restantes, con vencimiento el 18 de
noviembre de 2026. Es crédito temporal, no un límite mensual de consumo.

Este runbook fija el orden para una futura activación y los controles que impiden
declararla operativa antes de una prueba real. Nunca registrar aquí los valores de
secretos ni adjuntarlos a planes, logs o artefactos de CI.

## Inventario Azure observado (solo lectura, 2026-10-20)

- El portal muestra una suscripción habilitada llamada `Azure subscription 1` y
  USD 200 de crédito restante con vencimiento el 18 de noviembre de 2026.
- En Cloud Shell autenticado, `az account show`, `az group list --query
  'length(@)'` y `az resource list --query 'length(@)'` mostraron estado
  `Enabled`, cero grupos de recursos y cero recursos. La consulta no creó ni
  modificó recursos. La CLI local de Windows sigue sin instalarse.
- Esta evidencia confirma que no hay infraestructura desplegada en esa
  suscripción en el momento de la consulta. El piso estimado de un mes Wazuh +
  PostgreSQL es USD 242.51 antes de los demás componentes. Supera el umbral de
  alertas de USD 200 y los créditos promocionales observados; los créditos no
  son un límite de facturación y pueden agotarse antes de terminar el mes.

- El PR #75 se integró en `main` el 2026-10-20 (America/Lima), merge
  `48cbad26fa3e5d7d5f22e6b5658de11245ac0a4e`. `infra/azure` incluye la base de
  red/datos/identidad y conecta `modules/siem_host` detrás del objeto opcional
  `siem_host`, que permanece apagado cuando es `null`. `enable_runtime=false`; el
  runtime genérico no es el frontend ni el SIEM de destino.
- GitHub Actions ya expone las cuatro variables del backend remoto
  (`AZURE_TF_STATE_RESOURCE_GROUP`, `AZURE_TF_STATE_STORAGE_ACCOUNT`,
  `AZURE_TF_STATE_CONTAINER`, `AZURE_TF_STATE_KEY`). El acceso OIDC al state y
  la identidad Azure no se han demostrado porque el workflow remoto espera
  aprobación de `azure-demo` antes de inicializar Terraform. No se ha leído ni
  escrito state con ese workflow.
- El módulo SIEM requiere un bundle instalable completo que aún no existe. El
  workflow experimental construye Manager/Indexer y verifica Filebeat, pero sus
  paquetes son temporales y no incluyen `install.sh`, Dashboard QAPAQ ni core.
  Los workflows Azure de Dashboard y core son separados: el core Azure ya pasó
  build/checksum en el run
  [39531106649](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39531106649);
  el Dashboard se compila en
  [39531035378](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39531035378)
  y continuaba en ejecución a la hora de esta actualización. Ninguno de esos
  runs publica a Azure ni despliega una VM.
- El módulo `ankay_host` existe aislado, pero el root no lo instancia. Su
  `cloud-init` monta y prepara el Compose; no instala ni arranca Shuffle,
  Orborus, workers, OpenSearch o el backend. El workflow de Ankay en
  [39530587455](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39530587455)
  terminó el build sin publicar a ACR.
- El workflow heredado `QAPAQ SIEM` de `main` construyó `qapaq-core` y publicó
  el artefacto inmutable a S3 de AWS en el run
  [39530587442](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39530587442).
  El job `build-dashboard` de ese run seguía activo en la última lectura. Esto
  es publicación de artefactos, no despliegue ni cambio de infraestructura. El
  workflow Azure separado no reutiliza esa publicación. El repositorio separado
  [`CyberStill-GmbH/qapaq-dashboard`](https://github.com/CyberStill-GmbH/qapaq-dashboard)
  reporta versión `5.1.0-alpha0` en `main`; no sustituye el overlay compatible
  que se fija en `qapaq-secops/wazuh/dashboard/upstream.lock` para Wazuh 4.14.8 /
  OSD 2.19.6. La fuente de Ankay está en la
  rama `feature/ankay-qapaq`: `ankay/build.sh` fija
  Shuffle v2.3.0, construye el frontend con overlay QAPAQ y publica su fuente
  correspondiente bajo AGPL. El backend Go, Orborus, workers y OpenSearch son
  upstream Shuffle sin modificar. Orborus necesita acceso al socket Docker; el
  diseño apunta a una VM Linux privada con Compose y volúmenes persistentes. El
  módulo Azure aislado no demuestra el Compose ni el runtime funcional. El
  instalador versionado de Wazuh Office 365 usa AWS Secrets Manager y requiere
  adaptación explícita a Key Vault antes de ejecutarse en Azure.
- CI Security pasó en el run
  [39530588011](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39530588011).
  La validación del Terraform Azure y la validación aislada del host Ankay
  pasaron en los runs de `main`; son pruebas de código, no autenticación Azure
  ni despliegues.
- El workflow Terraform Azure se lanzó con `apply=false` en
  [39530618084](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39530618084).
  Permanece esperando aprobación de `azure-demo` antes de generar el plan. La
  API de GitHub reportó que el usuario que lanzó el run no puede aprobar su
  propio deployment; el revisor configurado es `CesarGuevaraQapaq`. El run actual
  solo puede generar un plan; no puede aplicar recursos. No se ejecutó apply ni
  se cambió DNS.
- GitHub Actions ya tiene configurados, como repository secrets, los nombres
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID`; también
  aparece `ENTRA_CLIENT_SECRET`. Solo se inspeccionaron nombres/metadata; no se
  leyeron valores. Los workflows Terraform prefieren
  `AZURE_TERRAFORM_CLIENT_ID`, mientras los publicadores esperan
  `AZURE_ACR_PUBLISHER_CLIENT_ID`. Terraform acepta `AZURE_CLIENT_ID` como
  alternativa a `AZURE_TERRAFORM_CLIENT_ID`; la identidad ACR continúa separada.
  La presencia del secreto no prueba la federación OIDC ni los roles del
  principal; validar eso con el plan autenticado.
- Terraform requiere `AZURE_POSTGRES_ADMIN_PASSWORD`; el propietario confirmó que
  el repository secret fue creado/actualizado después del inventario inicial. No
  se leyó ni se registra su valor. El backend remoto/state tiene configuradas
  las variables `AZURE_TF_STATE_RESOURCE_GROUP`,
  `AZURE_TF_STATE_STORAGE_ACCOUNT`, `AZURE_TF_STATE_CONTAINER` y
  `AZURE_TF_STATE_KEY`; todavía falta demostrar el acceso OIDC a Azure y al state.
  La publicación requiere `AZURE_ACR_NAME` y `AZURE_ACR_LOGIN_SERVER` después de
  crear el registry; plan/apply usa runner GitHub-hosted y no requiere
  `AZURE_TF_RUNNER_LABELS`. GitHub reportó cero runners propios en el inventario
  fechado y todavía no se ha demostrado OIDC desde Actions.
  El environment `azure-demo` está restringido a `main` y requiere revisión;
  eso no prueba la identidad o el acceso al state.
- El inventario de fuentes marca Sophos y Cato como `TO_BE_PROVIDED`/`planned`:
  faltan producto/edición, API y versión, región, autenticación, permisos,
  datasets, cuotas, replay, credencial y conectores validados. Tener credenciales
  sin esos contratos no habilita ingestión.
- La zona pública `jappi.net.pe` está delegada a Route 53 (`awsdns`). No hay A,
  AAAA ni CNAME para `app`, `qapaq-secops` o `wazuh`; los registros encontrados
  para esos tres nombres son solo CAA para Let's Encrypt. El único A de la zona
  apunta Vercel en `codexpt.jappi.net.pe`, fuera de los hostnames de corte. No se
  borró ningún DNS porque no existe un destino web antiguo en los hostnames
  solicitados; quitar CAA no redirige el tráfico y alteraría la política TLS.
- En la última lectura autenticada de Azure se observó la suscripción `Enabled`,
  la cuenta `cguevara@qapaq.pe` con `Owner` en el ámbito de suscripción y cero
  grupos de recursos en el portal. No se ejecutó un apply desde este checkout.
  La CLI `az` local no está instalada; renovar inventario desde Cloud Shell o
  Actions antes del plan. `aws sts get-caller-identity` respondió como la cuenta
  `955200662475` con ARN `root`; no
  se usará esa identidad para cambios. No se inspeccionaron valores de secretos
  en Azure, AWS, Sophos o Cato.

## Publicación del Dashboard QAPAQ a Azure Container Registry

El build existente produce un `.deb` verificable, pero su publicación actual es
solo a S3. ACR admite artefactos OCI genéricos además de imágenes de contenedor;
Microsoft documenta publicación y descarga con ORAS
([ACR: administrar artefactos OCI](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-manage-artifact)).
El flujo Azure debe:

1. Conservar el job sin credenciales para compilar y validar el paquete en PR.
2. Publicar solo por despacho explícito a un repositorio OCI dedicado, con tag
   derivado del SHA de Git, digest registrado y ACR OIDC `AcrPush`; no reutilizar
   AWS OIDC ni secretos persistentes.
3. Asignar a la futura VM Wazuh una identidad administrada de solo lectura
   (`AcrPull`) y descargar por digest, validar el `.deb` con el checksum y recién
   entonces instalarlo.
4. Registrar SBOM/procedencia y el digest aprobado en el manifiesto del release;
   el tag por sí solo no es prueba de inmutabilidad.

El workflow `.github/workflows/qapaq-dashboard-azure.yml` implementa el tramo de
build y publicación; su validación cloud-free puede correr en PR. El build/PR no recibe
`id-token`; la publicación requiere `workflow_dispatch`, `publish_to_acr=true`,
`main` y el environment `azure-demo`. Falla antes de autenticarse si se despacha
desde otra rama o faltan las variables. Usa acciones fijadas a commit y ORAS
1.3.5. Tras verificar el `.deb` en ambos jobs, publica el paquete, `SHA256SUMS`
y `package-metadata.txt` como OCI artifact con etiqueta compuesta por el SHA del
commit y el SHA-256 del paquete; registra y muestra la referencia por digest del
manifiesto. El token de ACR es temporal de Entra, se entrega a ORAS por stdin y no se guarda en variables
ni artefactos.

Los workflows de publicación leen `AZURE_ACR_PUBLISHER_CLIENT_ID`,
`AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID` desde repository secrets (con
fallback a variables). El `AZURE_ACR_PUBLISHER_CLIENT_ID` debe corresponder a la
identidad federada que Terraform crea con `AcrPush`, cuyo subject inmutable es
`repo:CyberStill-GmbH@220633794/qapaq-secops@1374673243:environment:azure-demo`.
El artifact de GitHub
se conserva un día entre jobs. Esta pipeline no instala el `.deb`, no modifica
una VM ni ejecuta Terraform. ACR conserva endpoint público autenticado con RBAC;
antes de tratarlo como registro productivo, restringir acceso a red o usar un
runner privado y revisar retención/immutability del registry.

La publicación cloud no se ha ejecutado: aunque el environment `azure-demo` ya
está creado, la identidad bootstrap `AZURE_TERRAFORM_CLIENT_ID`, la identidad
publicadora `AZURE_ACR_PUBLISHER_CLIENT_ID`, las variables del registry, el state
remoto, el registry Azure y el plan de costo siguen pendientes.
Tampoco existe la VM Wazuh con identidad `AcrPull`; por eso no se creó el
artifact ni se publicó nada a ACR.

## Catálogo de secretos

Guardar cada valor en Azure Key Vault desde un operador o runner con acceso
privado. Terraform recibe solo el URI versionado. El mapa `key_vault_secret_ids`
define qué secreto se referencia por servicio; no es un mecanismo para importar
valores desde AWS.

| Servicio consumidor | Secreto requerido | Estado y procedencia |
| --- | --- | --- |
| API QAPAQ | `QAPAQ_ENTRA_CLIENT_SECRET` | Requiere comprobar la versión vigente en el origen autorizado y copiarla mediante un canal seguro. Tenant ID y client ID son configuración, no secretos. |
| API QAPAQ | `QAPAQ_TEAMS_WORKFLOW_URL` | Debe ser la URL nueva de Teams Workflows. La URL firmada es una credencial y nunca se imprime ni prueba con `curl -v`. |
| API/gateway QAPAQ | `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN` y CA del Indexer, si aplica | Pendientes del paquete y endpoints de Wazuh para Azure; no configurar hasta establecer identidad de solo lectura, TLS y ruta privada. |
| Manager Wazuh | Credencial de la app Office 365 | Se consume localmente por el módulo `office365`. Migrar el script desde AWS Secrets Manager a Key Vault y comprobar permisos antes de iniciar la lectura. |
| Worker M365/Sophos/Cato | Credenciales de cada conector | M365 conserva la integración aceptada. Sophos y Cato están bloqueados por contratos de API/permisos todavía ausentes. No inyectar secretos a un worker sin adaptador aprobado. |
| PostgreSQL | Password bootstrap y password de rol runtime | El bootstrap es requerido para crear el servidor y queda en Terraform state. Falta crear un usuario de aplicación de mínimo privilegio y migraciones seguras; no reutilizar el administrador como identidad de runtime. |

Flujo de copia recomendado: inventariar nombres/owners/metadatos sin revelar valores;
confirmar que la fuente está vigente; copiar fuente→Key Vault directamente desde un
runner autorizado con egress privado; verificar por versión/metadata y prueba de
conexión con salida redactada; emitir los URIs versionados para Terraform; rotar o
revocar la credencial anterior solo después del corte validado. No enviar secretos
por el chat ni guardarlos en `tfvars`, GitHub variables de texto, logs o planes.

## Notificaciones Teams

La ruta de notificaciones de QAPAQ (`modules/soar/src/teams-adapter.ts` y
`teams-payload.ts`) ya utiliza una URL de **Teams Workflows** y adjuntos
**Adaptive Card**. La suite del adapter pasó 27/27 pruebas del módulo `soar`.
Microsoft documenta Workflows como receptor de webhook HTTP y la publicación de
Adaptive Cards; los conectores Office 365 heredados están en retirada.

Se preparó `infra/wazuh/teams/custom-qapaq-teams` como integración personalizada
del **backend Wazuh Manager 4.x** y `ossec-teams-workflow.xml` como bloque de
configuración. No es un cambio en `modules/soar` ni en el frontend. El adaptador
rechaza el webhook heredado `IncomingWebhook`, requiere Teams Workflows y envía una
tarjeta mínima para reglas de nivel 12 o superior. La URL debe llegar al host desde
Key Vault mediante identidad administrada y quedar en un archivo protegido; nunca
se incluye en Git, `ossec.conf`, argumentos visibles o logs.

La integración está preparada y probada con datos sintéticos, pero **no está
instalada ni verificada contra un Manager real**: este checkout no contiene el
Manager Wazuh modificado ni su paquete Azure, y no se ha identificado una instancia
Wazuh administrada en la región AWS consultada. Antes del despliegue hay que
integrar estos archivos al artefacto/bootstrap del Manager 4.x, confirmar una sola
ruta de notificación para evitar duplicados, provisionar la URL desde Key Vault y
validar entrega, timeout, rate limit y recuperación del integratord. El aviso de
Teams no es ACK de un analista. Wazuh 5.x requiere un mecanismo distinto porque
retiró `<integration>`/`integratord`.

Para la automatización SOAR se preparó `infra/wazuh/shuffle/`: Wazuh Manager 4.x
publica al trigger moderno `/api/v1/webhooks/webhook_<id>` de Shuffle con TLS y
header de autenticación obligatorio, enviando un payload mínimo. El workflow puede
usar una acción HTTP hacia Teams Workflows solo con almacenamiento cifrado/KMS
verificado para la URL firmada; si no, el emisor crítico continúa en el outbox de
QAPAQ (ADR-022) para no duplicar notificaciones. El workflow, host Shuffle,
credencial, webhook y ejecución reales siguen pendientes; no están creados ni
aplicados por Terraform.

El catálogo inicial de playbooks está en
el directorio `docs/security/ankay-playbooks/` (no presente en esta rama). Define el
trigger directo Wazuh solo para triage read-only; ejecución de acciones requiere
despachador del outbox QAPAQ, callback firmado, permisos revisados y aprobación
SoD. VirusTotal queda bloqueado hasta confirmar licencia Enterprise/comercial,
condiciones de privacidad de IOCs y referencia de secreto en Key Vault. Graph,
Sophos y Cato no se consideran conectados hasta validar scopes/tenant y entregar
eventos sintéticos por los conectores reales.

Ankay Qapaq **es Shuffle modificado**, no otro producto SOAR: el overlay actual
cambia marca, arte y CSP del frontend, mientras sus servicios backend siguen el
upstream fijado. La exposición propuesta es un enlace del Dashboard bajo
`/ankay/*` detrás de la sesión y autorización QAPAQ, sin iframe ni cambio del
login. Requiere integrar la ruta en el edge, desplegar Compose en la VM privada y
contar con Manager y Shuffle desplegados; el stack Azure actual aún no contiene
esos componentes. La integración Wazuh→Shuffle existente es solo el adaptador del
Manager; no crea la plataforma Shuffle ni workflows.

La validación local del overlay (2026-10-19) aplicó los tres parches sobre el SHA
fijado y pasó 11/11 pruebas del codemod, incluyendo texto de UI con
interpolaciones. Se generó el paquete de fuente exigido por AGPL; no se construyó
la imagen porque el daemon Docker local no estaba disponible. Por tanto, aún no
hay imagen publicada ni despliegue funcional. Se añadió
`.github/workflows/ankay-azure.yml`: el job de PR no recibe credenciales cloud y
compila el contenedor en GitHub Actions; la publicación manual a ACR está
restringida a `main` y depende del mismo environment/identidad OIDC que el
workflow del Dashboard. El workflow está en PR #75; sus checks de PR no publican
imágenes ni se autentican en Azure.

El baseline profesional de agentes, malware, telemetría y respuesta está en
el documento `docs/security/qapaq-sophos-cato-wazuh-baseline.md` (no presente en esta rama).
Es una propuesta, no una comprobación ni aplicación de políticas en proveedores.
Sophos y Cato permanecen `TO_BE_PROVIDED`/`planned` en el inventario de fuentes;
faltan contratos de API/licencia/tenant y las credenciales de acceso a sus
consolas. No se afirma que sus agentes, reglas o políticas estén aplicados.

## DNS y TLS para `app.jappi.net.pe`

1. Crear y verificar el edge Azure con ingress HTTPS y obtener su FQDN de salida.
2. Vincular `app.jappi.net.pe` al Container App y completar la validación del
   dominio/certificado que Azure requiera. Probar HTTPS, health, login y rutas API
   usando el hostname temporal antes del corte.
3. Preparar en Route 53 un cambio revisable de solo el registro `app` hacia el
   destino Azure, con TTL bajo y snapshot del valor anterior. No cambiar la
   delegación de la zona ni otros registros del dominio.
4. Después del cambio, comprobar resolución desde resolvers públicos, cadena TLS,
   login, API, health y notificación sintética. Revertir `app` al valor respaldado
   si falla cualquiera de esas comprobaciones.

El registro no se puede preparar con un destino final mientras no exista el
Container App y el mapeo TLS. El Terraform Azure de este checkout no gestiona
Route 53; DNS conserva state y operador AWS aparte.

## Agentes Wazuh

No hay un manager Azure al cual enrolar agentes. Antes de instalar agentes, fijar
versión y artefacto del manager compatible; publicar puertos de enrolamiento solo
por la red aprobada; configurar autenticación de agente y rotación; asignar grupos
por perfil de activo y aplicar políticas/rulesets revisados. Empezar por endpoints
de prueba, demostrar inventario, heartbeat, FIM y reglas sintéticas, y después
incorporar equipos autorizados por grupos. No publicar enrollment keys en la UI ni
usar una clave compartida como sustituto del control de acceso.

## Gates antes de declarar el servicio listo

1. Autenticarse a Azure y AWS; seleccionar la suscripción/tenant correctos.
2. Crear state backend con endpoint de red público y acceso de datos protegido
   por Entra ID/OIDC y RBAC, sin shared keys ni acceso anónimo. Esta decisión
   permite runners GitHub-hosted con egress dinámico y expone el endpoint a la
   red pública; mantener container privado, alcance RBAC mínimo, environment
   protegido y revisión del plan. Instalar herramientas fijadas y confirmar el
   lockfile del provider.
3. Resolver las decisiones de región y residencia; cotizar SKUs, GB de logs,
   retención, backups y réplicas. Mantener USD 200/mes como umbral de alerta; no
   programar apagado o destroy automático por alcanzar ese monto.
4. Publicar imágenes compatibles por CI, fijar digests y validar Queue/Worker
   PostgreSQL en el código de aplicación. La infraestructura actual no demuestra
   que la cola esté implementada en runtime.
5. Proveer contratos de conectores y materializar secretos por URI de Key Vault.
6. Ejecutar `terraform plan`; revisar altas, cambios, exposición pública,
   `prevent_destroy`, permisos RBAC y costo antes de aplicar.
7. Desplegar Wazuh QAPAQ y Ankay (frontend overlay más backend/Orborus/workers/
   OpenSearch de Shuffle) con almacenamiento/recuperación; validar TLS, ruta
   protegida, workflows sintéticos y flujos de notificación. Enrolar primero
   agentes sintéticos.
8. Configurar TLS/DNS, cortar solo `app.jappi.net.pe` y ejecutar smoke tests desde
   red externa y SOC. Documentar run IDs, digests, IDs de recursos y evidencia
   redactada.

La autorización general de despliegue no reemplaza las identidades y permisos
técnicos de Azure, AWS, Microsoft 365 y Route 53. Sin ellos no se puede ejecutar
el plan ni certificar una integración real.
