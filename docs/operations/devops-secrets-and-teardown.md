# DevOps, secretos externos y retiro del demo

**Estado de verificación:** 6 de octubre de 2026. Este runbook separa la configuración observada de los pasos que requieren credenciales externas o autorización administrativa. No declara desplegados servicios que el state y los workflows disponibles no acreditan.

## Resumen de estado observado

| Superficie | Evidencia revisada | Estado |
| --- | --- | --- |
| GitHub main | b235a41029904f2cc807c9634fd5a2e196692382 | CI / required verde. |
| Terraform Demo | [run 37418984196](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37418984196) | fmt, validate y plan verdes; propuso 44 altas y Apply quedó omitido. |
| Vercel qapaq-secops | https://qapaq-secops.vercel.app; vercel env ls | Proyecto accesible; no hay variables de entorno configuradas. |
| AWS local | aws sts get-caller-identity | Sin credenciales locales; no se pudo consultar el state ni AWS directamente. |
| Microsoft 365 | Inventario de fuentes y ADR-024 | La vertical está definida, pero autorización y conexión real aún necesitan evidencia del tenant. |

La documentación de arquitectura contiene material de varias etapas. Para el estado operativo prevalecen los runs de Actions y el state remoto, no una afirmación de despliegue no respaldada por esos registros.

## Vercel

El frontend es estático y no debe recibir secretos de servidor. `QAPAQ_API_ORIGIN` es obligatorio en Production y se usa como origen del rewrite `/api/*`. Debe apuntar al backend por HTTPS con certificado confiable; no pongas secretos en esta variable. `apps/web/vercel.ts` falla el build de Production si falta, para que la aplicación no publique rutas `/api/*` que terminan en un 404.

No copiar a Vercel variables de PostgreSQL, Redis/Valkey, Wazuh, Microsoft 365, client secrets, claves, tokens ni credenciales de .env.local. Los secretos de acceso de usuario Entra y los de la fuente Microsoft 365 pertenecen al runtime de backend/Wazuh y al gestor de secretos de ese entorno.

### Configuración pendiente para habilitar el BFF

1. Provisionar y comprobar el origen backend HTTPS y su certificado.
2. Configurar `QAPAQ_API_ORIGIN` en Production con el origen HTTPS confiable y confirmar que Vercel aplica el rewrite definido para `/api/*`.
3. Publicar un nuevo deployment de Vercel.
4. Probar callback, sesión, cookie Secure, health y logout desde https://qapaq-secops.vercel.app.

No se crea un valor placeholder: un origen inventado o HTTP aparentaría conectar la consola mientras deja el BFF fuera de servicio o envía sesiones por una ruta no aprobada.

## Microsoft 365 → Wazuh

La ruta aceptada es Microsoft 365 → integración nativa de Office 365 en Wazuh → alertas en Indexer → QAPAQ. No se configura un cliente Microsoft Graph paralelo.

El inventario referencia secret://qapaq/microsoft/entra-app, pero esa referencia no prueba que exista un secreto cargado. La configuración necesita valores de tenant y aplicación, un secreto de cliente vigente y consentimiento administrativo del tenant. No se encontró la referencia materializada en una configuración accesible desde este checkout.

Para Office 365 Management Activity API, solicitar al administrador del tenant únicamente el permiso de aplicación ActivityFeed.Read requerido por el feed de actividad. El consentimiento debe ser revisado y concedido por el administrador autorizado de Microsoft 365/Entra (Franco, según la solicitud); habilitar además Unified Audit Logging en el tenant. La fuente oficial indica que el tenant admin debe otorgar consentimiento y que los tokens app-only subsecuentes usan client credentials: [Microsoft Learn: Get started with Office 365 Management APIs](https://learn.microsoft.com/en-us/office/office-365-management-api/get-started-with-office-365-management-apis), [referencia de Activity API](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference).

Después del consentimiento:

1. Guardar el client secret en Secrets Manager/Wazuh keystore, según el runtime que quede operativo. No guardarlo en Vercel, Terraform, Git ni logs.
2. Mantener tenant ID, client ID y autoridad como configuración no secreta; la credencial se consume mediante una referencia de secreto.
3. Configurar solo los datasets autorizados y documentar región/endpoint, retención, frecuencia, owner y ticket de consentimiento.
4. Validar token app-only, suscripción/lectura del feed, actividad sintética y alerta derivada en Wazuh. No marcar la fuente enabled/operativa por tener solamente una app registration.

## GitHub Actions y Terraform

- CI requerido: ejecución por push a main; no publicar imágenes ni desplegar servicios desde una comprobación fallida.
- Publicación ECR: workflow aparte, OIDC, repositorios allowlisted y tags de commit inmutables; el despliegue debe fijarse por digest.
- Terraform: backend S3 qapaq-secops-terraform-state-955200662475, key demo/terraform.tfstate, región us-east-1, cifrado y lockfile. El bucket de backend fue creado fuera de este stack y no está gestionado por el state demo.
- Los workflows usan OIDC; las credenciales temporales no se guardan en el repositorio ni en archivos tfvars.

El último plan disponible propuso 44 altas, 0 cambios y 0 bajas y omitió Apply. Por eso este checkout no acredita que Fase 4/5 estén presentes en el state actual. La cuenta de AWS no fue accesible localmente en esta sesión. No se afirma que los recursos hayan sido eliminados.

### Retiro controlado del stack

Ejecutar desde un workflow manual con OIDC y el state remoto vigente:

1. Ejecutar terraform init, validate y terraform plan -destroy.
2. Revisar el plan completo, incluidos recursos añadidos manualmente o importados después del último workflow. Terraform solo borra direcciones registradas en su state.
3. Confirmar respaldo/retención y vaciar explícitamente objetos/versiones S3 o imágenes ECR si impiden el borrado. No borrar datos silenciosamente.
4. Aplicar el plan destroy manualmente; volver a listar el state y auditar recursos etiquetados ManagedBy=terraform en us-east-1.
5. Conservar el bucket y el objeto de backend hasta confirmar el retiro y exportar la evidencia del state. Si también se quiere eliminar el backend, hacerlo en un paso separado: elimina evidencia y capacidad de administrar el state.
6. Verificar eliminación de NAT/EIP, ENIs, ALB, ECS, EC2, bases, buckets, ECR, IAM, Secrets Manager y Security Groups. KMS puede permanecer pendiente del periodo de eliminación de AWS después de solicitar su borrado.

La ausencia de credenciales AWS locales impidió ejecutar este procedimiento en esta sesión. No se alteró el state ni se ejecutó apply/destroy.

## Revisión de secretos y respuesta ante exposición

- Revisar nombres/ARNs y owners sin imprimir valores.
- Rotar un secreto si aparece en logs, historial Git, artifacts o variables de build públicas; redeployar consumidores y revocar la versión anterior.
- .env.local y .env están ignorados por Git. Mantenerlos fuera de commits y no copiar su contenido a Vercel ni a workflows.
- Adjuntar al cambio solo evidencia no sensible: commit, digest, workflow run, IDs de recursos y resultado de health checks.

## Referencias

- [CI/CD del repositorio](../ci-cd.md)
- [Operación y entrega](../deployment.md)
- [Vertical Microsoft 365 → Wazuh (ADR-024)](../adr/024-microsoft-365-wazuh-mvp-vertical.md)
- [Inventario de fuentes](../integrations/source-inventory.yaml)
- [Terraform AWS demo](../../infra/aws/README.md)
