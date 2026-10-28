# Runbook Terraform de East US 2

Este runbook describe un entorno `demo-eus2` independiente del demo actual de
East US (`demo-eus`) y de Chile Central. El workflow es
`.github/workflows/terraform-azure-demo-eus2.yml`; usa GitHub OIDC, el backend
remoto EUS2 y el plan guardado en la misma ejecución. No administra DNS ni carga
credenciales de integración.

## Estado verificado — 2026-10-27

- El grupo de runtime es `rg-qapaqsecopsdemoeus-3a2405f3`. El apply de
  `foundation` creó PostgreSQL Flexible Server 16 `psql-qapaqsecopsdemoeus-3a2405f3`
  con `Standard_D2s_v3` y las bases `qapaq_secops`/`qapaq_jobs`. Azure CLI
  confirma estado `Ready`.
- El state EUS2 está aislado en `qapaqsecopseus23a2405f3`, container `tfstate`,
  key `qapaq-secops/demo-eus2/terraform.tfstate`. El container no admite acceso
  anónimo ni shared keys; su endpoint de red es público y requiere Entra/RBAC.
- El state de bootstrap EUS2 continúa separado en `qapaqsecopseus261026`,
  container `tfstate`, key `qapaq-secops/demo-eus2/bootstrap.tfstate`. No
  reconfigurar ese root como state vacío, migrarlo ni limpiarlo.
- La UAMI de Terraform `id-qapaqsecopsdemoeus-github-tf-3a2405f3` tiene una FIC
  limitada a `azure-demo-eus2`; se usa para plan/apply y acceso al state.
- La identidad publicadora `id-qapaqsecopsdemoeus-github-publisher` tiene
  `AcrPush` en el ACR EUS2 y `Storage Blob Data Contributor` en los contenedores
  de releases EUS2 y legacy. Terraform state confirma FIC independientes para
  `azure-demo` y `azure-demo-eus2`; la segunda no reemplaza la existente.
- La identidad de seeding `id-qapaqsecopsdemoeus-kv-seeder` ya tiene dos roles
  personalizados limitados al grupo de runtime y al Key Vault exactos; sus dos
  asignaciones están verificadas en Azure y Terraform state. La variable pública
  `AZURE_EUS2_SECRET_SEEDER_CLIENT_ID` está configurada. Esto no significa que se
  hayan cargado secretos: no se leyeron valores del vault ni hay evidencia de que
  el workflow de seed haya corrido.
- GitHub ya tiene el environment `azure-demo-eus2`, OIDC, los valores de state y
  `AZURE_EUS2_APPLY_READY=true`. `AZURE_EUS2_ENABLE_RUNTIME=false`, los perfiles
  `siem_host`/`ankay_host` son nulos, `AZURE_EUS2_CONTAINER_IMAGES_JSON={}` y
  `AZURE_EUS2_KEY_VAULT_SECRET_IDS_JSON={}`. El ACR está vacío.
- La lectura de solo metadatos del environment GitHub del 2026-10-27 confirma que
  los únicos nombres de secretos presentes son los del password administrador de
  PostgreSQL y el client ID de Terraform; no aparecen secretos de aplicación,
  M365, Teams, Sophos, Cato ni el tar de instalación de Wazuh. Tampoco están
  configuradas las variables de perfil `AZURE_EUS2_SIEM_HOST_JSON` ni
  `AZURE_EUS2_KRAKEND_GATEWAY_JSON`. Esto describe GitHub Environment, no el
  contenido del Key Vault; no se consultaron valores de secretos.
- Key Vault `kv-qapaqsecopsd-3a2405f3` mantiene `PublicNetworkAccess=Disabled`.
  La consulta de nombres fue bloqueada desde esta máquina por la regla de red;
  no se leyeron ni modificaron valores secretos.
- La Storage de datos `qapaqsecdemoeus23a2405f3` permanece privada. El Storage
  de releases `qapaqdemoeus2rel3a2405f3` admite tráfico de red público autenticado,
  con blobs anónimos deshabilitados. No se tocó DNS ni recursos legacy.
- El State `demo-eus` en East US y Chile no se compartió ni se migró.

## Configuración del environment GitHub

El environment `azure-demo-eus2` ya existe y restringe deployments a `main`,
requiere aprobación de `CesarGuevaraQapaq` y bloquea self-review. Tiene habilitado
el bypass administrativo; este runbook no lo usa para sustituir la revisión
requerida. El workflow también exige `AZURE_EUS2_APPLY_READY=true` y una referencia
HTTPS de revisión de costo antes de `apply=true`.

### Secretos del environment

| Nombre | Uso |
| --- | --- |
| `AZURE_EUS2_TERRAFORM_CLIENT_ID` | Client ID de la UAMI EUS2; obtenerlo por metadata de Azure, no es un client secret |
| `AZURE_EUS2_POSTGRES_ADMIN_PASSWORD` | Nueva contraseña de bootstrap PostgreSQL, única para este entorno; Terraform la conserva en state |

No guardar aquí credenciales M365, Sophos, Cato, Teams, VirusTotal u otras
integraciones. Los valores de proveedores no son necesarios para el plan de
fundación.

### Variables requeridas del environment

| Nombre | Valor esperado/uso |
| --- | --- |
| `AZURE_EUS2_TENANT_ID` | Tenant de la suscripción destino |
| `AZURE_EUS2_SUBSCRIPTION_ID` | Suscripción destino |
| `AZURE_EUS2_TF_STATE_RESOURCE_GROUP` | `rg-qapaqsecopsdemoeus-state-3a2405f3` |
| `AZURE_EUS2_TF_STATE_STORAGE_ACCOUNT` | `qapaqsecopseus23a2405f3` |
| `AZURE_EUS2_TF_STATE_CONTAINER` | `tfstate` |
| `AZURE_EUS2_TF_STATE_KEY` | `qapaq-secops/demo-eus2/terraform.tfstate` |
| `AZURE_EUS2_APPLY_READY` | `true`; el workflow aún exige un scope y plan exactos, costo HTTPS y aprobación del environment |
| `AZURE_EUS2_ACR_LOGIN_SERVER` | `qapaqsecopsdemoeus3a2405f3.azurecr.io`; requerido para un apply `soc` |
| `AZURE_EUS2_GITHUB_PUBLISHER_CLIENT_ID` | Client ID no secreto de la UAMI publicadora EUS2; ya configurado para la FIC EUS2 |
| `AZURE_EUS2_SECRET_SEEDER_CLIENT_ID` | Client ID no secreto de la identidad de seed; ya configurado tras aplicar sus roles limitados |

Las variables opcionales de runtime son `AZURE_EUS2_ENABLE_RUNTIME`,
`AZURE_EUS2_CONTAINER_IMAGES_JSON`, `AZURE_EUS2_SIEM_HOST_JSON`,
`AZURE_EUS2_ANKAY_HOST_JSON` y `AZURE_EUS2_KEY_VAULT_SECRET_IDS_JSON`. Sin ellas,
el runtime permanece apagado. Los scopes son secuenciales:

- `foundation`: mantenimiento de base sin perfiles SIEM/Ankay y con runtime
  apagado.
- `siem`: despliega primero Wazuh con un perfil SIEM completo, runtime de
  aplicaciones apagado y sin perfil Ankay. Permite verificar la telemetría y
  el dashboard antes de levantar los demás servicios.
- `soc`: despliegue posterior de Wazuh más Ankay. Exige el runtime genérico
  apagado, perfiles SIEM y Ankay completos, artefactos por digest y referencias a
  secretos ya existentes. No habilita el Edge público genérico de Container Apps;
  ese runtime requiere un scope y una revisión de exposición/auth separados.

No usar placeholders para aparentar disponibilidad. Los scopes `siem` y `soc` no
cambian DNS; el primero no implica que Ankay ni las integraciones externas estén
operativas.

## Ejecución controlada

1. Comprobar de nuevo que el environment usa subject/issuer/audience indicados,
   que el runner tiene OIDC y que los roles siguen limitados a los scopes
   documentados. Confirmar la key state EUS2 exacta; no apuntar a
   `qapaq-secops/demo-eus/terraform.tfstate` ni a Chile.
2. Ejecutar manualmente `Terraform Azure demo East US 2 plan and apply` desde
   `main`, primero con `apply=false`. Revisar el resumen de cada recurso y el
   costo para la duración prevista. El workflow fija `environment=demo-eus2`,
   `location=eastus2` y valida el Storage/key EUS2 exactos.
3. Para `apply=true`, proporcionar un enlace HTTPS al cálculo de costos, habilitar
   `AZURE_EUS2_APPLY_READY=true` después de la revisión y aprobar el deployment
   protegido. La ejecución valida y aplica únicamente el artifact planificado en
   ese run; el resumen rechaza acciones destructivas.
4. Verificar recursos/health en Azure antes de preparar una migración de datos o
   un cambio DNS. Esta preparación no configura ni cambia DNS.

## Publicación de artefactos EUS2

- `azure-siem-release-publish-eus2.yml` valida un candidate release exitoso,
  presenta en un job sin credenciales el SHA-256, bytes y URI exacta, y después
  requiere la aprobación protegida de `azure-demo-eus2`. Solo crea un Blob privado
  bajo `releases/<commit>/`; si ya existe, exige coincidencia de hash/tamaño y
  nunca lo sobrescribe.
- El candidato Wazuh `c96e35fc…` pasó validación de artefacto y se publicó en el
  Blob privado EUS2 en el run `40453658942`, que terminó correctamente. La escritura
  verificó la URI inmutable y su digest. Esto acredita publicación, no instalación:
  todavía no existe una VM SIEM EUS2 que haya consumido el bundle ni evidencia de
  salud de Wazuh, Core o ingestión.
- `ankay-azure-eus2-publish.yml` sigue el mismo gate para publicar el frontend
  QAPAQ y su fuente AGPL al ACR/Blob EUS2. Solo publica el frontend; no demuestra
  ni despliega backend, Orborus, worker, `shuffle-security` u OpenSearch.
- Ambos flujos usan `id-qapaqsecopsdemoeus-github-publisher`, no el principal
  más amplio de Terraform. La FIC EUS2 y las variables
  `AZURE_EUS2_GITHUB_PUBLISHER_CLIENT_ID` y `AZURE_EUS2_ACR_LOGIN_SERVER` están
  configuradas. Cada publicación nueva sigue requiriendo el gate protegido del
  environment; el run `40453658942` ya completó su aprobación y publicación.

No cambiar `location` dentro del state `demo-eus`: su grupo/infraestructura vive
en East US. East US 2 tiene nuevo grupo, nombres y state para evitar que Terraform
interprete los recursos EUS existentes como reemplazos. Mantener los recursos
EUS hasta que se inventaríen sus datos y el entorno EUS2 pase health checks; no
destruir ni limpiar automáticamente el state anterior.
