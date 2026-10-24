# QAPAQ SecOps en Azure: auditoría de disponibilidad

**Fecha:** 2026-10-24  
**Alcance:** estado de Terraform, configuración de runtime, Key Vault, integraciones y gates de publicación.  
**Resultado:** Azure todavía no ejecuta el SOC QAPAQ. Este documento registra la evidencia observada y los gates que faltan; no autoriza un apply ni un cambio DNS.

## Evidencia de estado actual

| Comprobación | Evidencia | Resultado |
| --- | --- | --- |
| Terraform remoto | [Plan protegido #40061611323](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40061611323), `main` en `95add81bbee4bb0d12cec99d2b45fa9c7e0d70ce` | Validación, plan y resumen correctos: `0` recursos con cambios; no se ejecutó apply. |
| Perfil de runtime | El workflow validó los valores opt-in sin imprimirlos; el resumen Terraform resultó sin diferencias. En `main`, `AZURE_ENABLE_RUNTIME` usa `false` por defecto, y `AZURE_SIEM_HOST_JSON`/`AZURE_ANKAY_HOST_JSON` usan `null` por defecto. | No hay VM SIEM ni host Ankay habilitados por la configuración del plan. Un plan vacío no demuestra salud de servicios. |
| Key Vault | En Azure Portal, la sesión `cguevara@qapaq.pe` confirmó MFA. IAM en `kv-qapaqsecopsd-66f8c73b` muestra `Owner` heredado desde la suscripción y ninguna asignación elegible PIM. El vault tiene acceso público deshabilitado, RBAC como modelo de permisos, soft-delete y purge protection habilitados. Existe `pe-qapaqsecopsdemo-vault` aprobado en `vnet-qapaqsecopsdemo/snet-private-endpoints`. La lista de secretos muestra “Public network access is disabled and request is not from a trusted service nor via an approved private link” y “You are unauthorized to view these contents.” | MFA y permisos de control plane están confirmados, pero no se logró listar metadatos: `Owner` no concede por sí mismo acceso de datos a los secretos y esta sesión no llega por la ruta privada. No se abrió ni copió ningún valor secreto. Para inventario de solo metadatos, Microsoft documenta `Key Vault Reader` (ID `21090545-7ca7-4776-b22c-e363652d74d2`); no usar `Key Vault Secrets User`, que permite leer valores. La conectividad privada sigue siendo requisito independiente del rol. |
| Terraform local | `terraform fmt -check -recursive`, `terraform validate` y pruebas de bootstrap | Correctos; validan el código, no el estado operativo de Azure. |
| Ingesta Sophos/Cato | [PR #139](https://github.com/CyberStill-GmbH/qapaq-secops/pull/139), merge `a56263dbd223827c600f7e277f307995bb45d98e` | El código está en `main`. Añade collectors optativos con cursores persistentes y escritura idempotente. No están habilitados contra un tenant: faltan configuración runtime, referencias de secretos, permisos y aceptación de las APIs. |
| CI de `main` | [Run #40063917040](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40063917040), commit `9062223847aa74b8b196d49be2aa00e88cecfc46` | Los 14 jobs finalizaron correctamente. La CI valida el código; no prueba despliegue ni conectividad de Azure. |

## Servicios e integraciones pendientes

- **Wazuh QAPAQ:** el bundle de release puede empaquetar Manager, Indexer, Dashboard y `qapaq-core`, pero el host permanece deshabilitado. No hay evidencia de instalación, TLS, health checks ni ingestión Azure en ejecución.
- **M365/Entra:** hacen falta configuración de Graph en Azure y una lectura real controlada. Las reglas configuradas en código no demuestran eventos indexados.
- **Sophos/Cato:** el PR #139 agrega collectors con hashes de origen fijados, cursores persistentes y timers; ambos quedan apagados hasta configurar referencias Key Vault, tenant/account, permisos y egress. CI no equivale a aceptación de la API del cliente.
- **Teams:** el código de integración no está instalado en el Manager Azure ni se validó contra un webhook real.
- **Ankay/Shuffle:** el módulo de host prepara una VM/disco y reglas de red; no instala Docker ni levanta Compose. Aún faltan imágenes fijadas para backend, Orborus, worker, `shuffle-security` y OpenSearch, ruta protegida validada, playbooks, backup/restore y prueba end-to-end.
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

## Revisión adicional del 24 de octubre

- Tras renovar MFA, el workflow de solo metadatos [#40075969633](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40075969633) autenticó por OIDC y completó la consulta ARM del Key Vault `kv-qapaqsecopsd-66f8c73b`. El resumen de GitHub devolvió **cero nombres de secretos**. La consulta no usó el plano de datos y no leyó valores. Este resultado permite decir que la lista ARM no devolvió objetos de secretos; no demuestra que las credenciales necesarias estén cargadas ni permite leerlas.
- La inspección de nombres de configuración encontró el environment `azure-demo` sin variables ni secretos. En el repositorio sí existen nombres de credenciales para OIDC de Azure, PostgreSQL y Entra, pero no existen `AZURE_ENABLE_RUNTIME`, `AZURE_SIEM_HOST_JSON`, `AZURE_ANKAY_HOST_JSON`, `AZURE_CONTAINER_IMAGES_JSON` ni `AZURE_KEY_VAULT_SECRET_IDS_JSON`. Tampoco hay nombres de secretos de Sophos, Cato, Teams Workflow o VirusTotal. No se consultaron valores secretos.
- El plan protegido anterior a esta inspección, [#40075268409](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40075268409), declaró que la infraestructura coincide con el state actual y no ejecutó apply. Como los inputs de runtime están ausentes y sus defaults son `false`/`null`/`{}`, ese plan **no crea ni inicia** QAPAQ SecOps, Wazuh ni Ankay.
- El despliegue sigue bloqueado por perfiles de host revisables, clave SSH pública recuperable, CIDR de ingreso aprobados, digests de imágenes Ankay, referencias existentes de Key Vault y configuración no secreta para M365/Sophos/Cato. No se deben inventar estos datos ni abrir el acceso de red del vault para sortear la falta de referencias.
- Tras el merge de [PR #148](https://github.com/CyberStill-GmbH/qapaq-secops/pull/148), el siguiente bundle de release empacará el catálogo de 30 detecciones, reglas QAPAQ de endpoint/proveedor e instalador local transaccional; el candidato Blob publicado el 23 de octubre sigue sin esos archivos y no se ha desplegado un bundle nuevo. Los workflows de reglas pasaron en `main`, pero esto no acredita eventos reales ni activa conectores Sophos/Cato.

