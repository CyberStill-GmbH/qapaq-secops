# ADR-016 — Baseline de toolchain, límites y medición de capacidad

Estado: Accepted · Fecha de decisión: 2026-09-18, indicada por el usuario.

Decision owners: Development + Platform.

Evidencia: resolución explícita de U-002 aportada por el usuario.

## Context

El stack de alto nivel estaba definido, pero faltaban versiones, ORM, gestor del
monorepo, herramientas de calidad y límites iniciales. Sin una baseline fijada,
los entornos, CI y benchmarks no serían reproducibles. Tampoco existe evidencia
para afirmar una cantidad de EPS soportada por el sistema aún no implementado.

Node 24 figura como LTS y Node recomienda LTS para producción. NestJS 12 requiere
versiones modernas de Node para ejecutar/generar código y recomienda el último LTS
activo. Las versiones fijadas se comprobaron contra fuentes oficiales o registros
de paquetes el 2026-09-17; eso confirma disponibilidad, no compatibilidad completa.

## Decision

Adoptar la baseline y los límites canónicos de
[toolchain y capacidad](../architecture/toolchain-and-capacity.md). Los manifests,
lockfiles, imágenes y CI fijarán las versiones exactas al implementarse; no se
usarán tags flotantes `latest` en entornos reproducibles.

La arquitectura escala mediante API stateless, workers por cola, procesamiento
asíncrono, batches y payloads acotados, backpressure, idempotencia, separación de
control/telemetry plane, PostgreSQL transaccional, OpenSearch para telemetría,
Redis/BullMQ para jobs operacionales y contratos explícitos con Python.

La capacidad aceptada será el mayor perfil que supere los gates en el hardware de
referencia con el margen acordado. Ninguna cifra de EPS queda aceptada por este ADR.

## Alternatives

Usar versiones flotantes impide reproducibilidad. Adoptar Node Current, Prisma RC
o BullMQ 6 inmediatamente eleva el riesgo sin evidencia del proyecto. Nx/Turborepo
añaden orquestación que pnpm no necesita inicialmente. Declarar capacidad desde
benchmarks públicos ignora flujos, reglas, payloads y hardware de QAPAQ SecOps.

## Consequences

El repositorio deberá materializar pnpm/uv lockfiles, scripts de calidad y perfiles
de contenedor antes de afirmar que el toolchain funciona. Cambiar un major requiere
PR separado, pruebas completas y registro de compatibilidad. Prisma no cruza el
límite de infraestructura y BullMQ no se convierte automáticamente en backbone de
telemetría. Los límites iniciales pueden ajustarse mediante decisión/evidencia.

Los resultados de capacidad se registrarán en `docs/performance/` y serán
comparables porque incluyen commit, configuración, versiones, hardware y dataset.

## Trade-offs

Fijar versiones y límites reduce flexibilidad inmediata, pero evita deriva entre
desarrollo, CI y benchmark. Fastify, pnpm, Prisma y el doble runtime agregan
decisiones operativas; a cambio ofrecen una baseline explícita. El margen del 30%
reduce la cifra publicable para conservar capacidad de recuperación y crecimiento.

## Validación y revisión

La aceptación de U-002 no sustituye instalación ni ejecución. Antes de desarrollar,
verificar compatibilidad real de la matriz, generar lockfiles y ejecutar los scripts.
Antes de publicar capacidad, completar al menos tres ejecuciones por escenario y
todos los gates definidos. Revisar la baseline ante fin de soporte, vulnerabilidad,
incompatibilidad o necesidad demostrada; no por disponibilidad de un major nuevo.

[U-002 aceptada](../decisions/unresolved.md) ·
[fuentes consultadas](../references.md) ·
[resultados de rendimiento](../performance/README.md).
