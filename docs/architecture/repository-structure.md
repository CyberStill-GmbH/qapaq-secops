# Estructura propuesta del repositorio

Estructura del workspace ACCEPTED por
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md), alineada con los módulos
aprobados en ADR-015. La distribución interna fina sigue evolutiva. No se crean
carpetas de aplicación en esta tarea.

```text
qapaq-secops/
  AGENTS.md
  .codex/skills/                 # existente; workflows locales
  docs/                         # diseño y decisiones de esta entrega
  apps/
    api/
      src/
        modules/
          access/
          connectors/
          telemetry/
          detection/
          soc/
          threat-intelligence/
          soar/
          antifraud/
        platform/               # capacidades transversales, no dominio compartido
        bootstrap/              # composición y HTTP
      test/
    worker/                     # BullMQ consumers y schedulers
      notifications/           # capability de soar para entrega asíncrona
        application/           # solicitar, entregar y escalar sin acuse
        domain/                # notification, policy y attempt
        infrastructure/        # adapter de Microsoft Teams Workflow
    web/
      src/
        features/               # vistas y flujos SOC, no copias de entidades ORM
  research/
    analytics/                  # experimentos Python no desplegados
  packages/
    contracts/                  # contratos internos versionados
    database/                   # Prisma client y migraciones
    observability/              # logging, métricas y tracing
    configuration/              # configuración tipada
    testing/                    # fixtures sintéticos
  scripts/                      # cuando exista automatización ejecutable necesaria
  .github/
    workflows/                  # CI gestionado aparte; no creado por esta tarea
```

API y worker son entrypoints del mismo monolito modular, no servicios de negocio
independientes. El proceso separado protege la API de carga asíncrona y escala por
cola. API/web/worker comparten pnpm workspace/lockfile. `pyproject.toml`, `uv.lock` y
`apps/analytics` solo se incorporan al runtime después del gate de U-007.
Versiones y herramientas están fijadas en [toolchain](toolchain-and-capacity.md).

## Interior de un módulo

```text
modules/soc/
  domain/                       # agregados Incident, Case, Alert; invariantes
  application/
    ports/                      # repositorios, autorización contextual y evidencia
    use-cases/                  # cerrar incidente, vincular evidencia, etc.
  infrastructure/
    persistence/
    adapters/
  presentation/
    http/
  public/                       # contratos de colaboración entre módulos
```

Los nombres son ejemplos de organización. Crear subcarpetas solo al existir
contenido; separar commands/queries si aporta legibilidad, no por exigir CQRS.
No repositorio genérico BaseRepository ni entity base llena de dependencias.
La relación entre estas capas se muestra como C4 nivel 4 propuesto en el
[modelo C4](c4-model.md); no prueba que las clases o carpetas estén creadas.

Repositorios y ports viven en application por defecto; una interfaz de dominio
solo si expresa una necesidad puramente de dominio. NestJS module y wiring van en
composición/presentation/infrastructure según convención acordada, nunca en domain.

## Paquetes y límites

contracts contiene schemas de eventos/jobs y API compartidos, no entidades de
dominio ni permisos autoejecutables. Modelos internos no se exportan para que React
haga lógica de negocio. Evitar packages/shared; extraer security/observability
solo cuando dos consumidores reales justifiquen compartir implementación.
No distribuir un paquete gigante que haga depender todos los contextos de todos.

La investigación Python usa datos sintéticos o sanitizados y no constituye runtime.
Tras una activación aprobada, Python consume contratos y fixtures, no importa
paquetes TypeScript ni escribe tablas del backend; sus dependencias se fijan en
`uv.lock` y se validan por separado.

## Documentación canónica

architecture/ describe diseño; adr/ registra decisiones; diagrams/ conserva Mermaid.
Documentos planos anteriores enlazan a canónicos por compatibilidad. Referencias
de vendors y preguntas se mantienen sin crear árboles de docs vacíos.
