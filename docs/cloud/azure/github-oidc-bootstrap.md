# Bootstrap de GitHub OIDC para Azure

**Estado:** bootstrap OIDC incompleto; el environment de GitHub está creado, pero no hay identidad ni despliegue Azure.
**Repositorio:** `CyberStill-GmbH/qapaq-secops`.
**Environment GitHub:** `azure-demo` (solo `main`, aprobador requerido y bypass administrativo desactivado).

## Por qué hacen falta dos identidades

La raíz `infra/azure` crea `github_publisher`, una identidad administrada
federada con `azure-demo` que recibe únicamente `AcrPush` sobre el ACR creado por
Terraform. Esa identidad no existe antes del primer apply y no tiene permisos
para aplicar la infraestructura.

El primer `terraform plan/apply` requiere una identidad **bootstrap de IaC** ya
existente, autenticada con OIDC. Debe limitarse al resource group de la demo y al
contenedor remoto de state. No se debe reutilizar la identidad del publicador ni
dar permisos de suscripción Owner/Contributor para resolver el ciclo inicial.

## Secuencia recomendada

1. Crear y proteger un backend de state independiente. Habilitar versionado,
   soft delete, bloqueo por lease y RBAC; no guardar el state en GitHub artifacts.
2. Crear el resource group destino de QAPAQ y una identidad bootstrap dedicada.
3. Agregar a esa identidad una credencial federada con issuer
   `https://token.actions.githubusercontent.com`, audience
   `api://AzureADTokenExchange` y subject
   `repo:CyberStill-GmbH/qapaq-secops:environment:azure-demo`.
4. Conceder permisos mínimos revisados para los recursos del plan en el resource
   group destino y acceso de datos solo al state container. Revisar por separado
   cualquier permiso para crear role assignments; no conceder Owner a nivel de
   suscripción como atajo.
5. El environment `azure-demo` existe; solo admite `main`, exige aprobación de
   `CesarGuevaraQapaq`, impide autoaprobación y desactiva el bypass administrativo.
6. Configurar GitHub repository secrets sin imprimir sus valores:

   ```powershell
   gh secret set AZURE_TERRAFORM_CLIENT_ID --repo CyberStill-GmbH/qapaq-secops
   gh secret set AZURE_POSTGRES_ADMIN_PASSWORD --repo CyberStill-GmbH/qapaq-secops
   # AZURE_TENANT_ID y AZURE_SUBSCRIPTION_ID ya existen como repository secrets.
   ```

   `AZURE_TERRAFORM_CLIENT_ID` debe ser el Client ID de la identidad bootstrap
   para plan/apply. `AZURE_POSTGRES_ADMIN_PASSWORD` es la credencial nueva del
   usuario bootstrap PostgreSQL; el estado y el plan Terraform pueden contenerla,
   por lo que se limitan a state remoto cifrado y al artifact efímero del propio
   run. No reutilizar contraseñas de AWS. El Client ID de `github_publisher` es
   otra identidad y va en `AZURE_ACR_PUBLISHER_CLIENT_ID`, que se obtiene del
   output Terraform después del primer apply controlado.
7. Definir como GitHub variables los datos no secretos del backend remoto ya
   creado y protegido:

   ```powershell
   gh variable set AZURE_TF_STATE_RESOURCE_GROUP --body "<resource-group>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_TF_STATE_STORAGE_ACCOUNT --body "<storage-account>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_TF_STATE_CONTAINER --body "<container>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_TF_STATE_KEY --body "qapaq-secops/demo/terraform.tfstate" --repo CyberStill-GmbH/qapaq-secops
   ```

   No llenar valores de ejemplo antes de crear el state backend.
8. El workflow `.github/workflows/terraform-azure.yml` se ejecuta solo por
   `workflow_dispatch` desde `main`. La validación de PR no accede a Azure. El
   plan usa OIDC y el environment `azure-demo`; la opción `apply` exige una
   referencia HTTPS al costo mensual revisado, guarda el plan por un día y espera
   otra aprobación del mismo environment después de mostrar el resumen. El
   apply verifica commit y checksum y ejecuta exactamente ese plan. La guarda
   rechaza `delete`, `forget` y reemplazos. El plan binario puede contener valores
   sensibles: el repositorio debe seguir privado y no se debe descargar ni
   compartir el artifact fuera de los revisores autorizados.
9. Después del primer apply y de que ACR exista, definir como GitHub variables:

   ```powershell
   gh variable set AZURE_ACR_NAME --body "<acr-name>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_ACR_LOGIN_SERVER --body "<acr-name>.azurecr.io" --repo CyberStill-GmbH/qapaq-secops
   ```

   Establecer el secreto `AZURE_ACR_PUBLISHER_CLIENT_ID` con el output
   `github_publisher_client_id`. La federación de Terraform y la publicación
   deben seguir separadas, cada una con su subject y permisos por purpose.
   Nunca guardar `AZURE_CLIENT_SECRET`: se usa federación OIDC.

## Estado observado el 2026-10-20

- Existen los repository secrets `AZURE_TENANT_ID` y
  `AZURE_SUBSCRIPTION_ID`; solo se consultaron nombres y metadata.
- No existen `AZURE_TERRAFORM_CLIENT_ID`, `AZURE_POSTGRES_ADMIN_PASSWORD`,
  las cuatro variables `AZURE_TF_STATE_*`, `AZURE_ACR_PUBLISHER_CLIENT_ID`,
  `AZURE_ACR_NAME` ni `AZURE_ACR_LOGIN_SERVER` entre los repository
  secrets/variables verificados. `AZURE_TENANT_ID` y
  `AZURE_SUBSCRIPTION_ID` sí están configurados.
- El environment `azure-demo` está limitado a `main`, exige aprobación de
  `CesarGuevaraQapaq`, impide autoaprobación y desactiva el bypass administrativo.
- `infra/azure` cuenta ahora con un workflow manual plan/apply protegido. No se
  ha ejecutado: la identidad bootstrap, el backend remoto y sus variables
  todavía no existen. La validación Terraform de PR sigue ejecutando
  `init -backend=false` y no autentica con Azure.
- Los workflows de build/publicación de Ankay y Dashboard aceptan
  `AZURE_ACR_PUBLISHER_CLIENT_ID` como secret o variable y tenant/subscription
  como secrets o variables. Publicar requiere ACR ya creado, OIDC funcional y
  los valores de destino. Esta compatibilidad no configura la federación por sí
  misma.

## Aprobaciones y validaciones antes de implementar

- Confirmar el resource group, el contenedor/storage de state y su red antes de
  conceder roles.
- Revisar la lista exacta de `roleDefinitionIds` que Terraform necesita asignar.
  Evitar `User Access Administrator` amplio; si es imprescindible, restringir
  roles y principales mediante condición soportada y probar el alcance.
- Verificar en plan que ninguna identidad, state, secreto, bucket o dato vital
  sea destruido o reemplazado.
- El primer apply todavía requiere un plan y costo detallados; este documento no
  autoriza ejecutarlo.
