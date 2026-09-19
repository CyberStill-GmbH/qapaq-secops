# Sprint 1 — Base ejecutable y contratos

Fechas: 2026-09-19 a 2026-10-02 · Planning: 2026-09-21 · Review/Retro: 2026-10-02.

## Sprint Goal

Disponer de una base reproducible que valide SecurityEvent y sus dependencias reales,
y cerrar el contrato operativo Microsoft 365/Wazuh necesario para construir la
vertical sin supuestos.

## Forecast inicial

1. PBI-001 — workspace y toolchain.
2. PBI-002 — CI de PR y evidencia.
3. PBI-003 — ambiente de integración con servicios reales.
4. PBI-004 — SecurityEvent 1.0.0.
5. PBI-005 — port y suite de conformidad de adapters.
6. PBI-006 — contrato operativo Microsoft 365/Wazuh.

El Sprint Goal puede cumplirse aunque PBI-006 quede `BLOCKED` por una dependencia
externa, siempre que el bloqueo tenga evidencia y el resto de la base sea ejecutable.
La integración externa no se declara Done en ese caso. PBI-005 no implementa
proveedores futuros: define la frontera y pruebas comunes usadas por el adapter real.

## Componentes a construir

| Orden | Componentes | Resultado físico |
| --- | --- | --- |
| 1 | C-01 | Workspace pnpm, versiones, scripts y configuración TypeScript reproducibles |
| 2 | C-03, C-05 | Configuración tipada y contrato SecurityEvent 1.0.0 ejecutable |
| 3 | C-06, C-04 | Entorno de servicios reales y persistencia/migración base |
| 4 | C-02, C-07 | Entrypoints ejecutables y límites arquitectónicos comprobados |
| 5 | C-08 | Port, suite de conformidad y probe Wazuh read-only real |
| 6 | C-09 | CI de PR #2 adaptada al workspace y a sus scripts reales |

La secuencia C-01 → C-03/C-05 → C-06 es el camino de desbloqueo. No se crean todos
los módulos del producto: solo aparecen las rutas con código o specs de este Sprint.
Los contratos, comandos y evidencia de cada C-ID están en el
[plan por componentes](../component-delivery-plan.md).

## Plan de trabajo

### Inicio y primera semana

- Planning confirma capacidad y acceso al repositorio/CI.
- Materializar workspace, scripts y CI antes de ampliar código.
- Levantar servicios reales aislados y probar health/teardown.
- Implementar schema, catálogos y corpus SecurityEvent.
- Abrir el requerimiento formal de acceso Microsoft 365/Wazuh con todos los campos
  de PBI-006 y fecha objetivo no posterior a 2026-09-25.

### Segunda semana

- Generar/verificar tipos y validadores contra el schema.
- Implementar port, composition root mínimo y regla de dependencias.
- Ejecutar suite de conformidad inicial con el adapter Wazuh real si existe acceso.
- Completar CI, evidencia y documentación de incorporación de proveedores.
- Cerrar defectos P0/P1 antes de tomar PBI adicional.

## Dependencias de entrada

- acceso de escritura al repositorio y ejecución de CI;
- runtime local o runner con capacidad para servicios reales;
- dueño técnico de Wazuh y Microsoft 365 identificado;
- versión/endpoint Wazuh, Indexer y red disponibles para PBI-006;
- proceso aprobado para secretRefs.

## Specs obligatorias

- instalación limpia, format, lint, typecheck, unit y build;
- smoke integration de PostgreSQL, Redis/BullMQ, object storage y Wazuh;
- corpus SecurityEvent válido/inválido y versiones incompatibles;
- regla de dependencia domain/application → infrastructure;
- health y consulta mínima real al Wazuh Indexer para cerrar PBI-006.

## Criterios de Review

La demostración parte de un checkout limpio: instala, levanta dependencias, ejecuta
CI local, valida el corpus y muestra un documento real de Wazuh consultado con
acceso restringido cuando el entorno esté autorizado. Se revisan Product Backlog,
riesgos y accesos, no solo archivos creados.

Evidencia esperada:

- PRs y CI verdes;
- schema/corpus versionados;
- reporte de servicios reales y versiones;
- ficha Microsoft 365/Wazuh completa o bloqueo formal;
- resultado de la Retrospective y una mejora para Sprint 2.

## Regla de salida

Si workspace, CI o schema no cumplen Done, Sprint 2 no toma ingesta funcional hasta
terminarlos. Si solo falla el acceso corporativo, Sprint 2 puede avanzar en
persistencia y adapter contra Wazuh real local, pero PBI-007 permanece bloqueado y
no se usa una respuesta Microsoft simulada para cerrarlo.

[Product Backlog](../product-backlog.md) · [Plan por componentes](../component-delivery-plan.md) ·
[Definition of Done](../definition-of-done.md)
