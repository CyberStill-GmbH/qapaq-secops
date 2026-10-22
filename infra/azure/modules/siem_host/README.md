# Azure SIEM host module

Este módulo agrega una VM privada al VNet existente para el SIEM QAPAQ. La combinación fijada por el
contrato es Wazuh Manager/Indexer/Filebeat/Dashboard **4.14.8**, OpenSearch Dashboards **2.19.6** y
`qapaq-core` con Node **24.21.0**, según `docs/10-decisiones.md` y `docs/12-backend-en-el-siem.md`.

## Controles incluidos

- VM Ubuntu 24.04 con versión exacta requerida, vTPM, Secure Boot y cifrado de host.
- Sin dirección IP pública. Sin regla SSH, Manager API ni Indexer en el NSG.
- Subnet y NSG dedicados dentro del VNet existente, con `default_outbound_access_enabled = false`.
  La UDR fuerza `0.0.0.0/0` hacia el Azure Firewall existente. Sin su IP privada y una referencia
  de policy no vacía, Terraform no puede planificar el módulo.
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
  de instalar paquetes. El bootstrap se detiene ante un formato desconocido o ante datos previos en
  los puntos que se montarían; nunca los oculta ni reforma un disco firmado.
- Identidad asignada a la VM: `AcrPull` en el ACR indicado, lectura del blob de release limitada al
  contenedor, lectura Key Vault limitada a los secretos nombrados y escritura opcional limitada al
  contenedor de evidencia indicado.
- Terraform no acepta valores de secretos. La extensión obtiene los secretos en tiempo de ejecución
  por Managed Identity; no se imprimen ni se envían en argumentos de proceso. Las claves privadas SSH
  no se admiten como input.
- El log del bootstrap queda con modo `0600`; la salida del instalador se descarta porque el asistente
  oficial de Wazuh puede mostrar credenciales generadas. Ante un fallo, el bootstrap registra solo el
  código de salida y un mensaje genérico, sin volcar la salida del instalador.
- La instalación de Wazuh es de una sola ejecución por SHA-256 de release. El bootstrap registra el
  SHA en el disco persistente después de validar servicios y `/health/ready`; una repetición de la
  misma release verifica salud sin volver a ejecutar el instalador. Si encuentra paquetes/datos
  previos sin registro o una release distinta, se detiene para proteger el estado. Las actualizaciones
  requieren un flujo explícito de migración y rollback; cambiar el bundle no equivale a upgrade seguro.
- La URL del artefacto debe ser Blob HTTPS privado, sin SAS; el SHA-256 completo lo fija CI. No se usa
  `latest`, AWS SSM ni AWS Secrets Manager. El cambio de artefacto reejecuta la extensión sin recrear
  la VM; el bootstrap falla cerrado si no concuerdan versión, integridad o servicios.

## Contrato obligatorio del artefacto

El módulo **no declara una instalación funcional** hasta que CI publique el bundle de bootstrap que
consume esta VM. Se requiere un `.tar.gz` privado en Blob con un directorio raíz único que contenga:

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
- `install.sh`, instalador idempotente que debe instalar y configurar los componentes del manifiesto,
  crear `qapaq-core-api` y `qapaq-core-worker`, leer `/etc/qapaq-core/core.env` y `/etc/qapaq-secrets`,
  y usar `/srv/qapaq-siem` para el estado durable. El bootstrap compara metadatos y versiones Debian
  instaladas, verifica Node 24.21.0, exige activos los servicios systemd de Wazuh, Filebeat y QAPAQ
  Core,
  y comprueba `/health/ready`; eso no sustituye las pruebas de paridad de API, M365 ni el flujo de alertas.

El bootstrap también rechaza llamadas shell a AWS SSM/Secrets Manager. El bundle, sus hashes y el
instalador son un contrato de CI pendiente: el repositorio actual no contiene un release bundle Azure
que instale manager, indexer, dashboard QAPAQ y core conjuntamente. Hasta producirlo y ejecutar el
preflight del módulo, no se debe habilitar runtime ni declarar el SIEM listo.

## Límites de este módulo

- El Azure Firewall y su policy son una dependencia externa obligatoria: `firewall_private_ip` crea
  la ruta forzada y `firewall_policy_reference` hace explícita la revisión requerida, pero esta
  referencia es un gate declarativo, no una lectura/verificación de la policy. Antes de integrar,
  el operador debe inspeccionar la policy por ARM y confirmar default-deny, reglas DNS necesarias,
  endpoints de artefactos/ACR y APIs autorizadas. Sin firewall operativo, egress queda bloqueado y el
  bootstrap falla de forma segura. Este módulo no crea ni cobra el firewall; la infraestructura
  compartida debe presupuestarlo aparte. Azure Firewall tiene costo fijo por hora más procesamiento
  de datos según SKU/región, así que su cotización es obligatoria antes del plan de entorno.
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
5. El Azure Firewall y su policy existente están operativos, con ruta de retorno, default-deny y
   allowlist revisada para DNS, releases, ACR y APIs; el `firewall_policy_reference` identifica la
   policy auditada. La sola cadena de referencia no prueba el contenido de la policy.
6. Los CIDR exactos de Private Endpoints y PostgreSQL están reservados y se verificó conectividad
   privada desde la subnet SIEM.
7. La reserva de IP/rutas y el modo de acceso privado están definidos fuera de este módulo; no hay DNS.
8. Plan y costo completo revisados antes de cualquier apply, incluyendo costo fijo/variable del Firewall.
