# Daily Scrum — operación y registro

Estado: ACTIVO · Inicio: 2026-09-21 · Facilitador: Cesar Adrian Guevara Salcedo.
Duración máxima: 15 minutos por día laborable.

## Propósito

Inspeccionar el avance hacia el Sprint Goal y ajustar el plan de las siguientes
24 horas. No es un reporte de estado al Product Owner. El resultado debe ser un
Sprint Backlog actualizado, con bloqueos, dueño y siguiente acción visibles.

## Agenda de 15 minutos

1. Minuto 0–2: leer el Sprint Goal y comprobar si sigue alcanzable.
2. Minuto 2–9: recorrer solo los componentes `C-xx` activos; revisar evidencia
   terminada, siguiente resultado verificable y cambio del plan.
3. Minuto 9–12: registrar bloqueos, dependencia, dueño y fecha de escalamiento.
4. Minuto 12–15: acordar el foco del día respetando WIP máximo de dos items.

Las discusiones de diseño, depuración o acceso se programan después con quienes
corresponda. El Daily no se extiende para resolverlas.

## Campos del registro diario

```text
Fecha / Sprint / Sprint Goal:
Componentes activos y estado:
Evidencia terminada desde el Daily anterior:
Plan hasta el siguiente Daily:
Bloqueos: causa / impacto / dueño / siguiente acción / escalamiento:
Cambio al Sprint Backlog:
Confianza en el Sprint Goal: verde | ámbar | rojo, con motivo:
```

Estados admitidos: `PLANNED`, `READY`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED` y
`DONE`. Un componente solo pasa a `DONE` con las specs y evidencia de su definición;
“casi terminado” permanece `IN_PROGRESS`.

## Registro — 2026-09-21

Sprint: 1 — Base ejecutable y contratos.

Sprint Goal: disponer de una base reproducible que valide SecurityEvent y cerrar
el contrato operativo Microsoft 365/Wazuh sin supuestos.

Componentes activos y estado:

- C-01 workspace: `READY`; es el primer componente de implementación.
- C-03 configuración y C-05 SecurityEvent: `READY` después de C-01.
- C-02, C-04, C-06…C-09: `PLANNED` y dependientes según el plan; ninguno está Done.

Evidencia terminada:

- auditoría STR-01…STR-12 y estructura objetivo documentadas;
- plan C-01…C-23, ruta crítica y evidencia por Sprint documentados;
- validación documental aprobada; no existen aún tests de aplicación ejecutables.

Plan hasta el siguiente Daily:

1. confirmar horas disponibles de Cesar para Sprint 1;
2. iniciar C-01 con workspace, versiones y scripts reproducibles;
3. confirmar estado de integración del PR #2 de CI;
4. obtener dueño y fecha de acceso para Wazuh, Indexer y Microsoft 365;
5. no abrir más de un segundo componente hasta que C-01 produzca build verificable.

Bloqueos y riesgos:

| Elemento | Estado | Dueño | Siguiente acción y fecha |
| --- | --- | --- | --- |
| Workspace y código de aplicación inexistentes | Riesgo activo | Cesar | Iniciar C-01 el 2026-09-21 |
| CI vive en PR #2, separado de esta rama | Dependencia | Cesar | Verificar estrategia de integración antes de C-09 |
| Tenant, permisos, Wazuh/Indexer y secretRefs no evidenciados | Por confirmar | Franco | Asignar dueño y fecha objetivo antes del 2026-09-25 |
| Capacidad real del único Developer no declarada | Bloqueo de forecast | Cesar y Franco | Declararla en Planning del 2026-09-21 |

Cambio al Sprint Backlog: Sprint 2 se reduce a dos días laborables, 2026-10-05 y
2026-10-06. Sus accesos y componentes previos deberán estar listos al cerrar Sprint
1; la reducción no elimina specs ni permite fakes.

Confianza en el Sprint Goal: ÁMBAR. La documentación está lista, pero el incremento
ejecutable depende de materializar C-01 y confirmar accesos externos.

## Registro — 2026-09-23

Sprint: 1 — Base ejecutable y contratos.

Sprint Goal: disponer de una base reproducible que valide SecurityEvent y cerrar
el contrato operativo Microsoft 365/Wazuh sin supuestos. Sigue alcanzable.

Componentes activos y estado:

- C-01, C-02, C-03, C-05, C-07: `DONE`; sin cambios hoy.
- C-04 — persistencia de admisión: `IN_PROGRESS`. Cubre criterios 1–3 de 7
  (migración desde vacío, rollback, una carrera concurrente); faltan rechazo
  (4), identidad/replay (5), comando público de admisión (6) y evidencia
  adjunta desde CI (7).
- C-06 — entorno de integración real: `IN_PROGRESS`. `IntegrationEnvironment`
  operativo (perfiles `base`/`search`/`wazuh`/`full`);
  `integration-environment.lock.json` sigue con digests en `null`.
- C-08 — probe Wazuh: `IN_PROGRESS`. Ya no depende de acceso externo de
  Infraestructura; bloqueado por trabajo propio (suite de conformidad y
  consulta real al Indexer local, sujeta a TLS/topología de C-06).
- C-09 — CI y ownership: `IN_PROGRESS`. Pipeline verde; protección de rama en
  `main` sigue sin configurar.

Evidencia terminada desde el Daily anterior (2026-09-22, commit `d6ea599`):

- Commit `0fe6b8b` — `docs/architecture/wazuh-engine-and-opensearch.md`:
  documento nuevo que consolida [ADR-005](../adr/005-opensearch-wazuh-telemetry.md)
  y [ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md); formaliza la
  frontera de ownership Wazuh/Infraestructura vs. QAPAQ/SOC Development y la
  distinción entre el Wazuh Indexer (externo, read-only) y una eventual
  proyección OpenSearch propia (aún `Proposed`, no desplegada). No cambia
  código ni el estado de ningún componente `C-xx`; es documentación que
  respalda formalmente la reclasificación de Wazuh como trabajo de ingeniería
  interno (C-06/C-08) ya anunciada informalmente en el
  [informe de 2026-09-23](informes-de-avance/2026-09-23-informe-de-avance.md).

Plan hasta el siguiente Daily (2026-09-24):

1. Avanzar C-04 hacia los casos de rechazo (cruces de Source/tenant, IDs
   inválidos) — criterio 4 de 7.
2. Evaluar si el perfil `base` de `IntegrationEnvironment` (C-06) alcanza para
   adjuntar evidencia de C-04 desde CI, o si hace falta resolver antes los
   digests de `integration-environment.lock.json`.
3. Commitear la referencia cruzada pendiente en `docs/README.md` y
   `docs/architecture/c4-model.md` hacia el nuevo documento Wazuh/OpenSearch
   (editada localmente, aún sin commit en `main` al cierre de este registro).
4. Verificar con Franco el avance de Microsoft 365 hasta `enabled` (PBI-006);
   fecha objetivo 2026-09-25.
5. Mantener el límite de WIP de dos componentes activos (C-04 y C-06).

Bloqueos: causa / impacto / dueño / siguiente acción / escalamiento:

- Microsoft 365 sin `enabled` (dataset, scopes aprobados, ticket de
  autorización) — impacto: bloquea cierre de PBI-006 — dueño: Franco Clavo
  Santander — siguiente acción: aprobación formal antes del 2026-09-25 —
  escalamiento: Product Owner si no hay respuesta al vencer la fecha.
- C-04 con evidencia parcial contra PostgreSQL real — impacto: no permite
  declarar `DONE` — dueño: Cesar — siguiente acción: cubrir criterios 4–7 —
  sin escalamiento, es trabajo planificado.
- C-06 sin digests reproducibles en `integration-environment.lock.json`;
  OpenSearch/Wazuh locales sin TLS ni topología oficial — impacto: evidencia
  de C-04/C-08 no reproducible en CI — dueño: Cesar — siguiente acción:
  resolver antes de usar C-06 como fuente de evidencia en CI.
- Protección de rama en `main` no configurada — impacto: riesgo de proceso si
  más de una persona escribe en `main` — dueño: Cesar / Franco — siguiente
  acción: definir política de PR obligatorio.

Cambio al Sprint Backlog: ninguno. El commit `0fe6b8b` es documentación que
formaliza una frontera ya vigente; no reordena ni modifica ningún PBI. PBI-006
permanece con el mismo criterio de aceptación, pendiente solo de la
aprobación de Microsoft 365.

Confianza en el Sprint Goal: ÁMBAR. La mitad ejecutable del incremento avanza
(C-01, C-02, C-03, C-05, C-07 `DONE`); el cierre depende de completar C-04 y
C-06 (trabajo interno) y de la aprobación externa pendiente de Microsoft 365.

## Registro — 2026-09-24

Sprint: 1 — Base ejecutable y contratos.

Sprint Goal: disponer de una base reproducible que valide SecurityEvent y cerrar
el contrato operativo Microsoft 365/Wazuh sin supuestos. Sigue alcanzable.

Componentes activos y estado:

- C-01, C-02, C-03, C-05, C-07: `DONE`; sin cambios hoy.
- C-04 — persistencia de admisión: `IN_PROGRESS`. Desde el cierre de ayer
  cubre migración, rollback, carrera concurrente, comando público de admisión
  (`commitAdmission`), idempotencia, CAS de checkpoint y cuarentena contra
  PostgreSQL real, con evidencia verificada en CI (run `35945693397`, commit
  `c213073`). Faltan casos explícitos de rechazo por cruce de Source/tenant e
  IDs inválidos, y el smoke de object storage/Wazuh exigido por Sprint 1.
- C-06 — entorno de integración real: `IN_PROGRESS`. Sin cambio técnico desde
  ayer; `integration-environment.lock.json` sigue con digests en `null`;
  OpenSearch y Wazuh locales siguen `BLOCKED` por TLS y topología.
- C-08 — probe Wazuh: `IN_PROGRESS`. Sin cambio técnico; misma frontera de
  ownership documentada ayer (`wazuh-engine-and-opensearch.md`).
- C-09 — CI y ownership: `IN_PROGRESS`. Job `c04-postgres` verde en el gate;
  generación de Prisma y alcance del fixture de gitleaks corregidos ayer;
  protección de rama en `main` queda decidida como innecesaria en este
  timebox (ver bloqueos).

Evidencia terminada desde el Daily anterior (2026-09-23, commit `74200a0`):

- Commit `0fe6b8b` — documentación Wazuh/OpenSearch (ver Daily de ayer).
- Commits `b25b59c`…`8901a1b` — comando público de admisión C-04, job de CI
  `c04-postgres` con evidencia por commit, y correcciones de CI/gitleaks. Ver
  desglose completo en el
  [informe de cierre de 2026-09-23](informes-de-avance/2026-09-23-informe-de-cierre.md).
- No hay commits nuevos en `main` entre la apertura de este Daily y el cierre
  de ayer (`74200a0` sigue siendo el `HEAD` de `main` al momento de este
  registro).

Plan hasta el siguiente Daily (2026-09-25):

1. Cerrar C-04: casos de rechazo por cruce de Source/tenant e IDs inválidos,
   y smoke de object storage/Wazuh — criterios restantes antes de `DONE`.
2. Resolver los digests en `null` de `integration-environment.lock.json`
   (C-06) para que la evidencia sea reproducible en CI.
3. Commitear la referencia cruzada pendiente en `docs/README.md` y
   `docs/architecture/c4-model.md` hacia `wazuh-engine-and-opensearch.md`
   (sigue editada localmente, sin commit, reportado desde ayer).
4. Verificar con Franco el estado de Microsoft 365 hasta `enabled`
   (PBI-006); fecha objetivo 2026-09-25 vence hoy/mañana.
5. Mantener el límite de WIP de dos componentes activos (C-04 y C-06).

Bloqueos: causa / impacto / dueño / siguiente acción / escalamiento:

- ~~Microsoft 365 sin `enabled`~~ — **Actualizado el 2026-09-24**: Franco
  (Product Owner) declaró `status: enabled` en
  [`source-inventory.yaml`](../integrations/source-inventory.yaml) sobre la
  base del `credential_ref` de app registration ya entregado (2026-09-22).
  `approved_scopes`, `approval_ticket`, `dataset`, `api_version` y `region`
  siguen sin valores reales, y no hay una conexión mínima de lectura
  demostrada. Este `enabled` **no cierra PBI-006**, que sigue abierto en el
  Product Backlog hasta cubrir esos criterios — ver
  [decisión completa](../decisions/unresolved.md#decisión-microsoft-365-pasa-a-enabled-sin-el-gate-técnico-completo-de-pbi-006).
  No se declara PBI-006 `DONE` en este registro.
- C-04: rechazo por cruce Source/tenant e IDs inválidos, y smoke object
  storage/Wazuh sin cubrir — impacto: no permite declarar `DONE` — dueño:
  Cesar — siguiente acción: continuar hoy — sin escalamiento, es trabajo
  planificado.
- C-06 sin digests reproducibles en `integration-environment.lock.json`;
  OpenSearch/Wazuh locales sin TLS ni topología oficial — impacto: evidencia
  de C-04/C-08 no reproducible en CI — dueño: Cesar — siguiente acción:
  resolver antes de usar C-06 como fuente de evidencia en CI.
- ~~Protección de rama en `main` no configurada~~ — **Resuelto el 2026-09-24**:
  Franco (Product Owner) decidió que un PR obligatorio antes de `main` es
  intrascendente en este timebox (Cesar tiene control total del código, el
  repositorio es privado, y los otros dos colaboradores son cuentas propias
  de Cesar). Ver
  [decisión completa](../decisions/unresolved.md#decisión-protección-de-rama-en-main-no-es-requisito-de-este-timebox).
  Se reabre si se incorpora un colaborador externo real.
- Referencia cruzada Wazuh/OpenSearch en `docs/README.md` y `c4-model.md`
  editada localmente sin commit desde el 2026-09-23 — impacto: bajo, solo
  navegación de documentación — dueño: Cesar — siguiente acción: incluir en
  el próximo commit de documentación.

Cambio al Sprint Backlog: ninguno. Ningún PBI cambia de prioridad ni de
criterio de aceptación hoy.

Confianza en el Sprint Goal: ÁMBAR. C-01, C-02, C-03, C-05, C-07 permanecen
`DONE`; C-04 cerró hoy sus criterios de pertenencia/límites (`DONE`, pendiente
de confirmación por CI); C-06 no avanza en digests/TLS desde ayer; Microsoft
365 pasó a `enabled` por decisión de Franco, pero PBI-006 sigue abierto hasta
cubrir scopes, ticket, dataset y una conexión real de lectura.

## Regla para los siguientes registros

Se agrega una sección fechada por día laborable. No se reescribe el historial para
mejorar métricas. Si no hubo avance, se registra la causa. Un bloqueo que dura un
día laborable se escala conforme al plan Scrum.

## Registro — 2026-09-25

Sprint: 1 — Base ejecutable y contratos.

`main` se revisó inicialmente en `df44dc7`: C-04 ya estaba DONE y C-06 base
integrado. El cierre con evidencia real OpenSearch/Wazuh y excepción aceptada de
capacidad se integró después por PR #14, merge `ec4d357`; todos los jobs CI del
PR terminaron PASS. El corte final de este Daily es `main` en `ec4d357`.

Componentes activos y estado:

- C-06: `DONE` según la excepción aceptada para el entorno de pruebas disponible.
- C-08: `IN_PROGRESS`; confirmar tenant/permisos/secretRefs.
- C-09: `IN_PROGRESS`; confirmar protección de rama y checks requeridos.

Evidencia terminada:

- CI base limpio: dos entornos concurrentes PostgreSQL/Redis/MinIO con health,
  aislamiento y cleanup PASS.
- OpenSearch QAPAQ 3.7.0: TLS, health GREEN, CRUD y cleanup PASS en Railway.
- Wazuh 4.14.7: alerta sintética procesada y marcador recuperado por API en el
  índice diario; evidencia JSON/PNG versionada en la rama de cierre.
- El entorno Railway temporal fue eliminado al terminar la captura.

Plan hasta el siguiente Daily: continuar la gestión de accesos C-08 y confirmar
C-09. La orquestación local `search` /
`wazuh` / `full` y el sizing oficial del Compose Wazuh quedan como mejoras
posteriores; el sizing oficial sigue requerido para despliegue.

Cambio al Sprint Backlog: se acepta la capacidad de prueba disponible para la
aceptación funcional de C-06, dejando registrada la excepción limitada a pruebas.

Confianza en el Sprint Goal: ÁMBAR; la aceptación C-06 y C-04 están cerradas,
pero accesos externos y gobierno de rama aún necesitan confirmación.

Informe: [Daily Scrum 2026-09-25](informes-de-avance/2026-09-25-informe-de-avance.md).

[Plan Scrum](README.md) · [Componentes](component-delivery-plan.md) ·
[Sprint 1](sprints/01-base-ejecutable.md)

## Registro — 2026-09-24

Sprint: 1 — Base ejecutable y contratos.

Sprint Goal: disponer de una base reproducible que valide SecurityEvent y cerrar
el contrato operativo Microsoft 365/Wazuh sin supuestos.

Componentes activos y estado al corte de `main` (`8901a1b`):

- C-01, C-02, C-03, C-05 y C-07: `DONE`, según evidencias previas.
- C-04 — persistencia de admisión: `IN_PROGRESS`; el comando público
  `commitAdmission`, la transacción, la idempotencia y el CAS de checkpoint ya
  están implementados. Persisten escenarios de aceptación por ampliar.
- C-06 — entorno de integración: `IN_PROGRESS`; el perfil `postgres` y su job de
  CI producen evidencia; `base` requiere más memoria y `search`/`wazuh` siguen
  condicionados por configuración, capacidad y topología autorizada.
- C-08 — probe Wazuh: `IN_PROGRESS`; no consta acceso autorizado para la consulta
  real al Indexer.
- C-09 — CI y ownership: `IN_PROGRESS`; CI está habilitado y el job C-04 publica
  evidencia; falta confirmar la protección obligatoria de `main`.

Evidencia terminada desde el Daily anterior:

- El merge `8901a1b` (2026-09-23) integra C-04 y el job de evidencia PostgreSQL.
- El comando `commitAdmission` concentra la admisión transaccional de manifiesto,
  raws, eventos, cuarentenas, outbox y checkpoint; la API comprueba la revisión
  esperada antes de confirmar.
- El run CI `35945693397` terminó `success` para `c213073`, con job C-04, cinco
  pruebas, PostgreSQL fijado por digest y artifact redactado con cleanup. El run
  no corresponde al SHA exacto `8901a1b`.
- La documentación de C-06 registra ejecución local de PostgreSQL/Redis; no
  acredita CRUD de MinIO ni un flujo E2E de Wazuh/OpenSearch.

Plan hasta el siguiente Daily (máximo dos componentes en WIP):

1. C-04: completar cobertura verificable para rechazos, repetición con contenido
   diferente, identidad/reintento, rollback por etapa y concurrencia de CAS;
   conservar artifact vinculado al commit ejecutado.
2. C-06: mantener reproducible el perfil `postgres` y registrar los prerequisitos
   cuantificados de `base`, `search` y `wazuh`; no presentar esos perfiles como
   aceptados.
3. Escalar antes del 2026-09-25 la confirmación de tenant, permisos, Wazuh/Indexer
   y referencias de secretos con Franco Clavo Santander.
4. Confirmar política de protección de `main` con Cesar y Franco.

Bloqueos y riesgos:

| Elemento | Impacto | Dueño | Siguiente acción y fecha |
| --- | --- | --- | --- |
| Tenant, permisos, Wazuh/Indexer y secretRefs sin evidencia de acceso | C-08 y forecast de Sprint 2 | Franco Clavo Santander | Confirmar dueño y fecha objetivo antes del 2026-09-25 |
| C-06 `base` requiere al menos 4 GiB; engine reportado cerca de 3 GiB | No permite aceptar perfiles completos | Infraestructura | Asignar capacidad o replanificar el perfil; antes del siguiente Daily |
| TLS, digests, MinIO CRUD y flujo Wazuh E2E pendientes | C-06 `search`/`wazuh` no cerrables | Infraestructura + Cesar | Acordar prerequisitos y plan de evidencia |
| Protección de rama `main` no confirmada | Riesgo de cambios directos sin gate de PR | Cesar + Franco | Definir checks requeridos y revisar el merge gate |
| C-04 tiene cuatro casos visibles en la suite | Cobertura parcial de sus siete criterios de aceptación | Cesar | Completar la matriz de escenarios y adjuntarla a CI |

Cambio al Sprint Backlog: no se registra una aceptación de cambio de alcance.
Mantener el límite WIP de dos; priorizar C-04 y C-06, con coordinación de accesos
como gestión de bloqueo.

Confianza en el Sprint Goal: ÁMBAR. La base ejecutable y CI avanzaron; la
aceptación restante depende de completar cobertura, asegurar recursos de
integración y confirmar accesos externos antes de Sprint 2.

### Actualización de ejecución C-06 — 2026-09-24, corte posterior

Después del snapshot anterior, `main` avanzó a `74200a0e41d9` y se ejecutó el
perfil `base` con Docker local. La suite de integración completa pasó 10 pruebas
en 4 archivos; dos entornos PostgreSQL/Redis/MinIO concurrentes aprobaron
operaciones reales, aislamiento y limpieza con cero recursos restantes. Los dos
JSON declaran correctamente `workingTreeDirty: true`. El job `c06-base` quedó
añadido a CI, pero no se atribuye PASS remoto sin observar una ejecución GitHub
del SHA correspondiente.

C-06 base: PASS local. C-06 global permanece `IN_PROGRESS`: OpenSearch requiere
TLS/autenticación aprobados y Wazuh oficial se detuvo en preflight (Docker 3.5
GiB y disco 11 GiB; requeridos 8 GiB y 50 GiB), antes de descargar o iniciar.
El plan, comandos, criterios y capturas derivadas de stdout/JSON reales están en
[Plan y ejecución C-06](c-06/README.md) y la
[auditoría técnica](../architecture/c-06-completeness-audit.md).

### Actualización de ejecución C-06 — 2026-09-25, piloto Railway

Con autorización se probó Wazuh 4.14.7 en un proyecto Railway temporal aislado,
que ya fue eliminado. Manager, Indexer y Dashboard arrancaron; Indexer quedó
`RUNNING`, creó/mapeó el índice diario de alertas y reportó health `GREEN`.
Filebeat cargó el pipeline de alertas. La consulta API del marcador sintético no
se pudo completar por limitaciones de sesión/sonda; por tanto este resultado es
smoke de infraestructura, no aceptación E2E. El piloto tenía volumen de 5 GB
frente a 50 GB requeridos y no verificó el sysctl del host. Evidencia redactada
y logs preservados en `artifacts/integration/c06-railway-2026-09-25/`. C-06 se
mantiene `IN_PROGRESS`; detalle en [plan y ejecución](c-06/README.md).

## Registro — 2026-09-28

Sprint: 2 — Ingesta durable Microsoft 365/Wazuh (Sprint Goal vigente).

Sprint 1 cerró sus nueve componentes (`C-01`…`C-09`) el 2026-09-25, ocho días
laborables antes de su límite original (2026-10-02). Este registro abre el
trabajo de Sprint 2 hoy, adelantado respecto a las fechas 2026-10-05/06 que
todavía figuran en
[`sprints/02-ingesta-microsoft-wazuh.md`](sprints/02-ingesta-microsoft-wazuh.md);
pendiente confirmar con Franco una Sprint Planning corta que re-feche el
documento formalmente.

Componentes activos y estado:

- C-01…C-07: `DONE`, sin condiciones.
- C-08: `DONE` solo para habilitar Sprint 2, por excepción del Product Owner
  (2026-09-25); integración real contra Wazuh sigue pendiente como gate del
  E2E final del MVP.
- C-09: `IMPLEMENTED / BLOCKED_BY_REPOSITORY_ADMINISTRATION`, no `DONE`.
- C-10 — adapter Wazuh: `READY`; inicia hoy sobre el contrato local de C-08.

Evidencia terminada desde el Daily anterior: cierre de Sprint 1 completo, ver
[informe de cierre 2026-09-25](informes-de-avance/2026-09-25-informe-de-cierre.md).

Plan hasta el siguiente Daily:

1. Confirmar fecha de Sprint Planning y timebox real de Sprint 2 con Franco.
2. Avanzar C-10 (registro de fuente, paginación, errores de frontera) contra
   el contrato local de C-08; sin afirmar aceptación contra Wazuh real.
3. Registrar PBI-007 como `BLOCKED` en el Product Backlog con dueño (Franco).
4. Evaluar abrir C-11 como segundo ítem de WIP solo si no compromete el foco
   en C-10.

Bloqueos: causa / impacto / dueño / siguiente acción / escalamiento:

- PBI-007 sin tenant/permisos/red reales de Microsoft 365/Wazuh — impacto:
  bloquea el Sprint Goal completo, no el desarrollo local — dueño: Franco
  Clavo Santander — siguiente acción: confirmar acceso real o mantener el
  bloqueo con fecha objetivo explícita — escalamiento: Product Owner si no
  hay respuesta antes del cierre de Sprint 2.
- Fechas de Sprint 2 desactualizadas en el documento de plan — impacto: bajo,
  riesgo de proceso — dueño: Cesar / Franco — siguiente acción: re-fechar
  tras la Sprint Planning.

Cambio al Sprint Backlog: ninguno declarado hoy; PBI-007 se mantiene `BLOCKED`
como ya estaba registrado.

Confianza en el Sprint Goal: ÁMBAR. El gate previo de Sprint 1 está satisfecho
con sus excepciones documentadas y C-10 puede avanzar en local hoy mismo; el
Sprint Goal completo depende enteramente de que Franco confirme acceso real a
Microsoft 365/Wazuh durante el Sprint.

Informe: [Daily Scrum 2026-09-28](informes-de-avance/2026-09-28-informe-de-avance.md).

## Registro — 2026-09-29

Sprint: 2 — Ingesta durable Microsoft 365/Wazuh (Sprint Goal vigente).

Cierre de ayer (`3e10d73`): C-28 (gateway KrakenD, contrato/baseline)
fusionado en `main` con contrato local 6/6 PASS y gate CI `c28-krakend`
obligatorio; integración local sin ejecutar por el fallo persistente de
Docker Desktop/WSL, validada en CI. PBI-007 sigue `BLOCKED`, ahora con
diagnóstico real de causa raíz: el app registration de Entra autentica pero
no tiene permisos de aplicación concedidos (`401 AF10001`); falta el admin
consent de Franco sobre `ActivityFeed.Read`. Detalle en
[informe de cierre 2026-09-28](informes-de-avance/2026-09-28-informe-de-cierre.md)
y [C-10 — diagnóstico](c-10/README.md).

Componentes activos y estado:

- C-01…C-09, C-28: `DONE` o `DONE` con excepción documentada, sin cambio
  hoy respecto al cierre de ayer.
- C-10, C-11, C-12, C-13, C-14, C-15, C-24: sin código construido; hoy abre
  como objetivo de la jornada.

Plan hasta el siguiente Daily — objetivo deliberadamente ambicioso: cerrar
en su totalidad el alcance construible de Sprint 2 en un solo día en vez de
mantener el ritmo de uno o dos componentes por jornada:

1. C-10 — adapter Wazuh read-only contra el contrato local de C-08 vía C-28.
2. C-11 — admisión durable (raw/ref/hash, manifiesto, checkpoint) antes de
   publicar referencia en BullMQ.
3. C-12 — mapping Wazuh → SecurityEvent versionado y validado.
4. C-13 — idempotencia, replay, duplicados y cuarentena con lineage.
5. C-14 — proyección OpenSearch y consulta tipada/autorizable.
6. C-15 (transversal) — Collector, Loki/Prometheus, dashboard mínimo.
7. C-24 (transversal) — contrato write-only create/rotate/revoke de
   credenciales.
8. Seguimiento en paralelo del admin consent pendiente de PBI-007; si se
   otorga hoy, re-ejecutar de inmediato la verificación real de C-10.

Cada componente exige su suite local real y failure path demostrado antes de
declararse `DONE`; el volumen de alcance de hoy no relaja ese estándar.

Bloqueos: causa / impacto / dueño / siguiente acción / escalamiento:

- PBI-007 sin admin consent otorgado sobre `ActivityFeed.Read` — impacto:
  bloquea el Sprint Goal E2E aunque C-10…C-14 lleguen a `DONE` local —
  dueño: Franco Clavo Santander — siguiente acción: otorgar el consentimiento
  en Azure Portal hoy si es posible — escalamiento: Product Owner si no hay
  respuesta antes del cierre de Sprint 2.
- Docker Desktop/WSL sin levantar el daemon en el host de desarrollo —
  impacto: bloquea validación local de C-28 y posiblemente de los nuevos
  componentes — dueño: Cesar — siguiente acción: reintentar el runbook
  ampliado ayer; escalar con Diagnostic ID si persiste.
- Alcance de hoy cubre siete componentes/PBI en una sola jornada — impacto:
  riesgo de sobrecompromiso aceptado explícitamente — dueño: Cesar —
  siguiente acción: registrar `IN_PROGRESS` con pendiente exacto cualquier
  componente que no cierre con evidencia real al final del día, sin forzar
  `DONE`.

Cambio al Sprint Backlog: ninguno declarado al abrir hoy; PBI-007 se
mantiene `BLOCKED` como ya estaba registrado.

Confianza en el Sprint Goal: ÁMBAR. El objetivo de hoy —completar toda la
construcción local de Sprint 2— es alcanzable porque C-28 y el contrato de
C-08 ya están en `main`, pero exige mantener evidencia verificable en siete
componentes/PBI sin recortarla por el timebox. El Sprint Goal formal sigue
condicionado enteramente al admin consent pendiente de PBI-007.

Informe: [Daily Scrum 2026-09-29](informes-de-avance/2026-09-29-informe-de-avance.md).
