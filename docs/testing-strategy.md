# Estrategia de pruebas

Estrategia funcional: diseño. Toolchain/metodología de capacidad: ACCEPTED por
[ADR-016](adr/016-toolchain-and-capacity-baseline.md). No hay tests de aplicación ejecutados.

U-001 está aceptada sin depender de ejecutar estas pruebas. Las pruebas posteriores
validan implementación contra sus módulos, ownership y lifecycles canónicos.

## Unit

Invariantes de Incident/Case/Alert, transiciones y concurrencia; cálculo de permisos
con scopes y revocación; detección/correlación determinista con reloj controlable;
parsers/normalizadores con entradas malformadas; mapping de errores y redacción.
Fakes de ports, sin red ni servicios de Qapaq. No tests que solo repitan propiedades
de una clase sin comprobar comportamiento.

## Integration

Con instancias desechables de versiones elegidas: transacciones PostgreSQL
estado+audit+outbox; claves únicas/inbox; Redis/BullMQ retries/locks y recuperación;
mappings/queries del indexador; object store/manifiestos. Probar rollback,
restricciones append-only con cuenta runtime, migraciones y restore. Emulador
S3/Azure no certifica WORM ni semántica exacta de producción.

## Contract

Los schemas Node/Python se prueban solo en investigación o al activar U-007; el MVP
no necesita levantar un runtime Python. Mantener fixtures de cada adapter. Productores y
consumidores validan el mismo corpus: opcionales/null, enteros grandes, UTC,
versiones desconocidas, campos extra, límites y raw refs. Fixtures de vendor
sintéticos con casos válidos, 401/403/429/timeout, paginación, cursor vencido y
payload incompatible. No usar SDK mock como prueba de contrato real.

Prueba autorizada separada contra sandbox confirma API/version/licencia y scopes;
no es requisito para que tests locales corran sin acceso a Qapaq. Registrar qué
parte quedó sin verificar y no llamar «integración funcional» al fake.
Los pilotos A/B son ese gate autorizado; los tests con fakes no los sustituyen.

## E2E

Identidad de prueba → política → fuente fake → raw/manifiesto → normalización →
detección → alerta → incidente/case → exportación autorizada y auditoría.
Añadir rutas deny, object-level access y revocación. UI ocultando botones no cuenta
como prueba de autorización. Las rutas exactas nacerán del contrato de cada feature.
Antes de producción ejecutar los 27 escenarios de federación/autorización de
[ADR-017](architecture/identity-and-authorization.md), incluyendo tenant/issuer/
audience, PKCE/state/nonce, CSRF, scopes, SoD, step-up, revocación, raw y services.
Ejecutar además los 20 escenarios de lifecycle de
[ADR-018](architecture/retention-privacy-custody.md): clasificación, cuarentena,
expiración aislada, hold, WORM, SHA-256/custodia, export, purga parcial, restore,
deletion ledger, residencia, aprobación y reconciliación.
Para fuentes, ejecutar los 15 escenarios de ADR-019 con entornos autorizados:
Wazuh/Microsoft sintéticos, normalización/procedencia, restart idempotente, replay,
`GAP_DETECTED`, expiración, correlación, lineage, ausencia de secretos, revocación
aislada, fallos independientes y distinción de evento/alerta/incidente.
Antes de producción ejecutar además las 25 pruebas de ADR-020: reinicios/fallos por
dependencia, backlog y drenaje con tráfico, restores, checkpoint/deletion ledger/
holds/audit/evidencia, SOAR sin doble efecto, modos read-only/ingest-only, rollback,
runbook cruzado, RPO/RTO medidos e informe de gaps.

### Gate U-006 — observabilidad y auditoría

Antes de producción ejecutar los 24 escenarios de ADR-021:

1. Mutación, estado y audit event quedan en una transacción.
2. Fallar el audit insert revierte la mutación.
3. El rol runtime no actualiza ni elimina audit events.
4. Secretos quedan redactados en logs y traces.
5. Jobs conservan `traceId` y `requestId`.
6. Métricas no contienen labels de alta cardinalidad.
7. La caída del Collector no detiene la aplicación.
8. La pérdida operacional incrementa sus contadores.
9. La caída del archive acumula outbox durable.
10. El atraso alerta antes del límite.
11. Recuperar archive drena completamente el outbox.
12. Se verifica el checksum del objeto almacenado.
13. Alterar un evento rompe la cadena de hashes.
14. Eliminar un evento produce gap de secuencia.
15. Duplicar un evento se detecta.
16. Un manifest con firma inválida se rechaza.
17. La rotación permite verificar manifests antiguos y nuevos.
18. Restaurar PostgreSQL anterior detecta rollback.
19. Reconciliación detecta eventos archivados ausentes en base.
20. Operaciones privilegiadas fallan cerrado al 95% del buffer.
21. Una alerta SEV1 llega a un canal externo a QAPAQ.
22. El runbook reconstruye la proyección de auditoría.
23. Un legal hold impide eliminar el archive afectado.
24. La evidencia registra RPO/RTO observado.

## Fallos, seguridad y rendimiento

Inyectar caída en cada frontera descrita en data-flow: object write/manifest,
outbox publish/mark, effect/ack; perder Redis y reconciliar; fuente desconectada;
índice caído; duplicados concurrentes; reloj desviado/evento tardío; poison payload;
backpressure/disco lleno; auditoría no disponible; replay con versión nueva.

Probar SSRF por URL/redirección, stored XSS en raw, query/command injection,
deserialización y decompression bombs en entornos acotados. Sin explotación
contra producción. SAST y scanners complementan, no sustituyen flujo/evidencia.

Cargas sintéticas siguen L1/L2/L3 y gates de
[toolchain y capacidad](architecture/toolchain-and-capacity.md). Medir ingreso,
drenaje, lag, memoria, búsquedas y restores. No fijar «soporta X EPS» sin
experimento reproducible con hardware/configuración documentados.

## Gates futuros

PR: oxlint/Prettier/typecheck, unit y contract relevantes; integración si toca
persistencia/cola/index/adapters; E2E de verticales críticas; import boundaries;
SAST, secret/dependency scanning. Vitest cubre unit/integration, Playwright E2E,
Testcontainers dependencias y k6 capacidad. Releases: migraciones/rollback compatible,
restore, inventario de dependencias, permisos y pruebas operacionales.
La aprobación de releases no habilita por sí sola la eliminación automática: el
gate de ADR-018 requiere ratificación de Legal/Compliance y evidencia productiva.

Severidades/bloqueos/excepciones de CI se acuerdan con Seguridad; excepción con
dueño y vencimiento, no silenciamiento permanente. Cobertura numérica no sustituye
tests de autorización y fallos. [Verificación existente](verification.md) mantiene
checks sin configurar; no inventar PASS.

## Gate ADR-023 — CI, release y despliegue

Probar los ocho escenarios de cierre de U-011: PR no confiable sin privilegios,
CI completa, candidato con digest/SBOM/attestation, aceptación del contrato, mismo
digest en staging, health checks negativos, rollback y evidencia auditable.
Contract tests verifican manifest de release y migraciones; una prueba de staging
usa el destino real autorizado. Hasta entonces publicación y despliegue siguen
bloqueados aunque CI y build funcionen.

## Gate U-010 — SecurityEvent

U-010 se cierra técnicamente cuando la implementación demuestra sus doce criterios:

1. JSON Schema Draft 2020-12 ejecutable para `qapaq.security-event` 1.0.0.
2. Diccionario de campos y taxonomía versionados.
3. Mapping `wazuh.alerts.severity/1.0.0` probado con corpus autorizado.
4. Un mapping piloto adicional probado sin reutilizar escalas de otro proveedor.
5. Corpus sintético con los escenarios canónicos de ADR-011.
6. Contract tests de productores y consumidores en CI.
7. Replay que conserva `eventUid`, renueva `recordId` y no duplica efectos.
8. Cuarentena/DLQ y reproceso con lineage y versiones.
9. Verificación de existencia y SHA-256 del raw.
10. Reporte de cobertura de perfiles ECS 9.5.0 y OCSF 1.9.0.
11. Rechazo de declaraciones de compatibilidad sin validación del perfil.
12. Aprobación conjunta de SOC/Desarrollo y Seguridad.

El corpus incluye eventos válidos y límites: Wazuh alerta/raw, autenticación M365,
alerta de identidad/correo, Cato, Sophos, finding, identidad sin ID nativo, replay,
lookalikes legítimos, tiempo ambiguo/tardío, extensión desconocida, exceso de
tamaño, secreto, JSON malformado, hash inválido y cambio de versión. Pruebas de
ejemplo no sustituyen muestras autorizadas de los pilotos.

## SOAR y Antifraude

Probar dry-run sin efectos externos, aprobación ligada a versión/targets/parámetros,
permiso vigente y trazabilidad de ejecución/ticket. Reintentos no deben duplicar
respuestas. Antifraude conserva permisos/reglas/entidades propios al reutilizar
casos y correlación; probar denegaciones cruzadas y explicación reproducible del
score. No se asumen fuentes transaccionales ni datos de clientes disponibles.

## Evidencia de entrega

Guardar commit/scope, entorno/versiones, comandos, resultados, fallos conocidos y
pruebas no realizadas. No guardar secretos/raw real en reportes. Diferenciar
validación documental, test simulado, test local con dependencias y prueba de
proveedor. [Validación de esta entrega](validation.md).

## Gate ADR-007 — capacidad Python dormante

El MVP verifica que ningún build, despliegue o flujo operativo dependa de Python.
La investigación puede probar schemas y benchmarks offline sin publicarse como
feature. La activación futura exige las 18 pruebas de
[analítica Python](architecture/python-analytics.md#pruebas-de-aceptación), además
de comparación contra baseline determinística, presupuesto, aislamiento y rollback.

## Gate ADR-022 — notificación crítica por Teams

Los contract tests validan payload allowlisted, adapter, códigos de error,
timeouts, cinco intentos, jitter e idempotencia. Integración cubre transacción
alerta/outbox, recuperación, estados y auditoría. E2E usa workflow o fake autorizado
para demostrar deep link con RBAC, acuse, escalamiento, fallback y p95. Los veinte
escenarios canónicos están en [notificaciones críticas](architecture/critical-alert-notifications.md#pruebas-de-aceptación). No se prueba contra un tenant real sin autorización.
