# Bootstrap aislado de Azure East US

Este runbook prepara el state Terraform y la identidad OIDC dedicados a `demo-eus`.
No crea el SIEM, Ankay, imágenes, secretos de proveedor ni DNS. No reutiliza ni migra
el state del demo Chile.

> **Estado: no aplicado.** El bootstrap requiere una sesión Azure CLI autenticada
> con permisos para crear grupos de recursos, Storage, identidades y asignaciones
> RBAC. No guardar el plan ni el state local en Git.

## Alcance que crea el bootstrap

El módulo `infra/azure/bootstrap` crea 11 recursos: dos grupos de recursos
protegidos contra destrucción, un Storage Account LRS y su contenedor privado,
una identidad administrada con federación limitada al repositorio
`CyberStill-GmbH/qapaq-secops` y al GitHub environment `azure-demo-eus`, y las
asignaciones RBAC del módulo:

- `Contributor` y `Role Based Access Control Administrator` con condición ABAC
  en el grupo de recursos destino `demo-eus`. La condición limita la delegación
  a `AcrPull`, `AcrPush`, `Key Vault Secrets User` y
  `Storage Blob Data Contributor` para identidades de servicio, y evita la
  autoasignación de roles a la identidad Terraform.
- `Storage Blob Data Contributor` para la identidad GitHub solo en el Storage
  Account del state.
- `Cost Management Contributor` para la identidad GitHub a nivel de suscripción.
- `Storage Blob Data Contributor` para el operador autenticado solo en el Storage
  Account del state, para crear el contenedor y migrar el state.

La asignación de Cost Management es persistente y tiene alcance de suscripción.
El Storage permite acceso de red por endpoint público para runners GitHub-hosted,
pero mantiene acceso anónimo y shared keys deshabilitados, contenedor privado,
HTTPS/TLS 1.2, versionado y soft delete de 30 días. Revisar estos efectos en el
plan antes de aplicarlo.

## Plan y aplicación

Ejecutar desde Azure Cloud Shell (Bash), en la suscripción `aaf787f8-5964-4470-9eb6-89d15eacda61`,
con el código de este repositorio que incluya `infra/azure/bootstrap`:

```bash
set -euo pipefail
az account show --query '{subscription:id,tenant:tenantId,state:state}' --output json

export TF_VAR_subscription_id="$(az account show --query id --output tsv)"
export TF_VAR_tenant_id="$(az account show --query tenantId --output tsv)"
export TF_VAR_project="qapaq-secops"
export TF_VAR_environment="demo-eus"
export TF_VAR_location="eastus"
export TF_VAR_github_repository="CyberStill-GmbH/qapaq-secops"
export TF_VAR_github_owner_id="220633794"
export TF_VAR_github_repository_id="1374673243"
export TF_VAR_github_environment="azure-demo-eus"
export TF_VAR_state_container_name="tfstate"
export TF_VAR_state_key="qapaq-secops/demo-eus/terraform.tfstate"

suffix="$(printf '%s' "${TF_VAR_subscription_id}:qapaq-secops:demo-eus" | sha256sum | cut -c1-8)"
export TF_VAR_state_storage_account_name="qapaqsecopseus${suffix}"

cd infra/azure/bootstrap
terraform init -backend=false -input=false
terraform plan -input=false -no-color -out=bootstrap-eus.tfplan
terraform show -no-color bootstrap-eus.tfplan
```

El nombre se deriva del subscription ID para evitar reutilizar el Storage Chile;
Azure exige que el nombre sea globalmente único. Si el plan falla por colisión,
elige un sufijo distinto permitido y vuelve a revisar el plan antes de aplicar.

Antes del apply, confirmar en el plan exactamente los recursos y scopes anteriores,
región `eastus`, subject OIDC con `environment:azure-demo-eus`, 0 destrucciones,
ningún DNS ni secreto de proveedor, y ningún cambio a recursos/state del demo Chile.
No aplicar si el plan propone acciones distintas o si la identidad ejecutora no
tiene los permisos documentados.

Después de revisar ese plan:

```bash
terraform apply -input=false bootstrap-eus.tfplan
```

Migrar el state local del bootstrap al nuevo backend EUS. No usar `-force-copy`;
revisar y aceptar la migración interactiva:

```bash
terraform init -migrate-state \
  -backend-config="resource_group_name=$(terraform output -raw state_resource_group_name)" \
  -backend-config="storage_account_name=$(terraform output -raw state_storage_account_name)" \
  -backend-config="container_name=$(terraform output -raw state_container_name)" \
  -backend-config="key=bootstrap/demo-eus/terraform.tfstate" \
  -backend-config="use_azuread_auth=true" \
  -backend-config="use_cli=true"
```

## GitHub environment `azure-demo-eus`

Con `gh auth status` ya autenticado y la federación creada, cargar el client ID
como secret de environment y los datos del backend como variables. El client ID
no es una contraseña, pero el workflow lo consume como secret. Los comandos no
imprimen el output ni los valores secretos:

```bash
repo="CyberStill-GmbH/qapaq-secops"
env_name="azure-demo-eus"

terraform output -raw github_terraform_client_id | \
  gh secret set AZURE_EUS_TERRAFORM_CLIENT_ID --env "$env_name" --repo "$repo"
gh variable set AZURE_EUS_TF_STATE_RESOURCE_GROUP --env "$env_name" --repo "$repo" \
  --body "$(terraform output -raw state_resource_group_name)"
gh variable set AZURE_EUS_TF_STATE_STORAGE_ACCOUNT --env "$env_name" --repo "$repo" \
  --body "$(terraform output -raw state_storage_account_name)"
gh variable set AZURE_EUS_TF_STATE_CONTAINER --env "$env_name" --repo "$repo" \
  --body "$(terraform output -raw state_container_name)"
gh variable set AZURE_EUS_TF_STATE_KEY --env "$env_name" --repo "$repo" \
  --body="qapaq-secops/demo-eus/terraform.tfstate"
```

`AZURE_EUS_TENANT_ID`, `AZURE_EUS_SUBSCRIPTION_ID` y
`AZURE_EUS_POSTGRES_ADMIN_PASSWORD` ya están configurados en ese environment;
no imprimir ni volver a copiar la contraseña. El workflow EUS aún necesita que
este archivo esté en `main` antes de que GitHub permita `workflow_dispatch`.
El apply del bootstrap solo deja lista la identidad y el backend: no aplica el
stack del SOC ni habilita servicios.
