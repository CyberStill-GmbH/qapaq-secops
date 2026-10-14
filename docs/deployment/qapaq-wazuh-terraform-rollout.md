# Migración de Wazuh a QAPAQ SecOps en AWS

## Estado

Preparación en la rama local `codex/deploy-qapaq-wazuh`. No se ha ejecutado `terraform
apply`, no se han cambiado valores de Secrets Manager y no se ha enviado tráfico a una
infraestructura nueva.

El cambio conserva la identidad de producto pedida: los dueños del grupo de admisión reciben
`qapaq.platform.admin`; la asignación individual de la persona SOC analista permanece en
`QAPAQ_ROLE_BINDINGS`; pertenecer al padrón de admisión no concede admin por sí solo. Los grupos
adicionales con rol admin requieren declaración explícita en `QAPAQ_ADMIN_GROUP_IDS`.

## Por qué el apply está bloqueado

El Terraform actual todavía no consume las ramas modificadas de OpenSearch Dashboards y Wazuh.
`module.wazuh_public` crea una sola EC2 Ubuntu e instala Wazuh oficial desde el instalador
asistido. No recibe un digest de la imagen QAPAQ, del Dashboard modificado ni de los plugins; la
EC2 tampoco tiene ASG, reemplazo gradual ni un volumen de Indexer separado que sobreviva al
reemplazo. Los digests de `runtime_image_digests` son solo API, Worker y KrakenD.

La última evidencia del workflow es Terraform Demo #50: el plan pasó, pero el apply falló después
de crear parcialmente RDS, Valkey, ALB, NAT, EC2 Wazuh y servicios ECS. La existencia y salud de
cada recurso debe reconciliarse contra AWS y el state antes de planificar cambios. La rama usa el
mismo backend `s3://qapaq-secops-terraform-state-955200662475/demo/terraform.tfstate`; una rama
separa el código y el historial de Git, pero **no** aísla el state ni los recursos de AWS.

El workflow `terraform-demo.yml` fue ajustado para que `apply` solo verifique que el secreto Entra
existente tenga una versión `AWSCURRENT`; ya no publica valores de GitHub a Secrets Manager. No
leer ni reemplazar secretos durante esta migración. La carga o rotación explícita queda fuera del
workflow de Terraform. El bootstrap SSM de Wazuh también puede publicar secretos si cambia la
versión del documento/asociación; revisar que el plan no los ejecute. Su script reutiliza
contraseñas cuando coincide el usuario guardado, pero genera otra si el secreto falta o el nombre
de usuario no coincide. Antes de cambiar ese bootstrap, debe agregarse una protección que falle
ante diferencias y evite crear una nueva versión de Secrets Manager con el mismo valor.

La zona declarada actualmente es `jappi.net.pe` y el dashboard es `wazuh.jappi.net.pe`. Cambiar la
zona raíz a `secops.net.pe` puede reemplazar la hosted zone y afectar delegación y registros. Antes
de añadir `qapaq.secops.net.pe`, hay que verificar en AWS quién administra `secops.net.pe`, su
delegación autoritativa, los registros actuales y el certificado TLS. No modificar la zona raíz
existente como atajo. La URI de callback y la URL pública de Entra siguen en `app.jappi.net.pe`;
el cambio de hostname del Dashboard no debe cambiarlas accidentalmente.

## Secuencia requerida

1. Compilar y probar los checkouts concretos del Dashboard, plugins/login y Manager; publicar
   artefactos inmutables por digest. El checkout local `qapaq-wazuh` es upstream limpio y no es el
   fork modificado.
2. Añadir al Terraform referencias a esos digests y una topología paralela resiliente. Mantener
   la EC2 y los datos actuales hasta validar salud, login Entra, roles, Indexer/Manager, ingesta y
   rollback. No cambiar `user_data` de la instancia vigente si eso causa reemplazo.
3. Auditar el state remoto y recursos vivos usando la identidad OIDC prevista. Guardar el plan
   exacto y detenerse ante destrucción/reemplazo de hosted zones, EC2/volúmenes, RDS, Valkey,
   ECR/S3 o secretos. Validar que el rol OIDC acepte la rama de despliegue antes de ejecutarla.
4. Crear y validar el hostname `qapaq.secops.net.pe` sin sustituir la zona existente; emitir y
   comprobar TLS y preparar el cutover con TTL/rollback.
5. Ejecutar plan y apply desde la rama solo después de que estén disponibles el artefacto, state,
   zona y rol OIDC correctos. Confirmar que el plan conserva secretos y recursos existentes, y
   validar funcionalmente la nueva instancia antes de retirar la anterior.

## Validación local de esta rama

Se ejecutaron `terraform fmt -check -recursive` y `terraform validate -no-color` con Terraform
1.16.5 y providers firmados por HashiCorp, inicializando con `-backend=false`. Pasaron `pnpm run
lint` y `pnpm run test:unit` (73 archivos, 888 tests). No se obtuvo identidad AWS en este
entorno: `AWS_PROFILE` apunta a un perfil inexistente, no hay proveedor de rol/metadata activo y
no se inicializó ni consultó el backend remoto. Por ello no hay plan AWS revisado ni apply.
