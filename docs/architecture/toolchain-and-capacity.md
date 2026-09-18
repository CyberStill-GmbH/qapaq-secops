# Toolchain, límites y capacidad

Estado: ACCEPTED por [U-002](../decisions/unresolved.md) y
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md). Fecha de decisión
aportada: 2026-09-18. La capacidad numérica está pendiente de medición.

## Baseline reproducible

| Componente | Versión fijada | Uso |
| --- | ---: | --- |
| Node.js | 24.21.0 LTS | Runtime de NestJS y tooling React |
| TypeScript | 6.0.3 | Lenguaje en modo estricto |
| NestJS | 12.x | API y composición; mismo major en `@nestjs/*` |
| Fastify | 5.12.1 | Adaptador HTTP de NestJS |
| React | 19.3.0 | Frontend |
| Vite | 8.3.0 | Build y desarrollo frontend |
| Python | 3.14.7 | Analítica especializada |
| PostgreSQL | 18.6 | Estado transaccional |
| Redis | 8.10.1 | Cache y backend de colas |
| BullMQ | 5.81.5 | Jobs, SOAR y tareas operacionales |
| Prisma ORM | 7.10.0 | ORM y migraciones PostgreSQL |
| OpenSearch | 3.7.x | Telemetría, búsqueda y agregaciones |
| pnpm | 12.4.2 | Paquetes y workspaces JavaScript |
| uv | 0.12.15 | Dependencias y lockfile Python |

Las versiones patch exactas deberán constar en manifests, lockfiles, imágenes y
CI. No usar `latest`. Actualizar dentro de la línea fijada por seguridad después
de evaluar compatibilidad. No adoptar Node 26 mientras sea Current, TypeScript 7,
Prisma 8 RC ni BullMQ 6 sin la revisión descrita en ADR-016.

NestJS usa ESM y `@nestjs/platform-fastify`. Todos los paquetes oficiales de NestJS
comparten major. Fastify aporta schemas, serialización y límites configurables;
su rendimiento público no constituye capacidad de QAPAQ SecOps.

TypeScript requiere como mínimo:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "useUnknownInCatchVariables": true,
  "noFallthroughCasesInSwitch": true
}
```

## Prisma y persistencia

Prisma se limita a migraciones, acceso transaccional, consultas del control plane,
tipos generados y administración del schema PostgreSQL. No representa dominio;
sus tipos no salen de `infrastructure/persistence`. Cada módulo posee repositorios
propios. Migraciones son obligatorias y `db push` no es mecanismo productivo.

Una consulta crítica puede usar SQL parametrizado después de medir/documentar el
cuello de botella. PostgreSQL no almacena telemetría masiva.

## Workspace

Monorepo con pnpm workspaces, sin Nx ni Turborepo inicialmente:

```text
qapaq-secops/
├── apps/
│   ├── api/                    # NestJS HTTP
│   ├── worker/                 # BullMQ consumers/schedulers
│   ├── web/                    # React + Vite
│   └── analytics/              # Python analytics
├── packages/
│   ├── contracts/              # contratos internos versionados
│   ├── database/               # Prisma client y migraciones
│   ├── observability/          # logging, métricas y tracing
│   ├── configuration/          # configuración tipada
│   └── testing/                # fixtures sintéticos compartidos
├── docs/
├── scripts/
├── pnpm-workspace.yaml
├── package.json
├── pnpm-lock.yaml
├── pyproject.toml
└── uv.lock
```

Los módulos de negocio permanecen dentro de `apps/api` o paquetes internos con
límites explícitos; el monorepo no los convierte en aplicaciones independientes.

Python usa uv/uv.lock, Ruff, mypy o Pyright y pytest. Intercambia contratos
JSON/Protobuf versionados y no accede a tablas propiedad de NestJS.

## Toolchain de calidad

JavaScript/TypeScript: oxlint, Prettier, `tsc`, Vitest, Playwright, Testcontainers
y k6. CI: GitHub Actions, CodeQL, secret scanning, dependency review y Trivy.
Los scripts esperados son `format`, `format:check`, `lint`, `typecheck`, `test`,
`test:unit`, `test:integration`, `test:e2e`, `build` y `bench`.

Un script solo existe cuando está declarado en `package.json` o `pyproject.toml`
y se ejecuta realmente. Esta documentación no permite reportarlo como PASS.

Dependencias directas se fijan con lockfile; CI usa modo congelado. Parches de
seguridad se evalúan cuanto antes; patch mensuales, minor trimestrales y major en
PR independiente con pruebas completas/compatibilidad. No habilitar scripts de
instalación no aprobados ni dependencias abandonadas/duplicadas sin justificación.
Fijar imágenes por versión y digest cuando el pipeline exista.

## Límites HTTP y búsquedas

| Recurso de control plane | Límite inicial |
| --- | ---: |
| JSON request body | 1 MiB |
| URL | 8 KiB |
| Request headers | 16 KiB |
| Página por defecto / máxima | 50 / 200 |
| Request síncrona | 15 s |
| OpenSearch interactivo | 10 s |
| Intervalo de búsqueda por defecto / máximo | 24 h / 30 días |

Lo que exceda timeout o intervalo interactivo se convierte en job. Usar cursor
pagination; no offset para colecciones grandes. OpenSearch acepta solo filtros y
campos permitidos, rango temporal, `search_after`/point-in-time cuando corresponda,
agregaciones/cardinalidad limitadas y cancelación si es posible. El frontend no
envía Query DSL. Consultas costosas se convierten en exports asíncronos.

## Límites de ingesta

| Recurso | Límite inicial |
| --- | ---: |
| Evento normalizado individual | 256 KiB |
| Eventos por batch | 500 |
| Batch descomprimido | 5 MiB |
| Bulk OpenSearch | 500 documentos o 5 MiB |
| Flush máximo del bulk | 1 s |
| Payload de job BullMQ | 256 KiB |

Aplicar límites después de descomprimir para impedir compression bombs. Los jobs
transportan IDs/referencias, no copias de telemetría cuando exista referencia
segura. Un exceso se rechaza o va a cuarentena con trazabilidad; nunca se trunca.

## Conexiones y concurrencia para benchmark

Pools PostgreSQL iniciales: 10 conexiones por API, 5 por worker y 5 reservadas
para migraciones/administración. La suma de pools no supera 70% de
`max_connections`; 30% se reserva para operación/recuperación. Aumentar exige
evidencia de espera por conexión.

| Worker | Concurrency inicial |
| --- | ---: |
| Integration synchronization | 4 |
| Normalization | 8 |
| Enrichment | 8 |
| Deterministic detection | 8 |
| Notifications | 10 |
| SOAR action | 2 |
| Python analytics | 2 |

Son puntos de partida, no capacidad aceptada. Cada cola tiene límite independiente;
SOAR usa menor concurrencia por sus efectos externos.

## Resiliencia

Reintentar solo errores transitorios, máximo inicial 5, con backoff exponencial y
jitter. Validación, autorización y contrato no se reintentan. Todo consumidor es
idempotente; todo mensaje lleva correlation ID e idempotency/deduplication key.
Fallos terminales van a dead-letter o cuarentena. Workers soportan cierre ordenado,
recuperación tras reinicio y reconciliación sin pérdida silenciosa.

Integraciones externas usan timeout y circuit breaker cuando corresponda. No se
declara exactly-once: se diseña at-least-once con procesamiento idempotente.
BullMQ 5 sirve jobs operacionales; no se convierte en backbone de telemetría hasta
que la decisión de transporte lo determine. BullMQ 6 exige prueba comparativa de
recuperación, stalled jobs, reconexión y actualización del ADR correspondiente.

## Entornos locales de referencia

- Core: 4 vCPU, 16 GiB RAM y 50 GiB SSD para API, web, PostgreSQL y Redis.
- Full integration: 12 vCPU, 32 GiB RAM y 200 GiB NVMe/SSD para API, workers,
  web, PostgreSQL, Redis, OpenSearch, Python y servicios de prueba.

Son máquinas de referencia para reproducir benchmarks, no sizing productivo.
Wazuh completo puede ejecutarse aparte si impide reproducibilidad.

## Benchmark

Registrar hardware/límites, dataset sintético versionado, distribución/tamaños,
reglas reales, warm-up, al menos tres ejecuciones, p50/p95/p99, CPU/memoria/I/O/GC,
queue depth, errores, contadores de aceptados/procesados/rechazados/duplicados,
commit, versiones y configuración.

| Perfil | Carga sostenida | Burst |
| --- | ---: | ---: |
| L1 | 100 EPS durante 30 min | 500 EPS durante 5 min |
| L2 | 500 EPS durante 30 min | 1,500 EPS durante 5 min |
| L3 | 1,000 EPS durante 60 min | 3,000 EPS durante 5 min |

No ejecutar L3 si L2 incumple gates. Probar además 25/50/100 usuarios API,
duplicados, reinicio de API/workers, caída de Redis/OpenSearch/integración,
acumulación/drenaje de backlog y consultas de 1/10/50 millones de eventos
sintéticos cuando el entorno permita generarlos.

## Gates y publicación

Un perfil aprueba solo si no pierde eventos silenciosamente; contadores son
reconciliables; duplicados no duplican efectos; errores internos <1%; p95 lectura
simple <300 ms; p95 escritura transaccional <500 ms; p95 ingreso→índice <5 s;
p95 ingreso→alerta determinista <15 s; sin OOM; CPU sostenida <75%; memoria
sostenida <80%; cola no crece durante carga sostenida; backlog drena tras recuperar
dependencia; reinicio no requiere reparación manual; y queda ≥30% de headroom.

Los thresholds pueden ajustarse antes del primer benchmark, no después de ver
resultados para convertir un fallo en éxito. Publicar capacidad solo con EPS
sostenido/burst, tamaño medio/p95, duración, reglas, volumen, concurrencia,
hardware, configuración, versiones, commit y fecha. Guardar resultados en
[`docs/performance/`](../performance/README.md).
