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
