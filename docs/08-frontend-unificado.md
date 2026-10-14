# 08 · Frontend unificado

## Decisión

El **Wazuh Dashboard modificado es la interfaz única de QAPAQ SecOps**. El plugin `qapaq_ops`
contiene las vistas QAPAQ dentro del shell del SIEM; `apps/web` y el hosting Vercel se retiran.
La dirección pública prevista es `https://qapaq-secops.jappi.net.pe`.

Esta decisión retira solo el frontend independiente. El plugin sigue consumiendo `apps/api` y
`modules/*` para login Entra, sesión única y revocación, casos Ayni Qapaq, auditoría, salud y
notificaciones Teams. PostgreSQL sigue siendo el origen durable de esos datos.

## Integración de origen único

El host Wazuh publica el Dashboard en `/` y proxy-rutea `/qapaq-api/` hacia la API TypeScript
al API. El edge quita el prefijo antes de enviar la solicitud; para completar OIDC también
reescribe el `Path` de la cookie de binding al prefijo público. El plugin usa el mismo origen
público para sus llamadas y para el flujo de autenticación. La pantalla de login QAPAQ forma
parte del Dashboard modificado; sus recursos
gráficos se versionan en `wazuh/dashboard/assets/images/` y se verifican durante el build.

| Pieza | Ubicación | Función |
| --- | --- | --- |
| Dashboard QAPAQ | `wazuh/dashboard/` | Shell SIEM y marca QAPAQ |
| Login QAPAQ | `wazuh/dashboard/plugins/qapaq_ops/server/` y assets del Dashboard | Inicio/cierre de sesión con API TypeScript |
| Vistas Ayni Qapaq | `wazuh/dashboard/plugins/qapaq_ops/public/` | Casos, incidentes, tareas, auditoría y administración |
| Configuración de API same-origin | `wazuh/dashboard/opensearch_dashboards.qapaq.yml` | Prefijo `/qapaq-api/api` |
| Proxy | `infra/aws/scripts/configure-wazuh-domain.sh` | Dashboard en `/`; proxy HTTPS `/qapaq-api/` al ALB |
| API de negocio | `apps/api`, `modules/*`, `platform/*` | Identidad, sesión, revocación, casos, auditoría y avisos |

El API no se elimina: Wazuh proporciona SIEM, búsqueda y shell visual; el backend QAPAQ mantiene
el diferencial de negocio y gobierno.

## Contrato de autenticación y API

El plugin inicia el login contra la API (`/qapaq-api/api/auth/start`), recibe el retorno de Entra
en el mismo origen y conserva la cookie de sesión emitida por la API. La revocación consulta la
sesión QAPAQ y se refleja en las solicitudes protegidas del Dashboard.

**Gate de Entra:** antes de permitir el login en el nuevo host, agregar y verificar en el
registro de la aplicación la URI exacta
`https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback`. No rotar ni reemplazar el client
secret: solo cambia el redirect URI/origen configurado.

Las rutas que consume el plugin incluyen sesión e identidad, alertas y comandos, incidentes,
tareas/notas/timeline, auditoría, usuarios/sesiones y revocación, salud de fuentes y notificaciones
Teams. El contrato y los DTO viven en el backend y deben probarse contra la API antes de publicar
artefactos.

## Cambios en vivo y resiliencia

- El endpoint de cambios conserva long-poll como mecanismo de actualización/respaldo.
- Valkey mantiene una caché de eventos con TTL breve; ante error o ausencia de caché, la API lee
  la fuente durable.
- BullMQ publica señales para que el worker ECS drene el outbox. El registro del trabajo y la
  auditoría permanecen en PostgreSQL; la señal se puede reconstruir.
- La API conserva polling de respaldo para el outbox. La caída de Valkey no debe eliminar casos,
  auditoría ni notificaciones asentadas.

La presencia de estos cambios en el código/configuración de la rama no significa que estén
desplegados. El build, pruebas, plan Terraform y verificación funcional en AWS son gates previos
al lanzamiento.

## Retirada de `apps/web` y Vercel

La eliminación de `apps/web`, sus builds y pruebas ya está preparada en esta rama. Los DNS
`app`/`codexpt` y el alias `wazuh.jappi.net.pe` se conservan en el primer corte para rollback; un
segundo plan Terraform los retira después de los smokes de login, vistas y API. Mantener el backend
API y su dominio/API privada, además de KrakenD, mientras la ingesta QAPAQ hacia Wazuh Indexer
dependa de él.

No declarar completada la retirada hasta que el Dashboard sirva el login y las vistas QAPAQ, el
proxy same-origin funcione, el callback esté registrado en Entra y pasen los tests de plugin/API.
