# Carga privada de secretos para QAPAQ SecOps EUS2

Este procedimiento prepara referencias de secretos para el runtime QAPAQ en East US 2.
No ejecuta Terraform, no habilita perfiles SIEM/Ankay, no cambia DNS y no abre el
Key Vault a Internet.

## Destino y controles

- Suscripción: la definida para `azure-demo-eus2`.
- Grupo destino: `rg-qapaqsecopsdemoeus-3a2405f3`.
- Key Vault determinístico del root: `kv-qapaqsecopsd-3a2405f3`, región `eastus2`.
  Confirmar que el recurso exista después del apply de fundación antes de usarlo.
- El Key Vault debe conservar `publicNetworkAccess=Disabled`, ACL `Deny`, bypass
  `None`, Private Endpoint y `prevent_destroy`. El importador comprueba esas
  propiedades, la resolución DNS a IP privada y TCP/443 antes de transmitir valores.
- El operador debe usar una identidad Azure que ya tenga permiso de crear secretos
  en ese vault (`Key Vault Secrets Officer` con el alcance más estrecho disponible).
  Este flujo no crea ni amplía roles. La identidad de Terraform no se usa para
  cargar secretos de proveedores.

El archivo `.env.local` se procesa localmente, sin `eval`, sin cargar sus otros
valores y sin imprimir valores. El importador usa un allowlist explícito y hace las
escrituras a Key Vault por HTTPS autenticado a través del Private Endpoint. No
acepta secretos en `tfvars`, variables GitHub, argumentos CLI o logs. Los valores
que fueron pegados en el chat deben rotarse antes de ejecutar; el script requiere
`-ConfirmRotatedSecrets` para cualquier escritura real. Su comportamiento no
garantiza borrado forense de strings inmutables de memoria.

## Secretos y formatos

| Nombre en Key Vault | Origen/forma | Consumidor en Terraform/runtime | Estado de la fuente local revisada |
| --- | --- | --- | --- |
| `qapaq-entra-client-secret` | `QAPAQ_MICROSOFT_ENTRA_CLIENT_SECRET`; valor de client secret de la app QAPAQ Entra, una línea | `core_secret_names.QAPAQ_ENTRA_CLIENT_SECRET` | La clave está presente en `.env.local`; rotar y validar que el `client_id` corresponda a esta app. |
| `office365-client-secret` | `OFFICE365_CLIENT_SECRET`; valor de client secret de la app registrada para Office 365/Graph, una línea | `wazuh_secret_names["office365-client-secret"]` | No hay clave `OFFICE365_CLIENT_SECRET` en la fuente revisada. No copiar automáticamente el secreto de login QAPAQ: solo reutilizar la app después de confirmar que el client ID y permisos Graph son los mismos. |
| `wazuh-install-files.tar.b64` | Se genera al codificar el archivo binario `wazuh-install-files.tar` del asistente oficial; base64 de una sola línea, tar ≤18.000 bytes y contenido validado | `wazuh_secret_names["wazuh-install-files.tar.b64"]` | No es una variable de `.env.local`; se entrega al importador como ruta de archivo protegida. El script valida paths, miembros, certificados, contraseñas y límites antes de cargar. |
| `sophos-client-id` | `SOPHOS_CLIENT_ID`; client ID de Sophos Central | `wazuh_secret_names["sophos-client-id"]` | No está presente en `.env.local`. Se almacena bajo Key Vault porque el bootstrap lo consume como referencia protegida. |
| `sophos-client-secret` | `SOPHOS_SECRET`; secret de Sophos Central | `wazuh_secret_names["sophos-client-secret"]` | La clave está presente; usar únicamente después de rotar. |
| `cato-api-key` | `CATO_SECRET`; API key de Cato, una línea | `wazuh_secret_names["cato-api-key"]` | La clave está presente; usar únicamente después de rotar. |
| `qapaq-teams-workflow-url` | `TEAMS_WORKFLOW_URL`; URL firmada del Workflow de Teams, una línea HTTPS | `core_secret_names.QAPAQ_TEAMS_WORKFLOW_URL` o referencia de integración Wazuh según el perfil | No está presente en `.env.local`. Tratar la URL como credencial; no ponerla en variables, Terraform, correo o documentación pública. |

Los nombres GitHub `AZURE_EUS2_TERRAFORM_CLIENT_ID` y la contraseña de
administrador PostgreSQL son para autenticación/state y bootstrap de base,
respectivamente; no son secretos de integraciones y no se importan desde
`.env.local`.

### Entradas no conectadas al runtime EUS2

No cargar `CLAUDE_API_SECRET`, `VIRUS_TOTAL_API_KEY` ni
`ACTIVE_DIRECTORY_SECRET` con este importador: el perfil Terraform/runtime de
EUS2 no declara consumidores para esos valores. Tampoco se importan passwords de
PostgreSQL local, Redis, MinIO, el Indexer local ni credenciales genéricas. Antes
de activar cualquiera de esos servicios se requiere un contrato versionado,
referencia Key Vault con mínimo privilegio, allowlist de egress y prueba real.

Los GUID de tenant/client, región Sophos, account ID Cato, CIDR, llave SSH pública,
digest del bundle y nombres de secretos son configuración no secreta. Deben ir en
el perfil aprobado `AZURE_EUS2_SIEM_HOST_JSON`; nunca se rellenan con placeholders.

## Uso desde una red autorizada

El equipo que ejecute el importador debe estar en una red con acceso al VNet o
Private Endpoint aprobado. Una GitHub-hosted runner normal y una laptop fuera de
la VPN/VNet no pueden resolver/conectar a este Key Vault; en esos casos el script
se detiene sin habilitar acceso público. No se debe cambiar `publicNetworkAccess`
para sortear el bloqueo.

```powershell
az account set --subscription aaf787f8-5964-4470-9eb6-89d15eacda61
Resolve-DnsName kv-qapaqsecopsd-3a2405f3.vault.azure.net -Type A
Test-NetConnection kv-qapaqsecopsd-3a2405f3.vault.azure.net -Port 443

# Preflight privado y lista de nombres; no escribe secretos.
.\infra\azure\scripts\seed-eus2-keyvault-secrets.ps1 -WhatIf

# Tras rotar las credenciales expuestas, preparar sólo los secretos permitidos.
.\infra\azure\scripts\seed-eus2-keyvault-secrets.ps1 `
  -WazuhInstallArchivePath C:\secure\wazuh-install-files.tar `
  -ConfirmRotatedSecrets -Confirm
```

El archivo del asistente debe generarse fuera del repositorio y protegerse con ACL
local. No pegar su base64 en una terminal interactiva. Si se omite, el informe del
script lo deja explícitamente ausente y no se puede habilitar `siem_host`.

Las escrituras son por secreto, no transaccionales. Por defecto se rechaza crear
una nueva versión si ya existe un nombre. El parámetro `-OverwriteExisting` solo
debe usarse para una rotación revisada y confirma cada escritura. El script no
comprueba validez del permiso Graph, Sophos/Cato, ni el webhook de Teams; se deben
probar esos proveedores por separado antes del apply del perfil SOC.

## Alternativa manual por GitHub Actions (ARM, solo alta inicial)

El workflow `.github/workflows/seed-eus2-key-vault-secret.yml` crea **un** secreto
ausente desde un GitHub Environment secret usando `Microsoft.KeyVault/vaults/secrets`
con parámetro ARM `secureString`. Es `workflow_dispatch` únicamente, acepta solo
`main`, valida una frase de confirmación, requiere la protección del environment
`azure-demo-eus2` y rehúsa sobrescribir un secreto existente. Esta ruta no ejecuta
Terraform ni cambia DNS, red, Key Vault, RBAC, perfiles runtime o servicios.

ARM usa el plano de administración de Azure. Las reglas de red del Key Vault
controlan el plano de datos y siguen sin abrirse; por eso la ruta funciona desde un
runner hospedado aunque no tenga conexión al VNet. El workflow comprueba por ARM
que el destino sea el vault EUS2 correcto, con `publicNetworkAccess=Disabled`, ACL
`Deny`/`None` y un Private Endpoint aprobado. Los valores van en un archivo de
parámetros temporal con modo `0600`, se pasan a ARM como `secureString`, no se
imprimen, no se guardan en state ni se adjuntan como artefacto, y el runner lo
elimina al terminar. El borrado de archivos y referencias en memoria es best-effort;
no equivale a un borrado forense. Fuentes: [Key Vault network security](https://learn.microsoft.com/en-us/azure/key-vault/general/how-to-azure-key-vault-network-security), [ARM data types](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/data-types), [Key Vault secret ARM resource](https://learn.microsoft.com/en-us/azure/templates/microsoft.keyvault/vaults/secrets).

### Identidad y permisos requeridos (configuración externa, no los crea el workflow)

- Environment existente `azure-demo-eus2`, limitado a `main`, con aprobación
  obligatoria y self-review deshabilitado.
- Terraform del root `infra/azure` crea una identidad administrada exclusiva para
  seed, separada de Terraform, runtime y publicador. Su FIC queda limitada al
  issuer `https://token.actions.githubusercontent.com`, subject exacto
  `repo:CyberStill-GmbH/qapaq-secops:environment:azure-demo-eus2` y audience
  `api://AzureADTokenExchange`.
- Tras una aplicación revisada del root, copiar únicamente el output
  `eus2_secret_seeder_client_id` a la variable de Environment
  `AZURE_EUS2_SECRET_SEEDER_CLIENT_ID`. `AZURE_EUS2_TENANT_ID` y
  `AZURE_EUS2_SUBSCRIPTION_ID` siguen siendo variables del mismo Environment.
- El módulo crea dos roles personalizados separados: en el grupo de recursos
  destino, `Microsoft.Resources/deployments/validate/action`,
  `Microsoft.Resources/deployments/write`, `Microsoft.Resources/deployments/read`,
  `Microsoft.Resources/deployments/operations/read`,
  `Microsoft.Resources/deployments/operationStatuses/read` y
  `Microsoft.Resources/subscriptions/resourceGroups/read`. La identidad de seed
  no recibe acciones de escritura sobre otros tipos de recursos.
- En el alcance del Key Vault exacto, `Microsoft.KeyVault/vaults/read`,
  `Microsoft.KeyVault/vaults/secrets/read` y
  `Microsoft.KeyVault/vaults/secrets/write`. Ese rol no contiene `dataActions` y
  no permite leer el valor de secretos existentes.

No asignar permisos desde Actions. La identidad de seed no necesita `Owner`,
`Contributor`, `Key Vault Secrets Officer`,
`Microsoft.Authorization/roleAssignments/write`, ni acciones de plano de datos
como `Microsoft.KeyVault/vaults/secrets/getSecret/action`; no requiere acceso a
valores existentes. La lectura anterior es metadata ARM para comprobar existencia
y estado, separada del permiso de recuperar valores.

**Bloqueo de autorización para aplicar Terraform:** el bootstrap EUS2 actual delega
RBAC al identity de Terraform mediante una condición que permite asignar solo los
IDs predefinidos de `AcrPull`, `AcrPush`, `Key Vault Secrets User` y
`Storage Blob Data Contributor`. Además, el rol `Role Based Access Control
Administrator` de ese identity no incluye `Microsoft.Authorization/roleDefinitions/write`.
Por eso el workflow de Terraform existente no puede crear estas definiciones ni
asignarlas. Para un apply futuro, la identidad autorizadora debe tener
`Microsoft.Authorization/roleDefinitions/write` en el alcance asignable del grupo y
`Microsoft.Authorization/roleAssignments/write` en el grupo y vault destino. Si se
prefiere automatizarlo, debe revisarse por separado una delegación exacta de los dos
custom role IDs; no ampliar la condición a roles genéricos ni conceder Owner,
Contributor o Secrets Officer para sortear el bloqueo. El workflow de seed no
puede crear ni autoasignarse RBAC.

**Evidencia del 2026-10-27:** el apply del workflow EUS2
[#40449785537](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40449785537)
falló con HTTP 403 en `Microsoft.Authorization/roleDefinitions/write` al intentar
crear los dos custom roles. El apply parcial creó la identidad dedicada de seed y
su FIC, y añadió una FIC EUS2 a la identidad publicadora preexistente; no completó
los roles. La lectura de solo plan
[#40451172490](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40451172490)
terminó correctamente y conserva **4 altas, 0 cambios y 0 destrucciones**: dos
custom roles asignables dentro del resource group EUS2 y dos asignaciones a la
identidad de seed (una al resource group y otra al vault). Ese plan no se aplicó.
No acredita que se hayan cargado secretos
ni que el runtime SOC esté habilitado. El siguiente paso es una revisión y
aprobación explícita del mecanismo de autorización; no reintentar el apply con un
rol genérico para evitar el 403.

Referencias RBAC: [custom role scopes and permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions),
[who can create custom roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/custom-roles)
y [Role Based Access Control Administrator permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/privileged#role-based-access-control-administrator).

### Allowlist exacta de origen y Key Vault

Configurar solo en `azure-demo-eus2` los GitHub Environment secrets de la columna
izquierda. No usar GitHub repository secrets compartidos con otros entornos.

| GitHub Environment secret | Nombre exacto en Key Vault |
| --- | --- |
| `QAPAQ_EUS2_ENTRA_CLIENT_SECRET` | `qapaq-entra-client-secret` |
| `QAPAQ_EUS2_OFFICE365_CLIENT_SECRET` | `office365-client-secret` |
| `QAPAQ_EUS2_SOPHOS_CLIENT_ID` | `sophos-client-id` |
| `QAPAQ_EUS2_SOPHOS_CLIENT_SECRET` | `sophos-client-secret` |
| `QAPAQ_EUS2_CATO_API_KEY` | `cato-api-key` |
| `QAPAQ_EUS2_TEAMS_WORKFLOW_URL` | `qapaq-teams-workflow-url` |
| `QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64` | `wazuh-install-files.tar.b64` |

El bundle Wazuh debe ser base64 de una sola línea del tar validado por el importador
local (máximo 18.000 bytes decodificados, sin links, traversal ni miembros
especiales). No cargar credenciales expuestas previamente en conversación o
terminal: rotar y validar cada credencial primero. El workflow es de alta inicial;
para rotación hace falta un procedimiento separado, revisado y con versionado
intencional.

### Ejecución y límites

1. Un administrador configura identidad federada, permisos mínimos y secretos
   recién rotados como se indica arriba; no pegar valores en el chat ni en CLI.
2. Abrir **Actions → Seed one EUS2 Key Vault secret through ARM → Run workflow**,
   elegir un único nombre de la allowlist y escribir `SEED-EUS2-SECRET`.
3. El job de validación no recibe credenciales. El job de escritura espera la
   aprobación del environment, comprueba target/red y ausencia del nombre, hace
   una sola alta y verifica solo nombre/`enabled`/caducidad.
4. Revisar el resumen de Actions. Un `resource not found` no prueba que el secreto
   haya sido creado: cualquier error de autorización, red o consulta aborta.

La ejecución no habilita `siem_host`, agentes, Ankay ni conectores, y no demuestra
que un proveedor acepte esas credenciales. No almacenar aquí `CLAUDE_API_SECRET`,
`VIRUS_TOTAL_API_KEY` ni `ACTIVE_DIRECTORY_SECRET`: esos valores no tienen un
consumidor EUS2 conectado en Terraform/runtime.

### Datos no secretos aún necesarios

Antes de activar el runtime deben incorporarse a su perfil revisado, sin secretos
ni placeholders: IDs de tenant y aplicación/permisos Graph de M365, Sophos tenant
GUID y región, Cato account ID y nueva URL de Workflow de Teams protegida en Key
Vault. El secret de cliente por sí solo no suple esos metadatos. Validar además el
bundle Wazuh, las referencias exactas de Key Vault y pruebas sintéticas de cada
proveedor antes del apply del perfil SIEM.

## Datos no secretos aún necesarios para el perfil SIEM

- Office 365: `tenant_id`, `client_id`, `api_type` y permiso Graph mínimo; el
  client secret separado anterior tiene que existir en Key Vault.
- Sophos: `sophos_tenant_id` GUID, `sophos_data_region`, client ID y secret.
- Cato: `cato_account_id` numérico y API key.
- Teams: URL de Workflows nueva, protegida como `qapaq-teams-workflow-url`.
- Wazuh: bundle ya publicado en Blob con URI/SHA inmutables, tar de credenciales
  validado y referencias por nombre.
- Red/host: CIDR de Dashboard/agentes aprobados, subnet/VM y llave pública SSH
  recuperable. No usar `0.0.0.0/0`.

Mientras falte cualquiera de los datos obligatorios, mantener
`AZURE_EUS2_SIEM_HOST_JSON`/`AZURE_EUS2_ANKAY_HOST_JSON` en `null` y runtime
apagado. Poner un secreto en Key Vault por sí solo no arranca Wazuh ni demuestra
que M365, Sophos, Cato, Teams o Ankay estén operativos.
