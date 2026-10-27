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
  de releases EUS2 y legacy. Su FIC actual solo acepta el environment
  `azure-demo`. El cambio Terraform de esta rama añade una FIC separada para
  `azure-demo-eus2` y conserva la FIC existente; no utilizar el publicador EUS2
  hasta que un plan revisado confirme esa única alta.
- GitHub ya tiene el environment `azure-demo-eus2`, OIDC, los valores de state y
  `AZURE_EUS2_APPLY_READY=true`. `AZURE_EUS2_ENABLE_RUNTIME=false`, los perfiles
  `siem_host`/`ankay_host` son nulos, `AZURE_EUS2_CONTAINER_IMAGES_JSON={}` y
  `AZURE_EUS2_KEY_VAULT_SECRET_IDS_JSON={}`. El ACR está vacío.
- Key Vault `kv-qapaqsecopsd-3a2405f3` mantiene `PublicNetworkAccess=Disabled`.
  La consulta de nombres fue bloqueada desde esta máquina por la regla de red;
  no se leyeron ni modificaron valores secretos.
- La Storage de datos `qapaqsecdemoeus23a2405f3` permanece privada. El Storage
  de releases `qapaqdemoeus2rel3a2405f3` admite tráfico de red público autenticado,
  con blobs anónimos deshabilitados. No se tocó DNS ni recursos legacy.
- El State `demo-eus` en East US y Chile no se compartió ni se migró.

## Configuración del environment GitHub

Crear `azure-demo-eus2` en **Settings → Environments**. Restringir deployments a
`main`, exigir aprobación de un revisor autorizado y deshabilitar self-review.
La existencia de la FIC no crea estas reglas. El workflow incluye además el gate
`AZURE_EUS2_APPLY_READY=true`; configurarlo solo después de comprobar las reglas
de protección y aprobar el costo. Sin ese valor, `apply=true` se rechaza.

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
| `AZURE_EUS2_APPLY_READY` | Mantener ausente hasta aprobar protecciones/costos; usar `true` para habilitar apply explícito |
| `AZURE_EUS2_ACR_LOGIN_SERVER` | `qapaqsecopsdemoeus3a2405f3.azurecr.io`; requerido para un apply `soc` |
| `AZURE_EUS2_GITHUB_PUBLISHER_CLIENT_ID` | Client ID de la UAMI publicadora EUS2; configurar después de crear/revisar la FIC adicional |

Las variables opcionales de runtime son `AZURE_EUS2_ENABLE_RUNTIME`,
`AZURE_EUS2_CONTAINER_IMAGES_JSON`, `AZURE_EUS2_SIEM_HOST_JSON`,
`AZURE_EUS2_ANKAY_HOST_JSON` y `AZURE_EUS2_KEY_VAULT_SECRET_IDS_JSON`. Sin ellas,
el runtime permanece apagado. El scope `soc` de un apply exige perfiles SIEM y
Ankay completos y revisados, además de artefactos por digest y referencias a
secretos ya existentes. No usar placeholders para aparentar disponibilidad.

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
- `ankay-azure-eus2-publish.yml` sigue el mismo gate para publicar el frontend
  QAPAQ y su fuente AGPL al ACR/Blob EUS2. Solo publica el frontend; no demuestra
  ni despliega backend, Orborus, worker, `shuffle-security` u OpenSearch.
- Ambos flujos usan `id-qapaqsecopsdemoeus-github-publisher`, no el principal
  más amplio de Terraform. Requieren que su FIC adicional esté aplicada y que
  estén configuradas las variables `AZURE_EUS2_GITHUB_PUBLISHER_CLIENT_ID` y
  `AZURE_EUS2_ACR_LOGIN_SERVER`. La aprobación del environment revisa los bytes,
  destino y efecto antes de cualquier escritura cloud.

No cambiar `location` dentro del state `demo-eus`: su grupo/infraestructura vive
en East US. East US 2 tiene nuevo grupo, nombres y state para evitar que Terraform
interprete los recursos EUS existentes como reemplazos. Mantener los recursos
EUS hasta que se inventaríen sus datos y el entorno EUS2 pase health checks; no
destruir ni limpiar automáticamente el state anterior.
