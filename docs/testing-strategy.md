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

Schemas JSON compartidos Node/Python y fixtures de cada adapter. Productores y
consumidores validan el mismo corpus: opcionales/null, enteros grandes, UTC,
versiones desconocidas, campos extra, límites y raw refs. Fixtures de vendor
sintéticos con casos válidos, 401/403/429/timeout, paginación, cursor vencido y
payload incompatible. No usar SDK mock como prueba de contrato real.

Prueba autorizada separada contra sandbox confirma API/version/licencia y scopes;
no es requisito para que tests locales corran sin acceso a Qapaq. Registrar qué
parte quedó sin verificar y no llamar «integración funcional» al fake.

## E2E

Identidad de prueba → política → fuente fake → raw/manifiesto → normalización →
detección → alerta → incidente/case → exportación autorizada y auditoría.
Añadir rutas deny, object-level access y revocación. UI ocultando botones no cuenta
como prueba de autorización. Las rutas exactas nacerán del contrato de cada feature.
Antes de producción ejecutar los 27 escenarios de federación/autorización de
[ADR-017](architecture/identity-and-authorization.md), incluyendo tenant/issuer/
audience, PKCE/state/nonce, CSRF, scopes, SoD, step-up, revocación, raw y services.

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

Severidades/bloqueos/excepciones de CI se acuerdan con Seguridad; excepción con
dueño y vencimiento, no silenciamiento permanente. Cobertura numérica no sustituye
tests de autorización y fallos. [Verificación existente](verification.md) mantiene
checks sin configurar; no inventar PASS.

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
