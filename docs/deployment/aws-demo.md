# Despliegue AWS demo — estado por fases

Esta guía registra solo la **Fase 1: red y seguridad** de la arquitectura demo
[documentada aquí](../architecture/aws-demo.md). No declara desplegada ni lista
para ejecutar la aplicación.

## Fase 1: red y security groups

Terraform describe VPC `10.0.0.0/16`, dos subnets públicas, dos privadas de
aplicación y dos aisladas de datos; Internet Gateway, route tables y asociaciones;
y siete security groups de capas. CIDRs: públicas `10.0.0.0/24`, `10.0.1.0/24`;
aplicación `10.0.16.0/24`, `10.0.17.0/24`; datos `10.0.32.0/24`,
`10.0.33.0/24`.

No hay NAT Gateway. No hay API, Worker, KrakenD, ALB, RDS, Redis, S3, ECR, Wazuh,
observabilidad ni VPC endpoints en esta fase. Aunque el SG define las relaciones
que usarían esos tiers, los servicios no están creados.

Wazuh Dashboard está cerrado si `allowed_admin_cidrs=[]` (valor por defecto).
Solo el futuro ALB admite HTTP público de bootstrap; HTTPS es opcional y requiere
una fase posterior de listener/certificado. No se abren puertos Wazuh al mundo.

## Comprobaciones

Comandos requeridos desde `infra/aws`:

```sh
terraform fmt -check -recursive
terraform init -input=false
terraform validate -no-color
terraform plan -var-file environments/demo.tfvars -input=false -no-color
```

El plan real necesita identidad AWS; ejecutar `Terraform Demo` manualmente en
`main` mediante OIDC y revisar que solo contenga los recursos de Fase 1. No hacer
`apply` hasta revisar ese plan. No hay resultado `apply` ni prueba de conectividad
de aplicación.

Verificación completada en [Terraform Demo #2](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37339466733)
el 5 de octubre de 2026, sobre `main` en `us-east-1`: `fmt`, `validate` y `plan`
pasaron. El plan reportó 44 recursos por crear, ninguno por cambiar o destruir
(18 de red y 26 de security groups/reglas), y solo recursos de Fase 1. OIDC
consultó la cuenta `955200662475` y las AZ `us-east-1a`/`us-east-1b`. Después,
[Terraform Demo #3](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37340825790)
aplicó ese plan guardado desde `main`; el job terminó correctamente. Se crearon
solo recursos de la Fase 1, sin cómputo ni servicios de aplicación.

## Imágenes locales API y Worker

Se añadieron [`apps/api/Dockerfile`](../../apps/api/Dockerfile) y
[`apps/worker/Dockerfile`](../../apps/worker/Dockerfile), además del
[`.dockerignore`](../../.dockerignore) y sus targets de escaneo en
`.github/ci/containers.json`. Ambos usan Node 24.21.0 y pnpm 12.4.2 para
compilar, despliegue multi-stage filtrado por workspace, y un runtime Distroless
Node 24 Debian 13 fijado por digest sin shell ni package managers. Se ejecutan
como UID/GID `1000:1000` con contexto de monorepo. API expone 3000 con healthcheck
local; Worker no expone puertos. `scripts/docker/prune-deploy.mjs` quita material
de desarrollo y pruebas de los directorios runtime.

Antes de escribir Dockerfiles de producción hay que resolver y probar exactamente:

1. **Build del monorepo:** Node `24.21.0`, pnpm `12.4.2`, `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, `.npmrc`, configuración de TypeScript raíz y workspace
   filtrado. Verificar que los módulos internos referenciados (`@qapaq/*`) se
   compilan y empaquetan como runtime, con dependencias de producción solamente.
2. **Imagen API:** entrypoint `node` sobre el output de `apps/api` (script `build`),
   paquete `@qapaq/api`, puerto 3000, `QAPAQ_PROFILE=production`, host `0.0.0.0`,
   health path `/health/live` y shutdown SIGTERM con el límite ya implementado.
   No hay ruta `/health/ready` real de dependencias mientras los contribuidores
   de readiness estén vacíos.
3. **Imagen Worker:** entrypoint `node` sobre el output de `apps/worker`, paquete
   `@qapaq/worker`, sin puerto entrante, manejo SIGTERM y exit code al fallar.
4. **Contratos de configuración:** resolver `SecretProvider` real de runtime antes
   de entregar referencias `QAPAQ_*_PASSWORD_REF`, `QAPAQ_*_ACCESS_KEY_REF`,
   `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF`, `QAPAQ_WAZUH_CURSOR_SECRET_REF` y
   `QAPAQ_SECRET_FINGERPRINT_KEY_REF`. Definir acceso a RDS/Redis/S3, TLS/CA y
   endpoint; no pasar secretos plaintext en variables normales.
5. **Validación y supply chain:** `docker build` reproducible, ejecución como UID
   no root, filesystem/capabilities mínimos, health check real, SBOM/scan y digest
   inmutable en ECR. Fijar plataforma/arquitectura de CPU para ECS.
6. **Gateway:** la config actual requiere issuer/JWKS/audience, credencial read-only
   de Indexer y URL/CA Wazuh; esos insumos externos faltan. No inventarlos para
   conseguir que el contenedor parezca healthy.

## Validación de imágenes y límites de despliegue

Validación local realizada el 5 de octubre de 2026:

- `pnpm --filter '@qapaq/api...' run build` y
  `pnpm --filter '@qapaq/worker...' run build`: correctos.
- `pnpm run smoke:api`: 5/5; `pnpm run smoke:worker`: 4/4.
- Las primeras imágenes bookworm se construyeron y ejecutaron localmente como
  UID/GID 1000:1000; API respondió 200 en sus health endpoints y ambas terminaron
  limpiamente con SIGTERM. Esos tamaños/resultados no representan el digest
  Trixie actual.
- CI Security #202 confirmó que los tres builds Docker compilan, pero Trivy
  bloqueó las imágenes Node: detectó vulnerabilidades HIGH en npm incluido por
  la imagen Bookworm y CVE de paquetes del sistema. KrakenD pasó el escaneo. El
  cambio a Trixie quitó las CVE del npm base, aunque Trivy siguió encontrando
  CVE de util-linux/OpenSSL en la distribución. Por eso el runtime cambió a
  Distroless Node 24 sobre Debian 13. CI comprueba versión exacta `v24.21.0`,
  arranque/health/SIGTERM de ambos servicios y ejecuta Trivy. El workflow del
  commit más reciente debe confirmar los resultados de ese runtime.

Estas pruebas validan build y ciclo de vida local, no un despliegue. La API
todavía no demuestra conectividad con M365 ni con infraestructura AWS y el health
ready actual solo refleja estado del proceso porque no tiene contribuyentes de
readiness de dependencias. El Worker es un runtime inactivo de admisión: aunque
BullMQ/ioredis figuran como dependencias, el código actual no conecta Redis ni
consume colas. No se publica ninguna imagen en ECR.

La API smoke usó IDs ficticios y un URI de referencia de secreto, sin valores
secretos ni credenciales reales. No demuestra integración con Microsoft 365.
Además, las subnets privadas aún no tienen ruta de salida ni VPC endpoints, por
lo que Fase 1 no permite a ECS recuperar imágenes ni leer Secrets Manager. El
script local `infra:repair-docker` falló en el último reinicio: Docker Desktop
reportó que su engine WSL no respondió y el `docker-desktop` distro quedó
detenido. Por eso el runtime Distroless no se volvió a ejecutar localmente; CI
corre esa validación en runners limpios.

## Riesgos y costo de Fase 1

Los objetos de red y Security Groups de esta fase no añaden cargo horario fijo;
no se ha creado ningún recurso facturable de cómputo, balanceo, NAT o endpoint.
Riesgo principal: la topología privada no tiene egress para recuperar imágenes ni
leer secretos; antes de activar ECS, una fase posterior debe diseñar endpoints o
salida.
Wazuh requerirá egress HTTPS autorizado para su integración saliente con M365. No
se abre aún porque Wazuh no se despliega en esta fase.
