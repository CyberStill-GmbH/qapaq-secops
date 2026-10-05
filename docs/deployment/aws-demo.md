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
consultó la cuenta `955200662475` y las AZ `us-east-1a`/`us-east-1b`. No se hizo
`apply`; la infraestructura sigue sin desplegar.

## Dockerfiles API y Worker: inventario para la siguiente fase

`apps/api` y `apps/worker` tienen scripts `build`/`typecheck`, pero no Dockerfiles.
Solo existe `platform/gateway/krakend/Dockerfile`, que empaca KrakenD CE y su
template; no es imagen de la app.

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

## Riesgos y costo de Fase 1

Los objetos de red y Security Groups de esta fase no añaden cargo horario fijo;
no se ha creado ningún recurso facturable de cómputo, balanceo, NAT o endpoint.
Riesgo principal: la topología privada no tiene egress para recuperar imágenes ni
leer secretos; la Fase 2 debe diseñar endpoints o salida antes de activar ECS.
Wazuh requerirá egress HTTPS autorizado para su integración saliente con M365. No
se abre aún porque Wazuh no se despliega en esta fase.
