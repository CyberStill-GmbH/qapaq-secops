# ADR-007 — Analítica Python como capacidad dormante

- Estado: **ACCEPTED — DORMANT CAPABILITY**
- Estado del runtime MVP: **NOT ENABLED**
- Activación: **BLOCKED UNTIL USE CASE AND BENCHMARK PASS**
- Fecha: 2026-09-18
- Responsables de decisión: Development + SOC + Security

## Context

QAPAQ permite Python para analítica especializada, pero el MVP no tiene todavía
un caso medible que justifique un segundo runtime, dependencias, observabilidad y
recuperación. Wazuh cubre detecciones nativas; TypeScript cubre reglas y
correlaciones determinísticas; OpenSearch cubre búsqueda y agregaciones.

## Decision

Python no se despliega en el runtime del MVP. Se conserva una frontera futura para
estadística avanzada, procesamiento vectorizado, grafos o ML cuando aporte valor
medible frente a Wazuh, TypeScript y OpenSearch.

El primer candidato posterior al MVP es `Authentication Behavior Anomaly Scoring`
sobre eventos normalizados de Microsoft Entra ID. Será offline, batch y acotado;
solo producirá `ANALYTICS_CANDIDATE`. TypeScript revalidará el resultado y decidirá
si existe una alerta usando contexto determinístico, criticidad, privilegio y
supresión. Python nunca crea alertas, incidentes ni acciones SOAR directamente.

La activación exige owner, pregunta de negocio, dataset autorizado, baseline
determinística, razón técnica, metodología, privacidad, presupuesto, benchmark,
comportamiento de fallo, rollback, contratos aprobados y las 18 pruebas definidas
en [Analítica Python](../architecture/python-analytics.md#pruebas-de-aceptación).

`apps/analytics/` solo se crea al activar la capacidad. Antes de ello puede existir
`research/analytics/` con documentación, fixtures sintéticos, experimentos offline
y benchmarks no desplegados. Los notebooks no son artefactos productivos.

## Alternatives

- **Desplegar Python desde el MVP:** descartado porque agrega coste operacional sin
  una detección concreta ni benchmark.
- **Implementar toda analítica en Python:** descartado porque desplaza casos de uso
  y ownership del monolito NestJS.
- **Excluir Python permanentemente:** descartado porque impediría usar un ecosistema
  científico cuando un caso aprobado demuestre valor.
- **Python inline o síncrono:** descartado porque podría bloquear ingesta o flujos
  de usuario.

## Consequences

- El runtime inicial contiene API, web y workers TypeScript, sin worker Python.
- La ausencia de Python en el MVP no constituye deuda arquitectónica.
- Versiones y herramientas Python de ADR-016 quedan reservadas para investigación
  reproducible y una activación futura; no obligan a crear manifests o imágenes.
- Los resultados futuros se tratan como input no confiable, se intercambian por
  artifacts y JSON versionado, y no acceden directamente a stores o secretos.
- Fallos analíticos nunca detienen ingesta, Wazuh ni reglas TypeScript.

## Trade-offs

Diferir Python reduce superficie operativa y concentra el MVP en el flujo principal,
pero posterga analítica probabilística. La frontera contractual añade trabajo antes
de activarlo, a cambio de impedir acoplamiento con persistencia y facilitar una
evaluación reproducible. El batch offline reduce riesgo y coste, pero no sirve para
decisiones de baja latencia.

## Validation

La decisión queda cerrada; la capacidad queda dormante. Activarla exige actualizar
C4 y despliegue, definir transporte, demostrar aislamiento y rollback, aprobar el
presupuesto y superar el benchmark y las pruebas del documento canónico.

[Diseño](../architecture/python-analytics.md) ·
[U-007](../decisions/unresolved.md) ·
[Toolchain](016-toolchain-and-capacity-baseline.md)
