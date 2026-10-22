# Runbook Azure: secretos, publicación y corte

## Estado actual — 2026-10-22

PR [#100](https://github.com/CyberStill-GmbH/qapaq-secops/pull/100) se integró en
`main`, ahora en `048716ada8e3e5e077b044888b1291ec101506d4`. Solo añadió validación
de la referencia de secreto en Key Vault y casos de `terraform test`; no modificó
infraestructura. La validación Azure Terraform
[39773533408](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533408)
está verde. CI Security
[39773533266](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533266)
seguía en progreso al momento de esta actualización. Estos checks no ejecutan
`terraform apply`.

La evidencia de infraestructura y ejecuciones anteriores es:

- [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034)
  aplicó solo el canal privado de artefactos: Storage dedicado, contenedor Blob
  privado, private endpoint y RBAC del publicador (**4 altas, 0 cambios,
  0 destrucciones**). No aplicó un runtime.
- [39768505115](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39768505115)
  generó el plan **0 altas, 1 cambio in-place, 0 destrucciones** para cambiar las
  reglas de red del Storage a `default_action=Allow` y permitir `AzureServices`.
  `apply` fue omitido: ese cambio no se ejecutó.
- [39771791770](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39771791770)
  corresponde al estado anterior y no sustituye un plan validado para el nuevo SHA
  de `main`.

El runtime Wazuh/QAPAQ/Ankay no está demostrado como desplegado ni operativo en
Azure; tampoco hay evidencia nueva de salud de integraciones o de endpoint público.
DNS no se cambió. El apply confirmado no modificó los secretos, el storage de
eventos/evidencia ni otros recursos existentes. No se hizo una lectura nueva del
inventario ARM como parte de esta actualización; consultar el portal antes de usar
una lista de recursos como inventario actual.

## Aplicación del canal de releases (2026-10-22 11:00 UTC)

- PR [#98](https://github.com/CyberStill-GmbH/qapaq-secops/pull/98), commit `c32ed62`, corrige la colisión del address de Terraform entre el recurso de publicación nuevo y la migración del permiso histórico. CI, seguridad y `fmt/init/validate` pasaron.
- El workflow protegido [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034) generó y aplicó el plan exacto tras revisión. Resumen: **4 altas, 0 cambios, 0 destrucciones** — Storage de releases, contenedor privado, private endpoint y `Storage Blob Data Contributor` para la identidad publicadora federada.
- No cambió el storage de eventos/evidencia, los valores de Key Vault, secretos de GitHub, PostgreSQL, DNS ni otros recursos existentes. Los recursos del canal de releases existen, pero la publicación end-to-end no está verificada; todavía no hay paquete completo publicado ni instalación de Wazuh/Ankay.
- No se refrescó el inventario ARM por portal después del apply; la evidencia de estas cuatro altas es el resultado de Terraform en Actions. Verificar el inventario del resource group antes de un plan adicional.
- Run anterior [39764311183](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39764311183) falló antes del apply por un `moved` block inválido; no produjo cambios.
- El build experimental [39758248744](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758248744) terminó correctamente para Manager 4.14.8, Indexer y Filebeat; la asamblea solo generó evidencia efímera de procedencia, no un bundle instalable. El archive QAPAQ Core [39758800010](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758800010) pasó validación. El paquete Dashboard [39758795551](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758795551) pasó build, pero la publicación a ACR se omitió. El siguiente gate es ensamblar y validar el bundle completo antes de publicarlo.

## Validación del adaptador Core Azure (2026-10-22 09:20 UTC)

- El PR [#93](https://github.com/CyberStill-GmbH/qapaq-secops/pull/93), commit `b94760b`, agrega el instalador Azure de `qapaq-core` y la validación segura del archive. El workflow [39754134555](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39754134555) pasó: cuatro casos de prueba del validador, sintaxis Bash, build en Ubuntu, checksum y comprobación del trust store CA.
- El artefacto producido por ese workflow es efímero (retención de un día); **no** se publicó en Blob/ACR ni se instaló en una VM. El workflow no construye el bundle Wazuh/QAPAQ completo y no demuestra worker BullMQ, migraciones o salud de Wazuh.
- Los checks generales de seguridad/contendedores del PR seguían en curso a esta hora. La rama `main` no cambió por este PR.
- La última ejecución Terraform observada sobre `main`, [39751334214](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39751334214), sigue siendo solo lectura con cero cambios. No hubo `apply`, cambio DNS, acceso a valores de Key Vault ni mutación de recursos en esta validación.

## Actualización de publicación (2026-10-22 08:42 UTC)

- El PR [#91](https://github.com/CyberStill-GmbH/qapaq-secops/pull/91) se integró en `main` como `b7ff341`. Corrige la instalación de ORAS en el workflow de publicación fijando URL y checksum oficiales de ORAS 1.3.5.
- El workflow [39745314741](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39745314741) terminó `success`: build y verificación del paquete (`wazuh-dashboard_4.14.8-1qapaq1_amd64.deb`, SHA-256 `e678df149679a5d564f2d3b7d56988c1e2533b7654a1aec0df0975dd7c0b39d8`) y publicación con GitHub OIDC a Azure Container Registry.
- ACR confirmó el repositorio `qapaq-dashboard`, tag inmutable `git-b7ff341a2e249e69dbcd190c0619c098d4d2eec6-sha256-e678df149679a5d564f2d3b7d56988c1e2533b7654a1aec0df0975dd7c0b39d8` y manifest OCI `sha256:63277d6e56942a2ebe0f2c511d7ee90851160b0caca948eef4a8cc288eb05e2b`. El contenido es un artefacto OCI que transporta el `.deb`, no una imagen de contenedor ni un Dashboard instalado.
- El build aplicó los overlays QAPAQ sobre Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6 e instaló `qapaqI18n`, `qapaqOps`, Wazuh y los plugins OpenSearch fijados. Usó Node 18.19.0 y Yarn 1.22.22 según el upstream; no hay mezcla de npm y Yarn en el build. Actions dejó una advertencia no bloqueante de que `actions/upload-artifact` será forzado a Node 24; requiere seguimiento de actualización del action.
- El plan Terraform protegido [39741366185](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39741366185) sobre `main` (`4b310b1`) concluyó **0 altas, 0 cambios, 0 destrucciones**. En el grupo Azure existen recursos fundacionales (identidades, Key Vault, Log Analytics, endpoints privados/DNS, PostgreSQL, ACR, Storage y VNet), pero no existe VM del SIEM, VM Ankay ni Container Apps runtime. Los objetos `siem_host` y `ankay_host` y `enable_runtime` siguen deshabilitados.
- No se instalaron servicios, no se ejecutó un apply de runtime, no se cambiaron secretos y no se hizo corte DNS. La subida a ACR únicamente demuestra que el paquete está disponible para un futuro instalador.

## Actualización de estado (2026-10-22 07:22 UTC)

- El PR [#84](https://github.com/CyberStill-GmbH/qapaq-secops/pull/84) se integró en `main` como commit `3eeaed0`; el PR [#86](https://github.com/CyberStill-GmbH/qapaq-secops/pull/86) como `3b58ab9`; y el PR [#87](https://github.com/CyberStill-GmbH/qapaq-secops/pull/87) como `4ee8dd6`. Estos cambios endurecen la publicación de bundles y el bootstrap idempotente; no constituyen un despliegue del SOC.
- El run Terraform [39731939654](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731939654), lanzado desde `main` en `3b58ab9`, ya autenticó por OIDC, abrió el state remoto y completó el plan tras la aprobación del reviewer `CesarGuevaraQapaq`. Resultado: **1 alta, 0 cambios, 0 destrucciones**; solo crea `Storage Blob Data Contributor` para el publicador sobre el contenedor privado `siem-release`. El input fue `apply=false`: el job de apply se omitió y no cambió recursos. El plan no incluye runtime Wazuh ni Ankay.
- El run posterior [39739274128](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39739274128) generó un plan guardado nuevo sobre `main` (`4ee8dd6`) con **1 alta, 0 cambios, 0 destrucciones** y aplicó exclusivamente `module.identity_registry.azurerm_role_assignment.siem_release_publisher`. GitHub Actions reportó `Apply complete! Resources: 1 added, 0 changed, 0 destroyed.` El rol queda acotado a `Storage Blob Data Contributor` del contenedor privado `siem-release`; no provisionó servicios ni tocó secretos, datos, DNS u otros recursos.
- El apply anterior [39649721166](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39649721166) falló después de intentar 30 altas y reportar errores de RBAC `roleAssignments/write` y registro del proveedor `Microsoft.App`. Reconciliar el state con un plan nuevo antes de otro apply; no inferir rollback completo del apply fallido.
- Builds del SHA `3b58ab9`: `qapaq-core` pasó en [39731393165](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731393165); Indexer y Filebeat pasaron en [39731386944](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731386944), pero la compilación del Manager aún estaba en curso a las 07:04 UTC; Dashboard pasó build/verificación en [39731390092](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731390092) y Ankay en [39731396102](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731396102). Las publicaciones a ACR se omitieron; no hay imágenes publicadas ni runtime instalado.
- Antes de la publicación actual, la vista Repositories del ACR `qapaqsecopsdemo66f8c73b` mostró cero repositorios. Después, el run Ankay agregó el repositorio de su imagen frontend. Se configuraron en GitHub las variables no secretas `AZURE_ACR_NAME`, `AZURE_ACR_LOGIN_SERVER` y `AZURE_ACR_PUBLISHER_CLIENT_ID` para apuntar a ese registro y a la identidad federada dedicada.
- La identidad publicadora `id-qapaqsecopsdemo-github-publisher` se verificó en el portal. Su `principal_id` coincide con el principal del plan y el rol `AcrPush` ya existe en el state. Su client ID quedó configurado en GitHub como variable de repositorio `AZURE_ACR_PUBLISHER_CLIENT_ID`; no es un secreto. La configuración OIDC de ACR está completa; hasta ahora se publicó solo la imagen frontend Ankay.
- El workflow Ankay [39738569548](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39738569548) pasó pruebas y publicó correctamente una imagen frontend en el ACR privado después de aprobación del environment `azure-demo`. Digest registrado: `sha256:40ee82ef93148df955f01f9d1faa3f38cc3547d42a92e044c3d23abac2c278fa`. Es solo el frontend Ankay; no representa el backend, Orborus, worker ni OpenSearch, y aún no se instala en una VM.
- El PR [#89](https://github.com/CyberStill-GmbH/qapaq-secops/pull/89) se integró en `main` como `b2e8161`; el cableado `ankay_host` es opcional, conserva `null` como default y no inicia Docker/Shuffle. Su verificación de Azure Terraform terminó en verde; no se volvió a aplicar Terraform por ese PR.
- El workflow de publicación del Dashboard [39738565521](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39738565521) sigue compilando el paquete Wazuh. El build Manager/Indexer/Filebeat [39731386944](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731386944) terminó correctamente y subió artefactos efímeros; no son una release durable.
- Inspeccioné solo nombres de GitHub Secrets/Variables y claves de `.env.example`, sin leer valores: están configurados los datos de OIDC Azure, password de bootstrap PostgreSQL, client secret de Entra y referencias/IDs de tenant y grupo M365/QAPAQ. No encontré nombres de configuración o secretos para Sophos, Cato ni Teams. No he consultado ni cambiado secretos de Key Vault. Por tanto, esas integraciones no están acreditadas ni listas para instalar.
- Entre `3b58ab9` del plan previo y `4ee8dd6` solo cambió documentación, sin diferencias en `infra/azure` ni en el workflow Terraform.
- La revisión de `main` confirma que `enable_runtime=false`; `siem_host` y `ankay_host` siguen apagados por defecto. El módulo Ankay crea subnet dedicada y prepara VM/disco y Compose en `cloud-init`: no instala Docker ni arranca Shuffle. Aún faltan el bundle Wazuh integral, imágenes completas de Ankay, Compose probado, credenciales Cato/Sophos/Teams en el almacén autorizado y `tfvars` con red/firewall revisados. El apply reciente solo agregó un permiso Blob acotado; no deja el SOC operativo.
- La estimación de lista publicada mantiene un piso de USD 530.86/mes con Wazuh, PostgreSQL y Firewall Basic, antes de Ankay, discos, tráfico y observabilidad. No es una cotización del tenant. El umbral USD 200 solo alerta; no limita cargos ni apaga recursos.

No declarar el SOC operativo hasta que se publique y verifique el bundle, el plan completo sea aprobado y aplicado, y las pruebas de salud e integraciones M365, Sophos, Cato, Teams, agentes y Ankay produzcan evidencia de ejecución.

## Alineación vigente de arquitectura

Este runbook conserva abajo observaciones fechadas del 2026-10-20. Para el diseño objetivo prevalece [`architecture.md`](architecture.md), basado en `docs/10-decisiones.md` A5–A9/A13/A18/A20/A22 y `docs/12-backend-en-el-siem.md`.

El destino Azure es Wazuh QAPAQ 4.14.8 / OSD 2.19.6 con edge Nginx QAPAQ en el host SIEM; `qapaq-core` API+worker Node 24 junto al SIEM; PostgreSQL durable; Valkey para sesiones, cache-aside y BullMQ; KrakenD para ingesta según A8; y Ankay como Shuffle completo en un host privado separado, tras `/ankay/*` con la sesión/autorización QAPAQ actual. `siem_host` está conectado al root detrás del objeto opcional `siem_host`, desactivado por defecto; el PR #89 integra `ankay_host` opcional, también desactivado y todavía sin runtime Compose. El apply de infraestructura descrito arriba completó una asignación de identidad acotada; no desplegó ese destino ni certifica el runtime.

## Estado de Azure verificado (2026-10-21, hora de Lima)

- El workflow protegido de Terraform ejecutó el apply en `main`, commit
  [`9a8fbe3`](https://github.com/CyberStill-GmbH/qapaq-secops/commit/9a8fbe38b8e28b3d26e9e2b1faf0034cb80e1bf5).
  El [run 39721818427](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39721818427)
  terminó `success`: **1 recurso añadido, 0 modificados, 0 destruidos**. La única
  acción fue crear `module.identity_registry.azurerm_role_assignment.raw_blob_writer`,
  asignando `Storage Blob Data Contributor` a la identidad administrada del runtime,
  limitado al contenedor `security-event-raw`. El workflow validó el checksum del
  plan guardado y aplicó ese mismo plan.
- El [plan posterior 39722269994](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39722269994)
  terminó `success`: **0 añadidos, 0 modificados, 0 destruidos**; el job de apply
  fue omitido. Es una comprobación de deriva para el estado Terraform en ese
  momento, no un health check de aplicaciones.
- Estos runs no cambiaron DNS, secretos, buckets de evidencia ni datos; tampoco
  crearon el host Wazuh/Ankay ni activaron conectores. El runtime genérico continúa
  deshabilitado (`enable_runtime=false`), `siem_host` permanece sin configuración
  (`null`) y `ankay_host` no está conectado al root. **QAPAQ SecOps y Ankay no están
  operativos en Azure por este apply.**
- Siguen pendientes el bundle instalable y bootstrap de Wazuh QAPAQ, Valkey y
  `qapaq-core` funcional, KrakenD, el despliegue completo de Ankay, migración segura
  de secretos a Key Vault, configuración/validación real de M365, Sophos, Cato y
  Teams, agentes/playbooks, TLS y corte DNS. No presentar la base Azure ni el rol
  Blob como evidencia de que esos servicios están conectados.
- El presupuesto configurado es una alerta, no un límite de gasto ni un apagado
  automático. Revisar la estimación de costos y el plan completo antes de habilitar
  componentes facturables.

Antes de usar este runbook, tener presentes estos gates:

- `enable_runtime` crea cinco Container Apps genéricas; no sustituye Wazuh ni representa A22. Una base `qapaq_jobs` tampoco acredita una cola activa. A9 define Valkey/BullMQ, pero el worker actual es lifecycle-only y no consume BullMQ.
- `wazuh/core` y Office 365 aún dependen de AWS SSM, Secrets Manager y la CA RDS. Se requiere una adaptación Azure con Managed Identity/Key Vault y PostgreSQL Azure. No rotar los secretos AWS existentes.
- No afirmar M365, Sophos, Cato, Teams, agentes o playbooks operativos sin pruebas contra los servicios Azure. El workflow Ankay publica el overlay de frontend; no instala backend, Orborus, workers ni OpenSearch.
- A11 fija snapshots/evidencia en S3 y excluye Azure. No usar Blob para esos datos hasta que una decisión revisada defina residencia, Object Lock y retención.
- USD 200/mes es un umbral de alertas, sin apagado ni `destroy`. La estimación actual ya supera ese importe antes de los componentes restantes.
- No aplicar el paso DNS de abajo como si el destino fuera Container Apps. Primero debe existir el edge del host SIEM con TLS y hostname probado. El Terraform Azure no administra Route 53.
**Estado al 2026-10-21:** fundación parcial aplicada y sin deriva Terraform en la
última lectura; el runtime QAPAQ/Ankay no está desplegado y DNS no fue cambiado.
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
  En los runs experimentales
  [39531441349](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39531441349)
  y
  [39531495712](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39531495712),
  Indexer falló al crear `artifacts/maven`: el contenedor builder corre como UID 1000
  y el checkout bind-mounted pertenecía al runner. La corrección temporal de ownership
  se integró en `main`; el builder Indexer ya terminó y validó su `.deb` en el run
  [39535588443](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39535588443).
  En esa misma ejecución, Manager construyó el paquete principal y el de símbolos, pero
  la validación falló porque contaba todos los `.deb` como si fueran el único Manager.
  El PR #78 corrigió la selección por metadato Debian `Package=wazuh-manager` y se
  integró en `main` como `d59bca44872bf5f430c9cf3cec5b381a48f35b04`. En el run
  [39644906120](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39644906120),
  Filebeat pasó firma/checksum; el job Manager seguía compilando en la última lectura.
  Indexer volvió a fallar, ahora porque `download.eclipse.org/eclipse/updates/4.29/p2.index`
  respondió HTML de mantenimiento en vez del índice P2. El endpoint presenta el mismo
  contenido HTML desde el runner y desde la estación de revisión, así que es una
  dependencia externa del build, no un fallo del paquete ni una conexión Azure.
  Los paquetes experimentales no se han publicado ni instalado.

- Actualización CI 2026-10-21: el pin de KrakenD Go se actualizó a 1.26.10 para incluir
  la corrección oficial de CVE-2026-111943; el PR #78 y los escaneos Trivy de contenedores
  pasaron y se integraron en `main`. Para el bloqueo Eclipse se está preparando el overlay
  QAPAQ [`wazuh-indexer-spotless-jdt-lockfile.patch`](../../../infra/azure/overlays/wazuh-indexer-spotless-jdt-lockfile.patch),
  limitado a la dependencia de formato de build. La compilación deberá registrar su SHA-256
  junto a la procedencia y demostrar que resuelve JDT 4.29 desde Maven Central. No modifica
  el código runtime de Wazuh. El overlay sigue sin validación de GitHub Actions al momento
  de esta nota.
  Los workflows Azure de Dashboard y core son separados: el core Azure pasó
  build/checksum en el run
  [39531106649](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39531106649);
  el Dashboard compiló y subió un artefacto temporal en
  [39531035378](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39531035378),
  pero su job de publicación a ACR fue omitido porque requiere ejecución manual en `main`.
  Ninguno de esos runs despliega una VM.
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
