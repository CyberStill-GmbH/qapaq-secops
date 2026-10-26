# Runbook Terraform de la demo East US

Este flujo mantiene el state de East US separado del state de Chile. El workflow
`terraform-azure-demo-eus.yml` opera solo con el GitHub Environment
`azure-demo-eus`, usa OIDC y aplica exclusivamente el plan guardado en la misma
ejecución. No modifica DNS.

## Configuración requerida en GitHub

Crear `azure-demo-eus`, permitir despliegues solo desde `main` y exigir revisión
de un operador autorizado antes de cualquier apply. No reutilizar secretos o
variables del environment `azure-demo` ni los valores globales del repositorio.
La identidad administrada debe tener una credencial federada con:

- Issuer: `https://token.actions.githubusercontent.com`
- Audience: `api://AzureADTokenExchange`
- Subject inmutable: `repo:CyberStill-GmbH@220633794/qapaq-secops@1374673243:environment:azure-demo-eus`

Configurar secretos **en el environment**:

| Nombre | Uso |
| --- | --- |
| `AZURE_EUS_TERRAFORM_CLIENT_ID` | Client ID de la UAMI EUS con OIDC y RBAC acotado |
| `AZURE_EUS_TENANT_ID` | Tenant Entra del destino |
| `AZURE_EUS_SUBSCRIPTION_ID` | Suscripción destino |
| `AZURE_EUS_POSTGRES_ADMIN_PASSWORD` | Credencial inicial PostgreSQL; Terraform la conserva en state |

Configurar variables **en el environment**:

| Nombre | Uso |
| --- | --- |
| `AZURE_EUS_TF_STATE_RESOURCE_GROUP` | Grupo que contiene el Storage de state dedicado EUS |
| `AZURE_EUS_TF_STATE_STORAGE_ACCOUNT` | Storage de state dedicado EUS |
| `AZURE_EUS_TF_STATE_CONTAINER` | Debe ser `tfstate` |
| `AZURE_EUS_TF_STATE_KEY` | Debe ser `qapaq-secops/demo-eus/terraform.tfstate` |
| `AZURE_EUS_SIEM_HOST_JSON` | Perfil no secreto del host Wazuh, CIDR, referencias Key Vault y bundle inmutable |
| `AZURE_EUS_ANKAY_HOST_JSON` | Perfil no secreto y Compose revisado de Ankay con imágenes fijadas por digest |
| `AZURE_EUS_ACR_LOGIN_SERVER` | ACR EUS usado por las imágenes Ankay |
| `AZURE_EUS_CONTAINER_IMAGES_JSON` | Digests de imágenes opcionales de Container Apps, si ese runtime fuese aprobado |
| `AZURE_EUS_ENABLE_RUNTIME` | Debe permanecer `false` hasta aprobar esos servicios |
| `AZURE_EUS_KEY_VAULT_SECRET_IDS_JSON` | IDs/refs de secretos existentes, nunca valores de secretos |

El plan valida el prefijo del backend EUS y rechaza la key de state de Chile.
El scope `soc` del apply requiere perfiles de SIEM y Ankay completos. Las
referencias deben apuntar a secretos existentes y a artefactos realmente
publicados en el destino EUS; el workflow no importa secretos ni copia datos.

## Aplicación y verificación

1. Verificar en Azure que el backend indicado existe, está protegido y contiene
   solo el state dedicado EUS; revisar la federación OIDC y permisos mínimos.
2. Completar y revisar las variables de perfil. Usar `apply=false` para obtener
   el plan, inspeccionar altas/cambios, reemplazos/destrucciones y costo mensual
   East US para las SKUs/duración indicadas.
3. Para aplicar, incluir una referencia HTTPS al cálculo de costos y ejecutar
   `apply=true`. El resumen Terraform bloquea acciones `delete` y `forget`; el
   job aplica el artifact protegido solo si SHA y checksum coinciden.
4. Ejecutar health checks y pruebas sintéticas de M365, Sophos, Cato, Teams,
   Wazuh, Ankay, administración y roles antes de cambiar DNS. Un plan exitoso,
   un host creado o un bundle publicado no prueban operación del SOC.

Hasta que el environment, la federación, el backend y los perfiles existan,
el workflow debe fallar en preflight. No completar valores desconocidos con los
de Chile ni permitir un plan vacío como evidencia de despliegue.
