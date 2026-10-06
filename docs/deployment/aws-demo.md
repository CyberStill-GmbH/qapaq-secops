# Despliegue AWS demo — estado por fases

Esta guía registra las foundations aplicadas y el pipeline de publicación de imágenes verificadas. La arquitectura sigue siendo una demo: no hay workloads ejecutándose en AWS.

## Fase 1 — red y seguridad (aplicada)

Terraform aplica VPC `10.0.0.0/16`, dos subnets públicas, dos privadas de aplicación, dos privadas aisladas de datos, Internet Gateway, route tables/asociaciones y siete security groups por capa.

| Capa | CIDR |
| --- | --- |
| Pública | `10.0.0.0/24`, `10.0.1.0/24` |
| Aplicación | `10.0.16.0/24`, `10.0.17.0/24` |
| Datos | `10.0.32.0/24`, `10.0.33.0/24` |

No hay NAT Gateway. Solo el ALB futuro tiene reglas HTTP/HTTPS públicas. El dashboard administrativo Wazuh parte cerrado: `allowed_admin_cidrs=[]`.

## Fase 2B — foundations (aplicada)

El apply remoto de [Terraform Demo #9](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37404363686) agregó 34 recursos, cambió 4 reglas in-place y no destruyó recursos, llevando el state a 78 recursos. Incluye tres repositorios ECR privados con scan-on-push y tags inmutables, tres buckets S3 privados, una CMK con rotación, seis entradas de metadata vacías de Secrets Manager y el IAM role dedicado de publicación por GitHub OIDC. No creó ECS, ALB, RDS, Redis/Valkey, Wazuh ni servicios de aplicación.

Los valores de secretos no están en Terraform. Su carga/rotación requiere un paso separado. Costo fijo estimado de foundations: aproximadamente USD 3.40/mes por la CMK y metadata de Secrets Manager, además del uso variable de ECR/S3, llamadas API y datos.

## Fase 2C — publicación verificada en ECR

`.github/workflows/publish-images.yml` permite únicamente `workflow_dispatch` desde `main`; si el ref no es `main`, falla explícitamente. Hace checkout del SHA exacto, espera `CI / required` verde para ese commit y ejecuta `.github/ci/verify-container-images.sh` antes de publicar. Se mantienen build, Node `v24.21.0`, smoke tests, SIGTERM/exit code y Trivy HIGH/CRITICAL para API, Worker y KrakenD.

Autenticación exclusivamente con GitHub OIDC y el role `qapaq-secops-demo-github-ecr-publisher`, limitado al repositorio y `main`. La cuenta aceptada es `955200662475`, región `us-east-1`. No hay credenciales estáticas ni se publica `latest`. El workflow comprueba que existan los tres repositorios antes del build. Solo después de pasar todos los gates publica tags inmutables `git-<full-commit-sha>` en:

- `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-api`
- `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-worker`
- `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-krakend`

El workflow recupera el digest `sha256` de cada tag y adjunta `image-manifest-<commit>` por 30 días. El manifiesto contiene `schemaVersion`, proyecto, entorno demo, cuenta AWS, región, SHA, timestamp UTC y por imagen: nombre del repositorio, URI, tag y digest. El despliegue futuro deberá fijar `repository@sha256:...`; los tags sirven para localizar la release y el digest identifica el contenido exacto. Para rollback se selecciona un digest de un manifiesto anterior y se vuelve a desplegar ese digest, conservando trazabilidad con el SHA fuente.

La política lifecycle conserva los 20 tags más recientes `git-*` y elimina imágenes sin tag tras un día. La policy del role incluye `ecr:GetAuthorizationToken` con `Resource: "*"` por requisito de ECR, y acciones de publicación/consulta limitadas a los tres ARNs: `BatchGetImage`, `BatchCheckLayerAvailability`, `CompleteLayerUpload`, `DescribeRepositories`, `InitiateLayerUpload`, `PutImage` y `UploadLayerPart`. No concede administración ECR, permisos S3 ni lectura de secretos.

### Límite del Worker

El contenedor Worker compila, inicia, pasa su smoke/lifecycle gate y finaliza limpiamente con SIGTERM, pero permanece en espera. Aunque BullMQ e ioredis aparecen como dependencias, todavía no consume colas ni procesa tareas asíncronas. Una imagen publicada no significa que el Worker sea funcional para procesamiento.

API y Worker pasan las validaciones de imagen, pero aún no se declaran desplegables: no hay ECS, la API no tiene readiness real de dependencias, las subnets privadas no tienen egress/endpoints y no se han cargado los secretos operativos.

## Fases expresamente fuera de alcance

No crear ni desplegar ECS, RDS, Redis/Valkey, ALB ni Wazuh en esta fase. Siguen pendientes el diseño de salida privada/endpoints, egress de Wazuh a Microsoft 365, certificado HTTPS, valores operativos de secretos y decisión de acceso administrativo.
