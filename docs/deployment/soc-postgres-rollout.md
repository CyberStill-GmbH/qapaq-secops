# Activar persistencia SOC en PostgreSQL

**Estado: código e infraestructura preparados; no desplegado.** El bootstrap de credenciales es recuperable ante fallos parciales (D-11, verificado contra PostgreSQL 18.6 con fallos inyectados). La infraestructura de demo se aplica por Terraform y GitHub Actions con OIDC; este runbook no ejecuta cambios en AWS.

## Diseño desplegado en código

- Una tarea Fargate `migrator` tiene dos modos (`bootstrap-roles` y `migrate`) y se ejecuta una vez por workflow; el API no aplica DDL al arrancar.
- Las tareas tienen execution roles distintos. Solo bootstrap lee la credencial master de RDS y escribe secretos; migrator lee la credencial `qapaq_migrator`; el API recibe solo la credencial `qapaq_soc_runtime`.
- Terraform crea los contenedores de Secrets Manager, no las contraseñas. Bootstrap genera credenciales, crea/ajusta roles SQL y genera la key HMAC de D-10b si no existe una versión vigente.
- La imagen API y la imagen migrator incluyen el bundle CA de RDS fijado por hash. PostgreSQL usa TLS con validación de certificado y nombre.
- `soc_database_enabled` deja el API en modo memoria hasta que la base esté preparada. El workflow one-off espera el estado terminal y el código de salida de la tarea.

El 2026-10-12 Claude reportó: PostgreSQL 18.6 SOC/dispatch 10/10, roles 7/7, `platform/database` 59/59 y Wazuh 4.14.7 48/48. Las pruebas de PostgreSQL encontraron y corrigieron la concesión `CREATE` que necesitaba el migrator para C-04; Wazuh corrigió la lectura de ambos formatos de la lista break-glass. Terraform valida y los workflows pasan validación YAML. Esta evidencia es de pruebas aisladas, no de despliegue ni aceptación en AWS.

## Bloqueos antes de activar

1. ~~Bootstrap recuperable~~ **Cerrado (D-11)**: `platform/database/migrator/bootstrap-protocol.mjs` publica cada contraseña candidata como `AWSPENDING` antes de tocar la base, la **reutiliza** si una corrida anterior quedó incompleta y promueve de forma idempotente. Con un fallo inyectado después del `COMMIT` y otro entre promociones, el reintento completa sin generar contraseñas nuevas y el `AWSCURRENT` de cada secreto abre sesión (`platform/database/test/migrator.integration.spec.ts`, 5/5). Ante un fallo, **repetir `bootstrap-roles` es el procedimiento de reparación**. Ventana conocida (sin usuarios alternados): desde el `COMMIT` hasta el redespliegue, las conexiones nuevas con la contraseña anterior fallan; el workflow fuerza `update-service --force-new-deployment` del API al terminar con éxito.
2. Confirmar `pnpm build` y CI del commit objetivo; la evidencia reportada de `platform/database` no sustituye el build de imágenes.
3. Completar y probar el runbook de backup, recuperación hacia delante y restauración. Una rotación exitosa exige redeploy de API y workers para que ECS lea los secretos nuevos.
4. Confirmar con una ejecución fallida que los logs de workflow, tarea Fargate y PostgreSQL no incluyen passwords, URL de conexión, valores de Secrets Manager ni `DATABASE_URL`.

## Secuencia de despliegue

Solo iniciar después de cerrar los bloqueos anteriores y revisar el commit objetivo.

1. Merge/push aprobado a `main` con CI verde y los cambios de admisión de persistencia resueltos.
2. Ejecutar `Terraform Demo` con `soc_database_enabled = false`. Crea los recursos y secretos vacíos; el API continúa en memoria.
3. Ejecutar `Publish verified images`. Registrar los digests API, worker y migrator; verificar que se originan del mismo commit.
4. Fijar los digests en el ambiente demo y ejecutar Terraform de nuevo para crear las task definitions one-off.
5. Ejecutar `Migrate SOC database` en modo `bootstrap-roles`. Confirmar salida 0 y eventos de aplicación de roles/promoción de secretos. Si falla, revisar el `errorCode` del evento `failed` y **volver a ejecutar `bootstrap-roles`**: reutiliza las candidatas pendientes y completa las promociones. El workflow redespliega el API al terminar.
6. Ejecutar `Migrate SOC database` en modo `migrate`. Confirmar salida 0 y eventos de migración/endurecimiento.
7. Aplicar un plan revisado con `soc_database_enabled = true`. ECS debe reemplazar API y workers para que consuman las versiones actuales de los secretos.
8. Verificar readiness, modo `postgres`, creación/lectura de alerta sintética, idempotencia al reingestar el evento y persistencia tras reinicio controlado.
9. Registrar commit, digests, resultado de migración, validaciones y aprobador en la evidencia del release.

## Recuperación y seguridad

- Si migración falla antes de actualizar el servicio, detener el rollout y reparar la migración; no arrancar el API con esquema parcialmente migrado.
- Antes de habilitar persistencia, tomar backup consistente y verificar su restauración. El rollback de aplicación a memoria no revierte las migraciones ni copia datos; puede dejar divergencia entre almacenes.
- No inyectar el secret master de RDS en API ni worker. No pasar secretos por Terraform state, variables de workflow o argumentos de proceso.
- La `QAPAQ_ENTITY_REF_KEY` de D-10b debe sobrevivir backup/restore exactamente. Su ausencia puede dejar refs opacas inutilizables; no rotarla automáticamente. Al habilitar persistencia, el API debe fallar cerrado o deshabilitar explícitamente pivotes hasta que la key vigente esté disponible.
- La rotación manual debe usar una operación recuperable, desplegar las tareas consumidoras y verificar conexiones antes de retirar credenciales anteriores.

## Referencias

- [Workflow de migración](../../.github/workflows/migrate-database.yml)
- [Tarea migrator](../../platform/database/migrator/entrypoint.mjs)
- [Roles y privilegios SQL](../../platform/database/bootstrap/roles.sql)
- [Diseño Terraform del migrator](../../infra/aws/modules/database_migrator/main.tf)
- [ECS: secretos como variables de entorno](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
- [RDS PostgreSQL: TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)
