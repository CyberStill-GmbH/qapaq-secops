# Sprint 3 — Entrega de C-16 a C-28

Fecha: 2026-10-01 · Alcance: operación SOC, autorización, auditoría, notificación,
consola, observabilidad, pasarela y evidencia del candidato.

Este documento registra qué se construyó, con qué se comprueba y qué permanece
bloqueado. No afirma que un componente esté `DONE` por existir: cada afirmación tiene
un comando que la reproduce, y lo que depende de un acceso externo se declara `BLOCKED`
con dueño y fecha en [`blocked-gates.json`](../project-management/c-22/blocked-gates.json).

## Qué se construyó

| ID | Ruta | Qué hace | Specs |
| --- | --- | --- | --- |
| C-16 | `modules/detection` | Priorización con reason codes y promoción idempotente por `(tenant, evento, versión de ruleset)` | `modules/detection/test` |
| C-17 | `modules/soc` | Alert/Incident, transiciones, triaje, concurrencia por revisión y unidad de trabajo atómica | `modules/soc/test` |
| C-18 | `modules/access` + BFF `apps/api` | OIDC/PKCE, validación de `id_token` RS256, sesión opaca, capabilities y autorización por recurso y campo | `modules/access/test`, `apps/api/test` |
| C-19 | `platform/audit` | AuditEvent append-only, cadena de hash por tenant, archivo JSONL con digest y reconciliación | `platform/audit/test` |
| C-20 | `modules/soar` | Outbox, transporte Teams con timeout propio, reintento, fallo ambiguo, fallback y acuse QAPAQ | `modules/soar/test` |
| C-21 | `apps/web` | Consulta, detalle, triaje y estados degradados contra la API real | `apps/web/test`, `tests/e2e/soc-vertical.spec.ts` |
| C-22 | `platform/testing` + `scripts/ci` | Matriz PASS/FAIL/BLOCKED atada a commit y ambiente, con decisión derivada | `platform/testing/test/release-evidence.spec.ts` |
| C-23 | `tests/architecture` + guía | Regla de acoplamiento a proveedor y conformidad del adapter real | `tests/architecture/provider-coupling.spec.ts` |
| C-25 | `modules/access` | Sesión única, red QAPAQ, cadena de proxies, passkey fuera de red, Smart Lockout y rate limit | `modules/access/test/network-lockout.spec.ts` |
| C-26 | `platform/observability` | Señales SOC, dashboards generados, alertas a destino externo, hardening, retención y plan de recuperación | `platform/observability/test` |
| C-27 | `packages/contracts` + `apps/web` | Catálogo de errores con `helpRef`, acción, `correlationId` y no enumeración | `packages/contracts/test/api-error.contract.spec.ts` |
| C-28 | `platform/gateway/krakend` | Perfil HA con balanceador, cuota por réplica con holgura N-1 y dashboard por ruta | `platform/gateway/krakend/test/ha.test.mjs` |

La persistencia de C-17/C-19/C-20 tiene migración, modelos Prisma y adaptadores
(`platform/database/src/soc-stores.ts`) con su contrato verificado sobre el SQL y una
suite de integración que corre cuando hay `DATABASE_URL`.

## Cómo se comprueba

```powershell
pnpm run test:unit                      # 589 specs
pnpm exec playwright test               # recorrido vertical en navegador
node --test platform/gateway/krakend/test/contract.test.mjs platform/gateway/krakend/test/ha.test.mjs
pnpm run boundaries ; pnpm run typecheck ; pnpm run build ; pnpm run smoke:built
node --import tsx scripts/ci/collect-release-evidence.mjs --environment <ambiente>
```

El recolector escribe
[`release-evidence.json`](../project-management/c-22/release-evidence.json) y
[`release-evidence.md`](../project-management/c-22/release-evidence.md) con el commit,
el ambiente y la decisión.

## Decisiones que conviene conocer

**La autorización vive en el caso de uso, no en el controlador.** Un cliente distinto de
esta API obtiene la misma decisión. La consola oculta lo que la API no envía; nunca al
revés.

**No enumeración.** "No existe" y "no tienes permiso" comparten código, estado y mensaje
(`RESOURCE_UNAVAILABLE`, 404). Lo mismo en el acceso: cuenta inexistente, bloqueada o sin
rol producen el mismo texto.

**El timeout de notificación es ambiguo, no fallido.** Un reenvío tras timeout conserva
el `client-request-id` para que el destino deduplique, en lugar de publicar dos tarjetas.

**`SENT` no es acuse.** El acuse humano es un estado aparte que alguien registra en
QAPAQ; que Teams responda 200 no significa que un analista lo haya visto.

**La cuota del gateway se dimensiona con holgura N-1.** Repartir el objetivo entre todas
las réplicas deja al conjunto por debajo del objetivo justo cuando una cae.

**La auditoría es append-only en la base.** Además de no exponer operaciones de
modificación en el puerto, la migración instala triggers que rechazan `UPDATE`, `DELETE`
y `TRUNCATE`.

## Emisor de identidad local

Para recorrer el flujo sin tenant, `QAPAQ_ACCESS_IDENTITY_MODE=local-development`
habilita un emisor que firma `id_token` con una clave efímera y publica su JWKS. El
código de validación es el mismo en ambos modos: solo cambia quién firma. El perfil de
producción rechaza ese modo al arrancar, y las rutas del emisor no se registran cuando
no existe.

## Límites declarados

- **Adaptadores en memoria en el BFF.** El runtime compone los stores en memoria que
  publican los módulos; los adaptadores PostgreSQL existen y están probados por contrato,
  pero su integración en el BFF y su suite con Docker siguen pendientes.
- **Entra, Wazuh y Teams reales** permanecen `BLOCKED`: hay specs que ejercitan la ruta
  completa con emisor local, servidor HTTP real y mock de indexador, pero la aceptación
  con el proveedor autorizado es gate de producto.
- **Failover y backup/restore en ejecución** están verificados como configuración;
  observarlos requiere Docker con capacidad para el perfil HA y el stack OSS.

[Plan por componentes](../project-management/component-delivery-plan.md) ·
[Sprint 3](../project-management/sprints/03-operacion-soc.md) ·
[Guía de extensión de proveedor](provider-extension-guide.md)
