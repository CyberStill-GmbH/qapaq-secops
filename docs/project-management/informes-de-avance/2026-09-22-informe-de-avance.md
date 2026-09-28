# Informe de avance — 2026-09-22

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 22 de septiembre de 2026

**Asunto:** Cierre de C-02, diseño y evidencia real de C-04, arreglo de CI

Preparado para el Daily Scrum de **2026-09-23**. Sprint 1 — Base ejecutable y
contratos (2026-09-19 → 2026-10-02). Facilitador: Cesar Adrian Guevara Salcedo.

Formato y vocabulario según [Daily Scrum](../daily-scrum.md) y
[Definition of Done](../definition-of-done.md): estados admitidos `PLANNED`,
`READY`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`. Un componente solo pasa
a `DONE` con specs y evidencia real; "casi terminado" queda `IN_PROGRESS`. Este
informe no reemplaza el registro diario en `daily-scrum.md`; lo alimenta.

## Resumen ejecutivo

`main` está sincronizado con `origin/main` (commit `7f0dc52`) y el pipeline de
CI (`CI Security`) pasa **completo**, incluido el `CI gate`, después de
corregir dos fallas reales detectadas hoy. Cinco componentes de Sprint 1 tienen
evidencia ejecutable (`C-01`, `C-02`, `C-03`, `C-05`, `C-07`); `C-04` avanzó de
diseño a evidencia real contra PostgreSQL (migración desde vacío, rollback y
una carrera concurrente), cubriendo parcialmente 3 de sus 7 criterios de
cierre; `C-06` avanzó de forma sustancial (harness de integración real, aún
sin digests reproducibles); `C-08` y `C-09` siguen `IN_PROGRESS` con evidencia
parcial. El hallazgo de enlaces rotos del reporte anterior ya se resolvió.

## Avance por componente

| ID | Estado | Evidencia |
| --- | --- | --- |
| C-01 — workspace | `DONE` | Install congelado, format, lint, typecheck y build reproducibles; verificado hoy de nuevo (ver captura). |
| C-02 — entrypoints | `DONE` (2026-09-22) | API/worker/web con lifecycle, health y composition roots propios, sin dependencias simuladas. Detalle completo en [`c-02-entrypoints.md`](../../development/c-02-entrypoints.md). CI job `entrypoints` verde, incluida la suite Playwright de arranque/recuperación en Chromium. |
| C-03 — configuración | `DONE` (2026-09-21) | Perfiles tipados, `SecretProvider`, fallo seguro ante configuración ausente. |
| C-04 — persistencia de admisión | `IN_PROGRESS` | ER de diseño cerrado en [`c-04-admission-er.md`](../../architecture/c-04-admission-er.md) y su [resolución de auditoría](../../architecture/c-04-mer-audit.md#resolución-documental-del-mer--2026-09-22). `platform/database/test/postgres-c04.integration.spec.ts` (real, contra PostgreSQL, `describe.skipIf(!DATABASE_URL)`) demuestra: migración desde base vacía con exactamente 7 tablas, rollback total tras una escritura fallida inyectada (7 conteos en cero) y una carrera concurrente resuelta a una sola escritura (1 fulfilled / 1 rejected). Cubre los criterios 1–3 de [cierre de C-04](../../architecture/c-04-admission-er.md#encaje-en-componentes-y-evidencia-para-cerrar-c-04) de forma parcial (un solo caso de carrera, no la matriz completa). Faltan los criterios 4–7: casos de rechazo (cruces de Source/tenant, IDs inválidos), identidad/replay, comando público de admisión y CAS de checkpoint, y evidencia adjunta desde CI. No se acepta como Done. |
| C-05 — contrato SecurityEvent | `DONE` | Schema JSON, catálogos, validador y corpus de 41 fixtures (válidos/inválidos) en `packages/contracts/src/security-event`; contract specs incluidos en los 180 tests unitarios verdes. |
| C-06 — entorno de integración real | `IN_PROGRESS` | Materializado parcialmente: `IntegrationEnvironment` (`platform/testing`) con `preflight/start/health/collectEvidence/stop`, perfiles `base`/`search`/`wazuh`/`full`, health real de PostgreSQL/Redis/MinIO vía Testcontainers, evidencia redactada y cleanup por etiquetas. `integration-environment.lock.json` tiene los digests en `null` — sin eso la evidencia no es reproducible en CI. OpenSearch y Wazuh permanecen `BLOCKED` (falta TLS y topología oficial). |
| C-07 — reglas de dependencia | `DONE` | `dependency-cruiser` + `scripts/check-entrypoints.mjs` activos: "no dependency violations found (91 modules, 110 dependencies cruised)" y "Entrypoint architecture: PASS" (ver captura). |
| C-08 — probe Wazuh | `IN_PROGRESS` | Solo existe el esqueleto `modules/connectors/src/infrastructure/wazuh-indexer-client.ts`; falta la suite de conformidad y la consulta real al Indexer autorizado. |
| C-09 — CI y ownership | `IN_PROGRESS` | Pipeline completo (`discover`, `codeql`×2, `secrets`, `filesystem`, `pnpm-audit`, `quality`, `entrypoints`, `containers`, `gate`) verde hoy. Pendiente: activar protección de rama en `main` — hoy mismo se empujaron commits directos sin bloqueo, lo que contradice el objetivo de "PR confiable/no confiable" de la aceptación de C-09. |

## Diagrama ER de C-04 y decisiones de diseño

![Diagrama entidad-relación de C-04 (admisión operacional)](../../architecture/assets/c-04-admission-er.png)

Siete tablas de admisión (`sources` → `source_checkpoints`/`ingestion_manifests`
→ `raw_event_references`/`event_inbox`/`outbox_messages` → `quarantined_events`),
renderizado directo del `schema.prisma` real, no un boceto aparte — ver
[`c-04-admission-er.md`](../../architecture/c-04-admission-er.md) para el
diccionario físico completo.

Decisiones de diseño cerradas hoy (resolución de la
[auditoría del MER](../../architecture/c-04-mer-audit.md#resolución-documental-del-mer--2026-09-22)):

- **Checkpoint minimalista:** `source_checkpoints` guarda solo el último cursor
  confirmado (CAS por `revision`); no persiste estados de pipeline.
- **Reutilización de raw acotada:** un `event_inbox` puede referenciar un raw de
  otro manifiesto, pero solo de la **misma** `Source` — nunca de otro tenant.
- **Cuarentena por FK compuesta:** `quarantined_events` cuelga de la combinación
  completa `(sourceId, manifestId, inboxId, rawEventReferenceId, recordId)`, no
  de una tabla independiente sin pertenencia verificada.
- **Outbox de un solo mensaje por manifiesto:** payload cerrado a 4 KiB, con
  solo `manifestId`; generalizarlo requiere nueva migración, no se improvisa.
- **Sin cascadas de borrado:** todas las FK son `ON DELETE/UPDATE RESTRICT`;
  evidencia y raw no desaparecen por una eliminación en cadena.
- **Contadores disjuntos:** `accepted_count`/`quarantined_count`/`duplicate_count`
  son una foto de admisión (`duplicate_count = 0` en esta entrega), no se
  recalculan por fallos posteriores del parser.

Estas decisiones cierran el diseño físico; **no** cierran C-04 como componente
— la verificación contra PostgreSQL real sigue **parcialmente** pendiente (ver
evidencia y bloqueos).

### Primera evidencia real de conexión y migración

![Prisma migrate deploy contra PostgreSQL real](assets/2026-09-22-prisma-migrate-deploy.png)

Salida real de `prisma migrate deploy` contra una instancia PostgreSQL en
`127.0.0.1:5432`, base `qapaq_secops`: reconoce la única migración en
`prisma/migrations` y reporta "No pending migrations to apply" (sin drift).
Esto confirma conectividad real y consistencia del estado de migración, **no**
sustituye los criterios de cierre restantes de
[`c-04-admission-er.md`](../../architecture/c-04-admission-er.md#encaje-en-componentes-y-evidencia-para-cerrar-c-04):
falta migración desde vacío con reaplicación por historial, rollback inyectado
tras cada escritura, carreras concurrentes, casos de rechazo (cruces de
Source/tenant, IDs inválidos, etc.) y evidencia adjunta desde CI. C-04
permanece `IN_PROGRESS`.

### Migración desde vacío, rollback y concurrencia — evidencia real

![C-04 — migración desde base vacía](assets/2026-09-22-c04-migration-test-success.png)
![C-04 — rollback y concurrencia](assets/2026-09-22-c04-rollback-concurrency-success.png)

`platform/database/test/postgres-c04.integration.spec.ts` (commit `f03ec2a`)
crea una base PostgreSQL temporal por ejecución, aplica `prisma migrate
deploy` desde vacío y verifica exactamente las 7 tablas esperadas; inyecta un
fallo a mitad de una transacción de admisión y confirma que las 7 tablas
quedan en cero filas; y lanza dos escrituras concurrentes del mismo comando,
verificando 1 `fulfilled`/1 `rejected` y un único registro persistido. Las dos
capturas corresponden a corridas separadas (cada una solo ejecuta el
subconjunto no-`skip` de esa corrida), no a una única ejecución con los tres
casos en verde simultáneamente. Cubre los criterios 1–3 de cierre de C-04 de
forma parcial: un solo escenario de carrera, no la matriz completa (checkpoint
concurrente, mismo comando repetido, etc.). Referencia:
[actualización de la auditoría del MER](../../architecture/c-04-mer-audit.md#resolución-documental-del-mer--2026-09-22).

## Incidencia de CI resuelta hoy

El pipeline en `main` fallaba en `secrets`, `entrypoints` y `quality` desde el
merge de C-02/C-04. Diagnóstico y corrección (commit `91529b7`, detalle en su
mensaje):

1. **`secrets` (gitleaks):** falso positivo de historial — un fixture sintético
   (`tests/smoke/support.mjs`) se llamó `secret` en un commit y se renombró
   después; gitleaks escanea todo el historial y seguía marcándolo. Se agregó
   `.gitleaks.toml` con un allowlist acotado a ese commit + archivo (`extend.useDefault`
   conserva el resto de reglas activas).
2. **`entrypoints`/`quality`:** faltaba `prisma generate` explícito antes de
   `typecheck`/`build`. El workflow instala con `--ignore-scripts` (correcto por
   seguridad), lo que también bloquea el postinstall de Prisma. Se agregó el paso
   `pnpm --filter @qapaq/database run generate` en ambos jobs. El error asociado
   `Parameter 'tx' implicitly has an 'any' type` era consecuencia del mismo
   problema (TypeScript no podía resolver `Prisma.TransactionClient` sin el
   cliente generado), no un bug de tipos independiente.

Verificado en el run real `35793054805`: los 9 jobs aplicables y el `CI gate`
terminaron en `success` (`codeql` incluido en ambos lenguajes).

## Hallazgo: enlaces rotos en el merge de C-06 (ya resuelto)

El commit `f6659fc` (`feat(c06): audita pipeline y documenta entorno de
integración`) había agregado referencias en `docs/README.md` y `docs/ci-cd.md`
a tres documentos inexistentes. El commit posterior `7a902fe`
(`docs(c06): agrega auditoria de completitud y guia operativa`) los creó:

- [`docs/development/integration-environment.md`](../../development/integration-environment.md).
- [`docs/architecture/c-06-integration-testing.md`](../../architecture/c-06-integration-testing.md).
- [`docs/architecture/c-06-completeness-audit.md`](../../architecture/c-06-completeness-audit.md).

Los tres enlaces ya resuelven; no queda pendiente de este hallazgo. El
`CI Security` de ambos merges (runs `35797942905` y `35798906627`) terminó en
`success` completo.

## Evidencia de pruebas

Ejecución local de hoy (`main`, commit `91529b7`), después de `prisma generate`:

![Salida de typecheck, lint, boundaries y test:unit — 2026-09-22](assets/2026-09-22-test-output.png)

- `pnpm run typecheck`: 8/8 paquetes `Done`.
- `pnpm run lint`: 0 problemas (oxlint sin salida).
- `pnpm run boundaries`: sin violaciones de dependencia (91 módulos, 110
  dependencias) y arquitectura de entrypoints `PASS`.
- `pnpm run test:unit`: **180 tests, 13 archivos, todos en verde**, 9.53 s.

Esta captura corresponde a una ejecución real local, no a un run de CI; el run
de CI equivalente es `35793054805` (enlace en la sección de CI/CD).

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| Tenant, permisos, Wazuh/Indexer y secretRefs de Microsoft 365 | Por confirmar | Franco Clavo Santander | Fecha objetivo no posterior al 2026-09-25 (PBI-006), sin la cual C-08 no puede cerrar. |
| C-04 con evidencia parcial contra PostgreSQL real | Riesgo activo | Cesar | Migración desde vacío, rollback y una carrera concurrente ya demostrados hoy; faltan casos de rechazo (cruces de tenant, IDs inválidos), identidad/replay y evidencia adjunta desde CI para cerrar los 7 criterios. |
| Protección de rama en `main` no configurada | Riesgo de proceso | Cesar / Franco | Definir política de PR obligatorio antes de que más de una persona escriba en `main`. |

## Ajuste propuesto para el Daily Scrum de mañana (2026-09-23)

1. C-06 avanzó hoy (harness `IntegrationEnvironment` en `platform/testing`);
   falta resolver digests reales en `integration-environment.lock.json`,
   corregir los tres enlaces rotos que dejó su merge y decidir si el perfil
   `base` ya es suficiente para desbloquear evidencia real de C-04.
2. No declarar C-04 `DONE` en ningún reporte hasta cubrir los 7 criterios de
   cierre completos — hoy se demostraron 3 (migración desde vacío, rollback,
   una carrera concurrente); faltan casos de rechazo, identidad/replay,
   comando público de admisión y evidencia adjunta desde CI.
3. Escalar a Franco el acceso Microsoft 365/Wazuh si no hay avance para el
   2026-09-25, según lo ya registrado en `daily-scrum.md`.
4. Mantener el límite de WIP de dos componentes; hoy se tocaron efectivamente
   C-02 (cierre) y C-04 (diseño+código parcial) más la corrección de CI, que
   no cuenta como un tercer componente de negocio.

[Daily Scrum](../daily-scrum.md) · [Plan de componentes](../component-delivery-plan.md) ·
[Product Backlog](../product-backlog.md) · [Definition of Done](../definition-of-done.md) ·
[Run de CI](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/35793054805)
