# Estructura objetivo del repositorio

Estado: BASELINE DE IMPLEMENTACIÓN. El workspace fue aceptado por
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md); esta distribución fina
resuelve el uso compartido de módulos por API y worker. La estructura todavía no
existe en la rama documental.

```text
qapaq-secops/
  apps/
    api/                         # entrypoint HTTP/BFF y composition root
      src/
      test/
    worker/                      # entrypoint BullMQ, schedulers y composition root
      src/
      test/
    web/                         # React; consume API, nunca storage directamente
      src/
      test/
  modules/                       # capacidades de negocio compartidas por entrypoints
    access/
    connectors/
    telemetry/
    detection/
    soc/
    soar/
  platform/                      # implementaciones técnicas transversales
    audit/                       # AuditEvent, append-only y archivo/reconciliación
    configuration/
    database/
    observability/
    testing/
  packages/
    contracts/                   # schemas/eventos/jobs públicos y versionados
  research/
    analytics/                   # Python no desplegado; se crea solo tras su gate
  scripts/                       # automatización ejecutable necesaria
  docs/
  .github/
    workflows/
```

API y worker son entrypoints del mismo monolito modular. La API expone HTTP/BFF y
el worker ejecuta jobs; ambos componen módulos desde `modules/`. Ninguno importa
internals del otro. Esta ubicación reemplaza la propuesta anterior de poner los
módulos en `apps/api/src/modules`, que impedía compartirlos limpiamente con el
worker.

Solo se crean directorios cuando incluyen código, configuración o specs reales.
Durante el MVP se materializan `access`, `connectors`, `telemetry`, `detection`,
`soc` y `soar`. `threat-intelligence` y `antifraud` conservan su alcance aceptado,
pero no generan carpetas vacías hasta entrar en un incremento.

`apps/api`, `apps/worker` y `apps/web` comparten pnpm workspace y lockfile.
`pyproject.toml`, `uv.lock` y el runtime Python solo se incorporan después del gate
de U-007. Las versiones están fijadas en
[toolchain y capacidad](toolchain-and-capacity.md).

## Interior de un módulo

```text
modules/soc/
  src/
    domain/                      # agregados, value objects e invariantes
    application/
      ports/                     # necesidades del módulo, no SDKs
      use-cases/
    infrastructure/             # adapters y persistencia del módulo
    presentation/               # handlers HTTP/jobs sin reglas de negocio
    public/                      # única superficie importable por otros módulos
  test/
    unit/
    integration/
    contract/
```

Las carpetas se crean conforme aparece contenido. Repositorios y ports viven en
application por defecto; una interfaz pertenece al dominio solo si expresa una
necesidad puramente de dominio. DTO, entidad Prisma y agregado son tipos distintos.
No se introduce `BaseRepository`, entidad base ni `packages/shared`.

Cada módulo publica una fachada de composición. Los entrypoints conocen esa
fachada y suministran adapters; no importan archivos internos. El C4 nivel 4 de
[modelo C4](c4-model.md) sigue siendo representativo hasta que exista código.

## Límites de las áreas técnicas

- `platform/configuration` valida configuración y resuelve referencias a secretos;
  no contiene valores corporativos.
- `platform/audit` implementa la capacidad transversal de auditoría de seguridad;
  expone un port/fachada y nunca se sustituye por logging operacional.
- `platform/database` contiene cliente, migraciones y utilidades transaccionales;
  cada módulo conserva ownership de sus schemas y repositorios.
- `platform/observability` implementa logging, métricas y tracing; auditoría de
  seguridad sigue siendo una capacidad explícita, no un log.
- `platform/testing` contiene arranque y clientes de servicios reales aislados;
  no contiene servidores fake ni respuestas grabadas.
- `packages/contracts` contiene SecurityEvent, AuditEvent y mensajes versionados;
  no contiene entidades de dominio ni lógica de autorización.

## Orden de materialización

1. raíz pnpm y configuración TypeScript;
2. `packages/contracts` y áreas mínimas de `platform/`;
3. entrypoints ejecutables de API, worker y web;
4. módulos `connectors` y `telemetry` para la vertical Wazuh;
5. módulos `detection`, `soc`, `access` y `soar`;
6. componentes post-MVP solo cuando tengan PBI, contrato y entorno real.

La secuencia detallada, dependencias y evidencia están en el
[plan de construcción por componentes](../project-management/component-delivery-plan.md).

## Documentación canónica

`architecture/` describe diseño; `adr/` registra decisiones; `diagrams/` conserva
Mermaid. Los documentos planos anteriores enlazan a páginas canónicas. Referencias
de proveedores y preguntas se mantienen sin crear árboles vacíos.
