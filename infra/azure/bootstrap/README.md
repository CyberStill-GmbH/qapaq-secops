# Bootstrap Terraform de Azure

Este root se aplica **una sola vez desde una sesión Azure CLI autorizada** y
prepara el backend remoto, el grupo destino y la identidad federada que usa
GitHub Actions. No crea el SIEM ni componentes de runtime. No aplicar desde el
workflow principal hasta revisar este código, el plan y los roles.

## Recursos y permisos resultantes

- Grupo `state` dedicado y Storage Account LRS con HTTPS/TLS 1.2, claves
  compartidas y acceso anónimo deshabilitados, versionado de blobs y soft delete
  de 30 días. El endpoint de red es público para que el runner GitHub-hosted
  pueda usar el backend; autorización de datos exige Entra ID y RBAC. Migrar a
  private endpoint requerirá un runner dentro de la VNet.
- Contenedor privado de state y grupo destino `rg-*`, ambos con `prevent_destroy`.
- User-assigned managed identity federada únicamente con el subject inmutable
  `repo:CyberStill-GmbH@220633794/qapaq-secops@1374673243:environment:azure-demo`
  y audiencia `api://AzureADTokenExchange`.
- `Contributor` y `Role Based Access Control Administrator` sobre el grupo
  destino QAPAQ. Esto permite a la identidad administrar recursos de ese grupo;
  una condición ABAC limita la delegación a `AcrPull`, `AcrPush`, `Key Vault
Secrets User` y `Storage Blob Data Contributor` para service principals, y
  bloquea la autoasignación de roles a Terraform.
- `Storage Blob Data Contributor` solo en el Storage Account de state y
  `Cost Management Contributor` a nivel de suscripción para que el root existente
  pueda gestionar el presupuesto mensual.
- El operador bootstrap recibe `Storage Blob Data Contributor` solo en el
  Storage Account de state para crear el contenedor y migrar el backend.

El bootstrap operador necesita permisos para crear grupos/Storage, identidades y
asignaciones de roles con esos alcances. Si Azure no autoriza una asignación, no
elevar el scope como atajo: revisar el permiso faltante con el administrador del
tenant.

## Aplicación manual revisable

En Azure Cloud Shell (Bash), autenticado en la suscripción destino:

```bash
az account show --query '{subscription:id,tenant:tenantId,state:state}' --output json
export TF_VAR_subscription_id="$(az account show --query id --output tsv)"
export TF_VAR_tenant_id="$(az account show --query tenantId --output tsv)"
export TF_VAR_bootstrap_operator_object_id="$(az ad signed-in-user show --query id --output tsv)"
export TF_VAR_state_storage_account_name="<storage-account-name-unico>"
cd infra/azure/bootstrap
terraform init -backend=false
terraform plan -input=false -out=bootstrap.tfplan
terraform show -no-color bootstrap.tfplan
```

Verificar nombres, scopes RBAC, retención y configuración de red antes de
aplicar. El único permiso a nivel de suscripción de la identidad de GitHub es
Cost Management Contributor. La aplicación no cambia DNS ni lee ni crea secretos
de proveedores. La delegación RBAC usa una condición ABAC basada en los
[ejemplos de Microsoft](https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-examples).

Después de aprobar el plan:

```bash
terraform apply -input=false bootstrap.tfplan
terraform init -migrate-state \
  -backend-config="resource_group_name=$(terraform output -raw state_resource_group_name)" \
  -backend-config="storage_account_name=$(terraform output -raw state_storage_account_name)" \
  -backend-config="container_name=$(terraform output -raw state_container_name)" \
  -backend-config="key=bootstrap/terraform.tfstate" \
  -backend-config="use_azuread_auth=true" \
  -backend-config="use_cli=true"
```

No activar shared keys. Si la creación del contenedor falla inmediatamente tras
asignar RBAC, esperar a que se propague el rol y reintentar el apply del bootstrap.

Configurar en GitHub los outputs no secretos sin imprimir credenciales:

```bash
gh secret set AZURE_TERRAFORM_CLIENT_ID --body "$(terraform output -raw github_terraform_client_id)" --repo CyberStill-GmbH/qapaq-secops
gh variable set AZURE_TF_STATE_RESOURCE_GROUP --body "$(terraform output -raw state_resource_group_name)" --repo CyberStill-GmbH/qapaq-secops
gh variable set AZURE_TF_STATE_STORAGE_ACCOUNT --body "$(terraform output -raw state_storage_account_name)" --repo CyberStill-GmbH/qapaq-secops
gh variable set AZURE_TF_STATE_CONTAINER --body "$(terraform output -raw state_container_name)" --repo CyberStill-GmbH/qapaq-secops
gh variable set AZURE_TF_STATE_KEY --body "$(terraform output -raw state_key)" --repo CyberStill-GmbH/qapaq-secops
```

`AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID` ya existen. La contraseña nueva de
PostgreSQL se genera y carga por separado en `AZURE_POSTGRES_ADMIN_PASSWORD`;
no usar un secreto existente de AWS ni guardar el valor en Git, `tfvars` o logs.
El state root conserva esta contraseña, por lo que el acceso a state y a los
artifacts de plan se considera acceso privilegiado.

## Limpieza local

Migrar bootstrap state al Storage antes de borrar la sesión. No versionar
`bootstrap.tfplan`, `terraform.tfstate*` ni `.terraform/`; verificar `git status`
antes de cerrar la sesión. Los grupos y state storage tienen `prevent_destroy`.
