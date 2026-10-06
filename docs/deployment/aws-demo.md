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

Los Security Groups omiten las reglas egress inline: el provider elimina la regla allow-all predeterminada y cada salida necesaria se declara con una regla standalone restringida por destino. Así no se mezclan las reglas inline con `aws_vpc_security_group_egress_rule`, combinación que el provider AWS documenta como fuente de conflictos y diferencias perpetuas.

## Fase 2B — foundations (aplicada)

El apply remoto de [Terraform Demo #9](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37404363686) agregó 34 recursos, cambió 4 reglas in-place y no destruyó recursos, llevando el state a 78 recursos. Incluye tres repositorios ECR privados con scan-on-push y tags inmutables, tres buckets S3 privados, una CMK con rotación, seis entradas de metadata vacías de Secrets Manager y el IAM role dedicado de publicación por GitHub OIDC. No creó ECS, ALB, RDS, Redis/Valkey, Wazuh ni servicios de aplicación.

Los valores de secretos no están en Terraform. Su carga/rotación requiere un paso separado. Costo fijo estimado de foundations: aproximadamente USD 3.40/mes por la CMK y metadata de Secrets Manager, además del uso variable de ECR/S3, llamadas API y datos.

## Fase 2C — publicación verificada en ECR (completada)

`.github/workflows/publish-images.yml` permite únicamente `workflow_dispatch` desde `main`; si el ref no es `main`, falla explícitamente. Hace checkout del SHA exacto, espera `CI / required` verde para ese commit y ejecuta `.github/ci/verify-container-images.sh` antes de publicar. Se mantienen build, Node `v24.21.0`, smoke tests, SIGTERM/exit code y Trivy HIGH/CRITICAL para API, Worker y KrakenD.

Autenticación exclusivamente con GitHub OIDC y el role `qapaq-secops-demo-github-ecr-publisher`, limitado al repositorio y `main`. La cuenta aceptada es `955200662475`, región `us-east-1`. No hay credenciales estáticas ni se publica `latest`. El workflow comprueba que existan los tres repositorios antes del build. Solo después de pasar todos los gates publica tags inmutables `git-<full-commit-sha>` en:

- `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-api`
- `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-worker`
- `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-krakend`

El workflow recupera el digest `sha256` de cada tag y adjunta `image-manifest-<commit>` por 30 días. El manifiesto contiene `schemaVersion`, proyecto, entorno demo, cuenta AWS, región, SHA, timestamp UTC y por imagen: nombre del repositorio, URI, tag y digest. El despliegue futuro deberá fijar `repository@sha256:...`; los tags sirven para localizar la release y el digest identifica el contenido exacto. Para rollback se selecciona un digest de un manifiesto anterior y se vuelve a desplegar ese digest, conservando trazabilidad con el SHA fuente.

La ejecución [Publish verified images #8](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37407871065) completó correctamente en `main`, commit `5ea083bd6dccf12580d00b43ee66d1086c0e06ea`. El check `CI / required` de ese SHA y los gates de release pasaron. Trivy HIGH/CRITICAL terminó con código 0 en API, Worker y KrakenD. El manifiesto quedó como artifact de GitHub con 30 días de retención.

| Imagen | Tag | Digest |
| --- | --- | --- |
| API | `git-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` | `sha256:5183b8dbc8a01f0870429837db0b4bfc7dc2867cc5e8a4b6b36f32d1e7c81068` |
| Worker | `git-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` | `sha256:5b9bfd85b87f14ce0e4bad4d5ba784c9a8b5bb530e1963411fa846784d941624` |
| KrakenD | `git-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` | `sha256:7223fd58694264dec9c2630314ab3234b45af70a7cb8c3c4f5ab3573af7a5460` |

La política lifecycle conserva los 20 tags más recientes `git-*` y elimina imágenes sin tag tras un día. El role tiene una policy inline y ninguna policy administrada adjunta. Incluye `ecr:GetAuthorizationToken` con `Resource: "*"` por requisito de ECR, y acciones de publicación/consulta limitadas a los tres ARNs: `BatchGetImage`, `BatchCheckLayerAvailability`, `CompleteLayerUpload`, `DescribeRepositories`, `InitiateLayerUpload`, `PutImage` y `UploadLayerPart`. No concede administración ECR, permisos S3 ni lectura de secretos. Su trust policy restringe OIDC al subject inmutable del repo y `main`.

Para el tag nuevo, el plan remoto [Terraform Demo #10](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37407190420) mostró 12 altas, 1 cambio y 3 bajas. Las 9 reglas egress ausentes eran recursos del baseline de seguridad declarados en Terraform; los restantes cambios actualizaron los 3 lifecycle policies y el permiso mínimo para `DescribeRepositories`. El [apply #11](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37407657228) pasó y no creó workloads; el state resultó con 87 recursos.

La auditoría siguiente detectó cuatro diffs in-place en los Security Groups porque se combinaban `egress = []` con reglas standalone. Se removió el argumento inline y [Terraform Demo #13](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37409018924) confirmó `terraform fmt`, `terraform validate` y un plan con “No changes. Your infrastructure matches the configuration.” La misma auditoría consultó las policies reales del publisher en IAM.

### Límite del Worker

El contenedor Worker compila, inicia, pasa su smoke/lifecycle gate y finaliza limpiamente con SIGTERM, pero permanece en espera. Aunque BullMQ e ioredis aparecen como dependencias, todavía no consume colas ni procesa tareas asíncronas. Una imagen publicada no significa que el Worker sea funcional para procesamiento.

API y Worker pasan las validaciones de imagen, pero aún no se declaran desplegables: no hay ECS, la API no tiene readiness real de dependencias, las subnets privadas no tienen egress/endpoints y no se han cargado los secretos operativos.

## Fase 3 — PostgreSQL, Valkey y conectividad privada (plan verde; no aplicada)

La Fase 3 añade únicamente la capa de datos y conectividad saliente de runtime. Un push a `main` que cambie `infra/aws/**` ejecuta `terraform fmt -check -recursive`, `terraform validate` y `terraform plan`. El `apply` solo puede iniciarse por despacho manual con la opción explícita; no se autoriza `apply` como parte de esta entrega.

### PostgreSQL

- RDS PostgreSQL **18.6**, igual a `postgres:18.6` de Compose y a la versión aceptada en ADR-016. RDS publica 18.6 en la región elegida; no hay downgrade de major/minor que documentar.
- Instancia `db.t4g.micro`, Single-AZ, gp3 cifrado de 20 GiB, no pública y solo en las dos subnets de datos (`10.0.32.0/24`, `10.0.33.0/24`). El security group existente permite TCP/5432 solo desde API y Worker.
- `rds.force_ssl=1` obliga TLS en servidor. La aplicación debe conectar al hostname RDS con `sslmode=verify-full`, comprobar hostname y cadena de confianza usando el bundle CA vigente de RDS. El código de configuración actual valida que TLS esté activado, pero todavía no demuestra validación de CA/hostname; verificarlo antes de Fase 4.
- RDS genera y rota el password master en Secrets Manager. Terraform expone solo endpoint, puerto, database name y ARN del secreto. El master sirve para bootstrap/migración; antes de ejecutar una API de producción se debe crear un usuario de aplicación con permisos mínimos, guardar su secreto en Secrets Manager y no usar el master para tráfico ordinario.
- Backups automáticos por 1 día. No hay Performance Insights. `postgres_deletion_protection=false` y `postgres_skip_final_snapshot=true` simplifican el demo efímero; si se debe conservar información, activar protección y snapshot final con un identificador antes de `apply`/destrucción. La estrategia asume que los datos demo se pueden perder durante teardown.

### Valkey

- ElastiCache Valkey 8.0, `cache.t4g.micro`, replication group de **un solo nodo**, cluster mode deshabilitado, sin réplica ni failover, en subnets de datos y con el security group existente (API/Worker a TCP/6379).
- Cifrado en reposo y TLS obligatorio (`transit_encryption_mode=required`); AUTH token de 64 caracteres. `ephemeral.random_password` lo genera solo durante el apply y se envía a ElastiCache por `auth_token_wo`; la misma operación lo escribe a Secrets Manager con argumento write-only. El valor no queda en `.tfvars`, plan ni state, y los outputs devuelven solo ARN.
- La conexión será endpoint privado con TLS (`rediss://`) y AUTH. El token se refiere por ARN a través del provider de secretos del runtime. BullMQ/ioredis todavía no se ejercitan contra Valkey real; validar handshake TLS, AUTH y compatibilidad de comandos tras aplicar. El Worker sigue inactivo y no consume BullMQ.
- Valkey es cache/estado de cola, no persistencia autoritativa. No se configura snapshot porque sus datos se pueden reconstruir desde PostgreSQL/outbox. Una sola instancia reduce costo, pero una falla de nodo deja el runtime sin cache/queue hasta recuperarse.

### Egress privado de servicios AWS

Se elige una red privada con **cuatro Interface Endpoints en dos AZ** y un Gateway Endpoint S3:

| Endpoint | Uso previsto |
| --- | --- |
| `com.amazonaws.us-east-1.ecr.api` | autenticación/consulta ECR para Fargate |
| `com.amazonaws.us-east-1.ecr.dkr` | descarga de manifests y capas ECR |
| `com.amazonaws.us-east-1.s3` (Gateway) | capas ECR almacenadas en S3 y buckets de aplicación |
| `com.amazonaws.us-east-1.secretsmanager` | resolución de secretos por el execution role |
| `com.amazonaws.us-east-1.logs` | logs operativos de contenedores en CloudWatch Logs |

Los cuatro Interface Endpoints usan private DNS y ENIs en las dos application subnets. Un SG dedicado acepta TCP/443 solo desde SG KrakenD/API/Worker; las reglas egress de esos runtimes permiten 443 solo hacia ese SG. El S3 Gateway Endpoint se asocia a la route table privada de aplicación existente y no tiene tarifa de endpoint. No se crea endpoint STS: ECS entrega credenciales temporales al task por su metadata endpoint; STS se añadirá solo si el código asume roles explícitamente.

CloudWatch queda limitado a logs operativos (arranque, errores y salud). No se enviarán raw SOC events, payloads sensibles ni evidencias. El endpoint no crea log groups, retención, métricas ni plataforma SOC.

**Trade-off frente a NAT para una demo de cuatro horas:** AWS publica aproximadamente USD 0.01 por ENI/hora para Interface Endpoints en us-east-1 y USD 0.045 por hora más USD 0.045/GB procesado para NAT Gateway. Cuatro endpoints en dos AZ cuestan unos **USD 0.08/h** (USD 0.32/4 h; USD 58.40/730 h), antes de USD 0.01/GB de procesamiento. Un NAT en una AZ cuesta **USD 0.18/4 h** antes de procesamiento y transferencia, o USD 32.85/730 h. Para esta demo corta, el NAT único ahorraría unos USD 0.14 en cuatro horas bajo volumen insignificante, pero daría egress HTTPS genérico, tendría cargo por GB y salida inter-AZ si tasks usan ambas AZ. Elegimos endpoints: la diferencia absoluta es pequeña frente a RDS/Valkey, y mantiene la salida confinada a los servicios AWS enumerados. No se implementan endpoints y NAT simultáneamente. Si las sesiones de demo crecen a uso permanente, revisar coste y número de AZ antes de mantenerlos.

### IAM, costos, delta y gates

No se crean roles/policies ECS todavía. En Fase 4 separar execution role (pull ECR, emitir logs y obtener secretos concretos) de task role (permisos concretos de aplicación: ARN de buckets, secretos y `elasticache:Connect` donde corresponda); nada de `secretsmanager:*`, `s3:*` o `kms:*`.

Estimación on-demand orientativa para `us-east-1` (730 h/mes): RDS `db.t4g.micro` cerca de USD 0.019/h, gp3 20 GiB aproximadamente USD 2.30/mes y secreto administrado USD 0.40/mes; Valkey `cache.t4g.micro` cerca de USD 0.0128/h; endpoints USD 0.08/h + transferencia; Secrets Manager de Valkey USD 0.40/mes. Total incremental previsto **~USD 0.12/h y ~USD 85/mes** para la Fase 3, excluye la línea base Fase 2B (USD 3.40/mes), I/O/backups/snapshots excedentes, transferencia, impuestos y CPU credits. Una sesión de cuatro horas rondaría USD 0.48 incremental, con facturación mínima de 10 minutos de RDS por cada cambio de estado; endpoint-hours parciales redondean por endpoint. Eliminar los recursos al acabar la demo evita cargos continuos.

El plan remoto [Terraform Demo #14](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37412251901), ejecutado sobre `main` en el commit `d95170532501290f5e445b91036a3e3133f475b3`, terminó en verde para `terraform fmt -check -recursive`, `terraform validate` y `terraform plan`. Confirmó **19 recursos nuevos, 0 modificados, 0 destruidos y 0 reemplazos** respecto de los 87 recursos existentes: RDS (DB subnet group, parameter group, instancia), Valkey (subnet group, secreto + versión, replication group), y egress (SG, 3 ingress + 3 egress rules, 4 interfaces, 1 S3 gateway). [CI / required](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37412251883/job/112103959095) y [evidence](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37412551653/job/112103995310) también pasaron. Apply y Audit quedaron omitidos: esta fase sigue sin aplicar y no se modificó el state de AWS.

Gates pendientes antes de Fase 4: revisar y autorizar el apply de esos 19 recursos; esperar RDS/Valkey `available`; comprobar subnets privadas, cifrado y SG; probar PostgreSQL con `verify-full` y CA; probar Valkey `rediss` + AUTH desde una tarea autorizada; verificar los endpoint services y DNS privados. Además, la API aún está configurada alrededor de MinIO y no tiene wiring S3 de producción; readiness de dependencias no está implementada. El Worker sigue sin consumidor BullMQ. Wazuh necesitará un diseño separado de egress HTTPS a Microsoft 365. Ninguno de estos servicios se declara desplegable aquí.

No crear ni desplegar en esta fase ECS Services, ALB, Wazuh, Grafana, Prometheus, Loki ni runtime OpenTelemetry.
