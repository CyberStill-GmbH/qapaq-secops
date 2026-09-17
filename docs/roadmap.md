# Plan de implementación posterior

Estado: PROPOSAL por gates, sin fechas ni estimaciones inventadas.
Esta tarea termina en documentación; ninguna etapa ejecutable se crea ahora.

## Etapa 0 — acordar la primera vertical

Revisar ADRs/módulos, scopes e IdP, fuente piloto, retención, auditoría y SLO.
No es necesario decidir todas las integraciones futuras. Salida: una fuente de
lectura, un caso de detección/triage y criterios de aceptación medibles; dueños
operacionales confirmados y preguntas bloqueantes identificadas.

## Etapa 1 — base de ingeniería

Crear API/web mínimos, toolchain versionado, validación de configuración,
dependencias hacia adentro, CI GitHub Actions y fakes de ports. Health seguro y
redacción desde el inicio. No crear todas las carpetas/módulos vacíos.
Salida: gates reales, tests de límites y ejecución local reproducible sin Qapaq.

## Etapa 2 — acceso, autorización y auditoría

Federación/session, capabilities/scopes y auditoría transaccional. Vistas mínimas
de operación con estados de acceso/degradación. Salida: pruebas deny/revocación/
autoescalada, rollback de audit, grants revisados y acceso a evidencia separado.
No habilitar datos reales antes de estos controles.

## Etapa 3 — vertical de fuente piloto

Collector read-only autorizado, raw/manifiesto, BullMQ, parser/normalizer,
búsqueda, detección simple/alerta y un incidente/case. Reusar señales Wazuh si
cumplen el caso; no reescribir su motor.
Salida: origen→evidencia→alerta trazable, fallos/retries/replay probados,
capacidad de drenaje y prueba de fuente real claramente separada de fakes.

## Etapa 4 — ciclo de datos y operación

Archivo, restore selectivo, catálogo de cobertura, retención/hold aprobados,
auditoría archivada y runbooks. Salida: restore desde backup/archivo, purga segura,
quotas de queries/exports y simulacro de conector/cola/index caídos.

## Etapa 5 — expansión basada en evidencia

Más fuentes, contexto de activos, MISP y correlación transversal por prioridades
SOC. Python solo tras caso/benchmark y contrato interoperable. Reporting y
dashboards sobre proyecciones autorizadas, no acoplamiento a tablas.
Salida: beneficios operacionales medidos y coste soportable.

## Futuro condicionado

SOAR con aprobaciones/catálogo de acciones, analítica avanzada y extracción de
módulos solo por necesidad demostrada. No Kafka/Kubernetes/microservicios/ML
complejo por completar una lista. Cada ampliación debe reabrir threat model,
contratos, operación y ADR afectado.
