# Auditoría de estructura del repositorio

Estado: AUDITADO · Fecha: 2026-09-19 · Rama: `requirements` · Snapshot inicial:
`4a90cde`. Alcance: árbol Git, arquitectura, ADR, requisitos y plan Scrum. No se
auditó código de aplicación porque no existe en esta rama.

## Dictamen

El repositorio es una baseline documental coherente, pero aún no es un producto
ejecutable. El árbol versionado contiene `.gitignore`, `LICENSE` y `docs/`; carece
de workspace, manifests, lockfile, aplicaciones, módulos, schemas ejecutables,
migraciones y specs. Por ello ningún componente del MVP puede marcarse
IMPLEMENTED ni verificarse mediante tests de aplicación.

La arquitectura conceptual es utilizable como guía. Antes de esta auditoría, su
estructura fina ubicaba los módulos en `apps/api` y duplicaba la capacidad de
notificaciones dentro de `apps/worker`. Eso contradecía la decisión de que API y
worker fueran entrypoints del mismo monolito. La
[estructura objetivo](repository-structure.md) corrige esa distribución con
`modules/` compartido y entrypoints delgados.

## Método y evidencia

Se inspeccionaron los archivos rastreados por Git, los 24 ADR, estructura,
dependencias, módulos, C4, RF/RNF, backlog, Definition of Done y tres Sprints. La
comparación se hizo contra ADR-015/016/024 y la regla explícita de no sustituir
integraciones por fakes. La existencia de un documento se considera evidencia de
diseño, no de implementación.

## Hallazgos

| ID | Severidad | Observación | Impacto | Resolución documental / acción |
| --- | --- | --- | --- | --- |
| STR-01 | Bloqueante | No existen `package.json`, `pnpm-workspace.yaml`, `.nvmrc` ni lockfile | No hay instalación o build reproducible | C-01 y PBI-001 deben ser el primer incremento |
| STR-02 | Alta | No existen `apps/`, `modules/`, `platform/` ni `packages/` | Los límites hexagonales no pueden aplicarse ni probarse | Materializar solo los componentes planificados, en orden |
| STR-03 | Alta | Los módulos estaban bajo API aunque worker comparte casos de uso | Riesgo de imports app-a-app, duplicación y ciclos | Corregido; los módulos viven en `modules/` |
| STR-04 | Alta | No existe SecurityEvent ejecutable ni corpus | La integración Wazuh carece de frontera validable | C-05 antes del adapter y la normalización |
| STR-05 | Alta | No existen Prisma schema, migraciones ni ownership físico | No se puede demostrar atomicidad, outbox o auditoría | C-04 establece base; cada módulo conserva repositorios propios |
| STR-06 | Alta | No existe harness con PostgreSQL, Redis, object storage, OpenSearch y Wazuh reales | Las specs exigidas por DoD no pueden ejecutarse | C-06 y C-08; cualquier dependencia ausente queda BLOCKED |
| STR-07 | Media | CI está desarrollado en la rama/PR #2 y no forma parte de este snapshot | La documentación no prueba que CI proteja esta rama | Integrar y adaptar mediante C-09/PBI-002, sin duplicar workflow |
| STR-08 | Media | No hay enforcement de imports ni fixtures de violación | La arquitectura hexagonal puede degradarse silenciosamente | C-07 agrega reglas y casos que deben fallar |
| STR-09 | Alta | El Scrum listaba capacidades, pero no rutas, orden técnico ni evidencia por componente | El Sprint Backlog podía convertirse en una lista ambigua de features | Resuelto por el plan C-01…C-23 y las tablas de cada Sprint |
| STR-10 | Alta | El forecast P0 es amplio para un único Developer y no existe velocidad histórica | Alto riesgo de sobrecompromiso y calidad recortada | Planning selecciona componentes completos por capacidad; orden crítico obligatorio |
| STR-11 | Media | Los módulos post-MVP podían materializarse como carpetas vacías | Señal falsa de avance y abstracciones especulativas | No crear `threat-intelligence` o `antifraud` hasta un PBI autorizado |
| STR-12 | Media | No existen ownership automatizado ni revisión especializada materializados | Cambios críticos podrían integrarse sin el reviewer requerido | C-09 incorpora protección/owners cuando el repositorio lo permita |

## Árbol mínimo del MVP

```text
apps/{api,worker,web}
modules/{access,connectors,telemetry,detection,soc,soar}
platform/{audit,configuration,database,observability,testing}
packages/contracts
docs
.github/workflows
```

Este árbol es una meta, no una orden de crear directorios vacíos. Cada ruta aparece
solo en el PR que entrega código, configuración o specs ejecutables. Las áreas
post-MVP permanecen documentadas hasta que haya un consumidor real.

## Dependencias estructurales obligatorias

```text
apps ───────► modules.public / composition
modules ────► contracts y ports propios
adapters ───► modules.application ports
platform ───► librerías técnicas
domain ─────► lenguaje y librerías puras
```

Están prohibidos los imports desde `modules/*` hacia `apps/*`, entre internals de
módulos, desde domain/application hacia SDKs o infraestructura, y desde web hacia
base de datos, Wazuh Indexer u object storage. API y worker ensamblan fachadas; no
comparten código mediante imports relativos entre aplicaciones.

## Ruta crítica de construcción

```text
C-01 workspace
  ├─► C-03 configuración ─┐
  ├─► C-04 persistencia ──┼─► C-11 admisión durable ─► C-13 resiliencia
  ├─► C-05 contratos ─────┼─► C-12 normalización ────► C-14 consulta
  ├─► C-06 entorno real ──┤
  └─► C-07 límites ───────┘
C-08 contrato Wazuh ─► C-10 adapter ─► C-11…C-15
C-14 ─► C-16 detección ─► C-17 SOC ─► C-20 Teams
C-18 acceso y C-19 auditoría ─────────► C-17/C-21/C-22
```

La integración Microsoft 365/Wazuh real es dependencia externa de C-10 y de la
demostración E2E. Si está bloqueada, se puede avanzar en componentes internos que
tengan specs reales contra servicios locales, pero no cerrar la vertical.

## Criterios de preparación estructural

La estructura se considera materializada cuando:

- una instalación limpia usa versiones y lockfile fijados;
- API, worker y web arrancan desde sus entrypoints sin importar internals mutuos;
- cada módulo tiene owner, fachada pública y reglas de import comprobadas;
- SecurityEvent y mensajes públicos se validan con schemas y corpus;
- migraciones y ownership de datos son explícitos;
- integration specs levantan servicios reales aislados y provider specs usan
  entornos autorizados;
- CI ejecuta format, lint, typecheck, unit, contract, integration y build;
- ningún directorio, adapter o test existe solo para aparentar cobertura futura.

Hasta entonces, el estado correcto es DOCUMENTED / IMPLEMENTATION REQUIRED.

## Riesgo residual

La nueva distribución elimina la ambigüedad física, pero todavía debe probarse al
materializar el workspace. Un cambio que mueva módulos, introduzca servicios
independientes o permita dependencias cruzadas requiere actualizar esta baseline y,
si cambia una decisión aceptada, registrar un ADR.

[Plan por componentes](../project-management/component-delivery-plan.md) ·
[Reglas de dependencia](dependency-rules.md) ·
[Requisitos](../requirements/README.md)
