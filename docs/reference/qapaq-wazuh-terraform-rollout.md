# Rollout de QAPAQ sobre Wazuh en AWS

## Estado y alcance

Este documento describe el rollout preparado en la rama unificada. **No registra un `terraform
apply` ni afirma que los cambios estén desplegados.** La infraestructura operativa y su state se
deben reconciliar antes de actuar. Un checkout o una rama nueva no aísla el state remoto ni los
recursos AWS.

El Dashboard Wazuh modificado sirve la interfaz y el login QAPAQ en
`https://qapaq-secops.jappi.net.pe`. Se elimina `apps/web` del repositorio y se retiran sus DNS
Vercel tras validar el corte. El primer apply mantiene `wazuh.jappi.net.pe` como alias de rollback
y deja los A records `app`/`codexpt`; un segundo plan los elimina después de las pruebas. Terraform
no elimina por sí solo el proyecto externo de Vercel. Se conservan `apps/api`, `modules/*`,
`platform/*`, PostgreSQL, KrakenD y Wazuh: el plugin depende de la API para Entra, sesión única y
revocación, casos Ayni Qapaq, auditoría y notificaciones Teams; la integración QAPAQ → Indexer
depende de KrakenD.

## Arquitectura de destino

- Dashboard/plugin/login QAPAQ en el host público `qapaq-secops.jappi.net.pe`.
- El host Wazuh sirve `/` localmente y enruta `/qapaq-api/` sobre HTTPS al ALB del API.
- La API TypeScript conserva las reglas de negocio y usa PostgreSQL como almacenamiento durable.
- Valkey se configura con alta disponibilidad para caché de eventos con TTL breve y señales
  BullMQ. El worker ECS procesa el outbox PostgreSQL; el polling del API sigue como fallback.
- KrakenD se conserva para la ruta de integración que lee/ingiere información desde Wazuh
  Indexer.
- `apps/web`/Vercel y su enrutamiento de frontend se retiran después de validar el cutover.

Valkey, BullMQ y su worker no sustituyen al outbox ni hacen durable el trabajo. Una caída de
Valkey debe permitir leer desde la fuente y retomar el outbox desde PostgreSQL. El plan Terraform
debe conservar API, KrakenD, RDS/datos, EC2 y volúmenes Wazuh, hosted zone, S3/ECR, roles OIDC y
secretos existentes.

## Gate de Entra y credenciales

El callback esperado tras el cambio de origen es exactamente
`https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback`. Antes de abrir el login con el
nuevo hostname, registrarlo y verificarlo en la aplicación Microsoft Entra. Este alta es un gate
externo; el código/Terraform no prueba por sí solo que Entra ya tenga la URI.

No rotar, regenerar, reemplazar ni volver a publicar el client secret ni secretos operativos
existentes durante este rollout. El workflow reutiliza las versiones vigentes de Secrets Manager.
El AUTH token de Valkey se crea solo si el servicio/secreto no existe; si existe fuera del state,
reconciliar/importar ambos antes de planear. Cualquier plan que reemplace una credencial o genere
una versión inesperada se rechaza y se investiga antes de aplicar.

## Secuencia de rollout

1. **Completar el candidato:** compilar y probar el Dashboard, login y plugin para la versión
   fijada por `wazuh/VERSION`; verificar assets; correr pruebas de API y worker. Confirmar que los
   Dockerfiles, CI, scripts, smoke tests y workspace ya no dependen de `apps/web`.
2. **Verificar Entra:** registrar y validar la URI exacta de callback. No continuar el cutover de
   identidad mientras falte este paso.
3. **Reconciliar AWS:** confirmar cuenta, región, identidad de despliegue, state remoto y recursos
   existentes. Guardar referencias de los recursos durables y de los secretos sin exponer sus
   valores.
4. **Preparar y revisar el plan:** comprobar que el DNS existente resuelve al host previsto, TLS,
   proxy `/qapaq-api/`, ALB/API, Valkey Multi-AZ y worker ECS. Inspeccionar todos los `create`,
   `update`, `replace` y `destroy`; permitir únicamente el A y CAA de
   `qapaq-secops.jappi.net.pe` para apuntar al Dashboard y autorizar Let's Encrypt. Exigir cero
   acciones sobre hosted zones, delegaciones, API, alias legacy y cualquier otro recurso
   `aws_route53_*`.
   Rechazar destrucción/reemplazo no previsto de hosted zone, EC2 o discos Wazuh, RDS, API,
   KrakenD, buckets, ECR, roles de despliegue o secretos.
5. **Primer apply:** crear solo el A/CAA del hostname QAPAQ, configurar Nginx y emitir el
   certificado Let's Encrypt por HTTP-01; conservar `wazuh.jappi.net.pe` como alias de rollback.
   El timer de Certbot renueva el certificado y el hook de despliegue recarga Nginx.
6. **Validar funcionalmente:** exigir HTTP 200 en Dashboard y API con validación TLS activa; probar
   Entra/cookie/logout/revocación, permisos,
   casos, auditoría, Teams, ingesta por KrakenD, cache miss/fallback y drenaje de outbox con
   worker. Confirmar logs y salud antes de eliminar los registros Vercel antiguos.
7. **DNS restante:** conservar los registros Vercel y el alias Wazuh. Su limpieza requiere un
   cambio posterior y autorización explícita; no borrar el proyecto Vercel con Terraform ni tocar la
   API.
8. **Cerrar con evidencia:** registrar SHA de imágenes, workflow, plan y pruebas. El rollback usa
   el alias conservado hasta completar la limpieza y nunca recrea ni rota secretos.

## Criterios de salida

- El login Entra funciona en el host nuevo con el callback registrado y la credencial anterior.
- El plugin cubre las vistas de QAPAQ y las operaciones usan la API TypeScript existente.
- PostgreSQL conserva casos, sesiones, auditoría y outbox; Valkey/worker mejoran disponibilidad
  sin convertirse en fuentes durables.
- KrakenD mantiene la integración con Wazuh Indexer.
- RDS tiene protección contra destrucción; no se elimina como parte del retiro del frontend.
- `apps/web`/Vercel ya no reciben tráfico del producto; el plan no destruyó recursos ajenos a su
  función.
- El workflow y sus validaciones pasan. Hasta tener esa evidencia, el rollout permanece pendiente.
