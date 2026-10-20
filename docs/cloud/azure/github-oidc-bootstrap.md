# Bootstrap de GitHub OIDC para Azure

**Estado:** los IDs base de Azure están cargados en GitHub; bootstrap OIDC, backend remoto y despliegue Azure siguen pendientes.
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

## Secuencia de bootstrap revisable

1. Usar `infra/azure/bootstrap` desde Azure Cloud Shell autenticado para crear el
   state Storage y el grupo destino protegido. El state account tiene versionado,
   soft delete, keys y acceso anónimo deshabilitados, container privado y firewall
   limitado a egress estable autorizado. No abrirlo a Internet ni permitir el
   egress dinámico de runners estándar. Migrar el state local del bootstrap a
   `bootstrap/terraform.tfstate` antes de cerrar la sesión.
2. El bootstrap crea una User Assigned Managed Identity con issuer
   `https://token.actions.githubusercontent.com`, audience
   `api://AzureADTokenExchange` y subject inmutable
   `repo:CyberStill-GmbH@220633794/qapaq-secops@1374673243:environment:azure-demo`.
   GitHub informa `use_immutable_subject=true` para este repo; el formato sigue
   la [referencia OIDC oficial](https://docs.github.com/en/actions/reference/security/oidc).
3. Los permisos de la identidad se limitan a `Contributor` y `Role Based Access
   Control Administrator` dentro del resource group QAPAQ, `Storage Blob Data
   Contributor` en el Storage Account de state y `Cost Management Contributor`
   en la suscripción para el presupuesto del root. Una condición ABAC restringe
   la delegación a `AcrPull`, `AcrPush`, `Key Vault Secrets User` y `Storage
   Blob Data Contributor` para service principals, y bloquea la autoasignación.
   El operador bootstrap recibe acceso Blob solo en el Storage Account de state.
   No se concede Owner/Contributor a nivel de suscripción a GitHub.
4. El root `infra/azure` consulta el resource group creado por bootstrap; no lo
   administra y no puede destruirlo. El environment `azure-demo` existe; solo admite `main`, exige aprobación de
   `CesarGuevaraQapaq`, impide autoaprobación y desactiva el bypass administrativo.
5. Configurar GitHub repository secrets sin imprimir valores secretos:

   ```powershell
   gh secret set AZURE_TERRAFORM_CLIENT_ID --repo CyberStill-GmbH/qapaq-secops
   gh secret set AZURE_POSTGRES_ADMIN_PASSWORD --repo CyberStill-GmbH/qapaq-secops
   # AZURE_TENANT_ID y AZURE_SUBSCRIPTION_ID ya existen como repository secrets.
   ```

   `AZURE_TERRAFORM_CLIENT_ID` es el Client ID de la identidad bootstrap
   para plan/apply; se usa como dato de configuración de identidad, sin client
   secret. `AZURE_POSTGRES_ADMIN_PASSWORD` es la credencial nueva del
   usuario bootstrap PostgreSQL; el estado y el plan Terraform pueden contenerla,
   por lo que se limitan a state remoto cifrado y al artifact efímero del propio
   run. No reutilizar contraseñas de AWS. El Client ID de `github_publisher` es
   otra identidad y va en `AZURE_ACR_PUBLISHER_CLIENT_ID`, que se obtiene del
   output Terraform después del primer apply controlado.
6. Definir como GitHub variables los datos no secretos del backend remoto ya
   creado y protegido:

   ```powershell
   gh variable set AZURE_TF_STATE_RESOURCE_GROUP --body "<resource-group>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_TF_STATE_STORAGE_ACCOUNT --body "<storage-account>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_TF_STATE_CONTAINER --body "<container>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_TF_STATE_KEY --body "qapaq-secops/demo/terraform.tfstate" --repo CyberStill-GmbH/qapaq-secops
   ```

   No llenar valores de ejemplo antes de crear el state backend.
7. El workflow `.github/workflows/terraform-azure.yml` se ejecuta solo por
   `workflow_dispatch` desde `main`. La validación de PR no accede a Azure. El
   plan usa OIDC y el environment `azure-demo`; la opción `apply` exige una
   referencia HTTPS al costo mensual revisado, guarda el plan por un día y espera
   otra aprobación del mismo environment después de mostrar el resumen. El
   apply verifica commit y checksum y ejecuta exactamente ese plan. La guarda
   rechaza `delete`, `forget` y reemplazos. El plan binario puede contener valores
   sensibles: el repositorio debe seguir privado y no se debe descargar ni
   compartir el artifact fuera de los revisores autorizados.
8. Después del primer apply y de que ACR exista, definir como GitHub variables:

   ```powershell
   gh variable set AZURE_ACR_NAME --body "<acr-name>" --repo CyberStill-GmbH/qapaq-secops
   gh variable set AZURE_ACR_LOGIN_SERVER --body "<acr-name>.azurecr.io" --repo CyberStill-GmbH/qapaq-secops
   ```

   Establecer el secreto `AZURE_ACR_PUBLISHER_CLIENT_ID` con el output
   `github_publisher_client_id`. La federación de Terraform y la publicación
   deben seguir separadas, cada una con su subject y permisos por purpose.
   Nunca guardar `AZURE_CLIENT_SECRET`: se usa federación OIDC.

## Estado observado el 2026-10-20

- Existen los repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID` y `AZURE_POSTGRES_ADMIN_PASSWORD`; también aparece
  `ENTRA_CLIENT_SECRET`. Solo se consultaron nombres y metadata, nunca sus
  valores. `AZURE_CLIENT_ID` sirve como fallback para el Client ID Terraform,
  aunque se recomienda renombrarlo a `AZURE_TERRAFORM_CLIENT_ID` para distinguir
  su uso del principal publicador.
- Terraform acepta `AZURE_TERRAFORM_CLIENT_ID` y usa `AZURE_CLIENT_ID` como
  alternativa si el nombre dedicado todavía no está creado. El principal debe
  tener la federación OIDC `azure-demo` y permisos acotados para IaC; la mera
  presencia del secreto no prueba esos permisos. Los publicadores siguen
  exigiendo `AZURE_ACR_PUBLISHER_CLIENT_ID`, separado para `AcrPush`.
- No existen las cuatro variables `AZURE_TF_STATE_*`, `AZURE_TF_RUNNER_LABELS`,
  `AZURE_ACR_NAME` ni `AZURE_ACR_LOGIN_SERVER` entre los repository variables
  verificados. GitHub reporta cero runners propios registrados. La presencia de
  los secrets no demuestra una sesión OIDC de Actions ni acceso al backend
  remoto; tampoco acredita por sí sola que el Client ID tenga federación y roles
  correctos.
- El environment `azure-demo` está limitado a `main`, exige aprobación de
  `CesarGuevaraQapaq`, impide autoaprobación y desactiva el bypass administrativo.
- `infra/azure` cuenta ahora con un workflow manual plan/apply protegido. No se
  ha ejecutado: faltan las variables para seleccionar el backend remoto y un
  runner con salida estable autorizada por su firewall. No se ha verificado el
  estado real de los recursos bootstrap en Azure. La validación Terraform de PR
  ejecuta `init -backend=false` y no autentica con Azure.
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
