# URLs y permisos para la ingesta Microsoft 365 → Wazuh → QAPAQ

Este documento resume los accesos requeridos para recolectar actividad de
Microsoft 365 en Wazuh y permitir que QAPAQ lea las alertas. Son dos permisos
distintos y se conceden en sistemas diferentes.

## 1. Microsoft 365 → Wazuh

Wazuh usa la integración Office 365 y la API de Office 365 Management Activity
para recuperar actividad del tenant.

| Elemento | Valor |
| --- | --- |
| Host de la API de actividad | `https://manage.office.com` |
| Endpoint verificado por el proyecto | `GET https://manage.office.com/api/v1.0/{tenant-id}/activity/feed/subscriptions/list` |
| Autenticación | OAuth 2.0 `client_credentials` con Microsoft Entra ID; token para Office 365 Management APIs (`.default`) |
| Permiso requerido | **Application permission** `ActivityFeed.Read` en **Office 365 Management APIs** |
| Consentimiento | **Admin consent** otorgado por un administrador del tenant |

Reemplazar `{tenant-id}` por el GUID del tenant autorizado. La identidad de
aplicación (client ID y secreto/certificado) debe ser la configurada para Wazuh;
guardar el secreto en el gestor de secretos aprobado, no en el repositorio.
El token puede emitirse aunque falte el permiso, por lo que un `200` al pedir
token no demuestra que la API de actividad esté autorizada. El endpoint de
actividad debe responder correctamente para validar el permiso.

La obtención del token usa el endpoint de Microsoft Entra del tenant, con la
forma `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token`. Permitir
la salida HTTPS (TCP/443) desde el host/servicio Wazuh a los hosts de Entra y
Office 365 Management API que use la configuración aprobada.

## 2. Wazuh Indexer → KrakenD → QAPAQ

QAPAQ consulta alertas del Wazuh Indexer únicamente a través de KrakenD. El
adapter no debe conectarse directamente al Indexer.

| Operación | Ruta relativa | Método y propósito |
| --- | --- | --- |
| Estado del cluster | `/wazuh/_cluster/health` | `GET`, health check acotado |
| Lectura de alertas | `/wazuh/_search` | `POST`, búsqueda de solo lectura y paginada |

La base URL debe ser la del **gateway KrakenD** y configurarse como
`QAPAQ_WAZUH_GATEWAY_BASE_URL`. El acceso del servicio QAPAQ al gateway requiere
una identidad de workload autorizada, bearer token administrado mediante
`SecretProvider`, y permiso de lectura para las dos rutas indicadas. Las
credenciales administrativas o de escritura del Indexer no se deben entregar a
QAPAQ.

### URL pública de QAPAQ

El despliegue sin dominio usa la IP elástica de la instancia Wazuh como proxy
HTTPS. El API queda publicado bajo `/qapaq-api`; el proxy reenvía esa ruta al ALB,
cuyo security group solo acepta HTTP desde la instancia proxy. Después de aplicar,
obtener los valores desde `infra/aws` con `terraform output -raw public_api_url`
y `terraform output -raw wazuh_dashboard_url`. El certificado Let's Encrypt para
IP es de corta duración y se renueva automáticamente.

La base URL pública del API tendrá esta forma (la IP concreta se conoce al
aplicar Terraform):

```text
https://<IP-elastica>/qapaq-api/wazuh/_cluster/health
https://<IP-elastica>/qapaq-api/wazuh/_search
```

El gateway de KrakenD conserva sus rutas Wazuh (`/wazuh/...`). El proxy elimina
el prefijo `/qapaq-api` antes de enviar cada petición al ALB. El acceso al
Indexer solo permite el puerto/configuración necesaria desde KrakenD; no se abre
a Internet ni se concede acceso directo desde QAPAQ.

## 3. Dashboard de Wazuh

El stack oficial single-node que levanta
[`scripts/dev/setup-wazuh.ps1`](../../scripts/dev/setup-wazuh.ps1) publica el
Dashboard por HTTPS en el puerto 443 del host Docker. En ese host, abre
[https://localhost](https://localhost). Desde otro equipo de la misma red usa
`https://<host-docker>` solo si el administrador habilitó el acceso de red; no
expongas ese puerto a Internet. El certificado local es propio del stack y el
navegador puede avisar que no es de confianza.

**AWS:** después de aplicar y completar el bootstrap, la URL pública será el
output `wazuh_dashboard_url` (formato `https://<IP-elastica>/`). El certificado
HTTPS de Let's Encrypt se solicita para la IP y se renueva cada pocos días. El
Dashboard requiere autenticación; la contraseña inicial generada se guarda en
AWS Secrets Manager. Obtén el ARN con
`terraform output -raw wazuh_dashboard_admin_secret_arn` y consulta el valor en
Secrets Manager con una identidad autorizada. Terraform termina antes de que el
bootstrap de Wazuh y la emisión del certificado acaben, por lo que el URL puede
demorar unos minutos en responder.

La IP elástica también sirve QAPAQ API por `/qapaq-api`. Puertos 80/443 quedan
públicos para el proxy; SSH, Dashboard 5601, Manager 55000 e Indexer 9200 no se
abren a Internet. La zona Route 53 hija que se había creado se conserva, pero no
se usa en este despliegue sin dominio.

## Estado y referencias del proyecto

- El permiso `ActivityFeed.Read` y el admin consent aparecen como la dependencia
  externa pendiente en el diagnóstico de PBI-007.
- URL productiva del gateway, certificado e identidad read-only siguen pendientes
  de confirmación por Infraestructura.
- [Diagnóstico de Microsoft 365/Wazuh](../project-management/informes-de-avance/2026-09-28-informe-de-cierre.md)
- [Contrato del adapter Wazuh (C-10)](../project-management/c-10/README.md)
- [Variables y outputs de Terraform AWS](../../infra/aws/outputs.tf)
