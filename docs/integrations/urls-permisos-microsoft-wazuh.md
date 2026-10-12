# URL y permisos para el login SOC y la integración con Wazuh

Este documento separa tres accesos: el inicio de sesión de las personas en QAPAQ
SOC, la recolección de Microsoft 365 por Wazuh y la lectura/operación de alertas
de Wazuh desde QAPAQ.

## 1. Inicio de sesión SOC con Microsoft Entra ID

### URL de QAPAQ SOC

Configurar en Entra la URL pública HTTPS donde esté desplegado el frontend SOC.
El repositorio no confirma un hostname SOC productivo. `https://soc.qapaq.pe`
aparece en fixtures de pruebas y debe tratarse como ejemplo hasta que
Infraestructura confirme que ese sitio existe y resuelve públicamente.

Registrar la URL de retorno exacta que atiende la aplicación:

```text
https://<hostname-soc>/api/auth/callback
```

La URI debe coincidir exactamente en el registro de aplicación de Entra y en
`QAPAQ_ENTRA_REDIRECT_URI` y `QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS`. No usar
comodines ni permitir callbacks de otros dominios.

### Endpoints de Entra

Reemplazar `{tenant-id}` por el GUID del tenant de la organización. QAPAQ usa
OpenID Connect v2:

| Uso | URL |
| --- | --- |
| Inicio de autorización | `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/authorize` |
| Intercambio de código por tokens | `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token` |
| Issuer que debe validarse | `https://login.microsoftonline.com/{tenant-id}/v2.0` |
| Claves públicas para validar tokens (JWKS) | `https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys` |

El flujo implementado es Authorization Code con PKCE S256, `state` y `nonce`.
Solicita los scopes OIDC `openid`, `profile` y `offline_access`.

### Permisos para el login y acceso a funciones SOC

Para autenticación básica no se requieren permisos de Microsoft Graph. En el
registro de aplicación se configura OIDC y la URI de retorno; no se debe agregar
`User.Read` u otros permisos Graph salvo que una función adicional del producto
los requiera expresamente.

El administrador debe asignar a los usuarios el rol de aplicación QAPAQ y los
scopes internos apropiados. Estos valores son autorización de QAPAQ, no permisos
de Microsoft Graph. Las capacidades efectivas son la intersección del rol y los
scopes:

| Necesidad del usuario | Rol QAPAQ | Scope QAPAQ | Alcance |
| --- | --- | --- | --- |
| Analista SOC, lectura y triage | `qapaq.soc.analyst` | `soc.read` y, si hará triage/asignaciones, `soc.write` | Lee eventos, alertas e incidentes; puede triar/asignar alertas y actualizar incidentes. No puede cerrar incidentes ni leer eventos crudos. |
| Líder SOC | `qapaq.soc.lead` | `soc.read` + `soc.write`; agregar `audit.read` solo si debe revisar auditoría | Incluye las funciones de SOC del rol, cierre de incidentes y lectura de eventos crudos. |
| Auditor | `qapaq.auditor` | `audit.read` | Lectura/verificación de auditoría e incidentes, según las capacidades del rol. |
| Administrador de plataforma | `qapaq.platform.admin` | `audit.read` solo si se requiere | Administración de secretos y capacidades de auditoría definidas para ese rol; no asignar a analistas de rutina. |

No otorgar `soc.write` a una persona que solo necesita consultar. El código
aplica tanto el rol como el scope: un scope por sí solo no concede capacidades
que el rol no tenga.

### Datos que se configuran en QAPAQ

- `QAPAQ_ENTRA_TENANT_ID`: GUID del tenant.
- `QAPAQ_ENTRA_CLIENT_ID`: ID de aplicación (cliente) de QAPAQ SOC.
- `QAPAQ_ENTRA_REDIRECT_URI`: callback HTTPS exacto.
- `QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS`: lista que incluye únicamente callbacks aprobados.
- `QAPAQ_ENTRA_CLIENT_SECRET_REF`: referencia a secreto en AWS Secrets Manager; nunca pegar el secreto en el repositorio, tickets o comandos visibles.

El secreto de esta aplicación es para el login SOC. Es distinto de la credencial
que Wazuh usa para leer Microsoft 365 y de la cuenta de lectura del Indexer.

## 2. Microsoft 365 → Wazuh

Wazuh usa la API Office 365 Management Activity para obtener los registros de
actividad del tenant.

| Elemento | Valor |
| --- | --- |
| API de actividad | `https://manage.office.com` |
| Endpoint de ejemplo | `GET https://manage.office.com/api/v1.0/{tenant-id}/activity/feed/subscriptions/list` |
| Emisión de token | `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token` |
| Flujo | OAuth 2.0 `client_credentials`; audiencia/recurso Office 365 Management APIs |
| Permiso mínimo requerido | **Application permission** `ActivityFeed.Read` en **Office 365 Management APIs** |
| Consentimiento | **Grant admin consent** por un administrador del tenant |
| Permiso opcional | `ActivityFeed.ReadDlp`, solo si se habilita la ingesta de eventos DLP |

La aplicación registrada para esta integración necesita su propio `tenant ID`,
`client ID` y secreto o certificado, almacenado en el gestor de secretos. Estos
datos no son los del login de QAPAQ SOC. Autorizar salida HTTPS (TCP/443) desde
Wazuh a `login.microsoftonline.com` y `manage.office.com`. El permiso se valida
consultando la API de actividad; recibir un token no demuestra por sí solo que
se haya otorgado el consentimiento.

## 3. QAPAQ → Wazuh: leer alertas

QAPAQ consulta las alertas a través del gateway KrakenD. No configurar acceso
directo de QAPAQ al Indexer ni al Dashboard.

| Propósito | Ruta en el gateway | Método | Acceso |
| --- | --- | --- | --- |
| Estado acotado del cluster | `/wazuh/_cluster/health` | `GET` | Health check |
| Buscar alertas | `/wazuh/_search` | `POST` | Búsquedas de solo lectura en `wazuh-alerts-*` |

Configurar `QAPAQ_WAZUH_GATEWAY_BASE_URL` con la base HTTPS del KrakenD del
ambiente, sin sufijo de ruta, query ni credenciales. La URL concreta del
gateway productivo debe confirmarse en el despliegue; el output
`public_api_url` identifica la entrada pública de QAPAQ y no confirma por sí
mismo que KrakenD tenga identidad y rutas Wazuh productivas habilitadas.

Permisos que debe recibir la identidad de servicio de QAPAQ:

- Invocar únicamente el health check y la búsqueda de alertas publicados por
  KrakenD, con bearer token válido para issuer, audience y JWKS configurados.
- En el Wazuh Indexer, usar una cuenta/rol de solo lectura limitado a
  `wazuh-alerts-*` y a las operaciones necesarias para consultar/contar
  documentos y verificar salud.
- No conceder escritura, creación/eliminación de índices, cambios de mappings,
  administración del cluster ni acceso de administrador.
- Mantener la credencial Basic del backend en el proveedor de secretos de
  runtime (`WAZUH_BASIC_AUTH_B64`) y validar TLS del Indexer con CA confiable.

El contrato del gateway define las rutas anteriores y la autenticación hacia
el Indexer. En el estado del código revisado, el cableado del token OAuth del
servicio y su renovación, la CA productiva y la identidad de lectura aún deben
materializarse y verificarse antes de habilitar tráfico productivo. Los nombres
de secretos en AWS no garantizan que tengan valores cargados.

## 4. Permisos para que un operador trabaje en Wazuh

La identidad de QAPAQ descrita arriba solo lee alertas. Para que una persona
configure integraciones, administre agentes, reglas o políticas de Wazuh, usar
una cuenta individual del Dashboard con el rol de Wazuh que corresponda a las
tareas autorizadas. Separar los permisos de lectura de alertas de los permisos
administrativos; no reutilizar la cuenta de servicio de QAPAQ ni compartir la
contraseña del administrador.

La modificación de configuración del Manager y de las integraciones requiere
permisos de administración en Wazuh Manager/API según la acción concreta. El
repositorio no define un rol de operador de Wazuh ni enumera sus permisos API,
así que el administrador de Wazuh debe mapearlos a los roles/policies de la
versión instalada. No entregar permisos de escritura del Indexer a QAPAQ para
que el SOC pueda triar o trabajar incidentes: esas acciones pertenecen a la
API de QAPAQ y sus scopes `soc.write`.

## 5. URLs del Dashboard Wazuh

El Dashboard es una interfaz para personas y no es la URL de API que usa el
conector QAPAQ. En AWS, copiar el output de Terraform:

```powershell
terraform output -raw wazuh_dashboard_url
```

La salida tiene forma `https://<IP-elastica>/` en el despliegue sin dominio.
El URL solo es públicamente accesible si la IP es enrutable desde Internet, el
bootstrap completó y el certificado presentado es confiable. Obtener la
credencial desde el secreto cuyo ARN devuelve:

```powershell
terraform output -raw wazuh_dashboard_admin_secret_arn
```

En la instalación local Docker, el URL es `https://localhost`; desde otro
equipo, usar el hostname del host Docker solo cuando la red lo permita. No
exponer directamente los puertos del Indexer (`9200`) ni de la API Manager
(`55000`) a Internet.

## Referencias del proyecto

- [Contrato del adapter Wazuh (C-10)](../project-management/c-10/README.md)
- [Diseño de KrakenD (C-28)](../architecture/c-28-krakend-system-design.md)
- [Motor Wazuh y OpenSearch](../architecture/wazuh-engine-and-opensearch.md)
- [Variables y outputs de Terraform AWS](../../infra/aws/outputs.tf)
- [Wazuh: Monitoring Office 365 audit logs](https://documentation.wazuh.com/current/cloud-security/office365/monitoring-office365-activity.html)
