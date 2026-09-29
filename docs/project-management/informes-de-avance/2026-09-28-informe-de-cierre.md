# Informe de cierre del día — 2026-09-28

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 28 de septiembre de 2026

**Asunto:** Cierre de jornada — C-28 (gateway KrakenD) integrado en `main`; diagnóstico real de PBI-007 documentado; CI ampliado con gate obligatorio y verificación de formato

Este informe cierra la jornada del 2026-09-28 sobre `main` en el commit
**`3e10d73`** (`merge: integrate C-28 KrakenD gateway`). Complementa el
[Daily Scrum](../daily-scrum.md) y el
[informe de avance de hoy](2026-09-28-informe-de-avance.md), redactado antes
del mediodía; no lo reemplaza, lo cierra con lo ocurrido después.

> **Nota posterior.** El trabajo del día continuó después de redactarse este
> informe: el commit **`7e46282`** (`feat(platform): endurece lifecycle de
> secretos e ingesta`) incorporó **C-10**, **C-11** y **C-24** con sus suites
> locales y registró ADR-027. Lo que sigue describe el estado en `3e10d73` y
> se conserva sin reescribir, conforme a la convención de estos informes; el
> estado actualizado está en el
> [Daily Scrum del 2026-09-29](2026-09-29-informe-de-avance.md).

## Resumen ejecutivo

| Frente | Estado al cierre |
| --- | --- |
| C-28 — gateway KrakenD (contrato/baseline) | Implementado y fusionado en `main`; contrato local 6/6 PASS; integración local **no ejecutada** (Docker Desktop roto en este host); gate CI `c28-krakend` agregado como *required check* |
| PBI-007 (Microsoft 365 → Wazuh) | Sigue `BLOCKED`, pero con **diagnóstico real de causa raíz** documentado: credenciales Entra válidas, sin permisos de aplicación concedidos (`401 AF10001`) |
| CI / calidad | Job `c28-krakend` sumado al gate obligatorio; nuevo chequeo de formato Prettier acotado a archivos cambiados (`scripts/ci/check-format.mjs`) |
| Entorno local | Runbook de recuperación Docker Desktop/WSL ampliado; el bloqueo persiste hoy, no se resolvió |
| Decisiones administrativas previas (2026-09-24) | Documentadas formalmente hoy en `decisions/unresolved.md`: Microsoft 365 `enabled` sin gate técnico completo, y protección de rama no exigida en este timebox |

Ningún PBI se declara `DONE` en este informe. El avance de hoy es de
componente (`C-28`) y de diagnóstico (`PBI-007`), no de aceptación de PBI.

## C-28 — gateway KrakenD: contrato y baseline en `main`

Implementado en `platform/gateway/krakend/`: imagen oficial fijada
`krakend:2.13.11` (digest inmutable `TO_BE_PROVIDED`), `routes.json` como
allowlist contractual con únicamente dos rutas de lectura habilitadas
(`GET /wazuh/_cluster/health`, `POST /wazuh/_search`), `krakend.tmpl` en
Flexible Config, JWT RS256 con JWKS (`TO_BE_PROVIDED` en producción), CORS sin
origins, filtrado de headers internos vía Martian, filesystem de solo
lectura y capabilities retiradas, circuit breaker sin retries en el gateway
(la política de retries queda en el adapter). La invariante crítica de
ADR-026 se preserva: KrakenD no escribe a BullMQ ni decide idempotencia — la
admisión durable en PostgreSQL sigue siendo responsabilidad del adapter,
aguas abajo.

**Evidencia real ejecutada hoy:**

| Verificación | Resultado |
| --- | --- |
| `node --test platform/gateway/krakend/test/contract.test.mjs` | 6/6 PASS (allowlist de rutas, contrato de seguridad, CORS, timeout/rate finitos, dependencias de producción marcadas `TO_BE_PROVIDED`, dashboard Grafana normalizado) |
| `validate.ps1` (config check + `docker compose config`) | **No ejecutado localmente** — Docker Desktop sigue sin levantar el daemon en este host |
| `integration.mjs` (mock Indexer + JWKS efímero: 401/403/429/5xx/timeout/reset/404/recovery) | **No ejecutado localmente**, mismo motivo. Sí corre como parte del job `c28-krakend` en el runner de GitHub Actions, que sí tiene Docker sano |
| Benchmark local (`benchmark.mjs`) | Dos muestras loopback con mocks registradas en el README (292 req/s y 80 req/s, sin errores); explícitamente **no** es prueba de capacidad ni fundamento de SLO |

Por eso el propio [`platform/gateway/krakend/README.md`](../../../platform/gateway/krakend/README.md)
describe el estado como *"configuración y validación local implementadas;
producción bloqueada por insumos operativos"*, no como aceptación E2E. Lo que
sí es real y verificado localmente hoy es el contrato de rutas y seguridad
(6/6); lo que falta demostrar contra infraestructura real (LB, `SecretProvider`,
Indexer y JWKS corporativos) permanece explícitamente `TO_BE_PROVIDED` en
[`source-inventory.yaml`](../../integrations/source-inventory.yaml).

### CI: nuevo gate obligatorio y verificación de formato

El workflow `.github/workflows/ci.yml` incorpora el job **`c28-krakend`**
(allowlist de rutas, `docker compose config` y `integration.mjs` contra mocks
en el runner) y lo suma a la lista `required` del job `gate`: un PR o push a
`main` que rompa el contrato de KrakenD ya no puede fusionarse en verde de
forma incidental. Se agregó también `scripts/ci/check-format.mjs`, que corre
Prettier solo sobre los archivos cambiados respecto al commit base
(`FORMAT_BASE_SHA`), evitando que el checkout completo reformatee archivos no
tocados hoy.

### Lo que sigue bloqueado por Docker Desktop

El entorno local repitió el fallo conocido de sockets `dockerInference`/
`engine.sock` documentado desde el 2026-09-25. Hoy se amplió sustancialmente
el runbook en
[`docs/development/local-environment.md`](../../development/local-environment.md):
pasos de diagnóstico (`wsl --status`, `docker desktop diagnose`), ejecución
explícita del script de reparación existente, distinción entre caché de
build (`docker builder prune`, seguro) y limpieza destructiva (`docker system
prune -a --volumes`, factory reset, `wsl --unregister`, tocar `ext4.vhdx`
manualmente — explícitamente prohibidas), y criterio de escalamiento a
Infraestructura con Diagnostic ID. El bloqueo en sí **no se resolvió hoy**: el
runbook documenta cómo intentarlo con seguridad, no una reparación exitosa.
La consecuencia directa es que `validate.ps1` e `integration.mjs` de C-28
solo tienen evidencia real desde CI, no desde este host, hasta que Docker
Desktop vuelva a levantar.

## PBI-007 — diagnóstico real de causa raíz (Microsoft 365 → Wazuh)

Se ejecutó una verificación real, no documental, contra el app registration
de Microsoft Entra creado el 2026-09-22
(`secret://qapaq/microsoft/entra-app`):

| Paso | Resultado real |
| --- | --- |
| `client_credentials` grant — Microsoft Graph (`.default`) | `200`, token emitido, `roles: []` |
| `client_credentials` grant — Office 365 Management API (`.default`) | `200`, token emitido, `roles: []` |
| `GET /api/v1.0/{tenant}/activity/feed/subscriptions/list` (endpoint real del módulo `o365` de Wazuh) | **`401 AF10001`** — *"The permission set () sent in the request does not include the expected permission."* |

**Conclusión verificada:** el app registration autentica correctamente — no
es un problema de tenant, client ID ni secret. Microsoft valida permisos en
el servidor de recursos, no en la emisión del token, por lo que el token se
emite igual aunque no exista ningún permiso de aplicación concedido. Falta
exclusivamente: agregar el permiso de aplicación `ActivityFeed.Read` (Office
365 Management APIs) y otorgar **admin consent** sobre el tenant en Azure
Portal — una acción fuera del repositorio que ningún cambio de código puede
sustituir. El detalle completo, los pasos exactos pendientes y la
configuración objetivo (no versionada) del módulo `o365` de Wazuh quedan en
[C-10 — diagnóstico real de Microsoft 365 en Wazuh](../c-10/README.md) y en
[`decisions/unresolved.md`](../../decisions/unresolved.md).

Este diagnóstico es evidencia reutilizable, no un cierre: **PBI-007
permanece `BLOCKED`**. La próxima persona que retome esto no necesita
repetir la investigación, solo el consentimiento de administrador y la
re-prueba de los mismos tres pasos.

## Decisiones administrativas del 2026-09-24 — registradas formalmente hoy

Dos decisiones de Franco Clavo, tomadas el 2026-09-24 pero sin registrar en
`decisions/unresolved.md` hasta hoy, quedaron documentadas junto con el
diagnóstico de PBI-007:

- **Microsoft 365 pasa a `enabled`** en el inventario de fuentes por decisión
  administrativa del Product Owner, sin `approved_scopes`, `approval_ticket`,
  `dataset`, `api_version` ni `region` reales, y sin conexión mínima de
  lectura demostrada. Esto **no** satisface el gate completo de PBI-006, que
  permanece abierto en el Product Backlog.
- **Protección de rama en `main` no es requisito de este timebox**: Cesar es
  el único Developer, el repositorio es privado y los otros colaboradores
  configurados son cuentas propias, no terceros. La decisión es válida
  mientras se mantengan esas tres condiciones y se revisa antes de aceptar un
  colaborador externo real.

Ninguna de las dos cambia el resto del gate de CI (`discover`, `codeql`,
`secrets`, `filesystem`, `pnpm-audit`, `quality`, `entrypoints`,
`c04-postgres`, `c06-base`, ahora también `c28-krakend`, `containers`,
`gate`), que sigue aplicando a cada push.

## Backlog y estado vigente

- **Sprint 2** avanza con **C-28** cerrado a nivel de contrato/baseline
  (Sprint 3 hereda HA, rotación, failure modes, benchmark real y dashboards
  por ruta). **C-10** (adapter Wazuh) queda con diagnóstico de bloqueo
  externo documentado, sin código de adapter nuevo al cierre de este informe.
- **PBI-007** abre y cierra el día `BLOCKED`; la diferencia es que hoy el
  bloqueo tiene causa raíz verificada en vez de ser una suposición.
- **PBI-006** (Microsoft 365) sigue abierto en el Product Backlog pese al
  `enabled` administrativo; no se declara `DONE`.
- Ningún PBI se declara `DONE` en este informe.

## Riesgos y bloqueos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre permisos `ActivityFeed.Read` en el tenant Entra | `BLOCKED`, bloquea el Sprint Goal completo | Franco Clavo Santander (rol Application Administrator) | Otorgar el permiso y el admin consent en Azure Portal; re-ejecutar los tres pasos de verificación de C-10 |
| C-28: sin digest inmutable, LB, `SecretProvider`, JWKS ni Indexer reales | `TO_BE_PROVIDED`, bloquea HA/E2E de PBI-030 (Sprint 3) | Infraestructura / Cesar | Fijar versión y digest en el BOM; provisionar balanceador on-premises |
| Docker Desktop / WSL sigue sin levantar el daemon en el host de desarrollo | Activo, bloquea `validate.ps1` e `integration.mjs` locales de C-28 | Cesar | Ejecutar diagnóstico ampliado hoy documentado; escalar a Infraestructura con Diagnostic ID si persiste |
| C-08: integración real contra Wazuh Manager/Indexer autorizado | `BLOQUEADO`, gate obligatorio del E2E final del MVP | Cesar / Franco | Provisionar acceso real (tenant, credenciales, Docker o Railway funcional) |
| C-09: sin protección de rama ni CODEOWNERS activos | Riesgo de proceso aceptado explícitamente el 2026-09-24, no resuelto técnicamente | Cesar / Franco | Reevaluar si se incorpora un colaborador externo real |

## Confianza en el Sprint Goal

ÁMBAR, sin cambio de color respecto al informe de avance de hoy: C-28 suma
un componente real con contrato local verificado (6/6) a `main`, y el gate CI
ahora lo protege de regresiones. Pero el Sprint Goal formal —admitir una
alerta Wazuh real originada en Microsoft 365— sigue condicionado enteramente
a PBI-007, y hoy ese bloqueo pasó de ser una suposición a tener causa raíz
verificada con evidencia directa del servidor (`401 AF10001`). Eso acorta el
camino a resolverlo —una sola acción de administrador en Azure Portal—, pero
no lo resuelve: mientras no exista el admin consent, ni C-10 ni el Sprint
Goal pueden cerrarse con datos reales.

---

[Daily Scrum](../daily-scrum.md) · [Informe de avance de hoy](2026-09-28-informe-de-avance.md) ·
[Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[C-10 — diagnóstico real de Microsoft 365 en Wazuh](../c-10/README.md) ·
[Gateway KrakenD — README técnico](../../../platform/gateway/krakend/README.md) ·
[ADR-026 — Gateway KrakenD on-premises](../../adr/026-on-premises-krakend-provider-api-gateway.md) ·
[Decisiones sin resolver](../../decisions/unresolved.md) ·
[Informe de cierre de Sprint 1 (2026-09-25)](2026-09-25-informe-de-cierre.md)
