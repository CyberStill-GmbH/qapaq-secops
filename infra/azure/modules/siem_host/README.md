# Azure SIEM host module

Este módulo agrega una VM privada al VNet existente para el SIEM QAPAQ. La combinación fijada por el
contrato es Wazuh Manager/Indexer/Filebeat/Dashboard **4.14.8**, OpenSearch Dashboards **2.19.6** y
`qapaq-core` con Node **24.21.0**, según `docs/10-decisiones.md` y `docs/12-backend-en-el-siem.md`.

## Controles incluidos

- VM Ubuntu 24.04 con versión exacta requerida, vTPM, Secure Boot y cifrado de host.
- Sin dirección IP pública. Sin regla SSH, Manager API ni Indexer en el NSG.
- Subnet y NSG dedicados dentro del VNet existente, con `default_outbound_access_enabled = false`.
  Al habilitar `siem_host`, el root crea Azure Firewall Standard, policy y public IP de salida; la
  UDR fuerza `0.0.0.0/0` hacia ese firewall. No depende de un firewall preexistente.
- Salida explícita: DNS al resolver de Azure, IMDS para Managed Identity y WireServer/VM Agent en TCP/80 y TCP/32526,
  TCP/443 a la subnet exacta de Private Endpoints,
  TCP/5432 a la subnet exacta de PostgreSQL, y TCP/443 al destino `Internet` a través de la UDR.
  Reglas NSG explícitas deniegan el resto de egress antes de las reglas predeterminadas `AllowVnetOutBound`
  y `AllowInternetOutBound` de Azure. El firewall y su policy deben denegar por defecto y permitir
  solamente destinos revisados para instalación, ACR y APIs del servicio.
- `AzurePlatformLKM` solo se permite en TCP/80 y TCP/32526 para el canal WireServer requerido por
  Azure VM Agent y Custom Script Extension; no se abre TCP/1688. Microsoft indica que este canal
  especial normalmente no está sujeto a NSG/UDR, pero la regla estrecha deja explícito el requisito
  de plataforma y no permite egress general.
- HTTPS y puertos 1514/1515 solo se permiten cuando se proporcionan CIDR de origen aprobados; los
  valores vacíos los dejan cerrados. Ninguna regla acepta `0.0.0.0/0` o `::/0`.
- Disco administrado de datos con `prevent_destroy`, separado del disco de sistema y montado antes
  de instalar paquetes. Antes de inicializarlo, el bootstrap comprueba el enlace Azure LUN 0,
  dispositivo de bloques, estructura sin particiones, tamaño exacto configurado, ausencia de firmas
  con `blkid`/`wipefs` y una lectura completa en cero. Cualquier error o dato no cero detiene el
  proceso antes de `mkfs`. Los discos ext4 existentes se preservan; otros formatos no se convierten.
  La primera inicialización tarda más porque lee todo el volumen una vez. El bootstrap también se
  detiene ante datos previos en los puntos de montaje; nunca los oculta ni reforma un disco firmado.
  No medimos el throughput real del SKU/host Azure. Como ejemplo de dimensionamiento, escanear
  128 GiB a 100–500 MiB/s toma aproximadamente 22–4 minutos; 64 GiB, 11–2 minutos. Es tiempo
  adicional al resto del bootstrap y depende de la VM, SKU del disco y host.
- Identidad asignada a la VM: `AcrPull` en el ACR indicado, lectura del blob de release limitada al
  contenedor, lectura Key Vault limitada a los secretos nombrados y escritura opcional limitada al
  contenedor de evidencia indicado.
- Terraform no acepta valores de secretos. La extensión obtiene los secretos en tiempo de ejecución
  por Managed Identity; no se imprimen ni se envían en argumentos de proceso. Las claves privadas SSH
  no se admiten como input.
- El log del bootstrap queda con modo `0600`; la salida del instalador se descarta porque el asistente
  oficial de Wazuh puede mostrar credenciales generadas. Ante un fallo, el bootstrap registra solo el
  código de salida y un mensaje genérico, sin volcar la salida del instalador.
- `install.sh` instala solo los prerrequisitos faltantes del asistente oficial mediante APT. El helper
  `normalize_ubuntu_apt_sources.py` cambia a HTTPS únicamente mirrors Ubuntu aprobados y rechaza otras
  fuentes HTTP activas antes de descargar. No actualiza el sistema completo. El flujo de egress del
  Firewall permite los FQDN oficiales de Ubuntu por HTTPS.
- La instalación de Wazuh es de una sola ejecución por SHA-256 de release. El bootstrap registra el
  SHA en el disco persistente después de validar servicios y `/health/ready`; una repetición de la
  misma release verifica salud sin volver a ejecutar el instalador. Si encuentra paquetes/datos
  previos sin registro o una release distinta, se detiene para proteger el estado. Las actualizaciones
  requieren un flujo explícito de migración y rollback; cambiar el bundle no equivale a upgrade seguro.
- La URL del artefacto debe ser Blob HTTPS privado, sin SAS; el SHA-256 completo lo fija CI. No se usa
  `latest`, AWS SSM ni AWS Secrets Manager. El cambio de artefacto reejecuta la extensión sin recrear
  la VM; el bootstrap falla cerrado si no concuerdan versión, integridad o servicios.

## Contrato obligatorio del artefacto

El flujo `.github/workflows/azure-siem-release-bundle.yml` ensambla el bundle offline a partir de
artifacts CI verificados (Wazuh oficial, el `.deb` QAPAQ y core). El publisher OIDC ya lo promocionó
al contenedor Blob privado; la URI y el SHA-256 están en
[`docs/cloud/azure/siem-release-bundle.md`](../../../../docs/cloud/azure/siem-release-bundle.md).
La publicación no instala el release. El objeto `siem_host` debe fijar esa URI/SHA junto con red,
clave pública y referencias Key Vault revisadas.

La adaptación Azure elimina la dependencia de AWS para bootstrap e instalación: usa Managed Identity
para descargar el Blob y leer Key Vault, y `apply-core-azure.sh` para activar el core ya compilado.
No ejecuta AWS CLI, SSM ni Secrets Manager. El instalador AWS permanece separado; el adaptador Azure
de Office 365 y sus pruebas de lectura siguen pendientes.

El `.tar.gz` privado debe tener un directorio raíz único que contenga:

- `manifest.json`, versión 1, con `components` que fije `wazuhManager`, `wazuhIndexer`,
  `wazuhFilebeat` y `wazuhDashboard` a `4.14.8`, `openSearchDashboards` a `2.19.6` y
  `qapaqCoreNode` a `24.21.0`; `qapaqDashboardPackage` debe ser `4.14.8-1qapaq1` y
  `qapaqCoreSourceCommit` debe fijar el commit corto de 12 hex.
- `files`, un mapa de ruta relativa a SHA-256 minúsculo de **cada** script y paquete consumido,
  incluido `install.sh`.
- `debianPackages`, con la versión exacta instalada de `wazuh-manager`, `wazuh-indexer`, `filebeat`
  y `wazuh-dashboard` (Filebeat se fija a `7.10.2-2`); y `artifacts`, con las rutas `managerDeb`,
  `indexerDeb`, `filebeatDeb`,
  `qapaqDashboardDeb` y `qapaqCoreArchive` incluidas en el mapa de hashes.
- `install.sh`, instalador para host limpio que invoca el asistente oficial Wazuh 4.14.8 en modo
  offline, valida las versiones Debian y ejecuta el instalador QAPAQ core, que ya aporta activación
  atómica y rollback de sus releases. El bootstrap compara metadatos y versiones Debian instaladas,
  verifica Node 24.21.0, exige activos Manager, Indexer, Filebeat, Dashboard y QAPAQ Core y comprueba
  `/health/ready`. El instalador no reejecuta ni actualiza una instalación previa.
- `official-wazuh/wazuh-offline.tar.gz`, el árbol de paquetes/documentos en el formato esperado por
  el asistente oficial, `official-wazuh/wazuh-install.sh` construido desde el commit oficial fijado y
  su licencia GPL-2.0.

El bootstrap requiere una referencia Key Vault nombrada `wazuh-install-files.tar.b64` en
`wazuh_secret_names`. El secreto almacena en una sola línea base64 un `wazuh-install-files.tar`
generado por el asistente oficial que contiene `wazuh-passwords.txt` y los certificados Wazuh. El
installer valida su estructura y límites, lo decodifica en `/run` (tmpfs), nunca imprime valores, y
mantiene la copia instalada bajo permisos `0600` en disco durable para que los adaptadores existentes
puedan usar el material. No se lee el valor del secreto durante plan/build. El módulo no crea esa
referencia ni inventa credenciales; si falta o no cumple el formato, el bootstrap falla antes de
instalar paquetes.

`core_secret_names` y `core_environment` también deben estar completos para el perfil y modos elegidos
por el sistema (Entra, DB, Key Vault/provider, persistencia y conexiones requeridas). El bundle no
adivina esa configuración ni cambia los modos del API. El servicio Core puede hacer rollback a un
release previo si su activación falla; una instalación inicial fallida del asistente Wazuh no borra
paquetes/datos parcialmente creados. Se deja la VM sin marcar como instalada y requiere diagnóstico
operador antes de un nuevo intento para preservar el fail-closed.

El candidato no instala ni declara listos el overlay de acceso QAPAQ/roles, el edge TLS y rutas DNS,
la integración M365, Ankay/Shuffle, Teams, Sophos o Cato. Esos contratos necesitan configuración
adicional y pruebas de extremo a extremo antes de abrir ingreso o marcar el SOC operativo.

El bootstrap también rechaza llamadas shell a AWS SSM/Secrets Manager. La CI local de este candidato
valida hashes, paquete, estructura offline y contrato con el bootstrap. Aún hace falta ejecutar el
workflow con tres run IDs CI exitosos del mismo SHA, probar el artifact resultante en VM Ubuntu 24.04
aislada, promoverlo a Blob, comprobar las referencias Key Vault y completar las integraciones listadas
arriba. Hasta cerrar esas comprobaciones, no se debe habilitar runtime ni declarar el SIEM listo.

## Límites de este módulo

- El root crea Azure Firewall Standard y una policy con threat-intelligence deny, proxy DNS y
  allowlist HTTPS explícita para Ubuntu, Entra, Graph y VirusTotal. El firewall tiene costo fijo por
  hora y procesamiento; revisar el costo del plan antes del apply. Sophos/Cato requieren endpoints
  confirmados y un cambio revisado a la allowlist antes de conectar esos proveedores.
- Los dos CIDR de egress privado deben corresponder a las subnets dedicadas reales de Private
  Endpoints (Blob/Key Vault) y PostgreSQL. No uses el CIDR completo de la VNet como sustituto. No hay
  fallback a Internet directo cuando faltan o no responden esos servicios.

- No copia ni elimina datos de AWS, no migra secretos, no crea DNS ni un certificado TLS.
- HTTPS queda denegado por defecto. Al indicar `dashboard_ingress_cidrs`, el operador debe haber
  verificado que el bundle configura el edge QAPAQ con TLS y `auth_request`; el módulo no puede
  certificar esa condición desde Terraform.
- Los agentes solo reciben conectividad cuando se especifican redes privadas aprobadas; no se abre
  enrolamiento a Internet.
- No configura snapshots del Indexer en Azure Blob. El diseño vigente describe snapshots S3 y debe
  resolver compatibilidad/retención Azure antes de considerar cubierta la evidencia duradera.
- No administra API Gateway/KrakenD, Ankay/Shuffle, Sophos, Cato, Teams, reglas M365 ni roles de
  usuarios QAPAQ. El bundle de instalación tampoco sustituye las pruebas de esos contratos.
- El disco persistente de datos está protegido contra `terraform destroy`, pero no reemplaza
  backup/restauración comprobados. La VM conserva `prevent_destroy`; si se reconstruye deliberadamente,
  hay que volver a conectar y montar el disco de datos antes de reinstalar. El disco de sistema no es
  la copia durable de evidencia ni de secretos (estos permanecen en Key Vault).

## Preflight de módulo

El módulo está conectado a `infra/azure/main.tf` detrás del objeto opcional `siem_host` y permanece
apagado cuando ese objeto es `null`. La integración debe inicializar Terraform con AzureRM 4.x y
ejecutar `terraform validate`. Antes de completar el objeto, habilitar el ingress o aplicar, también
debe verificar:

1. El bundle existe en Blob privado y su digest coincide con el manifiesto de release de CI.
2. Los roles Key Vault apuntan solo a secretos existentes y los nombres de sus mapas se corresponden.
3. CIDR de Dashboard y agentes son privados/aprobados y no incluyen `0.0.0.0/0`.
4. SKU de VM, disco y disponibilidad de Secure Boot/encryption-at-host están confirmados en la región.
5. El plan crea Firewall Standard, policy, IP pública de salida, subnet dedicada y UDR; revisar
   costo, fuentes y destinos permitidos antes del apply.
6. Los CIDR exactos de Private Endpoints y PostgreSQL están reservados y se verificó conectividad
   privada desde la subnet SIEM.
7. La reserva de IP/rutas y el modo de acceso privado están definidos fuera de este módulo; no hay DNS.
8. Plan y costo completo revisados antes de cualquier apply, incluyendo costo fijo/variable del Firewall.
