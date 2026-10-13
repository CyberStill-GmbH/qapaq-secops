# 09 · Plan de lanzamiento

El objetivo es lanzar en semanas, no en sprints de documentación. Cada fase deja algo usable y
termina en un **criterio de aceptación verificable en la demo AWS**, no en mocks. La evidencia es
el SHA, el comando, la versión del proveedor y la salida redactada, registrada en el PR.

## Fase 0 · Estabilizar (1–2 días)

| Tarea | Owner | Acepta cuando |
| --- | --- | --- |
| CI verde en `main` (`unit`, `boundaries`, `C-02` rotos desde `111b5d9`) | Codex | Los checks pasan |
| Commitear `GET /api/auth/introspect` (trabajo en curso en `main`) | Claude | Tests de `bff.spec.ts` verdes |
| Merge de esta rama (docs nuevos, `wazuh/` en la raíz, Grafana fuera) | Dueño | CI verde |

## Fase 1 · Plataforma unificada (semana 1)

| Tarea | Archivos | Acepta cuando |
| --- | --- | --- |
| Edge nginx con `auth_request` en el host Wazuh y `/soc` estático | `wazuh/edge/` y el workflow de aplicación | `curl` sin cookie da 302 a Entra. Con sesión, el dashboard abre como el usuario Entra con sus roles |
| Proxy auth en el Indexer y el Dashboard, más el mapeo de roles | `wazuh/indexer/security/`, `wazuh/dashboard/` | Un analista ve `wazuh-alerts-*` pero no puede gestionar la seguridad. Un admin sí |
| Marca QAPAQ | `wazuh/dashboard/opensearch_dashboards.qapaq.yml` y los assets | Login y header con la marca QAPAQ |
| Retención hot/warm/cold y repo S3 | `wazuh/indexer/ism/`, el bucket en `infra/aws` | `_plugins/_ism/explain` muestra la política. Un snapshot manual al repo responde OK |
| API → Indexer sin KrakenD | `apps/api` (base URL y basic auth del lector), `infra/aws/modules/runtime` | La fuente «Wazuh Indexer · alertas» se pone en verde. Se cierra `PROVIDER_RESPONSE_INVALID` |
| Retirar KrakenD, Valkey, worker y Vercel de Terraform | `infra/aws` | El plan muestra solo destroys esperados y el costo baja según [06](06-operacion.md) |
| Cambio de rol desde QAPAQ con revocación inmediata (`PUT /api/admin/users/:oid/roles`, SoD, aprobación para subir de rol) | El admin le baja el rol a alguien → esa persona pierde la consola y el dashboard en ≤ 5 s → al volver a entrar ve el rol nuevo. Todo queda auditado |
| Revocación por `accountEnabled=false` y por cambio de app role en Entra | Usuario sintético deshabilitado en Entra → sesión revocada en el siguiente ciclo de sincronización |
| Sesión única atómica (índice único parcial más transacción) | Dos logins concurrentes dejan exactamente una sesión `active` |
| Logs de API y ALB a Wazuh | `wazuh/manager/` (módulo AWS y decoders) | Un login QAPAQ aparece como evento en Discover |

**Resultado:** una URL, un login Entra, Wazuh con marca QAPAQ y casos QAPAQ en `/soc`.

## Fase 2 · Diferencial visible (semana 2)

| Tarea | Acepta cuando |
| --- | --- |
| Plugin `qapaq-ops` (navegación más contador en vivo) compilado para OSD 2.19.6 | Instala con `opensearch-dashboards-plugin install` y la categoría QAPAQ aparece en el menú |
| SSE `/api/changes/stream` | Una alerta nueva aparece en ≤ 3 s sin recargar, en la consola y en el contador |
| Detectores de Anomaly Detection más la lectura de resultados en `modules/detection` | Una ráfaga sintética de descargas crea una anomalía y sube la prioridad de las alertas de ese usuario, con la razón visible |
| Push `custom-qapaq` y `POST /api/ingest/wazuh` | Una alerta de nivel ≥ 7 llega a QAPAQ en ≤ 5 s. El pull no la duplica |
| Stores de OIDC, lockout y CSRF en Postgres y Secrets Manager | Dos réplicas de la API: el login funciona aunque el callback caiga en la otra |
| Secuencias M365 movidas a reglas Wazuh | Logtest pasa y `modules/detection` deja de duplicarlas |

## Fase 3 · SOAR gobernado (semanas 3–4)

| Tarea | Acepta cuando |
| --- | --- |
| Fencing token en el outbox | Test: el dueño viejo no publica después de un takeover |
| Step-up para aprobar | Aprobar sin una reautenticación reciente devuelve 401 `STEP_UP_REQUIRED` |
| `endpoint.block-ip` vía Wazuh AR | Sobre un agente sandbox: pedido → aprobado por otra persona → IP bloqueada → timeline y auditoría |
| Shuffle privado más `m365.revoke-sessions` | Contra un usuario sintético del tenant sandbox |
| Archivo WORM de auditoría en S3 con Object Lock | Un manifiesto firmado se verifica con `GET /api/audit/verify` |

## Fase 4 · Wazuh 5 (cuando haya GA)

Cluster nuevo (4.x no se puede actualizar in-place). Migración por snapshot, que hay que validar
porque la documentación de las RC se contradice. Plugin recompilado para OSD 3.6. Security
Analytics con Sigma. Searchable snapshots para el cold. Opcional: fork `qapaq-dashboard` para el
tema OUI.

## Fuera del plan

Threat intelligence con MISP, antifraude, fuentes nuevas por adaptador TS e ITSM. Cada uno entra
solo con una decisión nueva en [10](10-decisiones.md).
