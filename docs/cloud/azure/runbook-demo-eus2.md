# Runbook Terraform de East US 2

Este runbook describe un entorno `demo-eus2` independiente del demo actual de
East US (`demo-eus`) y de Chile Central. El workflow es
`.github/workflows/terraform-azure-demo-eus2.yml`; usa GitHub OIDC, el backend
remoto EUS2 y el plan guardado en la misma ejecución. No administra DNS ni carga
credenciales de integración.

## Auditoría previa — 2026-10-26

- Azure ya tiene el grupo destino vacío
  `rg-qapaqsecopsdemoeus-3a2405f3` y el grupo state
  `rg-qapaqsecopsdemoeus-state-3a2405f3`, ambos en `eastus2`.
- La UAMI Terraform `id-qapaqsecopsdemoeus-github-tf-3a2405f3` tiene la FIC
  `github-terraform-demo-eus2`: issuer `https://token.actions.githubusercontent.com`,
  audience `api://AzureADTokenExchange`, subject
  `repo:CyberStill-GmbH@220633794/qapaq-secops@1374673243:environment:azure-demo-eus2`.
  Tiene Contributor y Role Based Access Control Administrator en el grupo destino,
  Storage Blob Data Contributor en el Storage de state y Cost Management
  Contributor en la suscripción.
- El Storage remoto es `qapaqsecopseus23a2405f3`; el container `tfstate` es
  privado, las shared keys están deshabilitadas y el endpoint de red es público.
  El container está vacío en esta cuenta. El state de runtime EUS2 usará la key
  nueva `qapaq-secops/demo-eus2/terraform.tfstate`.
- El state de bootstrap EUS2 sí existe en el Storage EUS anterior
  `qapaqsecopseus261026`, container `tfstate`, key
  `qapaq-secops/demo-eus2/bootstrap.tfstate`; `terraform state list` confirmó
  ese state remoto. Es distinto del container EUS2 nuevo y administra recursos
  bootstrap existentes. No reconfigurar ni volver a inicializar ese root como
  state vacío, ni migrarlo al backend de runtime.
- El environment GitHub `azure-demo-eus2` aún no existe. Tampoco tiene variables
  ni secretos; no copiar valores del entorno `azure-demo` o `azure-demo-eus`.
  Hasta configurar el environment, este workflow no puede autenticarse ni aplicar.
- El state y recursos existentes de `demo-eus` en East US no se comparten ni se
  migran. PostgreSQL no existe en el grupo EUS2; la API actual de capacidades
  confirma PostgreSQL 16 y `Standard_B2s` en East US 2.

Esta inspección no consultó ni exportó valores secretos. Revalidar todos los
recursos, el container y el estado remoto antes de usar el runbook.

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

No cambiar `location` dentro del state `demo-eus`: su grupo/infraestructura vive
en East US. East US 2 tiene nuevo grupo, nombres y state para evitar que Terraform
interprete los recursos EUS existentes como reemplazos. Mantener los recursos
EUS hasta que se inventaríen sus datos y el entorno EUS2 pase health checks; no
destruir ni limpiar automáticamente el state anterior.
