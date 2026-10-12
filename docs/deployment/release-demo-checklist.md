# Checklist de release al demo AWS

Estado: **preparado; no desplegado**. Fecha: 2026-10-12. Consolida en un solo orden los
runbooks de persistencia ([soc-postgres-rollout.md](soc-postgres-rollout.md)), Microsoft 365
→ Wazuh ([infra/wazuh/office365](../../infra/wazuh/office365/README.md)) y el log sin query
del borde (C-12). Cada paso dice quién lo ejecuta y cómo se verifica. Un paso sin evidencia
no se marca hecho.

Lo que el código ya no puede adelantar: commit, push y merge, el dispatch de workflows y la
aplicación en AWS requieren al dueño del producto (credenciales OIDC de GitHub Actions).

## 0. Precondiciones en el repositorio

| # | Paso | Verificación |
| --- | --- | --- |
| 0.1 | Resolver el WIP de `platform/database/src/commit-admission.ts` (hoy no compila: importa fixtures de test, le faltan exports y tiene espacios sobrantes). Restaurar la versión de `HEAD` o terminar el cambio | `pnpm -r typecheck` y `pnpm --filter '@qapaq/api...' run build` sin errores |
| 0.2 | Suite local | `pnpm test:unit`; con `DATABASE_URL` de un PostgreSQL 18.6 efímero: `pnpm exec vitest run --config vitest.integration.config.ts modules/soc modules/soar modules/access` y `pnpm --filter @qapaq/database test` |
| 0.3 | Reglas Wazuh | `infra/wazuh/office365/tests/run-logtest.sh <contenedor wazuh-manager 4.14.7>` → 48/48 |
| 0.4 | Imágenes | `bash .github/ci/verify-container-images.sh` (API, worker, KrakenD, migrator) |

### Evidencia local registrada (2026-10-12)

Corrida en la estación de desarrollo con `commit-admission.ts` en su versión de `HEAD`:

- Unitarias: 716 pass (los únicos fallos son los 18 del WIP de `commit-admission.ts`).
- PostgreSQL 18.6: `@qapaq/database` 72/72; SOC+SOAR 11/11; sesiones 6/6; roles 8/8; migrator 5/5.
- Wazuh logtest 48/48; nginx C-12 en Ubuntu 24.04 OK; `terraform validate` PASS.
- API + web 113/113; contrato KrakenD 11/11; typecheck web PASS.
- Imágenes API y migrator construidas desde una copia limpia; smokes de `verify-container-images.sh` (sin Trivy) exit 0; bundle CA `/etc/qapaq` 0755 y archivo 0644, legible por el usuario 1000 en ambas.
- Contenedor migrator contra PostgreSQL: `migrate` aplica las 6 migraciones y una segunda corrida es idempotente (`migrate.applied`, `migrate.hardened`, `completed`).

Trivy, el worker y KrakenD se verifican en CI, no en esta corrida.

## 1. Integración

| # | Paso | Quién |
| --- | --- | --- |
| 1.1 | Commit y push de la rama; PR a `main` con CI `CI / required` verde | Dueño |
| 1.2 | Merge a `main`. Como toca `infra/aws/**`, `Terraform Demo` corre solo **en modo plan**: revisar el plan (sin reemplazos ni destrucciones inesperadas, en particular de la instancia de Wazuh y de RDS). Después, dispatch de `Terraform Demo` con `action = apply`: crea el repositorio ECR `qapaq-secops-migrator`, los secretos vacíos (`postgres/migrator`, `postgres/soc-runtime`, `api/entity-ref-key`, `wazuh/office365-client-secret`, `wazuh/break-glass-identities`), los roles IAM y el log group. **El API sigue en memoria** (`soc_database_enabled = false`); no se reemplaza la instancia de Wazuh | Dueño (revisar plan y lanzar apply) |

## 2. Imágenes

| # | Paso | Verificación |
| --- | --- | --- |
| 2.1 | `Publish verified images` (dispatch desde `main`) | Artefacto `image-manifest-<sha>.json` con 4 digests |
| 2.2 | Actualizar en `infra/aws/environments/demo.tfvars`: `runtime_image_digests` (API, worker, KrakenD), `runtime_image_manifest_commit` y `migrator_image_digest`. Commit a `main`, revisar el plan y dispatch `apply` | Nuevas task definitions del runtime y `…-migrator-bootstrap`/`…-migrator-migrate` |

## 3. Base de datos

| # | Paso | Verificación |
| --- | --- | --- |
| 3.1 | `Migrate SOC database` → `bootstrap-roles` | Código 0; eventos `bootstrap.roles_applied`, `bootstrap.candidate_promoted` y `bootstrap.entity_ref_key_created`. Si falla: **repetir el mismo modo** (D-11) |
| 3.2 | `Migrate SOC database` → `migrate` | Código 0; `migrate.applied` y `migrate.hardened` |
| 3.3 | `soc_database_enabled = true` en las variables del ambiente; commit a `main`, revisar el plan y dispatch `apply` | El API se redespliega con `QAPAQ_SOC_PERSISTENCE=postgres`, `qapaq_soc_runtime` y la clave de referencias |
| 3.4 | Verificar el API | Readiness 200; log `soc.persistence.postgres`; `GET /api/operations/health` como admin → `soc.persistence = postgres`, `platform.databaseLatencyMs` numérico; iniciar sesión, reiniciar el servicio y seguir con la sesión abierta |
| 3.5 | Verificar sesiones de administración (C-10(b)) | Como admin, `/admin/sessions` lista la sesión propia marcada como actual y sin botón de revocar; revocar una sesión de prueba de otro usuario deja `access.session.revoked` en auditoría y esa sesión recibe 401 en su siguiente request |

## 4. Microsoft 365 → Wazuh

| # | Paso | Quién |
| --- | --- | --- |
| 4.1 | Crear la app de Entra con `ActivityFeed.Read` y consentimiento de administrador; cargar el client secret en `qapaq-secops/demo/wazuh/office365-client-secret` y los UPN break-glass en `…/break-glass-identities` | Dueño de Microsoft 365 |
| 4.2 | `Configure Wazuh Office 365 collection` en modo `render` y después `apply` | Salida con `wazuh-modulesd:office365: INFO: Module Office365 started` |
| 4.3 | Actividad sintética controlada en el tenant (regla de bandeja de prueba en un buzón de laboratorio) | Alerta 100510 en el Indexer y alerta SOC en QAPAQ con `entities` y `signal = persistence` |

## 5. Borde y observabilidad

| # | Paso | Verificación |
| --- | --- | --- |
| 5.1 | `qapaq-api-no-query-logging` → `apply` (C-12) | `nginx -t` OK; un request con `?q=<marcador>` no deja el marcador en `/var/log/nginx` |
| 5.2 | Revisión de CloudWatch: logs del API y del migrator sin URLs, contraseñas ni UPN fuera de los campos previstos | Búsqueda del marcador vacía |

## 6. Cierre

- Registrar SHA, digests, salidas de los workflows y verificaciones en la matriz de evidencia (C-22).
- Gates que siguen abiertos aunque el demo esté arriba: recolección M365 con actividad real (ADR-024), entrega real a Teams, y las reglas marcadas `qapaq_pending_provider_evidence` hasta tener el registro real del tenant.
- Rollback: `soc_database_enabled = false` devuelve el API a memoria sin tocar la base; `qapaq-api-no-query-logging → rollback` restaura nginx.
