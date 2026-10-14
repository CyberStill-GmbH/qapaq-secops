# 06 · Operación

## Topología objetivo en AWS (us-east-1)

La tabla describe la arquitectura que se prepara en esta rama; **no afirma que el Terraform se
haya aplicado**. RDS, API, KrakenD, Wazuh y sus datos se conservan. La retirada se limita al
frontend separado y a su hosting Vercel. El primer corte conserva los DNS antiguos hasta probar
el login nuevo; Terraform solo los borra en el plan de limpieza posterior.

| Recurso | Objetivo | Función y criterio de conservación |
| --- | --- | --- |
| VPC, subredes privadas, NAT y endpoints | Conservar según configuración actual | Red de API, worker, KrakenD, base de datos y caché |
| ALB y ACM | Conservar | Entrada al backend API; el Dashboard llama a la API desde el origen público de Wazuh por `/qapaq-api/` |
| ECS API | Conservar | Login Entra, sesión/revocación, casos Ayni Qapaq, auditoría y notificaciones |
| ECS KrakenD | Conservar | Gateway usado por la integración QAPAQ → Wazuh Indexer |
| ECS worker | Incorporar/reactivar en Terraform | Consume señales BullMQ y drena el outbox PostgreSQL |
| RDS PostgreSQL | Conservar | Fuente durable para estado, sesiones, auditoría y outbox |
| ElastiCache Valkey | Valkey con Multi-AZ y réplica(s) | Caché breve de lecturas y transporte BullMQ; reconstruible desde Postgres |
| EC2 Wazuh | Conservar | Manager, Indexer, Dashboard modificado, plugin QAPAQ y proxy del API |
| S3 snapshots/evidencia | Conservar o habilitar conforme a la política existente | No sustituir ni destruir buckets con datos como parte de quitar el frontend |
| `apps/web` / Vercel | Retirar del código y del enrutamiento DNS gestionado en Terraform | El plugin Wazuh sirve la interfaz en `https://qapaq-secops.jappi.net.pe` |
| Shuffle / Ankay Qapaq | Scope posterior | Red privada y sujeto a decisión de lanzamiento específica |

Valkey no almacena estado de negocio. BullMQ transporta avisos de trabajo; el worker recupera
trabajo durable de PostgreSQL, y la API conserva polling periódico como respaldo. Si Valkey o
BullMQ no están disponibles, no se deben perder casos, auditoría ni notificaciones ya asentadas
en el outbox.

## Acceso y Entra

El plugin Wazuh inicia el login y usa la API TypeScript para la sesión QAPAQ. El proxy sirve el
Dashboard en `/` y enruta `/qapaq-api/` al API; así la cookie y las llamadas del plugin usan un
solo origen. La URI prevista es
`https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback`.

**Gate previo a habilitar el login:** registrar y verificar esa URI exacta como redirect URI en la
aplicación de Microsoft Entra. Mantener el client secret existente: este cambio no requiere ni
autoriza rotación de credenciales.

## Observabilidad

La observabilidad se mantiene autogestionada. CloudWatch entrega métricas de infraestructura; la
telemetría operativa de AWS y QAPAQ se consulta desde Wazuh.

| Señal | Fuente | Dónde se ve |
| --- | --- | --- |
| Logs JSON de la API (`correlationId`) | CloudWatch Logs de ECS | Módulo AWS de Wazuh → `wazuh-alerts-*`; reglas QAPAQ en `wazuh/manager/rules/` |
| Access logs del ALB | S3/CloudWatch según el módulo de infraestructura | Módulo AWS de Wazuh |
| CPU, RDS, errores ALB y tareas ECS | CloudWatch Metrics | Alarmas CloudWatch/SNS |
| Salud de Wazuh | Wazuh API e Indexer | Vistas nativas del Dashboard |
| Salud de ingesta QAPAQ | `GET /api/operations/health` | API QAPAQ y vista operativa del plugin cuando esté habilitada |
| Acciones de usuarios | Auditoría hash en PostgreSQL | Vista «Auditoría» de QAPAQ; separada de logs operativos |
| Caché/eventos y cola | Métricas de aplicación, worker y Valkey | Logs/health checks de ECS y CloudWatch |

## Despliegue

- **Imágenes:** ECR con tags inmutables `git-<sha>`, publicadas por GitHub OIDC.
- **Overlay Wazuh:** los workflows empaquetan `wazuh/` y lo aplican por SSM con scripts
  idempotentes.
- **Terraform:** antes de `apply`, verificar cuenta, región y state; revisar cada create, replace
  y destroy. Aceptar solo cambios de frontend/hosting que estén identificados. Proteger
  explícitamente RDS, secretos, EC2/volúmenes Wazuh, hosted zone, ECR/S3, API, KrakenD, Valkey y
  worker según el plan revisado.
- **Credenciales:** usar las versiones actuales de Secrets Manager. No rotar Entra ni otros
  secretos existentes. El AUTH token de Valkey solo se crea si el clúster/secreto no existe; si
  ya existe fuera del state, importarlo/reconciliarlo antes de planear.
- **Evidencia:** guardar el plan exacto y los resultados de pruebas. Hasta que se ejecute y valide
  el workflow autorizado, tratar el despliegue como pendiente.

## Runbooks mínimos

| Situación | Acción |
| --- | --- |
| No carga el plugin/API | Comprobar `https://qapaq-secops.jappi.net.pe/`, luego el proxy `/qapaq-api/`, ALB y health check de ECS API |
| Falla el inicio de sesión | Revisar la URI exacta de callback en Entra, `GET /api/auth/introspect`, logs de API y cookie. No regenerar el client secret como primer paso |
| No se puede consultar un caso o la auditoría | Verificar API y PostgreSQL; esos datos no dependen del caché Valkey |
| Valkey no responde | Revisar el clúster y las conexiones. La API debe continuar atendiendo lecturas sin caché y el worker debe volver a consultar el outbox PostgreSQL |
| Worker detenido o cola sin señales | Revisar servicio ECS, conexión BullMQ y outbox PostgreSQL; el polling del API sirve como respaldo temporal |
| La ingesta de Indexer está en rojo | `GET /api/operations/health`; verificar KrakenD, su acceso al Indexer y el usuario de lectura configurado |
| Revocar una sesión | Retirar al usuario del grupo SOC en Entra o usar `POST /api/admin/sessions/:ref/revoke` |
| Disco del Indexer > 80 % | Revisar `_plugins/_ism/explain/wazuh-alerts-*` y la política de retención |
| Restaurar historia | [05 · Datos y retención](05-datos-y-retencion.md#restauración) |

Para teardown o limpieza de recursos consultar `infra/aws/README.md` y el state vigente. Nunca
vaciar buckets, reemplazar la zona DNS ni destruir datos durables para retirar el frontend.
