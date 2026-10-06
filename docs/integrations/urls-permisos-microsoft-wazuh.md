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

### URL de producción pendiente

La infraestructura Terraform define el output `runtime_load_balancer_dns_name`,
que identifica el balanceador público que recibe KrakenD. No se puede incluir
aquí un hostname concreto hasta que Terraform pueda consultar el state remoto de
AWS y el despliegue esté aplicado. Para obtenerlo después de configurar las
credenciales AWS y reconciliar el state, ejecutar desde `infra/aws`:

```powershell
terraform output -raw runtime_load_balancer_dns_name
```

El entorno Terraform requiere HTTPS (`enable_https = true`) y usa
`api.qapaq.secops.com` en la zona pública de Route 53 `qapaq.secops.com`.
Terraform solicitará y validará en ACM el certificado DNS, creará el alias A
hacia el ALB y redirigirá HTTP a HTTPS. No usar el DNS nativo del ALB como
hostname HTTPS porque no estará cubierto por el certificado. La base URL será
`https://api.qapaq.secops.com` y las rutas de lectura serán:

```text
https://api.qapaq.secops.com/wazuh/_cluster/health
https://api.qapaq.secops.com/wazuh/_search
```

El acceso de red al Indexer solo debe permitir el puerto/configuración necesaria
desde el security group de KrakenD. No se debe abrir el Indexer a Internet ni
conceder acceso directo desde QAPAQ.

## 3. Dashboard de Wazuh

El stack oficial single-node que levanta
[`scripts/dev/setup-wazuh.ps1`](../../scripts/dev/setup-wazuh.ps1) publica el
Dashboard por HTTPS en el puerto 443 del host Docker. En ese host, abre
[https://localhost](https://localhost). Desde otro equipo de la misma red usa
`https://<host-docker>` solo si el administrador habilitó el acceso de red; no
expongas ese puerto a Internet. El certificado local es propio del stack y el
navegador puede avisar que no es de confianza.

**AWS:** no hay URL pública del Dashboard que entregar. El despliegue AWS actual
no instala Wazuh ni el Dashboard; el Security Group administrativo permanece
cerrado (`allowed_admin_cidrs = []`). El piloto de Wazuh en Railway fue eliminado
y no dejó un endpoint activo. El hostname `https://api.qapaq.secops.com` es el
gateway/API de QAPAQ y no es el Dashboard. Cuando se despliegue Wazuh, publicar
el Dashboard detrás de acceso privado o de una allowlist administrativa y añadir
su URL aquí; no reutilizar el ALB de QAPAQ como si ya alojara Wazuh.

## Estado y referencias del proyecto

- El permiso `ActivityFeed.Read` y el admin consent aparecen como la dependencia
  externa pendiente en el diagnóstico de PBI-007.
- URL productiva del gateway, certificado e identidad read-only siguen pendientes
  de confirmación por Infraestructura.
- [Diagnóstico de Microsoft 365/Wazuh](../project-management/informes-de-avance/2026-09-28-informe-de-cierre.md)
- [Contrato del adapter Wazuh (C-10)](../project-management/c-10/README.md)
- [Variables y outputs de Terraform AWS](../../infra/aws/outputs.tf)
