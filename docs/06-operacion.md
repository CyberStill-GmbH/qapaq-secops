# 06 · Operación

## Topología AWS (demo, us-east-1)

| Recurso | Hoy | Objetivo | Δ USD/mes aprox. |
| --- | --- | --- | --- |
| VPC con 3 capas × 2 AZ, NAT, VPC endpoints | ✓ | Igual | — |
| ALB y ACM | → KrakenD → API | → API directo (`/api/*`). El dashboard entra por el edge nginx del host Wazuh | — |
| ECS: KrakenD (≥ 2 tareas de 0,25 vCPU) | ✓ | **Se retira** | −18 |
| ECS: API (0,5 vCPU / 1 GB) | ✓ | Igual. Una réplica hasta que los stores OIDC y CSRF pasen a Postgres | — |
| ECS: worker | ✓ (stub) | **Se retira** | −9 |
| RDS Postgres 18.6 `db.t4g.micro` | ✓ | Igual | — |
| ElastiCache Valkey `cache.t4g.micro` | ✓ (sin uso) | **Se retira** | −12 |
| EC2 Wazuh all-in-one `t3.xlarge` (4.14.8) | ✓ | Igual, más el edge nginx con `auth_request` y la marca QAPAQ | — |
| S3 de snapshots del Indexer | — | **Nuevo** (KMS, `standard_ia`) | +1–5 según volumen |
| S3 de evidencia con Object Lock | Versionado sin lock | **Nuevo bucket** con Object Lock (el lock no se puede activar sobre el bucket actual) | +<1 |
| EC2 Shuffle `t3.medium` (fase 3) | — | Nuevo, privado | +30 |
| Vercel (`apps/web`) | ✓ | **Se retira**. `/soc` se sirve desde el edge | — |

El costo base anterior era de unos USD 229/mes con todo encendido. El objetivo de fases 1–2
queda en unos **USD 190/mes**, y en unos USD 220/mes con Shuffle. Estas cifras son estimaciones
de lista on-demand: hay que confirmarlas con el plan de Terraform y Cost Explorer antes de
aplicar.

## Observabilidad sin Grafana

La decisión de negocio N1 (no tercerizar) exige que la observabilidad del SOC sea autogestionada.
Antes eso lo cumplía Grafana, Loki y Prometheus. Ahora lo cumple el **propio Wazuh**, sin
desplegar ni mantener un stack paralelo.

| Señal | Fuente | Dónde se ve |
| --- | --- | --- |
| Logs JSON de la API (con `correlationId`) | CloudWatch Logs `/qapaq-secops/demo/api` | Los ingiere el módulo **AWS de Wazuh** (`cloudwatchlogs`) → `wazuh-alerts-*`. Configuración en `wazuh/manager/ossec.qapaq-integrations.xml.tmpl`; reglas QAPAQ sobre esos eventos en `wazuh/manager/rules/` (fase 1, con logtest) |
| Access logs del ALB | Bucket S3 de logs | Módulo AWS de Wazuh (`alb`) |
| Métricas de infraestructura (CPU, conexiones RDS, 5xx del ALB, tareas ECS) | CloudWatch Metrics nativas | Alarmas de CloudWatch a SNS a correo o Teams. Las métricas no salen de la cuenta |
| Salud de Wazuh (agentes, cola de eventos, disco del Indexer) | Wazuh API e Indexer | Vistas nativas del dashboard |
| Salud de la ingesta QAPAQ (cursores, retrasos, `PROVIDER_RESPONSE_INVALID`) | `GET /api/operations/health` | Vista «Salud operativa» de QAPAQ |
| Acciones de los usuarios en QAPAQ | Cadena de auditoría | Vista «Auditoría» de QAPAQ. **Se mantiene separada** de los logs (ADR-021) |

Ventaja adicional: las acciones del SOC sobre su propia herramienta (logins, denegaciones,
aprobaciones) se vuelven eventos Wazuh. Se pueden alertar con reglas QAPAQ, por ejemplo una
ráfaga de `AUTHZ_DENIED` del mismo usuario. Esto cubre el monitoreo de APIs que pide la SBS
(art. 21) con la misma herramienta.

Prerrequisitos que hay que verificar en la demo: rol IAM de la EC2 con
`logs:FilterLogEvents`/`GetLogEvents` sobre el log group, `s3:GetObject` sobre el bucket de logs
del ALB, y el log driver `awslogs` de la tarea ECS de la API (ya está configurado en
`infra/aws/modules/runtime`).

## Despliegue

- **Imágenes:** ECR con tag inmutable `git-<sha>`, publicadas por GitHub OIDC (sin cambios).
- **Overlay Wazuh:** los workflows `initialize-wazuh.yml` y `configure-wazuh-office365.yml`
  empaquetan `wazuh/` y lo aplican por SSM con scripts idempotentes. Las fases 1–2 añaden
  `wazuh/edge`, `wazuh/indexer/*` y `wazuh/dashboard` al mismo empaquetado.
- **Terraform:** `infra/aws`. Antes de cada apply hay que verificar cuenta, región y backend,
  revisar todos los create/replace/destroy y comparar el costo con la tabla de arriba. Si aparece
  algo inesperado, se detiene.
- **Secretos:** se cargan en Secrets Manager con workflow y nunca entran a tfvars ni al estado.

## Runbooks mínimos

| Situación | Acción |
| --- | --- |
| La fuente «Wazuh Indexer · alertas» está en rojo | `GET /api/operations/health`. Desde la EC2, `curl --cacert` al proxy nginx con `qapaq_reader`. Workflow `repair-ingestion.yml` |
| Nadie puede entrar al dashboard | Probar `curl -i https://<dominio>/api/auth/introspect` con cookie. Si la API cae, el break-glass es el usuario interno `admin` por `https://<ip-privada>:5601` vía SSM port-forward, nunca público |
| Disco del Indexer > 80 % | `GET _plugins/_ism/explain/wazuh-alerts-*` para ver índices atascados en una fase. Revisar el repo `qapaq-s3` |
| Restaurar historia | [05](05-datos-y-retencion.md#restauración) |
| Revocar a alguien de inmediato | Sacarlo del grupo SOC en Entra (la sincronización Graph revoca) o `POST /api/admin/sessions/:ref/revoke`. El dashboard se pierde en ≤ 5 s |
| Teardown de la demo | Ver `infra/aws/README.md`. Vaciar los buckets salvo el de evidencia, que está bajo lock |
