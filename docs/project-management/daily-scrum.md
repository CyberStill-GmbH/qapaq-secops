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

## Regla para los siguientes registros

Se agrega una sección fechada por día laborable. No se reescribe el historial para
mejorar métricas. Si no hubo avance, se registra la causa. Un bloqueo que dura un
día laborable se escala conforme al plan Scrum.

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
