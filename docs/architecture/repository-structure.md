# Estructura propuesta del repositorio

Estado: PROPOSAL; representación documental. No se crean estas carpetas en esta tarea.

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
          assets/
          connectors/
          telemetry/
          detection/
          soc/
          audit/
          workspace/
        bootstrap/              # composición, HTTP y ciclo de vida de workers
      test/
    web/
      src/
        features/               # vistas y flujos SOC, no copias de entidades ORM
    analytics-worker/           # futuro, solo con caso Python justificado
  packages/
    contracts/                  # schemas JSON y DTO de fronteras estables
  scripts/                      # cuando exista automatización ejecutable necesaria
  .github/
    workflows/                  # CI gestionado aparte; no creado por esta tarea
```

La API y el runner de jobs pueden usar el mismo artefacto/release con distintos
entrypoints; no requiere otro servicio de negocio. Separar proceso solo para
proteger API de cargas asíncronas, con capacidad acordada. API y web tienen
toolchains distintos; gestor workspace, versiones y bundler se deciden después.

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

Repositorios y ports viven en application por defecto; una interfaz de dominio
solo si expresa una necesidad puramente de dominio. NestJS module y wiring van en
composición/presentation/infrastructure según convención acordada, nunca en domain.

## Paquetes y límites

contracts contiene schemas de eventos/jobs y API compartidos, no entidades de
dominio ni permisos autoejecutables. Modelos internos no se exportan para que React
haga lógica de negocio. Evitar packages/shared; extraer security/observability
solo cuando dos consumidores reales justifiquen compartir implementación.
No distribuir un paquete gigante que haga depender todos los contextos de todos.

Python consume JSON/schema y fixtures, no importa paquetes TypeScript. Dependencias
Python se fijan por su propio lockfile cuando se active; una instalación Node
verde no valida Python.

## Documentación canónica

architecture/ describe diseño; adr/ registra decisiones; diagrams/ conserva Mermaid.
Documentos planos anteriores enlazan a canónicos por compatibilidad. Referencias
de vendors y preguntas se mantienen sin crear árboles de docs vacíos.
