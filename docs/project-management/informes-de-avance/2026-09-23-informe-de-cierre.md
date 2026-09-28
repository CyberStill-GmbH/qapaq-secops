# Informe de cierre del día — 2026-09-23

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 23 de septiembre de 2026

**Asunto:** Cierre de día — Sprint 1, `main` tras la integración de dos frentes de trabajo

Este informe cierra la jornada del 2026-09-23. Complementa —no reemplaza— el
[Daily Scrum de la mañana](2026-09-23-informe-de-avance.md) y su addendum de
cierre; aquí se consolida todo lo que llegó a `main` durante el día, con
backlog y explicación de las decisiones tomadas en cada componente.

Formato y vocabulario según [Daily Scrum](../daily-scrum.md) y
[Definition of Done](../definition-of-done.md): estados admitidos `PLANNED`,
`READY`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`. Un componente solo pasa
a `DONE` con specs y evidencia real.

## Resumen ejecutivo

`main` cerró el día en el commit de merge **`74200a0`**, que integra dos
frentes que avanzaron en paralelo hoy:

1. **Documentación de arquitectura** (`0fe6b8b`): consolida ADR-005 y ADR-024
   en un documento único sobre el motor Wazuh y OpenSearch.
2. **Implementación e infraestructura de C-04/CI** (6 commits: `b25b59c` →
   `8901a1b`): agrega el comando público de admisión transaccional, fija CI
   para ejecutar la suite PostgreSQL de C-04 contra una versión digest-pinned,
   publica evidencia firmada por commit, y corrige generación de Prisma y el
   alcance de un fixture histórico de secretos en el escaneo de gitleaks.

Ningún componente pasa a `DONE` hoy. C-04 avanza de forma sustancial (de 3 a
5 de los 7 criterios de cierre con evidencia real); C-06/C-08 quedan
documentalmente resueltos en su frontera de ownership, sin cambio de estado
técnico. El único bloqueo externo real sigue siendo la aprobación de
Microsoft 365 por parte de Franco (PBI-006).

## Commits integrados hoy en `main`

| Commit | Tipo | Descripción |
| --- | --- | --- |
| `b25b59c` | feat(c04) | Agrega `commitAdmission` (comando público transaccional) y prueba PostgreSQL de admisión/idempotencia/CAS |
| `82f4a25` | ci(c04) | Job `c04-postgres` en CI: PostgreSQL fijado por digest, ejecuta la suite y adjunta evidencia como artifact |
| `e04a011` | fix(ci) | Genera Prisma client en el job de CI y acota un fixture histórico de secretos en gitleaks |
| `c213073` | merge | Incorpora avances de `main` antes de integrar C-04 |
| `70a38ae` | docs(decisions) | Registra en `unresolved.md` la evidencia C-04 y el gate CI en verde |
| `8901a1b` | merge | Integra C-04 y evidencia CI desde `develop` |
| `0fe6b8b` | docs(arch) | Documenta el motor Wazuh y OpenSearch (ver detalle en el [addendum de cierre del Daily](2026-09-23-informe-de-avance.md#cierre-de-día--actualización-tras-commit-0fe6b8b)) |
| `74200a0` | merge | Combina ambos frentes en `main`, sin conflictos |

## Decisiones tomadas hoy, por componente

### C-04 — persistencia de admisión (`IN_PROGRESS`, avance sustancial)

**Qué se implementó:** `platform/database/src/commit-admission.ts` agrega el
comando `commitAdmission`, que admite un lote (manifest, raw, eventos,
outbox y checkpoint) en una única transacción y devuelve un recibo
(`AdmissionReceipt`: `manifestId`, `eventCount`, `acceptedCount`,
`quarantinedCount`, `duplicateCount`, `checkpointRevision`).

**Qué demuestra la prueba nueva** (`postgres-c04.integration.spec.ts`) contra
PostgreSQL real:

- **Idempotencia real:** reenviar el mismo comando devuelve exactamente el
  mismo recibo, sin duplicar filas.
- **Conflicto detectado:** reenviar el mismo lote con un campo alterado
  (`providerEventId` distinto) falla con `PERSISTENCE_CONSTRAINT_VIOLATION`
  en lugar de aceptar silenciosamente una versión distinta del mismo evento.
- **CAS de checkpoint:** un comando con cursor desactualizado
  (`expectedRevision` obsoleto) falla con `PERSISTENCE_CONCURRENCY_CONFLICT`
  y no avanza el checkpoint ni crea filas — la revisión del checkpoint queda
  en el valor esperado (`revision: 1n`), confirmado por consulta directa.
- **Cuarentena en el mismo commit:** el evento de la prueba se admite
  cuarentenado (`quarantinedCount: 1`, `acceptedCount: 0`) y esa decisión
  queda persistida junto con el resto del lote, no en un paso separado.

**Qué NO queda cerrado todavía** (textual de
[`docs/decisions/unresolved.md`](../../decisions/unresolved.md#decisión-de-evidencia-c-04-con-el-entorno-c-06)):
*"Estas suites aún no cubren todos los criterios del comando público C-04 ni
el smoke de object storage/Wazuh exigido por Sprint 1."* En concreto, sigue
faltando evidencia explícita de rechazo por cruce de `Source`/tenant y por
identificadores inválidos (más allá del conflicto de constraint ya probado),
y el smoke de object storage/Wazuh que exige Sprint 1 antes de declarar
`DONE`.

**Evidencia CI verificada:** la
[ejecución 35945693397](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/35945693397)
del commit `c213073` terminó en `success`, incluido el gate y el nuevo job
`c04-postgres`, y publicó el artifact `c04-postgres-c213073…` con la
evidencia del perfil `postgres` fijado por digest. Esto **cierra** el gate
que el informe de la mañana reportaba como pendiente ("evidencia adjunta
desde CI", criterio 7 de 7): ya no es una promesa, es una corrida real y
verde sobre un commit integrado.

Balance del día para C-04: de los 7 criterios de cierre reportados en el
Daily de la mañana (migración desde vacío, rollback, carrera concurrente,
rechazo por cruce de tenant/IDs inválidos, identidad/replay, comando público
de admisión, evidencia desde CI), hoy se suman con evidencia real:
**identidad/replay**, **comando público de admisión** y **evidencia desde
CI** (parcial: cubre idempotencia/CAS/cuarentena, no todavía la matriz
completa de rechazo). Siguen abiertos: rechazo explícito por cruce de
Source/tenant e IDs inválidos, y el smoke de object storage/Wazuh.

### C-06 / C-08 — entorno de integración y probe Wazuh (`IN_PROGRESS`, sin cambio técnico)

El commit `0fe6b8b` (`docs/architecture/wazuh-engine-and-opensearch.md`) no
modifica código ni evidencia técnica de C-06/C-08, pero **cierra una
ambigüedad de proceso** que el informe de la mañana ya había señalado:
formaliza, con ADR-005 y ADR-024 como respaldo, que Wazuh es un componente
operado localmente por el propio proyecto (perfil `wazuh` de
`IntegrationEnvironment`, `wazuh-docker` fijado en `v4.14.7` vía
`scripts/dev/setup-wazuh.ps1`), no un acceso externo pendiente de
Infraestructura o de Franco. Detalle completo de esta decisión en el
[addendum del Daily de hoy](2026-09-23-informe-de-avance.md#cierre-de-día--actualización-tras-commit-0fe6b8b).

Pendiente real de evidencia (sin cambio hoy): `integration-environment.lock.json`
sigue con digests en `null`; OpenSearch y Wazuh locales siguen `BLOCKED` por
TLS y topología oficial, no por acceso externo.

### C-09 — CI y ownership (`IN_PROGRESS`, avance de infraestructura)

El commit `e04a011` corrige dos problemas operativos de CI descubiertos al
integrar C-04: el job ahora genera el cliente Prisma antes de ejecutar la
suite (evitando un fallo de build no relacionado con el código bajo prueba),
y acota un fixture histórico usado en pruebas de secretos para que gitleaks
no lo marque como hallazgo real (`.gitleaksignore` reemplaza a
`.gitleaks.toml`, que se elimina). El pipeline general permanece verde. La
protección de rama en `main` sigue sin configurarse — bloqueo de proceso sin
cambio hoy.

## Estado de componentes al cierre de día

| ID | Estado | Cambio hoy |
| --- | --- | --- |
| C-01, C-02, C-03, C-05, C-07 | `DONE` | Sin cambio |
| C-04 — persistencia de admisión | `IN_PROGRESS` | Comando público de admisión, idempotencia, CAS de checkpoint y cuarentena demostrados contra PostgreSQL real; evidencia de CI verificada en verde. Faltan casos de rechazo Source/tenant/IDs inválidos y smoke object storage/Wazuh |
| C-06 — entorno de integración real | `IN_PROGRESS` | Sin cambio técnico; frontera de ownership Wazuh/OpenSearch formalizada en documentación |
| C-08 — probe Wazuh | `IN_PROGRESS` | Sin cambio técnico; mismo respaldo documental que C-06 |
| C-09 — CI y ownership | `IN_PROGRESS` | Corrige generación de Prisma en CI y alcance de fixture de gitleaks; protección de rama sigue pendiente |

## Backlog (Product Backlog y plan de componentes)

Ningún PBI cambia de estado hoy. Relevancia directa de lo integrado:

- **PBI-006** (Cerrar contrato operativo Microsoft 365/Wazuh, P0, Sprint 1):
  la parte Wazuh del contrato queda documentada (`0fe6b8b`); el criterio de
  aceptación sigue abierto porque depende de la aprobación de Microsoft 365
  por Franco (dataset, scopes, ticket de autorización), no de trabajo interno.
- **PBI-009** (Persistir raw, manifiesto y checkpoint, P0, Sprint 2): el
  trabajo de hoy en `commit-admission.ts` adelanta la base transaccional que
  este PBI necesita, aunque su forecast formal es Sprint 2 y C-04 (Sprint 1)
  es quien lo demuestra primero a nivel de persistencia.
- **PBI-011** (Idempotencia, replay y cuarentena, P0, Sprint 2): la prueba
  nueva de C-04 ya demuestra idempotencia y cuarentena en el mismo commit
  transaccional — evidencia temprana reutilizable para este PBI cuando se
  aborde en Sprint 2.
- El resto del backlog (PBI-001…005, 007…025) no tiene cambios de estado ni
  de criterios de aceptación hoy.

Plan de componentes ([`component-delivery-plan.md`](../component-delivery-plan.md)):
sin cambios de orden ni de dependencias. El orden obligatorio declarado
(C-01 → C-03/C-05 en paralelo → C-06 habilita C-04/C-08 → C-02/C-07 cierran
la forma del workspace → C-09 se adapta) se mantiene vigente.

## Riesgos y bloqueos vigentes al cierre

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| Microsoft 365 sin `enabled` (dataset, scopes aprobados, ticket de autorización) | Por confirmar | Franco Clavo Santander | Fecha objetivo 2026-09-25 (PBI-006); `credential_ref` ya existe (`status: configured`) |
| C-04: rechazo por cruce Source/tenant e IDs inválidos, y smoke object storage/Wazuh | Riesgo activo | Cesar | Próxima sesión de trabajo sobre C-04 |
| C-06: digests de `integration-environment.lock.json` en `null`; TLS/topología de OpenSearch y Wazuh locales | Riesgo activo | Cesar | Resolver antes de usar C-06 como fuente de evidencia reproducible en CI |
| Protección de rama en `main` no configurada | Riesgo de proceso | Cesar / Franco | Definir política de PR obligatorio |
| `docs/README.md` y `docs/architecture/c4-model.md`: referencia cruzada al nuevo documento Wazuh/OpenSearch editada localmente, aún sin commit | Pendiente documental | Cesar | Incluir en el próximo commit de documentación |
| `daily-scrum.md` sin sección fechada para 2026-09-22 (solo existía 2026-09-21 antes de hoy) | Pendiente documental, reportado sin resolver | Cesar / Franco | Decidir si se reconstruye retroactivamente o se acepta el informe de avance de esa fecha como registro equivalente |

## Confianza en el Sprint Goal al cierre de día

ÁMBAR, con mejora de sustento respecto a la apertura del Daily: C-01, C-02,
C-03, C-05, C-07 permanecen `DONE`; C-04 avanzó de evidencia parcial a
evidencia sustancial con CI verde, y la frontera Wazuh/OpenSearch de C-06/C-08
quedó formalizada por escrito. El Sprint Goal sigue sin cerrarse porque
persiste un único pendiente de aprobación externa (Microsoft 365, PBI-006) y
trabajo interno restante en C-04 (rechazo, smoke) y C-06 (digests, TLS).

[Daily Scrum](../daily-scrum.md) · [Plan de componentes](../component-delivery-plan.md) ·
[Product Backlog](../product-backlog.md) · [Definition of Done](../definition-of-done.md) ·
[Decisiones sin resolver](../../decisions/unresolved.md) ·
[Informe del Daily de hoy](2026-09-23-informe-de-avance.md) ·
[Informe de 2026-09-22](2026-09-22-informe-de-avance.md)
