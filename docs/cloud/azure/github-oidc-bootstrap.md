# Bootstrap de GitHub OIDC para Azure

**Estado:** diseño revisable; no crea identidades, permisos ni recursos.
**Repositorio:** `CyberStill-GmbH/qapaq-secops`.
**Environment GitHub previsto:** `azure-demo`.

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
5. Crear el environment `azure-demo` en GitHub y restringirlo a `main` con
   aprobador requerido antes de cualquier apply o publicación.
6. Configurar GitHub repository secrets sin imprimir sus valores:

   ```powershell
   gh secret set AZURE_TERRAFORM_CLIENT_ID --repo CyberStill-GmbH/qapaq-secops
   # AZURE_TENANT_ID y AZURE_SUBSCRIPTION_ID ya existen como repository secrets.
   ```

   `AZURE_TERRAFORM_CLIENT_ID` debe ser el Client ID de la identidad bootstrap
   para la futura pipeline de Terraform. El Client ID de `github_publisher` es
   otra identidad y va en `AZURE_ACR_PUBLISHER_CLIENT_ID`, que se obtiene del
   output Terraform después del primer apply controlado.
7. Crear un workflow separado de `plan` y `apply`: plan en PR sin secretos,
   artefacto de plan protegido y vinculado al commit, revisión de altas/cambios/
   destroys y costo, y apply solo desde `main` después de aprobación del
   environment. No aplicar un plan distinto al revisado.
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

- Existen los repository secrets `AZURE_TENANT_ID` y
  `AZURE_SUBSCRIPTION_ID`; solo se consultaron nombres y metadata.
- No existe `AZURE_CLIENT_ID`/`AZURE_TERRAFORM_CLIENT_ID`,
  `AZURE_ACR_PUBLISHER_CLIENT_ID`, `AZURE_ACR_NAME` ni
  `AZURE_ACR_LOGIN_SERVER` entre los repository secrets/variables verificados.
- GitHub respondió 404 al consultar el environment `azure-demo`.
- `infra/azure` no tiene aún pipeline cloud para inicializar backend, planear ni
  aplicar. La validación Terraform actual ejecuta `init -backend=false` y no
  autentica con Azure.
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
