# C-24 — Control plane write-only de secretos

Estado: **DONE** · Referencia: PBI-029 · Decisión: ADR-027.

## Purpose

C-24 permite a un administrador autorizado crear, rotar y revocar credenciales de
tecnologías sin que QAPAQ se convierta en vault ni canal de extracción. El material
entra transitoriamente para `create` o `rotate`, cruza el puerto de lifecycle y se
elimina de memoria; QAPAQ conserva solo referencia, fingerprint y metadata segura.

## Inspección y trazabilidad

| Requerimiento | Implementación existente | Gap encontrado | Cambio C-24 | Evidencia |
| --- | --- | --- | --- | --- |
| Configuración C-03 | schema, perfiles, loader, `SecretProvider.resolve`, `SecretValue`, redacción | no existía configuración de lifecycle | loader separado sobre las mismas primitivas | `runtime-config.spec.ts` |
| Boundary C-08 | port/adapters y errores tipados de proveedor | no aplicaba el contrato Wazuh | se conserva el patrón hexagonal sin acoplar C-24 a Wazuh | ADR-027 y contract suite |
| PBI-029 | ADR-013/025 exigían ref/fingerprint y write-only | no había lifecycle ejecutable | control plane, provider port, store port y adapter PostgreSQL | suites C-24 |
| Persistencia | Prisma/PostgreSQL C-04 | no existían tablas ni unit of work C-24 | cinco tablas metadata-only, transacciones y optimistic locking | migración + integración PostgreSQL |
| RBAC | ADR-009 capability-based | faltaban capabilities C-24 | cuatro capabilities explícitas, ninguna de valor | tests permit/deny |
| Auditoría | ADR-012/PBI-019 documental | faltaba journal inmediato del lifecycle | journal append-only acotado y atómico | contract SQL + canary |
| Observabilidad | logs/métricas por puertos | riesgo de DTO sensible y labels cardinales | eventos allowlisted de baja cardinalidad | leakage spec |
| CI | lint, typecheck, Vitest, PostgreSQL, CodeQL, gitleaks, Trivy | faltaba cobertura C-24 | suites descubiertas por jobs existentes; integración entra en evidencia PostgreSQL | workflow `quality` y `c04-postgres` |

La inspección incluyó claves, passwords, tokens, certificados, private keys,
client secrets y credenciales de connectors. C-24 no migra valores existentes ni
añade rutas runtime; establece la frontera para su lifecycle futuro.

## Threat model

Activos: material secreto, identidad del provider, referencias, clave de
fingerprint, metadata de ownership e historial de auditoría.

Amenazas: persistencia plaintext, extracción por API o debug, log/audit leakage,
serialización accidental, backups de credenciales, abuso de privilegios, lectura
por un administrador, diccionarios offline, carreras de rotación, retries que crean
versiones duplicadas y divergencia provider/DB.

Se asume que host, memoria de proceso o provider completamente comprometidos están
fuera de la protección de C-24. Se reduce la ventana en memoria y se separan
identidades, pero no se promete protección contra un proceso privilegiado que lea
su propia memoria.

## Trust boundaries y separación de funciones

```text
CONTROL PLANE
authorized administrator
  -> SecretControlPlane
  -> SecretLifecycleProvider (create / rotate / revoke)
  -> external secret backend
  -> PostgreSQL (reference / fingerprint / metadata only)

RUNTIME PLANE
workload identity scoped to one namespace
  -> C-03 SecretProvider.resolve(reference)
  -> external secret backend
  -> material only inside the consuming workload
```

- control-plane administrator: solicita lifecycle; no puede leer valores;
- runtime consumer: resuelve solo referencias de su namespace; no administra;
- auditor: usa `secret:read_metadata` y el journal; no resuelve ni exporta;
- infrastructure/backend operator: administra disponibilidad, políticas e
  identidades del backend; no obtiene rol administrativo QAPAQ implícito.

## Security invariants

- INV-01: secret values are never persisted.
- INV-02: secret values are never returned.
- INV-03: secret values are never logged, traced or used as metric labels.
- INV-04: secret values are never audited, queued, emitted or exported.
- INV-05: `REVOKED` cannot transition directly to `ACTIVE`.
- INV-06: every lifecycle attempt produces safe audit; successful metadata,
  receipt and audit commit atomically.
- INV-07: control plane has no runtime resolve capability.
- INV-08: retries with the same operation ID cannot create an additional version.
- INV-09: unknown external state is reported as reconciliation, never success.

## SecretProvider y lifecycle

El puerto administrativo se denomina `SecretLifecycleProvider` para no ampliar el
resolver C-03. Sus únicos métodos son `create`, `rotate` y `revoke`. El adapter debe
considerar una nueva versión activa y validada antes de devolver éxito; en Sprint 3
el contrato se ejecutará contra el backend elegido y verificará el switch antes de
revocar la versión anterior. No hay método de valor, export, dump o listado.

Transiciones:

```text
create:                 absent -> ACTIVE(version 1)
rotate: ACTIVE(version n) -> ACTIVE(version n+1), n -> SUPERSEDED
revoke: ACTIVE -> REVOKED
revoke retry: REVOKED -> REVOKED
rotate: REVOKED -> denied
```

`SecretMaterial` copia a bytes, impide reutilización, serializa como `[REDACTED]` y
sobrescribe el buffer en `finally`, también cuando falla el provider. El resultado
del provider solo contiene `providerRef`, `providerVersion` y expiry opcional.
Si autorización o validación rechazan antes de invocar el provider, el `finally` de
la operación destruye igualmente el material no consumido.

## Fingerprint

Formato: `hmac-sha256:v1:<64 hex>`. La clave independiente debe tener al menos 32
bytes, entra por `QAPAQ_SECRET_FINGERPRINT_KEY_REF` y se resuelve mediante C-03. No
se guarda junto al fingerprint. HMAC identifica cambios y evita verificación offline
con solo una copia de PostgreSQL; no es cifrado y no permite recuperar el secreto.
La versión del formato permite una migración explícita si cambia la primitive.

## Persistence model

Se almacenan exclusivamente:

- `managed_secrets`: UUIDv7, logical name, purpose, owner, classification,
  provider, status, current version, revision y timestamps/actores;
- `secret_versions`: secret ID, versión, provider ref/version, HMAC fingerprint,
  estado, creation/expiry/supersede/revoke metadata;
- `secret_lifecycle_operations`: idempotency ID, operación, secret ID, versión y
  completion timestamp;
- `secret_lifecycle_audit`: actor, acción, target, provider/ref, versión,
  fingerprint, timestamp, resultado, correlation ID y failure class;
- `secret_reconciliations`: operación, versión intentada, metadata segura, razón,
  actor/correlation y resolución futura.

No existen columnas para value, plaintext, password, API key, token, private key o
client secret. Las operaciones y auditoría tienen triggers append-only. El historial
no usa cascadas destructivas. UUIDv7, estados, referencias y fingerprints tienen
restricciones SQL. `PrismaSecretMetadataStore` implementa el unit of work y traduce
errores del SDK a códigos seguros.

La migration es aditiva y transaccional. Un rollback de aplicación conserva estas
tablas para no destruir historial; después de admitir escrituras se usa roll-forward,
no un down migration destructivo. La promoción productiva de Sprint 3 debe verificar
backup/restore en staging antes de habilitar lifecycle real.

**Secret plaintext persisted: NO.** Verificado en modelo, migration, writes en
memoria y todas las filas PostgreSQL de la integración mediante canario sintético.

## Authorization

- `secret:create`: alta;
- `secret:rotate`: nueva versión;
- `secret:revoke`: revocación idempotente;
- `secret:read_metadata`: metadata segura para administración/auditoría.

No existe `secret:read_value`. La ausencia de actor produce
`SECRET_UNAUTHENTICATED`; capability ausente produce `SECRET_FORBIDDEN`. Campos
inválidos no se reflejan en audit o logs: se sustituyen por identificadores seguros.

## Error model

La frontera pública usa códigos estables para request inválido, autenticación,
autorización, duplicado, not found, transición inválida, provider unavailable,
timeout/rejection, conflicto de rotación, fallo de revocación/persistencia y estado
externo inconsistente. Mensajes y stacks del SDK/backend no cruzan la frontera.

## Failure modes y reconciliación

| Provider | PostgreSQL | Resultado observable | Estado |
| --- | --- | --- | --- |
| fail/reject | untouched salvo audit seguro | error tipado, nunca ACTIVE falso | conocido |
| success | success | respuesta metadata-only | confirmado |
| success | fail | `SECRET_EXTERNAL_STATE_INCONSISTENT` + reconciliación | divergente explícito |
| timeout | unknown | timeout + reconciliación `PROVIDER_STATE_UNKNOWN` | incierto explícito |

Dos rotaciones o rotate/revoke parten de la misma `revision`; solo una transacción
puede avanzar. El perdedor registra `CONCURRENT_STATE_CHANGE`. Reintentar el mismo
operation ID devuelve el receipt sin invocar de nuevo al provider. Si el store está
totalmente caído, no se puede afirmar auditoría durable: se emiten log/métrica
allowlisted y la operación falla; nunca se marca éxito.

Runbook de reconciliación:

1. localizar por operation/correlation ID, nunca por contenido secreto;
2. consultar estado y versión mediante la interfaz administrativa segura del
   backend operada por Infraestructura, no agregando una lectura a C-24;
3. comparar provider ref/version y keyed fingerprint cuando sea posible;
4. completar metadata o revocar la versión huérfana mediante un procedimiento
   aprobado y auditable;
5. marcar `resolvedAt/resolvedBy`; no modificar audit u operation receipts;
6. escalar si la clave HMAC, identidad, referencia o estado no pueden demostrarse.

## Audit y observability

Eventos: `secret.create`, `secret.rotate`, `secret.revoke` con actor, target,
provider/ref, version, fingerprint, timestamp, result, correlation ID y clase de
fallo cuando corresponde. El journal C-24 no sustituye la hash chain y archivo de
PBI-019.

`SecretTelemetry` expone exclusivamente `phase`, `operation`, `provider`, `result`,
`failureClass` y `durationMs`; mide por separado provider y operación completa. De
estos eventos el adapter de observabilidad deriva
`secret_operations_total`, `secret_operation_failures_total`,
`secret_provider_latency`, `secret_rotation_total`, `secret_revocation_total` y
`secret_reconciliation_required_total`. Ref, fingerprint, actor y valor están
prohibidos como labels.

Diagnóstico seguro: usar correlation ID, operation ID, código tipado, provider
lógico, versión y reason de reconciliación. No habilitar body logging, request dump,
SQL row dump, stack externo ni endpoint temporal de debug.

## API security

El componente publica un servicio de aplicación, no rutas HTTP. La spec escanea el
control plane y `apps/api/src` para prevenir operaciones de lectura/exportación.
Una futura ruta de metadata puede exponer `SecretMetadataResponse`; jamás el command
de entrada ni `SecretMaterial`.

```text
GET secret value endpoint: NONE
Secret export endpoint: NONE
```

## Evidencia automatizada

Comandos de aceptación:

```powershell
pnpm exec vitest run --config vitest.config.ts platform/configuration/test/runtime-config.spec.ts platform/configuration/test/secret-control-plane.spec.ts platform/database/test/c24-secret-metadata.contract.spec.ts
pnpm --filter @qapaq/configuration typecheck
pnpm --filter @qapaq/database typecheck
pnpm --filter @qapaq/database validate
pnpm run verify
```

Con `DATABASE_URL`, `pnpm --filter @qapaq/database test` aplica las migraciones a
PostgreSQL aislado y ejecuta `postgres-c24.integration.spec.ts`. El job
`c04-postgres` ya invoca esa suite completa con una imagen fijada y evidencia
redactada; `quality` ejecuta unit, contract/security, lint, typecheck y boundaries.
CodeQL, gitleaks, dependency audit y Trivy permanecen como gates existentes.

Resultado local del 2026-09-28:

```text
pnpm run verify                         PASS
unit                                   PASS (528/528)
integration                            PASS (12/12, servicios reales)
typecheck                              PASS
boundaries                             PASS (155 módulos / 231 dependencias)
build                                  PASS
smoke                                  PASS (16/16)
database package con PostgreSQL real   PASS (28/28)
Prisma validate                        PASS
pnpm audit --audit-level high          PASS (0 vulnerabilidades conocidas)
```

El workflow conserva CodeQL, gitleaks y Trivy como gates remotos. No se registra
una ejecución remota inexistente: el estado anterior acredita el pipeline local y
la integración de C-24 en CI; el run de GitHub debe quedar verde en el commit/PR.

Cobertura:

- funcional: create, duplicate, rotation idempotente, múltiples rotaciones, revoke,
  repeated revoke, rotate revoked, RBAC, configuración inválida y errores tipados;
- concurrencia: rotate/rotate y rotate/revoke sin versión duplicada ni lost update;
- partial failure: provider failure/timeout, DB failure y estado incierto;
- contract: safe create metadata, changed rotation, idempotent revoke y no plaintext;
- security: no read-value/export, metadata-only schema, DTO no serializable, error
  externo hostil, request inválido hostil y canario ausente;
- leakage surfaces: DB, logs, audit, responses, events/queues, reconciliation y
  telemetry.

## Configuración e inventario

C-24 añade provider type, timeout y referencia de clave HMAC al schema C-03. No hay
credentials hardcodeadas. `source-inventory.yaml` conserva como `TO_BE_PROVIDED`:
backend, endpoint productivo, identidad, certificado, workload identity, fuente de
credenciales y política. No se seleccionó arbitrariamente un producto.

## Sprint 3 E2E

El E2E final, explícitamente planificado para Sprint 3, debe usar el adapter y
backend productivos aprobados —no el fake— y ejecutar el mismo contract suite. Debe
probar identidad de control plane, namespaces/least privilege, TLS/certificado,
create, validación real de la nueva versión, switch, revoke, retries/idempotency,
timeout ambiguo, caída PostgreSQL, reconciliación, denegación de lectura/export,
redacción end-to-end, restart y rotación sin fallback. La evidencia debe identificar
producto/versión, ambiente, commit y política sin revelar refs sensibles o valores.
Este E2E futuro forma parte del criterio previsto y no es deuda del alcance C-24.

## Files changed

- `platform/configuration/src/control-plane/*`: dominio, puertos, lifecycle, HMAC,
  RBAC, errores, auditoría y observabilidad;
- `platform/configuration/src/testing/*`: contract suite portable;
- `platform/configuration/test/*`: functional, concurrency y security specs;
- `platform/configuration/src/schema`, `profiles`, loader/types: integración C-03;
- `platform/database/prisma/*`: modelo y migration metadata-only;
- `platform/database/src/secret-metadata.store.ts`: adapter PostgreSQL transaccional;
- `platform/database/test/*c24*`: contracts e integración/leakage real;
- `platform/testing/src/preflight/docker-preflight.ts`: single-flight del probe
  Docker para eliminar flakiness de CI por preflights concurrentes;
- `docs/adr/027-*`: decisión y alternativas;
- `docs/integrations/source-inventory.yaml`: dependencias productivas pendientes;
- `platform/configuration/README.md`, `platform/audit/README.md`: límites operativos.

## Remaining risks

- backend, adapter e identidades productivas aún no están seleccionados; están
  correctamente diferidos al E2E de Sprint 3;
- un compromiso del host durante los milisegundos de tránsito puede leer memoria;
- una caída total de PostgreSQL impide auditoría durable local y exige alerta;
- rotar la clave HMAC requiere una estrategia de versionado/migración aprobada;
- PBI-019 aún debe integrar el journal C-24 con custodia/hash chain transversal.

## Final status

`C-24: DONE`
