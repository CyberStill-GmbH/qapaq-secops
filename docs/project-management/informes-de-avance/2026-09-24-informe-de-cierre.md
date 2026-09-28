# Informe de cierre del día — 2026-09-24

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 24 de septiembre de 2026 (renovado con el cierre confirmado el 2026-09-25)

**Asunto:** Cierre de día — Sprint 1, C-04 confirmado y C-06 `DONE` con evidencia E2E real

Este informe consolida el trabajo de C-04 y C-06 sobre `main` hasta el commit
**`706fbec`** (`merge: actualiza Daily Scrum de cierre C-06`). Renueva la
versión anterior de este mismo informe: el cierre de C-06 llegó por PR #14
(`ec4d357`, todos los jobs de CI en verde) después de la primera redacción, así
que esta versión reemplaza las afirmaciones "C-06 `IN_PROGRESS`" / "sin run
remoto observado" de la anterior por el resultado final verificado. Complementa
el [Daily Scrum](../daily-scrum.md) y el
[informe de cierre de 2026-09-23](2026-09-23-informe-de-cierre.md); no los
reemplaza.

## Resumen ejecutivo

- **C-04**: `DONE`. Los dos bugs de test de pertenencia (conteos sin acotar y
  orden de inserción que violaba una FK compuesta) quedaron corregidos
  (`5ac1b25`, `394c51a`). Un tercer ajuste de fixture (`1c4d7cd`) fue necesario
  para que el job `c04-postgres` terminara realmente en verde en CI — ver
  detalle abajo. El run [36154234794](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36154234794)
  confirma C-04 PostgreSQL `PASS` en un commit limpio.
- **C-06**: `DONE`, con una excepción de capacidad aceptada explícitamente para
  el entorno de pruebas (no para despliegue). El perfil `base` pasó en CI con
  dos entornos concurrentes; OpenSearch QAPAQ 3.7.0 pasó TLS/CRUD/cleanup en
  Railway; Wazuh 4.14.7 completó el flujo Manager → pipeline → Indexer con el
  marcador sintético **recuperado por API** — a diferencia del piloto anterior
  del mismo día, que se había quedado en smoke por una sonda SSH que no abrió.

Ningún otro componente cambia de estado en este informe.

## C-04 — confirmación real en CI, no solo local

Los dos bugs de test reportados el 2026-09-24 quedaron corregidos:

- **`5ac1b25`** — el caso de rechazo por dataset comparaba conteos globales
  (`count()` sin `where`) en una base de datos temporal compartida por toda la
  suite; se acotó cada conteo a `sourceId: fixture.source.id`.
- **`394c51a`** — el caso de aislamiento de tenant insertaba el
  `rawEventReference` de la Source ajena antes de crear su
  `ingestionManifest`, violando la FK compuesta
  `raw_event_references_manifest_fkey`. Se invirtió el orden de inserción.

Al integrar el trabajo de C-06, apareció un **tercer problema real** en el
mismo archivo, encontrado y corregido en CI, no localmente: el fixture del
manifiesto de la Source ajena declaraba `eventCount: 0` / `acceptedCount: 0`
pese a llevar un evento admitido, lo que violaba una restricción de admisión
del comando. `1c4d7cd` (`fix(c06): destraba imagen MinIO en CI y fixture C-04`)
corrigió esos contadores a `eventCount: 1` / `acceptedCount: 1`. Con los tres
fixes integrados, el run de CI
[36154234794](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36154234794)
terminó **`PASS`** para C-04 PostgreSQL sobre el commit limpio `1c4d7cd7047e`.
Esto es lo que este informe no podía citar ayer: confirmación real de CI, no
solo razonamiento local sobre el esquema.

## C-06 — cierre `DONE` con evidencia E2E real

### Perfil `base`: PASS local y en CI

La suite `base-environment.integration.spec.ts` levanta dos entornos
`IntegrationEnvironment` concurrentes contra PostgreSQL, Redis y MinIO reales
(health, CRUD con hash SHA-256, aislamiento por etiquetas Docker y limpieza sin
recursos remanentes). Resultado: **10/10 pruebas PASS local**, y el mismo
resultado se reprodujo en CI en el run
[36154234794](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36154234794)
sobre el commit limpio `1c4d7cd7047e`, con dos entornos concurrentes reales
(Docker 28.0.4, 2 CPU, 7.75 GiB asignados). CI no podía descargar la imagen
MinIO anónimamente desde Quay (`401 unauthorized`); se fijó el harness al
mirror público `docker.io/tobi312/minio` por digest OCI, sin cambiar lo que la
prueba verifica (API S3 real).

**Salida real de Vitest (ejecución local, dos entornos concurrentes):**

![Captura renderizada desde stdout real de Vitest](../c-06/assets/2026-09-24-c06-vitest-output.png)

**Evidencia JSON de ambos entornos tras el cleanup:**

![Resumen visual de evidencias reales de ambos entornos](../c-06/assets/2026-09-24-c06-environment-evidence.png)

**Evidencia del mismo perfil `base` ejecutado en CI (run 36154234794):**

![Evidencia visual del run C-06 en CI](../c-06/assets/2026-09-25-c06-ci-evidence.png)

### Wazuh oficial local: preflight bloqueado por capacidad, no simulado

`scripts/dev/setup-wazuh.ps1` se ejecutó contra el prerequisito oficial local.
El preflight se detuvo **antes** de clonar el Compose o descargar imágenes:
12 CPU disponibles, pero 3.5 GiB de Docker frente a 8 GiB requeridos y 11 GiB
de disco frente a 50 GiB. No se descargó nada pesado ni se saltó la barrera.

![Salida real del preflight local Wazuh](../c-06/assets/2026-09-24-c06-wazuh-preflight.png)

### Piloto Wazuh en Railway: del smoke al E2E completo

El mismo día hubo **dos** corridas en Railway, con resultado distinto:

**Primera corrida (smoke, no E2E)** — Manager, Indexer y Dashboard llegaron a
`RUNNING`, con TLS sobre **DNS privado** de Railway (certificados con SAN
apuntando al hostname interno, no a uno público) y un intento de sonda por
**SSH cifrado** (`railway ssh`) para consultar el marcador sin exponer un
puerto público. La sesión SSH no abrió desde esta máquina, así que el marcador
`C06_RAILWAY_SYNTHETIC_20260925` no se pudo consultar por API en ese momento:

![Logs reales del smoke de Wazuh en Railway](../c-06/assets/2026-09-25-c06-railway-wazuh-smoke.png)

**Segunda corrida (E2E completo, commit `9adbbe33`)** — repitiendo la prueba
con acceso funcional, Wazuh `4.14.7` recibió una alerta sintética por **TCP
syslog**, la regla `100501` la procesó, y la sonda **sí confirmó el marcador
por API** en el índice `wazuh-alerts-4.x-2026.09.25`. OpenSearch QAPAQ `3.7.0`
pasó TLS verificado, health `GREEN`, CRUD autenticado y limpieza del índice de
prueba. El host de OpenSearch en esta corrida fue
`qapaq-opensearch-e2e.railway.internal` — un hostname **privado** de Railway,
no expuesto públicamente, consistente con la misma política de confidencialidad
de la primera corrida.

**Resultado esencial (JSON real, sin secretos):**

| Campo | Valor |
| --- | --- |
| `result` | `PASS` |
| `commit` | `9adbbe33c2961f83fb92d30fd683a9da0541e6c8` |
| Wazuh `sent` / `sendProtocol` | `true` / TCP syslog |
| Wazuh `ruleId` | `100501` |
| Wazuh `markerPresent` / `search` | `true` / `PASS` (5 intentos de consulta) |
| Wazuh `tlsVerified` | `true` |
| OpenSearch `health` | `GREEN` |
| OpenSearch `tlsVerified` / `crud` / `cleanup` | `true` / `PASS` / `PASS` |
| OpenSearch `host` | `qapaq-opensearch-e2e.railway.internal` (DNS privado) |

![Evidencia visual E2E real de Wazuh y OpenSearch en Railway](../c-06/assets/2026-09-25-c06-railway-full-e2e.png)

Al terminar de capturar la evidencia, el proyecto Railway temporal se
**eliminó** y la llave SSH efímera quedó **desregistrada**; no quedan
servicios ni credenciales de ese piloto activos. Para este cierre se acepta
como **excepción de pruebas** la capacidad disponible del piloto (5 GB de
volumen frente a 50 GB del Compose oficial; `vm.max_map_count` no verificado
en el host), sin cambiar el requisito de capacidad para un despliegue real.

### Definition of Done — C-06

| Gate | Estado |
| --- | --- |
| PostgreSQL, Redis, object storage: health y operaciones reales | PASS local y CI |
| Aislamiento concurrente | PASS local y CI |
| Limpieza completa de recursos por run | PASS local y CI |
| Suite C-06 en CI y artifact ligado al SHA | PASS, run `36154234794`, commit `1c4d7cd7047e` |
| OpenSearch real, TLS, CRUD y limpieza | PASS en Railway, evidencia JSON/PNG versionada |
| Wazuh E2E Manager → pipeline → Indexer y consulta API | PASS en Railway, marcador recuperado |
| Capacidad de Compose oficial Wazuh (50 GB, kernel) | Excepción aceptada para pruebas; requisito de despliegue no cambia |
| Perfiles locales `search`/`wazuh`/`full` orquestados en el harness | Pendiente como mejora posterior, no bloquea este cierre |
| **C-06 global** | **`DONE`** con excepción acotada al sizing del entorno de pruebas |

## Backlog y decisiones vigentes (sin cambio de criterio hoy)

- **PBI-006** (Microsoft 365/Wazuh): el estado `enabled` declarado por Franco
  sigue siendo una decisión administrativa, no una verificación técnica
  completa — ver
  [decisión](../../decisions/unresolved.md#decisión-microsoft-365-pasa-a-enabled-sin-el-gate-técnico-completo-de-pbi-006).
  El cierre E2E de C-06 de hoy es sobre la topología Wazuh/OpenSearch, no
  sobre el dataset Microsoft 365; no cierra PBI-006.
- **Protección de rama en `main`**: sigue cerrada por decisión de Franco
  (2026-09-24), sin cambios hoy.

## Estado de componentes al cierre

| ID | Estado | Cambio |
| --- | --- | --- |
| C-01, C-02, C-03, C-05, C-07 | `DONE` | Sin cambio |
| C-04 — persistencia de admisión | `DONE` | Confirmado por CI real (run `36154234794`), tras un tercer fix de fixture encontrado durante la integración de C-06 |
| C-06 — entorno de integración real | `DONE` | Perfil `base` PASS local y CI; OpenSearch y Wazuh E2E PASS real en Railway con marcador recuperado por API; excepción de capacidad aceptada para pruebas |
| C-08 — probe Wazuh | `IN_PROGRESS` | Sin cambio técnico |
| C-09 — CI y ownership | `IN_PROGRESS` | Jobs `c04-postgres` y `c06-base` verdes en CI; protección de rama resuelta como no requerida |

## Riesgos y bloqueos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| C-06: orquestación local de `search`/`wazuh`/`full` en el harness propio | Mejora posterior, no bloqueante | Cesar | Planificar como trabajo de Sprint 2 si aporta valor sobre la evidencia Railway ya aceptada |
| C-06: capacidad oficial del Compose Wazuh (50 GB, kernel `vm.max_map_count`) no demostrada | Riesgo aceptado para pruebas, vigente para despliegue | Infraestructura | Confirmar antes de cualquier plan de despliegue real |
| Microsoft 365 (`PBI-006`): `enabled` administrativo, gate técnico incompleto | Riesgo activo | Franco / Cesar | Completar scopes, ticket, dataset y conexión real de lectura |
| C-08: acceso/consulta real al Indexer sin confirmar | Riesgo activo | Cesar | Retomar con la evidencia Railway ya disponible como referencia técnica |

## Confianza en el Sprint Goal

VERDE-ÁMBAR: C-01 a C-07 y ahora C-04 y C-06 están `DONE` con evidencia real
verificada en CI y en un entorno Railway aislado (incluidas las medidas de
confidencialidad de DNS privado y SSH cifrado para la prueba de Wazuh). El
Sprint Goal depende ahora casi enteramente del gate técnico completo de
Microsoft 365 (PBI-006) y de C-08/C-09, no de trabajo de infraestructura de
pruebas pendiente.

[Daily Scrum](../daily-scrum.md) · [Plan de componentes](../component-delivery-plan.md) ·
[C-06 — plan y ejecución](../c-06/README.md) ·
[C-04 — cierre 2026-09-24](../../architecture/c-04-admission-er.md#cierre-2026-09-24) ·
[Decisiones sin resolver](../../decisions/unresolved.md) ·
[Informe de cierre de 2026-09-23](2026-09-23-informe-de-cierre.md)
