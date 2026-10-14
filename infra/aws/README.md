# AWS Terraform demo — fases 1, 2B y 2C

**Contexto histórico:** las fases 1, 2B y 2C documentadas aquí pasaron sus gates; ese snapshot
ya no describe por sí solo el state actual. Terraform Demo #50 aplicó parcialmente RDS, Valkey,
ALB, NAT, EC2 Wazuh y servicios ECS antes de fallar. Antes de cualquier apply, reconciliar los
recursos AWS y el state conforme a
[`terraform-apply-recovery.md`](../../docs/deployment/terraform-apply-recovery.md). La migración
posterior de producto está en
[`qapaq-wazuh-terraform-rollout.md`](../../docs/deployment/qapaq-wazuh-terraform-rollout.md).

## Arquitectura de esta fase

- Una VPC `10.0.0.0/16` en dos AZ.
- Dos subnets públicas para la futura entrada ALB/gateway.
- Dos subnets privadas de aplicación, sin ruta de salida a Internet.
- Dos subnets privadas aisladas para futuras bases de datos.
- Internet Gateway, tres route tables y asociaciones.
- Siete security groups separados: ALB, KrakenD, API, Worker, RDS, Redis/Valkey y
  Wazuh; reglas de capa a capa sin egress abierto.
- No hay NAT Gateway ni endpoints VPC en fase 1. El state remoto existente no es
  parte del stack.

Los Security Groups no declaran reglas egress inline. Cada salida permitida se
administra con `aws_vpc_security_group_egress_rule`; esto evita mezclar los dos
métodos en el mismo grupo y sus diffs perpetuos. El provider elimina la regla
allow-all predeterminada al crear un Security Group; cualquier salida necesaria
se reintroduce explícitamente por SG y destino.

Las subnets usan `/24`: públicas `10.0.0.0/24` y `10.0.1.0/24`; aplicación
`10.0.16.0/24` y `10.0.17.0/24`; datos `10.0.32.0/24` y `10.0.33.0/24`.
Terraform elige las dos primeras AZ disponibles de `us-east-1`; se pueden fijar
con `availability_zones` y reemplazar los CIDRs generados en `demo.tfvars`.

## Security groups

- **ALB:** inbound TCP/80 desde Internet para el bootstrap HTTP; TCP/443 solo si
  `enable_https=true`. Egress al puerto KrakenD únicamente.
- **KrakenD:** inbound del ALB al puerto 8080 y de API/Worker para la consulta
  interna de Wazuh. Egress al API TCP/3000 y al Indexer Wazuh TCP/9200.
- **API:** inbound TCP/3000 solo desde KrakenD; egress a PostgreSQL TCP/5432,
  Redis TCP/6379 y KrakenD TCP/8080.
- **Worker:** sin ingress; egress a PostgreSQL TCP/5432, Redis TCP/6379 y KrakenD
  TCP/8080.
- **RDS:** ingress TCP/5432 solo desde API y Worker; sin egress iniciado.
- **Redis/Valkey:** ingress TCP/6379 solo desde API y Worker; sin egress iniciado.
- **Wazuh:** Indexer TCP/9200 solo desde KrakenD. Dashboard TCP/443 desde
  `allowed_admin_cidrs`, que por defecto es `[]`; no abre acceso administrativo.
  Ningún puerto de manager/agentes ni SSH queda expuesto en esta fase.

Las reglas de respuesta se permiten por el seguimiento stateful de Security
Groups. La fase siguiente debe definir egress de ejecución para endpoints VPC,
ECR/Secrets Manager/CloudWatch y la salida HTTPS de Wazuh a Microsoft 365. Esas
rutas no se resuelven aquí con NAT ni reglas amplias.

## Bootstrap, OIDC y state

El backend existente usa el bucket bootstrap
`qapaq-secops-terraform-state-955200662475`, key `demo/terraform.tfstate`,
`us-east-1`, cifrado y lockfile S3. El stack no declara ni destruye ese bucket.
GitHub Actions usa OIDC con el role existente
`arn:aws:iam::955200662475:role/qapaq-secops-github-terraform-demo`; no se usan
access keys permanentes. Los cambios en `infra/aws/**` en `main` ejecutan
automáticamente fmt, init, validate y plan con `environments/demo.tfvars`. Apply
y auditoría solo se ejecutan mediante despacho manual con la opción explícita.

## Ejecutar verificaciones

Desde `infra/aws` con Terraform 1.16.5 y credenciales AWS vía GitHub OIDC:

```sh
terraform fmt -check -recursive
terraform init -input=false
terraform validate -no-color
terraform plan -var-file environments/demo.tfvars -input=false -no-color
```

`terraform plan` requiere AWS para consultar la identidad y las AZ disponibles.
En local no hay credenciales AWS; ejecutar el plan con el workflow manual desde
`main`. En esta fase el plan esperado solo contiene VPC, subnets, IGW, rutas,
asociaciones y security groups. Revisar que no aparezca ningún servicio fuera de
esta lista. No ejecutar `apply` todavía.

### Verificación y apply registrados

El workflow manual **Terraform Demo #2** terminó correctamente el 5 de octubre de
2026 sobre `main` (commit `def9f03`). OIDC autenticó en la cuenta AWS
`955200662475`, región `us-east-1`; Terraform resolvió las AZ
`us-east-1a` y `us-east-1b`. `fmt`, `validate` y `plan` pasaron. El plan mostró
**44 para crear, 0 para cambiar y 0 para destruir**: 18 recursos de red y 26 de
security groups/reglas. No incluyó API, Worker, KrakenD, ALB, RDS, Redis, Wazuh,
ECR, NAT ni endpoints. Luego, el workflow manual **Terraform Demo #3** aplicó el
plan guardado desde `main` y terminó correctamente el 5 de octubre de 2026. El
apply solo contiene esos 44 recursos de Fase 1; no se ejecutó ningún servicio de
aplicación.

Ejecuciones: [Terraform Demo #2 — plan](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37339466733) · [Terraform Demo #3 — apply](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37340825790).

## Costo, límites y siguientes gates

VPC, subnets, IGW, route tables, asociaciones y Security Groups no introducen un
cargo horario fijo. No se crea NAT Gateway, ALB, endpoints, instancia ni servicio
administrado en esta fase. Aplican cargos por transferencia de datos si se usan
recursos futuros.

## Fase 2B — foundations de aplicación (aplicada)

Esta fase agrega recursos base para publicar imágenes y almacenar datos de demo,
sin desplegar workloads de aplicación:

- **ECR privado:** repositorios `qapaq-secops-api`,
  `qapaq-secops-worker` y `qapaq-secops-krakend`, cifrado AES-256 de
  ECR, scan on push y tags inmutables. La política conserva los 20 tags `git-*`
  más recientes y vence imágenes sin tag luego de un día. Publicar tags de commit
  como `git-<commit>` permite identificar una versión; el manifiesto registra el
  digest que debe fijar ECS.
- **S3 privado:** tres buckets separados para `raw`, `evidence` y `artifacts`,
  nombrados con el ID de cuenta para evitar colisiones globales. Se bloquea acceso
  público, se impone TLS, se usa una CMK compartida con rotación automática,
  SSE-KMS y S3 Bucket Keys; ownership `BucketOwnerEnforced`.
  Solo el bucket de evidencia tiene versionado. Se abortan multipart uploads
  incompletos después de siete días; no se expiran objetos automáticamente porque
  falta definir retención de eventos y evidencias.
- **Secrets Manager:** seis entradas de metadata para Entra y credenciales de
  lectura/Wazuh, cursor y fingerprint. Terraform no define `secret_version`, ni
  valor de secreto. La carga inicial/rotación requiere un paso operativo separado.
- **IAM:** rol de publicación de imágenes de GitHub OIDC, confiado únicamente al
  repositorio configurado en `main` y con `aud=sts.amazonaws.com`. El `sub` usa
  los IDs inmutables del propietario y del repositorio de GitHub, además de
  `refs/heads/main`, porque este repositorio se creó después del cambio de
  formato de OIDC de GitHub. Puede publicar
  solo en los tres repositorios ECR; `GetAuthorizationToken` requiere `Resource
= "*"` por la semántica de AWS. Sus acciones limitadas por ARN son
  `BatchGetImage`, `BatchCheckLayerAvailability`, `CompleteLayerUpload`,
  `DescribeRepositories`, `InitiateLayerUpload`, `PutImage` y `UploadLayerPart`.
  `DescribeRepositories` permite validar el gate previo al build. No tiene
  acciones de administración ECR, S3 ni lectura de secretos. No se crea
  rol de tareas ni permisos runtime.

El Worker sigue siendo solo un proceso de ciclo de vida en espera: BullMQ e
ioredis están en dependencias, pero no existe consumidor ni conexión Redis. La
publicación de sus imágenes no implementa procesamiento asíncrono ni hace
desplegables API/Worker por sí sola.

### Costo estimado y delta de recursos

El CI de Fase 2B encontró el hallazgo HIGH AWS-0132: Trivy exige una CMK
administrada por el cliente para los buckets. Se incorporó una CMK compartida
para los tres buckets, con rotación y Bucket Keys; no se redujeron severidades ni
se añadieron excepciones. El plan remoto Terraform Demo #6 (commit `272d08d`)
registró **34 recursos nuevos, 4 cambios in-place y 0 destrucciones**, para un
total previsto de **78** frente a los 44 aplicados de Fase 1. Las altas son 6
recursos ECR, 19 S3, una CMK, 6 placeholders de Secrets
Manager y 2 IAM (rol y política inline). Los cuatro cambios in-place afectan a
los security groups de ALB, API, KrakenD y Worker: Terraform propone retirar los
bloques de egress declarados en el recurso SG mientras conserva reglas egress
explícitas gestionadas por `aws_vpc_security_group_egress_rule`. Revisar esta
coexistencia antes de aplicar para asegurar que no cambien las reglas efectivas
de red. No hay reemplazos ni destrucciones de los 44 recursos de Fase 1.
Ejecución: [Terraform Demo #6 — plan](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37354138323).
Si se aplica
el metadata de seis secretos, Secrets Manager factura por secreto almacenado; la
tarifa pública actual de referencia es USD 0.40 por secreto/mes, o USD 2.40/mes
por seis, antes de llamadas API. ECR cobra por almacenamiento de imágenes; S3 por
almacenamiento, solicitudes y transferencia. VPC/route tables/IAM no agregan
cargos mensuales fijos, y no hay NAT, endpoints ni cómputo. Los seis secretos
añaden aproximadamente USD 2.40/mes y la CMK USD 1/mes; por tanto, la parte fija
estimada es **USD 3.40/mes**, más llamadas de Secrets Manager/KMS y uso variable
de ECR/S3. S3 Bucket Keys reducen solicitudes KMS. Los repositorios, buckets y
roles no implican un cargo por hora.

Las verificaciones requeridas y ejecutadas para Fase 2B:

```sh
terraform fmt -check -recursive
terraform validate -no-color
terraform plan -var-file environments/demo.tfvars -input=false -no-color
```

El plan remoto confirmó que no reemplazaba ni destruía los 44 recursos de Fase 1;
añadía las foundations descritas y proponía los cuatro cambios in-place anotados
arriba. Una auditoría posterior encontró que esos recursos aún no estaban en AWS
ni en el state remoto. El apply correcto se ejecutó desde `main` en **Terraform
Demo #9**: 34 recursos añadidos, 4 cambios in-place y 0 destruidos, para un total
de 78 recursos. El plan no incluyó ECS, ALB, RDS, Redis/Valkey ni Wazuh. La
ejecución terminó correctamente: [Terraform Demo #9 — apply Fase 2B](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37404363686).

La VPC pública no implica que todas las subnets/instancias tengan IP pública; las
subnets no asignan IP pública automáticamente. El SG público con HTTP pertenece a
la futura entrada ALB, que aún no se crea. Wazuh Dashboard permanece cerrado hasta
aprobar una CIDR/VPN administrativa.

Pendiente para desplegar aplicación: endpoints o egress explícito; permiso de
egress HTTPS del Wazuh Manager para Microsoft 365; elección de HTTPS/certificado;
reglas del Dashboard y acceso administrativo. API y Worker compilan, pasan sus
smoke tests y arrancan como UID no root en contenedores locales, pero **no se
consideran desplegables ni DONE**: no hay despliegue ECS,
la API no tiene readiness real de dependencias y el Worker permanece en espera
inactiva sin consumidor BullMQ. Más detalles en
[`docs/06-operacion.md`](../../docs/06-operacion.md).

## Fase 2C — publicación verificada en ECR

`.github/workflows/publish-images.yml` solo admite despacho manual y falla si la
rama seleccionada no es `main`. Espera el check `CI / required` exitoso para ese
mismo SHA antes de pedir credenciales OIDC. Hace checkout del SHA exacto que pasó
CI. Usa GitHub OIDC con el rol
`github_ecr_publisher_role_arn`; el ARN se configura como variable no secreta del
repositorio `AWS_ECR_PUBLISHER_ROLE_ARN`, copiada del output de Terraform. La
cuenta se fija en `955200662475` y se valida contra STS; la región es `us-east-1`,
igual a `environments/demo.tfvars`. No hay access keys estáticas.

El rol verifica el `sub` inmutable de este repositorio:
`repo:CyberStill-GmbH@220633794/qapaq-secops@1374673243:ref:refs/heads/main`.
GitHub introdujo este formato como valor predeterminado para repositorios nuevos
creados desde el 15 de julio de 2026; confiar en el formato anterior basado solo
en nombres hace que STS rechace `AssumeRoleWithWebIdentity`. Los IDs son variables
Terraform validadas como numéricas, con valores predeterminados correspondientes
a los IDs reales del repositorio y su propietario. La rama sigue restringida a
`main`.

El commit `5ea083b` cambió el pipeline a despacho manual desde `main`, tags
`git-<full-sha>`, validación explícita de cuenta/repositorios y manifiesto de 30
días; también añadió `DescribeRepositories` al rol, limitado a los tres ARN ECR.
El CI requerido pasó: [CI Security #218](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37406590291).
El plan remoto [Terraform Demo #10](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37407190420)
fue de 12 altas, 1 cambio y 3 bajas: nueve reglas egress declaradas para la red
que faltaban en AWS, tres reemplazos de lifecycle ECR (`sha-`→`git-`) y un cambio
in-place de policy IAM. Tras revisar que no incluía workloads, el [apply Terraform
Demo #11](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37407657228)
completó exactamente ese plan: 12 añadidos, 1 cambiado y 3 reemplazados; el state
queda con 87 recursos. Ningún recurso de aplicación se creó. Una auditoría
posterior detectó cuatro diffs in-place porque `egress = []` en el recurso SG
competía con las reglas standalone; se eliminó ese argumento inline. La nueva
auditoría [Terraform Demo #13](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37409018924)
reportó “No changes. Your infrastructure matches the configuration.” y verificó
las políticas IAM activas del publisher.

La publicación manual [Publish verified images #8](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37407871065)
pasó todos los gates y publicó las tres imágenes de `5ea083bd6dccf12580d00b43ee66d1086c0e06ea`.
Trivy HIGH/CRITICAL dio código de salida 0 para API, Worker y KrakenD. El artifact
`image-manifest-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` expira el 5 de noviembre de 2026.
El worker sigue siendo una imagen que inicia correctamente pero permanece en
espera; todavía no consume BullMQ.

| Imagen  | URI ECR                                                             | Tag                                            | Digest                                                                    |
| ------- | ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| API     | `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-api`     | `git-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` | `sha256:5183b8dbc8a01f0870429837db0b4bfc7dc2867cc5e8a4b6b36f32d1e7c81068` |
| Worker  | `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-worker`  | `git-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` | `sha256:5b9bfd85b87f14ce0e4bad4d5ba784c9a8b5bb530e1963411fa846784d941624` |
| KrakenD | `955200662475.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-krakend` | `git-5ea083bd6dccf12580d00b43ee66d1086c0e06ea` | `sha256:7223fd58694264dec9c2630314ab3234b45af70a7cb8c3c4f5ab3573af7a5460` |

El job recuperó cada digest por `ecr:BatchGetImage`, confirmó que el tag
correspondiera al commit y validó el patrón SHA-256 antes de crear el manifest.
El role publisher confía solo en el subject OIDC inmutable de
`CyberStill-GmbH/qapaq-secops` para `refs/heads/main`, con `aud=sts.amazonaws.com`.
Tiene `ecr:GetAuthorizationToken` con `Resource: "*"`; las demás acciones
(`BatchGetImage`, `BatchCheckLayerAvailability`, `CompleteLayerUpload`,
`DescribeRepositories`, `InitiateLayerUpload`, `PutImage`, `UploadLayerPart`) se
limitan a los ARN de los tres repositorios. No hay políticas administradas ni
permisos para S3, Secrets Manager, ECS o administración ECR.

Antes de publicar, ejecuta el mismo script de gates que `CI / required`
(`.github/ci/verify-container-images.sh`): builds API/Worker/KrakenD, Node
`v24.21.0`, smoke API live/ready, smoke y ciclo de vida Worker, SIGTERM con exit
code 0 y Trivy HIGH/CRITICAL para las tres imágenes. Solo si todos pasan asigna
el tag inmutable `git-<full-commit-sha>` y hace push. Recupera el digest de cada
imagen de
ECR y adjunta `image-manifest-<commit>.json` con repositorio, tag, digest, commit,
región y timestamp UTC. El artifact se conserva por 30 días.

Las URLs siguen los nombres declarados por Terraform:
`<cuenta>.dkr.ecr.us-east-1.amazonaws.com/qapaq-secops-{api,worker,krakend}`.
No se publica `latest`. ECR escanea cada push y conserva los 20 tags `git-*` más
recientes. El futuro ECS debe referenciar las imágenes por digest. Esta fase no
despliega ECS, ALB, RDS, Redis/Valkey ni Wazuh. El Worker sigue arrancando como
proceso de ciclo de vida sin consumir BullMQ; publicar su imagen no significa que
el procesamiento asíncrono esté implementado.

## Destrucción

`terraform destroy` no debe ejecutarse hasta confirmar que el estado contiene
únicamente recursos de demo. El bucket de state, provider OIDC y role IAM están
fuera del stack. La Fase 3 (aún sin apply) configura PostgreSQL con final snapshot
omitido y Valkey sin snapshots para facilitar teardown breve; esto implica perder
los datos de prueba. Para conservarlos, habilitar deletion protection y final
snapshot de PostgreSQL, exportar/verificar la información necesaria y luego
retirar la protección de forma controlada.

## Fase 3 — base de datos y egress privado (aplicación reportada; state pendiente de re-auditar)

El diseño y Terraform de esta fase añaden RDS PostgreSQL 18.6 Single-AZ
(`db.t4g.micro`, gp3 cifrado de 20 GiB, `rds.force_ssl=1`, backup de 1 día,
secreto master administrado por RDS), ElastiCache Valkey 8.0 con un nodo
`cache.t4g.micro` (TLS obligatorio, AUTH y cifrado en reposo), y conectividad
privada de runtime. La versión PostgreSQL coincide exactamente con Compose
(`postgres:18.6`) y ADR-016. La autenticación de Valkey usa un password temporal
generado por un recurso efímero y los campos write-only de Terraform; la misma
operación introduce el token en Secrets Manager. El valor no está en git, plan,
state ni outputs.

RDS/Valkey usan solo las dos data subnets `10.0.32.0/24` y `10.0.33.0/24`. RDS
solo recibe TCP/5432 desde SG API/Worker; Valkey TCP/6379 desde API/Worker. RDS
force SSL queda activado; la conexión futura debe usar el endpoint DNS, TLS
`verify-full` y el CA bundle RDS actual. La API valida TLS a nivel de perfil,
pero todavía hay que demostrar validación de CA/hostname en su driver. Valkey se
consume por endpoint privado `rediss://`, con AUTH desde su ARN de Secrets
Manager; su compatibilidad real con la versión de ioredis/BullMQ del repositorio
requiere smoke de conexión tras apply. No hay snapshots de Valkey porque se trata
de cache/cola reconstruible; su caída única deja el servicio sin cache/cola hasta
recuperación. PostgreSQL master sirve para bootstrap, no para usuario ordinario de
API: crear un principal de aplicación de permisos mínimos y su secreto runtime
antes de ejecutar la API.

Se elige S3 Gateway Endpoint gratuito más cuatro Interface Endpoints: ECR API,
ECR DKR, Secrets Manager y CloudWatch Logs. Private DNS habilitado; endpoints en
las dos application subnets; su SG acepta TCP/443 solo desde SG KrakenD/API/Worker,
y esos runtimes solo egresan TCP/443 al SG de endpoints. S3 se asocia a la route
table de app; las capas de imágenes ECR descargan desde S3 a través de esta ruta.
CloudWatch queda para logs técnicos acotados, nunca raw SOC, payloads sensibles ni
evidencia. No se agrega STS: los tasks Fargate consumen credenciales del task role
por metadata; solo agregaremos endpoint STS si un servicio requiere AssumeRole.

Para cuatro horas, cuatro endpoints por dos AZ cuestan aproximadamente USD 0.32
antes de datos, frente a USD 0.18 de un NAT de una AZ más USD 0.045/GB procesado,
transferencia y potencial tráfico inter-AZ. Aunque ese NAT sería ~USD 0.14 más
barato bajo un volumen de datos muy bajo, introducimos endpoints para conservar
egress específico a servicios AWS sin salida web genérica. El endpoint S3 no tiene
cargo horario. El costo de los cuatro endpoints sería ~USD 58.40/730 horas. RDS
con compute, 20 GiB, secreto master y Valkey se estima ~USD 26/mes; secretos,
endpoints y almacenamiento llevan el delta Fase 3 a ~USD 85/mes. Precio real
depende de I/O, backups/snapshots, transferencia, créditos CPU, impuestos y free
tier; destruir al terminar la demo.

El plan remoto [Terraform Demo #14](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37412251901) terminó correctamente sobre `main` (commit `d95170532501290f5e445b91036a3e3133f475b3`): `terraform fmt -check -recursive`, `terraform validate` y `terraform plan` quedaron verdes. Delta de ese plan frente a los 87 recursos registrados entonces: **19 por añadir, 0 cambios, 0 destrucciones y 0 reemplazos**. Los 19 eran 3 recursos RDS, 4 Valkey y 12 de egress privado. [CI / required](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37412251883/job/112103959095) y [evidence](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37412551653/job/112103995310) también pasaron. Apply y Audit quedaron omitidos en ese run, aunque el usuario confirmó que Fase 3 se aplicó después. La auditoría posterior del state, en Terraform Demo #16, reportó una base distinta y propuso 44 adiciones; revisar la sección Fase 4 y reconciliar la divergencia antes de cualquier apply.

El plan de Fase 4 [Terraform Demo #18](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37418417341) quedó verde en fmt/validate/plan y propuso 44 adiciones: las 19 de Fase 3 más 25 de runtime. [CI / required #228](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37418417347) también terminó verde, incluyendo Trivy, contenedores, contratos KrakenD, calidad y CodeQL. No se ejecutó apply. Aunque el usuario confirmó que la Fase 3 se aplicó, el plan remoto propone de nuevo sus 19 recursos; reconcilia el estado real de AWS y Terraform antes de desplegar para evitar duplicados.

Fase 3 no habilita por sí sola el runtime: la API todavía no tiene persistencia
PostgreSQL/S3 ni readiness de dependencias; Worker no consume BullMQ; la
integración real de datos/TLS/Valkey necesita smoke desde la aplicación; Wazuh
requiere salida aprobada hacia Microsoft 365. El usuario confirmó que Fase 3 se
aplicó después del plan #14, pero el state actual debe comprobarse con el nuevo
plan remoto de Fase 4. Esta fase no crea ECS, ALB, Wazuh, Grafana, Prometheus,
Loki ni runtime OpenTelemetry.
