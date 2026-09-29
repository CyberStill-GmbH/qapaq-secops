# C-11 — admisión durable de telemetría

**Estado de entrega:** `BLOCKED — slice durable validado localmente; Definition of Done C-11 incompleto`
**Propietario:** `modules/telemetry`
**Dependencias:** C-04 (persistencia transaccional), C-06 (entorno de integración), C-10 (contrato neutral de proveedor).
**No habilita por sí mismo polling productivo ni un worker.**

## Propósito y límites

C-11 crea la frontera durable entre una página entregada por el contrato
`SecurityEventProvider` de C-10 y el procesamiento posterior. Admite páginas
neutrales de proveedor; no conoce Wazuh, OpenSearch, KrakenD ni la forma de una
API concreta. El módulo coordina objetos raw y usa el contrato público de C-04
para grabar manifiesto, inbox, outbox y checkpoint en una sola transacción.

```text
C-10 ProviderRecord[] + cursor
  → C-11 canonicalización acotada / SHA-256
  → object storage create-if-absent + lectura/verificación
  → C-04 PostgreSQL transaction:
      manifest + raw refs + inbox + outbox + checkpoint CAS
  → recibo durable al caller
```

Un registro se considera admitido únicamente después de que todos sus objetos
hayan sido leídos y verificados (bytes, tamaño y digest) y `commitAdmission` de
C-04 haya devuelto tras confirmar la transacción. La existencia del objeto sola
no equivale a admisión. No se publica directamente en Redis/BullMQ: el mensaje
`AdmissionDurable` queda en outbox para un dispatcher separado.

## Contrato de datos e integridad

- Límite: 1–500 registros por página, 262 144 bytes raw por registro y 5 MiB
  acumulados; son máximos contractuales C-04, no capacidad productiva validada.
- El objeto es `ProviderRecord.raw` serializado como JSON UTF-8 compacto,
  recursivamente con claves de objetos ordenadas por orden lexicográfico
  JavaScript; arrays conservan su orden. No se preservan bytes originales de la
  respuesta HTTP. Valores JSON no finitos, ciclos, prototipos no planos, claves
  de control / `__proto__` y profundidad mayor a 64 se rechazan.
- SHA-256 hexadecimal minúsculo cubre exactamente esos bytes UTF-8; no es firma,
  HMAC ni garantía de autenticidad. Referencia lógica `raw:<UUIDv7>`; clave S3
  compatible `raw/v1/<UUIDv7>`, sin datos del proveedor ni PII en la clave.
- El mismo `manifestId` UUIDv7, `manifestKey`, `receivedAt` y página exacta
  producen identidades de hijos deterministas; permiten repetir el mismo comando
  C-04 tras timeout o respuesta perdida. Una nueva recepción usa nuevos IDs.
  Cambiar contenido bajo la misma clave es conflicto de idempotencia, no update.
- Se almacena `ProviderRecord.raw`, no los bytes wire originales, y no se afirma
  canonicalización RFC 8785. La composición productiva debe mantener el formato
  compatible con C-10/C-05.

## Transacciones, orden y semántica

Object storage y PostgreSQL son fronteras separadas: no existe transacción ACID
distribuida. La escritura es create-if-absent; ante retry de un objeto existente
se comparan metadato SHA/tamaño y luego C-11 descarga el objeto con límite y
compara bytes y SHA-256. Sólo tras verificar cada raw se invoca C-04. En C-04
manifiesto, referencias, inbox, outbox y avance CAS del checkpoint comparten una
transacción PostgreSQL. Cualquier error revierte el conjunto relacional.

El checkpoint significa “todo hasta este cursor fue admitido durablemente”, no
“se intentó procesar”. Se actualiza sólo en la misma transacción que manifiesto
y outbox y sólo si `expectedRevision`, cursor previo, versión y generación pasan
el compare-and-swap. C-11 no interpreta el orden del cursor ni rellena gaps: la
semántica corresponde al proveedor/C-10.

Entrega: **at-least-once**, no exactly-once entre proveedor, object storage,
PostgreSQL y consumidor. Una respuesta perdida tras commit puede provocar retry;
C-04 devuelve el recibo previo cuando el comando preparado coincide. Una
relectura del proveedor es recepción nueva salvo política de replay posterior.

## Recuperación y reconciliación

Si se escribe raw y el proceso cae antes de C-04, puede quedar un objeto
huérfano. Se conserva; no se elimina en la ruta crítica ni por edad aislada. La
reconciliación debe comparar contra `raw_event_references` con ventana de gracia,
política de retención/hold y aprobación operacional antes de GC. Este corte no
implementa reconciler, retention worker ni GC: quedan `TO_BE_PROVIDED`.

Ausencia o diferencia de hash/tamaño/bytes produce `RAW_INTEGRITY_FAILED`, sin
invocar commit. Debe tratarse como incidente de integridad, preservar evidencia
y escalar; no reintentar indefinidamente ni sobrescribir. Errores de
disponibilidad de storage/DB son incidentes de disponibilidad. No serializar ni
registrar payloads, credenciales o causas que puedan contener secretos.

## Matriz de fallos

| Punto de fallo | Raw | Manifiesto/outbox | Checkpoint | Recuperación | Pérdida / cursor adelantado |
|---|---|---|---|---|---|
| Validación/límite antes de I/O | no escrito | no | sin cambio | corregir/releer | no / no |
| Put raw falla | parcial posible si respuesta ambigua | no se invoca C-04 | sin cambio | retry del mismo sobre | no / no |
| Verificación falta/mismatch | objeto preservado | no se invoca C-04 | sin cambio | incidente integridad | no / no |
| Caída luego de raw, antes de DB | raw durable huérfano posible | no | sin cambio | retry idempotente; reconciliar huérfano luego | no / no |
| Fallo manifiesto/inbox/outbox/CAS | raw durable; huérfano posible tras rollback | rollback C-04 completo | sin cambio | retry/conflicto CAS | no / no |
| Commit confirmado, ACK perdido | durable | durable | avanzado en misma TX | repetir comando exacto; recibo previo | no; duplicado controlado / no |
| Publish/caída después de publish | fuera de C-11; outbox durable | pending/retry por dispatcher futuro | ya confirmado | publisher idempotente futuro | outbox evita pérdida / no |

Las pruebas unitarias actuales cubren verificación fallida, orden antes de commit,
identidades estables, límite básico y propagación de fallo DB. La suite de
integración C-06 ejecutada localmente contra PostgreSQL + MinIO reales pasó el
happy path (incluye retry del mismo lote) y el fallo inyectado después de raw,
confirmando checkpoint estable. La matriz expresa además garantías del contrato
C-04; no equivale todavía a probar crash del proceso en cada instrucción.

## Seguridad, observabilidad y operación

Raw puede contener información sensible. Referencias opacas, sin payloads en
logs; el adapter S3 exige HTTPS por defecto (la excepción HTTP sólo acepta
loopback con opt-in explícito), bucket externo ya aprovisionado y no configura
por sí solo cifrado, versioning/WORM, lifecycle ni retención. En producción son
prerrequisitos que deben comprobarse con C-06/infra. SHA-256 detecta corrupción,
no sustituye firma/HMAC.

Esta biblioteca aún no emite logs ni métricas Prometheus. Al componer el worker,
instrumentar métricas de baja cardinalidad (`source_type`, `result`,
`failure_class`) y logs estructurados con `manifestId`, conteos y resultado; no
usar cursores/IDs como labels, ni evento/token en log. Outbox dispatcher,
backpressure global y reconciler no están implementados en este corte; el caller
debe limitar concurrencia.

Runbook inicial:

1. `RAW_PERSISTENCE_FAILED`: revisar salud/credenciales del object store y
   reintentar el mismo sobre con backoff acotado.
2. `RAW_INTEGRITY_FAILED`: detener retries automáticos, preservar objeto y
   evidencia redactada, escalar como incidente de integridad; nunca sobrescribir.
3. `DATABASE_ADMISSION_FAILED`: revisar PostgreSQL/C-04; reintentar el comando
   idéntico, conservando IDs, timestamps y cursor esperado.
4. CAS conflict: releer checkpoint y coordinar el fetch; no forzar cursor desde
   esta capa.
5. Objetos huérfanos: inventariar y comparar con refs tras grace period; no GC
   automático hasta aprobar retención, holds y reconciliación auditable.

## Tests y Definition of Done

`modules/telemetry/test/admission.spec.ts` cubre retry determinista, hash/bytes,
raw failure parcial, contenido manipulado (sin commit), fallo DB, payload
excesivo y página vacía. `s3-raw-store.spec.ts` valida HTTPS y la excepción
loopback de desarrollo.
`modules/telemetry/test/admission.integration.spec.ts` ejecuta con C-06
PostgreSQL + MinIO: migraciones, persistencia real, retry idempotente, outbox y
checkpoint en commit, y fallo DB después del raw sin adelantar checkpoint. C-04
mantiene aparte pruebas PostgreSQL de rollback, replay, CAS y concurrencia.

Evidencia local observada (2026-09-28):

```text
pnpm run format:check                                      PASS
pnpm run lint                                              PASS
pnpm run typecheck                                         PASS
pnpm run test:unit                                         PASS — 36 files / 528 tests
pnpm run boundaries                                        PASS
pnpm --filter @qapaq/telemetry build                       PASS
pnpm exec vitest run --config vitest.integration.config.ts \
  modules/telemetry/test/admission.integration.spec.ts     PASS — 2 C-06 cases
```

El job CI fue actualizado para ejecutar la suite C-11 después del perfil C-06;
su ejecución remota no es evidencia disponible desde este checkout.

Para `DONE` faltan crash fault injection en todas las fronteras, concurrencia
extremo a extremo del mismo stream, reconciliación segura, instrumentación y
pipeline CI completo (local completo no sustituye el resultado GitHub Actions).
No se afirma aceptación frente a proveedores reales, Wazuh o KrakenD. Estado:
**C-11: BLOCKED.** Bloqueantes para cumplir el DoD: fault injection/crash tests
en todas las fronteras, concurrencia extremo a extremo, reconciler conservador
con política de retención/GC aprobada, outbox publisher/retry policy,
instrumentación y resultado del pipeline CI remoto.

## Archivos

- `modules/telemetry/src/admission.ts` — límites, canonicalización, referencias,
  SHA-256, IDs de retry y orquestación durable.
- `modules/telemetry/src/s3-raw-store.ts` — adapter S3-compatible create-if-absent,
  HTTPS obligatorio (HTTP sólo con opción explícita en loopback), timeout
  opcional y lectura acotada.
- `modules/telemetry/test/admission.spec.ts` — pruebas unitarias/fallo de frontera.
- `platform/database/src/commit-admission.ts` — autoridad transaccional C-04,
  consumida vía puerto `AdmissionRepository`.
