# AWS Terraform demo — fase 1

**Estado:** fase 1 de red y seguridad. No crea aplicación, datos, ECR, ECS,
Wazuh, observabilidad ni balanceador. No ejecutar `apply` hasta revisar el plan de
esta fase.

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
access keys permanentes. El workflow manual ejecuta formato, init, validate y
plan con `environments/demo.tfvars`.

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

### Verificación registrada

El workflow manual **Terraform Demo #2** terminó correctamente el 5 de octubre de
2026 sobre `main` (commit `def9f03`). OIDC autenticó en la cuenta AWS
`955200662475`, región `us-east-1`; Terraform resolvió las AZ
`us-east-1a` y `us-east-1b`. `fmt`, `validate` y `plan` pasaron. El plan mostró
**44 para crear, 0 para cambiar y 0 para destruir**: 18 recursos de red y 26 de
security groups/reglas. No incluyó API, Worker, KrakenD, ALB, RDS, Redis, Wazuh,
ECR, NAT ni endpoints. No se ejecutó `apply`; no hay infraestructura de esta
fase desplegada por este workflow.

Ejecución y salida: [Terraform Demo #2 en GitHub Actions](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37339466733).

## Costo, límites y siguientes gates

VPC, subnets, IGW, route tables, asociaciones y Security Groups no introducen un
cargo horario fijo. No se crea NAT Gateway, ALB, endpoints, instancia ni servicio
administrado en esta fase. Aplican cargos por transferencia de datos si se usan
recursos futuros.

La VPC pública no implica que todas las subnets/instancias tengan IP pública; las
subnets no asignan IP pública automáticamente. El SG público con HTTP pertenece a
la futura entrada ALB, que aún no se crea. Wazuh Dashboard permanece cerrado hasta
aprobar una CIDR/VPN administrativa.

Pendiente para desplegar aplicación: endpoints o egress explícito; permiso de
egress HTTPS del Wazuh Manager para Microsoft 365; elección de HTTPS/certificado;
reglas del Dashboard y acceso administrativo; imágenes OCI válidas para KrakenD,
API y Worker. El repositorio solo tiene Dockerfile de KrakenD. **API y Worker no
se consideran desplegables ni DONE.**

## Destrucción

La fase 1 no contiene datos persistentes ni recursos bootstrap. `terraform destroy`
no debe ejecutarse hasta confirmar que el estado contiene únicamente recursos de
demo; el bucket de state, provider OIDC y role IAM están fuera del stack.
