# Informe de avance — 2026-09-23

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 23 de septiembre de 2026

**Asunto:** Daily Scrum — Sprint 1, agenda y plan del día (2026-09-23)

Preparado para el Daily Scrum de **2026-09-23**. Sprint 1 — Base ejecutable y
contratos (2026-09-19 → 2026-10-02). Facilitador: Cesar Adrian Guevara Salcedo.

Formato y vocabulario según [Daily Scrum](../daily-scrum.md) y
[Definition of Done](../definition-of-done.md): estados admitidos `PLANNED`,
`READY`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`. Un componente solo pasa
a `DONE` con specs y evidencia real; "casi terminado" queda `IN_PROGRESS`. Este
informe no reemplaza el registro diario en `daily-scrum.md`; lo alimenta.

Este reporte abre con el cierre acordado en el
[informe de 2026-09-22](2026-09-22-informe-de-avance.md#ajuste-propuesto-para-el-daily-scrum-de-mañana-2026-09-23)
como agenda del Daily de hoy. Al momento de este Daily no hay commits nuevos
en `main` posteriores a `d6ea599` (2026-09-22 18:50): el estado de componentes
es el mismo que dejó el reporte anterior. Este informe no repite esa
evidencia; documenta la revisión del Sprint Goal y el plan para las
siguientes 24 horas.

## Resumen ejecutivo

`main` sigue en el commit `d6ea599`, sin cambios desde el cierre de ayer. El
Daily de hoy repasó los tres pendientes que dejó abiertos el informe del
2026-09-22 y confirma el foco del día: (1) decidir si el perfil `base` de
`IntegrationEnvironment` (C-06) ya alcanza para desbloquear evidencia real
adicional de C-04, (2) continuar C-04 hacia los criterios 4–7 de cierre sin
declararlo `DONE`, y (3) mantener el WIP máximo de dos componentes. No se
declara ningún componente `DONE` nuevo en este informe.

Aclaración de alcance registrada hoy sobre accesos externos: el app
registration de Microsoft Entra (`credential_ref: secret://qapaq/microsoft/entra-app`,
commit `7cce315`, 2026-09-22) ya está creado — `status: configured` en
[`source-inventory.yaml`](../../integrations/source-inventory.yaml). Wazuh, según
[ADR-024](../../adr/024-microsoft-365-wazuh-mvp-vertical.md), no es una fuente
externa administrada por Infraestructura: QAPAQ opera su propio motor de
indexación, reglas y alertas (perfil `wazuh` de `IntegrationEnvironment`,
`platform/testing`), y consume ese Indexer en modo lectura — no depende de un
tenant ni de credenciales externas de Franco. El bloqueo de accesos externos
se reduce entonces a completar Microsoft 365 hasta `enabled` (dataset, scopes
aprobados y ticket de autorización); ver detalle en la tabla de bloqueos.

## Estado de componentes al inicio del Daily (sin cambios desde ayer)

| ID | Estado | Evidencia |
| --- | --- | --- |
| C-01 — workspace | `DONE` | Sin cambios; ver [informe 2026-09-22](2026-09-22-informe-de-avance.md). |
| C-02 — entrypoints | `DONE` (2026-09-22) | Sin cambios. |
| C-03 — configuración | `DONE` (2026-09-21) | Sin cambios. |
| C-04 — persistencia de admisión | `IN_PROGRESS` | Cubre criterios 1–3 de 7 (migración desde vacío, rollback, una carrera concurrente). Faltan 4–7: rechazo (cruces de Source/tenant, IDs inválidos), identidad/replay, comando público de admisión, CAS de checkpoint y evidencia adjunta desde CI. |
| C-05 — contrato SecurityEvent | `DONE` | Sin cambios. |
| C-06 — entorno de integración real | `IN_PROGRESS` | `IntegrationEnvironment` operativo (perfiles `base`/`search`/`wazuh`/`full`); `integration-environment.lock.json` sigue con digests en `null`, sin lo cual la evidencia no es reproducible en CI. OpenSearch y Wazuh (local, perfil `wazuh`) siguen `BLOCKED` por TLS y topología, no por acceso externo. |
| C-07 — reglas de dependencia | `DONE` | Sin cambios. |
| C-08 — probe Wazuh | `IN_PROGRESS` | Ya no bloqueado por acceso externo de infraestructura: Wazuh corre local (perfil `wazuh` de `IntegrationEnvironment`), sin tenant ni credenciales de terceros. Bloqueado por trabajo de ingeniería propio: falta la suite de conformidad y la consulta real al Indexer local (ver C-06 para TLS/topología pendientes). |
| C-09 — CI y ownership | `IN_PROGRESS` | Pipeline verde; protección de rama en `main` sigue sin configurar. |

## Agenda del Daily de hoy

Siguiendo [`daily-scrum.md`](../daily-scrum.md#agenda-de-15-minutos):

1. **Sprint Goal** — sigue siendo alcanzable: validar SecurityEvent (cerrado,
   C-05 `DONE`) y cerrar el contrato operativo Microsoft 365 (Wazuh ya no
   depende de un tercero externo, ver resumen ejecutivo) sin supuestos.
2. **Componentes activos** — se revisaron C-04 y C-06 como los dos ítems de
   WIP vigentes; C-08 y C-09 quedan fuera del WIP activo: C-08 hasta que
   avance C-06 (TLS/topología del Wazuh local) y C-09 hasta resolver la
   protección de rama.
3. **Bloqueos** — ver tabla siguiente; ninguno cambió de dueño ni de fecha de
   escalamiento respecto al informe de ayer.
4. **Foco del día** — continuar C-04 (criterios de rechazo 4–7) y decidir
   sobre C-06 (digests del lockfile) sin abrir un tercer componente.

## Plan hasta el siguiente Daily (2026-09-24)

1. Avanzar C-04 hacia los casos de rechazo (cruces de Source/tenant, IDs
   inválidos) — criterio 4 de 7.
2. Evaluar si el perfil `base` de `IntegrationEnvironment` (C-06) es
   suficiente para adjuntar evidencia de C-04 desde CI, o si hace falta
   resolver antes los digests de `integration-environment.lock.json`.
3. No declarar C-04 ni C-06 `DONE` hasta cubrir sus criterios de cierre
   completos.
4. Verificar con Franco el avance de Microsoft 365 hasta `enabled` (dataset,
   scopes aprobados, ticket de autorización — PBI-006); fecha objetivo sigue
   siendo 2026-09-25. Wazuh no requiere seguimiento con Franco: es un
   componente local del propio proyecto (ver resumen ejecutivo).
5. Mantener el límite de WIP de dos componentes.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| Microsoft 365 sin `enabled` (dataset, scopes aprobados, ticket de autorización) | Por confirmar | Franco Clavo Santander | Fecha objetivo no posterior al 2026-09-25 (PBI-006). El `credential_ref` ya existe (`status: configured`, commit `7cce315`); falta la aprobación formal para operar. |
| C-04 con evidencia parcial contra PostgreSQL real | Riesgo activo | Cesar | Cubiertos criterios 1–3 de 7; faltan casos de rechazo, identidad/replay, comando público de admisión y evidencia adjunta desde CI. |
| C-06 sin digests reproducibles en `integration-environment.lock.json`; Wazuh/OpenSearch locales sin TLS ni topología oficial | Riesgo activo | Cesar | Resolver antes de usar C-06 como fuente de evidencia reproducible en CI para C-04 y C-08. |
| Protección de rama en `main` no configurada | Riesgo de proceso | Cesar / Franco | Definir política de PR obligatorio antes de que más de una persona escriba en `main`. |

Cambio respecto al informe de ayer: se retira el ítem "Tenant, permisos,
Wazuh/Indexer y secretRefs de Microsoft 365" como bloqueo único de Franco.
Wazuh se reclasifica como trabajo de ingeniería interno (C-06/C-08, sin
dueño externo); Microsoft 365 queda como el único pendiente real de
aprobación externa, ya con su `credential_ref` creado.

## Confianza en el Sprint Goal

ÁMBAR: la mitad ejecutable del incremento avanza (C-01, C-02, C-03, C-05,
C-07 `DONE`); el cierre del Sprint Goal depende de completar los criterios
restantes de C-04 y C-06 (trabajo interno) y de un único acceso externo
pendiente — Microsoft 365 hasta `enabled` —, ya no de Wazuh.

## Cierre de día — actualización tras commit `0fe6b8b`

Este apartado se agrega al cierre de la jornada del 2026-09-23, sin reescribir
lo registrado en el Daily de la mañana. Entre la apertura de este informe y el
cierre de día, `main` avanzó un commit:

| Commit | Descripción | Archivos |
| --- | --- | --- |
| `0fe6b8b` | `docs(arch): documenta motor Wazuh y OpenSearch` | Nuevo: [`docs/architecture/wazuh-engine-and-opensearch.md`](../../architecture/wazuh-engine-and-opensearch.md) (217 líneas) |

### Qué decide este commit

No es un cambio de código ni mueve ningún componente `C-xx` de estado. Es
documentación que consolida [ADR-005](../../adr/005-opensearch-wazuh-telemetry.md)
(`Proposed`, parcialmente sustituido) y
[ADR-024](../../adr/024-microsoft-365-wazuh-mvp-vertical.md) (`Accepted /
Implementation Required`) en una referencia operativa única. Formaliza tres
puntos que hasta hoy solo vivían repartidos entre ambos ADR:

1. **Frontera de ownership explícita.** Wazuh se opera como stack oficial de
   terceros (Manager, Indexer, Dashboard) vía
   [`scripts/dev/setup-wazuh.ps1`](../../../scripts/dev/setup-wazuh.ps1)
   (`wazuh-docker` fijado en `v4.14.7`); QAPAQ no versiona `ossec.conf`,
   decoders, reglas ni `opensearch.yml` propios de Wazuh. Infraestructura
   posee la operación del stack; SOC Development posee la normalización,
   enriquecimiento y correlación complementaria sobre `SecurityEvent`. Esta
   distinción respalda formalmente la reclasificación que el Daily de la
   mañana ya había anunciado en el resumen ejecutivo: Wazuh **no** es un
   acceso externo pendiente de Franco, sino trabajo de ingeniería interno
   (C-06 para el entorno local, C-08 para el probe/adapter).
2. **Dos instancias de OpenSearch, no una.** El Wazuh Indexer (externo,
   read-only, consultado por
   [`WazuhIndexerClient`](../../../modules/connectors/src/infrastructure/wazuh-indexer-client.ts)
   con TLS obligatorio) se distingue de una eventual proyección "OpenSearch
   QAPAQ" propia, que sigue en estado `Proposed` por ADR-005, no está
   desplegada y no aparece en `infra/local/compose.yaml`. El documento fija
   que no debe declararse disponible hasta que ADR-005 pase a `Accepted` con
   inventario y prueba de carga — condición que hoy no se cumple.
3. **Niveles de procedencia y no-duplicación de correlación.** Registra la
   cadena `VENDOR_RAW → WAZUH_ARCHIVED_EVENT → WAZUH_ALERT →
   NORMALIZED_EVENT → CORRELATED_ALERT → INCIDENT` y reafirma que QAPAQ no
   duplica en el MVP el ruleset base de Wazuh (ADR-024): la correlación
   multifuente queda fuera de alcance hasta una decisión post-MVP explícita
   (coherente con PBI-023/PBI-024 del backlog post-MVP).

También incluye un subconjunto del gate productivo de 15 puntos de
[Fuentes y pilotos autorizados](../../architecture/source-integration-strategy.md#gate-productivo)
aplicable a esta pieza, y cinco reglas de mantenimiento (p. ej. cambiar
primero el ADR correspondiente antes que este documento, no versionar
configuración real de Wazuh/OpenSearch, no presentar la correlación de Wazuh
como correlación multifuente propia).

### Impacto sobre componentes y backlog

- **C-06 / C-08:** sin cambio de estado (`IN_PROGRESS`); el documento no
  sustituye la evidencia pendiente (digests de `integration-environment.lock.json`,
  TLS/topología, suite de conformidad), solo fija por escrito el marco que ya
  se estaba usando para decidir sobre ellos.
- **PBI-006** (Product Backlog): sin cambio de criterio de aceptación; el
  documento resuelve la ambigüedad sobre la parte Wazuh del contrato
  operativo, no la aprobación pendiente de Microsoft 365 con Franco.
- **Ningún PBI ni componente pasa a `DONE`** por este commit.

### Pendiente detectado al cierre (reportado, no resuelto en este informe)

Al revisar el árbol de trabajo al cierre de día se detectaron dos ediciones
locales relacionadas, **aún sin commit** en `main`:

- `docs/README.md` y `docs/architecture/c4-model.md` tienen una línea de
  referencia cruzada hacia `wazuh-engine-and-opensearch.md` pendiente de
  commit. Se recomienda incluirla en un commit de documentación separado para
  que el Modelo C4 enlace realmente al nuevo documento desde `main`.
- El registro diario obligatorio en [`daily-scrum.md`](../daily-scrum.md) no
  tenía sección fechada para 2026-09-22 ni 2026-09-23 (solo existía la de
  2026-09-21), pese a que la propia regla del documento exige una sección por
  día laborable. Se agregó hoy la sección `2026-09-23`; la de 2026-09-22 sigue
  faltante y se reporta como vacío documental pendiente de decisión (¿se
  reconstruye retroactivamente o se acepta el informe de avance del
  2026-09-22 como registro equivalente?).

### Confianza en el Sprint Goal (cierre de día)

ÁMBAR, sin cambio respecto a la apertura del Daily: el commit de hoy reduce
ambigüedad documental pero no adelanta ningún criterio de cierre de C-04 o
C-06, y el único acceso externo pendiente (Microsoft 365, PBI-006) sigue sin
resolución de Franco.

[Daily Scrum](../daily-scrum.md) · [Plan de componentes](../component-delivery-plan.md) ·
[Product Backlog](../product-backlog.md) · [Definition of Done](../definition-of-done.md) ·
[Informe de 2026-09-22](2026-09-22-informe-de-avance.md)
