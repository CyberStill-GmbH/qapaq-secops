# QAPAQ SecOps en Azure: auditoría de disponibilidad

**Fecha:** 2026-10-24  
**Alcance:** estado de Terraform, configuración de runtime, Key Vault, integraciones y gates de publicación.  
**Resultado:** Azure todavía no ejecuta el SOC QAPAQ. Este documento registra la evidencia observada y los gates que faltan; no autoriza un apply ni un cambio DNS.

## Evidencia de estado actual

| Comprobación | Evidencia | Resultado |
| --- | --- | --- |
| Terraform remoto | [Plan protegido #40067627940](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40067627940), `main` en `eba3da2c4e6936a6bdf2f88c532153a944eab234` | Plan actual: “No changes. Your infrastructure matches the configuration.” `apply=false`; el job de apply fue omitido. |
| Perfil de runtime | El workflow validó los valores opt-in sin imprimirlos; el resumen Terraform resultó sin diferencias. En `main`, `AZURE_ENABLE_RUNTIME` usa `false` por defecto, y `AZURE_SIEM_HOST_JSON`/`AZURE_ANKAY_HOST_JSON` usan `null` por defecto. | No hay VM SIEM ni host Ankay habilitados por la configuración del plan. Un plan vacío no demuestra salud de servicios. |
| Inventario de la suscripción | Cloud Shell, `az resource list --subscription aaf787f8-5964-4470-9eb6-89d15eacda61`: `length(@)=24`. Hay ACR, PostgreSQL, Key Vault, 3 identidades administradas, 3 NICs, Network Watcher, 3 zonas DNS privadas, 3 virtual links, 3 private endpoints, VNet, Log Analytics y 3 Storage Accounts. | La fundación Azure no está vacía; es infraestructura de estado/artefactos/datos. El inventario no contiene VM, Azure Firewall ni Load Balancer: el runtime SOC no está levantado. |
| Inputs, runner y gate del workflow | Inspección de nombres solamente: no existen `AZURE_ENABLE_RUNTIME`, `AZURE_SIEM_HOST_JSON`, `AZURE_ANKAY_HOST_JSON`, `AZURE_CONTAINER_IMAGES_JSON` ni `AZURE_KEY_VAULT_SECRET_IDS_JSON` como variables del repositorio o del entorno `azure-demo`; la API de GitHub reporta `0` self-hosted runners. Tampoco aparecen nombres de secretos de Sophos, Cato o Teams en el repositorio. No se consultaron valores. La API de GitHub muestra que `azure-demo` tiene únicamente una política de rama, sin revisores obligatorios; `terraform-azure.yml` usa el environment tanto para plan como apply y el bootstrap Azure vincula la federación OIDC a ese subject. El dispatch de #40061611323 dejó `apply=false`; por eso el job apply fue omitido tras producir un plan sin cambios. | No existe un bloqueo de aprobación humana en el environment ni una excepción de runner AWS que corregir. No se puede formar un plan SOC habilitado sin el perfil `AZURE_SIEM_HOST_JSON`, y tampoco hay un runner con ruta privada a Key Vault para inventariar metadatos. Quitar el environment no arreglaría nada: rompería el subject OIDC Azure. El guard de SOC rechaza el apply si el perfil SIEM no está definido. Los valores de Key Vault no pudieron inventariarse desde esta sesión. |
| Key Vault | En Azure Portal, la sesión `cguevara@qapaq.pe` confirma MFA. IAM en `kv-qapaqsecopsd-66f8c73b` muestra `Owner` heredado desde la suscripción y ninguna asignación elegible PIM. El vault tiene acceso público deshabilitado, RBAC como modelo de permisos, soft-delete y purge protection habilitados. Existe `pe-qapaqsecopsdemo-vault` aprobado en `vnet-qapaqsecopsdemo/snet-private-endpoints`. La lista del portal muestra bloqueo de red y “You are unauthorized to view these contents.” En Cloud Shell, `az keyvault secret list` con una proyección limitada a nombre/estado/expiración devolvió `ForbiddenByConnection`; Azure indicó que el cliente no usa un private link aprobado, el bypass no permite `AzureServices` y `PublicNetworkAccess` está `Disabled`. | No se obtuvo ningún nombre ni valor de secreto. La conectividad privada es el primer bloqueo confirmado; el acceso de datos RBAC debe verificarse desde la ruta aprobada después. `Owner` de control plane no implica permiso de lectura de datos. No cambiar el firewall ni abrir el vault para obtener este inventario. |
| Terraform local | `terraform fmt -check -recursive`, `terraform validate` y pruebas de bootstrap | Correctos; validan el código, no el estado operativo de Azure. |
| Ingesta Sophos/Cato | [PR #139](https://github.com/CyberStill-GmbH/qapaq-secops/pull/139), merge `a56263dbd223827c600f7e277f307995bb45d98e` | El código está en `main`. Añade collectors optativos con cursores persistentes y escritura idempotente. No están habilitados contra un tenant: faltan configuración runtime, referencias de secretos, permisos y aceptación de las APIs. |
| CI de `main` | [Run #40065066444](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40065066444), commit `eba3da2c4e6936a6bdf2f88c532153a944eab234` | Los 14 jobs finalizaron correctamente. Dos escaneos fallaron primero porque el mirror de Trivy devolvió `404`; pasaron al repetirlos. La CI valida el código; no prueba despliegue ni conectividad de Azure. |

## Servicios e integraciones pendientes

- **Wazuh QAPAQ:** los builds de Manager, Indexer, Filebeat, Dashboard y `qapaq-core` pasaron en [#40067400024](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40067400024), [#40067401957](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40067401957) y [#40067403783](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40067403783), todos fijados al SHA `eba3da2c4e6936a6bdf2f88c532153a944eab234`. El Dashboard temporal (196,337,668 bytes; retención de un día) está fijado a Wazuh 4.14.8/OSD 2.19.6 e incluye `qapaq_ops`; no se publicó a ACR. El primer ensamblado falló porque los tests de Sophos/Cato asumían un grupo Wazuh y privilegios `chown` disponibles en el runner. Los PR [#143](https://github.com/CyberStill-GmbH/qapaq-secops/pull/143) y [#145](https://github.com/CyberStill-GmbH/qapaq-secops/pull/145) simularon esas dependencias de sistema solo en el test; sus 28 checks pasaron y quedaron en `main`. El PR [#144](https://github.com/CyberStill-GmbH/qapaq-secops/pull/144) permite reutilizar artifacts cuando solo cambian tests no empaquetados; sus 28 checks también pasaron. El candidato reintentado [#40072778035](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40072778035) validó fuentes y pruebas y está descargando los paquetes binarios. Aún no está ensamblado ni publicado; el host sigue deshabilitado y no hay evidencia de instalación, TLS, health checks o ingestión real en Azure.
- **M365/Entra:** hacen falta configuración de Graph en Azure y una lectura real controlada. Las reglas configuradas en código no demuestran eventos indexados.
- **Sophos/Cato:** el PR #139 agrega collectors con hashes de origen fijados, cursores persistentes y timers; ambos quedan apagados hasta configurar referencias Key Vault, tenant/account, permisos y egress. CI no equivale a aceptación de la API del cliente.
- **Teams:** el código de integración no está instalado en el Manager Azure ni se validó contra un webhook real.
- **Ankay/Shuffle:** el módulo de host prepara una VM/disco y reglas de red; no instala Docker ni levanta Compose. La [PR #101](https://github.com/CyberStill-GmbH/qapaq-secops/pull/101) continúa en borrador, `mergeable=false`/`DIRTY` contra `main` (`head b2d6058`, `base 670169a`), y sin publicar imágenes ni habilitar Terraform/runtime. El job `Build and verify Ankay without cloud credentials` de #40051751449 pasó, pero no publica. El lock de componentes marca Orborus como `NOASSERTION` y `shuffle-security` como `NOASSERTION`, bloqueados por licencia; `shuffle-security` además no tiene compatibilidad acreditada con Shuffle v2.3.0. No distribuir esas imágenes hasta resolver licencia y compatibilidad. Siguen faltando la ruta protegida validada, playbooks, backup/restore y prueba end-to-end.
- **Administración:** el plugin `qapaq_ops` incluye la vista de usuarios, sesiones y solicitudes de rol; el backend en `main` persiste grants/solicitudes en PostgreSQL y audita las decisiones. La aprobación de `qapaq.platform.admin` falla cerrada con `STEP_UP_REQUIRED`: el runtime no acredita una reautenticación reciente. El flujo de roles está cubierto por el CI de [PR #88](https://github.com/CyberStill-GmbH/qapaq-secops/pull/88), pero no se ha verificado en Azure un inicio de sesión ni una acción administrativa contra el servicio desplegado porque no hay perfil runtime habilitado. No se deben elevar roles ni relajar autenticación como sustituto de una prueba controlada.
- **DNS:** no se modificó. `app.jappi.net.pe` no tiene un endpoint Azure probado al cual apuntar.

## Costo y decisión de despliegue

El último cálculo de referencia guardado, [`cost-feasibility-2026-10-20.md`](cost-feasibility-2026-10-20.md), estima alrededor de **USD 1,155.01/mes** para el piso que incluye Wazuh, PostgreSQL y Azure Firewall Standard, antes de Ankay, almacenamiento adicional, tráfico y servicios de observabilidad. Es una estimación de lista, no una cotización del contrato. La arquitectura documenta que el umbral de USD 200 genera avisos y no apaga ni destruye recursos automáticamente.

Antes de desplegar, volver a calcular con la región, SKU, discos, retención y duración exactos en la [calculadora de Azure](https://azure.microsoft.com/pricing/calculator/), y contrastar las tarifas oficiales de [Azure Firewall](https://azure.microsoft.com/pricing/details/azure-firewall/), [Linux Virtual Machines](https://azure.microsoft.com/pricing/details/virtual-machines/linux/) y [PostgreSQL Flexible Server](https://azure.microsoft.com/pricing/details/postgresql/flexible-server/). Las páginas de tarifa pública no sustituyen la cotización de la suscripción ni incluyen todas las variables de consumo.

El plan #40061611323 representa la configuración deshabilitada actual, no el SOC objetivo. No se debe usar como evidencia de que el despliegue cuesta cero ni como plan de lanzamiento.

## Gates para continuar

1. Habilitar una sesión/runner que alcance el private endpoint y, si se requiere inventario humano, asignar `Key Vault Reader` en el ámbito del vault a la identidad autorizada. No conceder acceso a valores secretos: el bootstrap debe seguir usando su identidad administrada y referencias versionadas.
2. Definir el perfil de SIEM y Ankay con recursos, IPs, SKU, imágenes por digest, referencias de secretos y egress mínimo; no habilitar servicios opcionales implícitamente.
3. Completar un plan Terraform protegido para ese perfil y revisar cada alta/cambio/destrucción, coste para la duración de demo y protección de datos antes de apply.
4. Publicar/revisar los artefactos y completar las pruebas de despliegue y runtime: Wazuh, Graph, Sophos, Cato, Teams, Ankay, roles, alertas y recuperación.
5. Cambiar DNS solo después de HTTPS, autenticación, health checks, ingestión y rollback comprobados.

## Contrato mínimo del perfil SIEM

El validador de `main` exige que `AZURE_SIEM_HOST_JSON` sea un objeto completo con:
`address_prefix`, `vm_size`, `admin_ssh_public_key`, `ubuntu_image_version`,
`data_disk_size_gb`, `dashboard_ingress_cidrs`, `agent_ingress_cidrs`,
`core_secret_names`, `wazuh_secret_names`, `core_environment`, `office365`,
`bootstrap_bundle_blob_url` y `bootstrap_bundle_sha256`. El SKU permitido por el
módulo es `Standard_F4s_v2`; Ubuntu debe fijarse a una versión numérica `24.04.x`.
Los CIDR deben elegirse para la red de acceso/agents y revisarse antes del apply.

`office365` requiere `tenant_id`, `client_id`, `api_type` (`commercial`, `gcc` o
`gcc-high`) y `enable_dlp`; `wazuh_secret_names` debe referenciar el secreto
`office365-client-secret`. `core_secret_names` debe mapear
`QAPAQ_ENTRA_CLIENT_SECRET` y `QAPAQ_TEAMS_WORKFLOW_URL` a nombres existentes en
Key Vault, y `core_environment.QAPAQ_ENTRA_CLIENT_SECRET_REF` debe apuntar al
mismo nombre (`secret://keyvault/<nombre>`). Los valores no van en este JSON.

La ingesta opcional acepta solo `sophos_enabled`, `sophos_tenant_id`,
`sophos_data_region`, `cato_enabled` y `cato_account_id`; habilitar Sophos requiere
sus referencias `sophos-client-id`/`sophos-client-secret`, y Cato requiere
`cato-api-key`. El bundle se fija con HTTPS Blob URL sin SAS y SHA-256 completo.
`AZURE_KEY_VAULT_SECRET_IDS_JSON`, si lo consume el runtime, debe llevar URIs
versionadas de secretos, no valores. La fuente de verdad para este contrato es
`infra/azure/variables.tf` y `scripts/ci/validate-azure-deployment-inputs.mjs`;
los nombres reales y versiones del vault siguen sin poder verificarse desde la
ruta actual.

