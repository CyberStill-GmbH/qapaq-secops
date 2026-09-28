# C-02 — Entrypoints independientes

Implementación: 2026-09-22. Alcance: startup mínimo, health, composition roots,
lifecycle y comprobación de ejecutables compilados. No constituye una decisión de
despliegue ni la implementación de componentes posteriores.

## Inspección y autoridad

Se revisaron ADR-001, el plan por componentes C-01/C-02/C-03, el Sprint 1,
las convenciones, estructura, dependencias, CI, observabilidad y configuración.
No se encontraron AGENTS.md aplicables en el repositorio ni sus directorios padre.
Se conservaron pnpm 12.4.2, Node 24.21.0, TypeScript 6.0.3, NestJS 12.0.4,
React 19.3.0, Vite 8.3.0, Fastify, Vitest, Playwright, oxlint y dependency-cruiser.

ADR-001 sigue en Proposed para sus detalles de procesos/release. La independencia
solicitada se aplica a los ejecutables del mismo monolito, sin convertirlos en
microservicios. `docs/ci-cd.md` condiciona `/health/startup` a una necesidad del
arranque; C-02 no la tiene y no agrega ese endpoint.

El worker anterior abría Redis y la web consultaba `/api/health`. El alcance
explícito de C-02 reemplaza esas dependencias por espera inactiva y disponibilidad
de la interfaz. Los cambios locales de `main.ts`, incluida la función incompleta
`deliverFrontend`, se corrigieron dentro de C-02 según la respuesta del usuario:
no se conserva la creación de un microservicio ni una segunda API frontend.

No existe en C-01 un paquete de lifecycle apropiado. La API modela el cierre del
servidor; el worker implementa una puerta de admisión y drenado propios. No se
crea un paquete shared, no se aloja lifecycle en C-03 y no se anticipa C-15.
Los pequeños límites de proceso permanecen locales; no se copió un runtime entre apps.

## Estructura y responsabilidades

- `apps/api/src/main.ts`: límite del proceso, señales, fallos sanitizados y salida.
- `apps/api/src/bootstrap.ts`: carga C-03, construye y devuelve `start`/`stop`.
- `apps/api/src/composition-root.ts`: crea Nest/Fastify y ensambla `AppModule`.
- `apps/api/src/app.module.ts`: enlaza lifecycle y contributors de readiness.
- `apps/api/src/lifecycle.ts`: estados HTTP y cierre idempotente/acotado.
- `apps/api/src/health/`: endpoints y contrato de contributor futuro; lista vacía.
- `apps/worker/src/main.ts`: límite del proceso y gestión de señales/fallos.
- `apps/worker/src/bootstrap.ts`: carga el contrato C-03 del worker inactivo.
- `apps/worker/src/composition-root.ts`: crea `WorkerRuntime`, sin clientes externos.
- `apps/worker/src/lifecycle/worker-runtime.ts`: espera, admisión y drenado.
- `apps/web/src/main.tsx`: localiza la raíz y llama al bootstrap del navegador.
- `apps/web/src/bootstrap/`: configuración pública, React root, Suspense y boundary.
- `apps/web/src/app/`: shell institucional y estilos mínimos adaptables.
- `apps/web/public/health.json`: disponibilidad estática del artefacto.

La composición React ocurre en `bootstrap/bootstrap.tsx`; no requiere un archivo
adicional que solo reexporte la misma función. Construir API/worker no abre puertos,
no inicia la espera y no registra handlers globales. Importar sus `main.js`
compilados tampoco arranca procesos. La ejecución directa se distingue con
`import.meta.url` y `process.argv[1]`.

## Startup y shutdown

El proceso entrega el entorno a C-03 desde `main.ts`. C-03 valida el perfil y los
valores consumidos. API solo necesita host/puerto; el worker inactivo solo necesita
perfil. Ninguno tiene secretos necesarios ni resuelve referencias no utilizadas.
Los loaders completos de C-03 siguen disponibles sin cambios incompatibles.

Tras validar: evento `application.starting`, composición, registro de handlers,
inicio del listener/espera y evento `application.ready`. Un fallo de configuración,
composición o listen se propaga al límite del proceso y produce salida 1.
El puerto ocupado se identifica como `PORT_IN_USE`; C-03 conserva sus códigos
estables; los demás fallos de arranque usan `BOOTSTRAP_FAILED`.

SIGTERM/SIGINT cambian a `draining` inmediatamente. Readiness deja de ser positiva;
el worker rechaza nueva admisión y espera promesas activas. C-02 no somete trabajos.
La API espera la resolución de un listen en curso antes de cerrar, para evitar
un listener tardío después de una señal. Fastify cierra conexiones ociosas y
permite terminar las activas dentro del presupuesto.

Cada app memoiza el cierre. Dos señales no ejecutan dos cierres concurrentes.
Un cierre correcto termina en `stopped`; startup/cierre/fallo fatal terminan en
`failed`. La transición no vuelve a `ready`. El presupuesto documentado de cierre
es 5 segundos; un watchdog exclusivo de `main.ts` limita el proceso a 6 segundos
si el cierre queda bloqueado. Solo ese límite de ejecutable puede forzar `exit(1)`;
bootstrap/lifecycle no llaman a `process.exit`. Los handlers se desmontan al cerrar.

`uncaughtException` y `unhandledRejection` fallan el proceso y cierran recursos;
no permiten continuar con estado desconocido. Se registra un único fallo por
proceso, con `UNCAUGHT_EXCEPTION`, `UNHANDLED_REJECTION`, `SHUTDOWN_FAILED` o
`SHUTDOWN_TIMEOUT`. Nunca se serializa el error recibido.

El logging conserva la escritura estructurada existente a stdout. Los únicos
campos emitidos son service, event, timestamp y, para fallos, errorCode.
Nest/Fastify no imprimen errores sin sanitizar. No hay objeto de configuración,
referencias, valores secretos, rutas locales ni topología en los eventos.

## Health y seguridad HTTP

- `GET /health/live`: 200 mientras el runtime puede responder y no está
  failed/stopped; no comprueba sistemas externos. Durante draining sigue vivo.
- `GET /health/ready`: 200 exclusivamente en ready. Starting, draining, stopped y
  failed devuelven 503. Se vuelve a comprobar el estado tras esperar contributors.
- Respuesta 200: `{"status":"ok","service":"qapaq-secops-api"}`.
- Respuesta 503: `{"status":"unavailable","service":"qapaq-secops-api"}`.
- Contributors: contrato de funciones asíncronas booleanas inyectado, vacío por
  defecto. No hay contributors ficticios ni conectividad anunciada.
- CORS no habilitado, sin X-Powered-By, body máximo 1 MiB y request timeout 15 s,
  conservando la baseline existente. No se agrega autenticación a health.

Readiness del worker se comprueba observando una sola línea JSON con
`event=application.ready` y `service=qapaq-secops-worker`. Internamente `ready`
controla la admisión. Un MessagePort referenciado mantiene activo el event loop
sin servidor, polling, mensajes fabricados ni timers de espera. Los puertos se
cierran durante shutdown; los únicos timers del runtime delimitan el cierre.

## Configuración y health públicos de React

El modelo del navegador admite únicamente `appName: "QAPAQ SecOps"` y
`basePath: "/" | "/secops/"`. `VITE_PUBLIC_BASE_PATH` permite elegir uno de esos
paths en build. No hay URL de API, tokens, flags operativos ni texto arbitrario.
Campos adicionales nunca se proyectan al modelo público; los valores públicos
inválidos detienen el build o activan el boundary en runtime.

Vite usa `envPrefix: []` y define explícitamente solo el objeto público validado.
La web no importa C-03 ni APIs de Node. El build incluye `health.json`, documento
raíz y assets. El health estático afirma disponibilidad del artefacto, no del SOC
ni del backend. El texto visible dice «Interfaz disponible».

El estado de carga existe en HTML y Suspense. El boundary captura errores de
render/carga del módulo de la shell y presenta una acción para recargar. No
imprime el objeto de error capturado. Una raíz ausente produce un aviso seguro.
El servidor Vite preview se utiliza únicamente para tests del artefacto; no es
una elección de servidor de producción.

## Pruebas y comandos

Desde la raíz, sin servicios ni secretos reales:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run format:check
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run boundaries
pnpm run build
pnpm run smoke:api
pnpm run smoke:worker
pnpm run smoke:web
pnpm run smoke:built
pnpm run test:e2e
```

`smoke:api` y `smoke:worker` compilan con sus dependencias usando filtros pnpm.
`smoke:web` compila con marcadores privados sintéticos y comprueba que no llegan
al bundle. `smoke:built` comprueba los tres artefactos y los fallos de proceso.
Las pruebas no dependen de puertos fijos: API usa C-03 test/puerto 0 y preview
solicita puerto 0. El observador IPC de test comunica el puerto real asignado,
sin modificar respuestas ni añadir una API de diagnóstico al producto.

Los smoke comprueban HTTP, assets, salida, puerto cerrado, procesos terminados,
configuración inválida, puerto ocupado, importación sin startup, señales,
excepciones/rechazos fatales y dos señales en el mismo turno. La web tiene además
pruebas Chromium de render real, recuperación tras abortar el chunk y ausencia
de llamadas a API; capturas desktop/móvil quedan en `test-results/` ignorado por Git.

La política de bundle rechaza los marcadores sintéticos inyectados, nombres de
configuración privada backend, referencias secret://, claves privadas y URLs con
credenciales. No prohíbe palabras como «token» presentes legítimamente en React;
las claves de configuración pública se restringen por contrato y AST.

## Límites arquitectónicos ejecutables

`pnpm boundaries` combina dependency-cruiser con el compilador TypeScript en
`scripts/check-entrypoints.mjs`. Se excluyen dist/node_modules del grafo fuente
para no confundir chunks generados con dependencias arquitectónicas.

Se detectan las seis direcciones entre apps, paths relativos, aliases de
tsconfig, nombres de workspace, rutas profundas, imports dinámicos, reexports,
require e imports de tipos. Se rechazan imports dinámicos no resolubles
estáticamente, acceso a process fuera de main backend, internals de paquetes
con exports y clientes de infraestructura fuera de composition roots.
Los imports de main y la construcción de objetos se limitan para detectar
desplazamientos de composición/negocio hacia el límite del proceso.

Los fixtures negativos se crean y eliminan en directorios temporales fuera de
los árboles compilados. Incluyen todas las direcciones y controles de entorno,
internals y clientes. Estos controles no sustituyen la revisión semántica de
reglas de negocio; se revisó que los entrypoints actuales solo coordinan runtime.

## CI y alcance de la verificación

El job `entrypoints` se integra en `.github/workflows/ci.yml` y en su gate.
Ejecuta instalación congelada, typecheck, lint, unit, boundaries, builds,
smoke con señales POSIX y Chromium. Tiene permisos heredados de solo lectura,
sin servicios, secretos, publicación ni despliegue. Los jobs preexistentes de
seguridad/integración conservan sus responsabilidades.

`scripts/verify.ps1` incorpora build y smoke al flujo general existente.
Ese flujo también incluye `test:integration`, perteneciente a C-06 y dependiente
de servicios reales. No se ejecutó `pnpm verify` ni `test:integration` en esta
tarea para respetar el alcance sin servicios. No se afirma que la CI remota haya
sido ejecutada: no se hizo commit ni push.

Windows no implementa entrega POSIX de SIGTERM por `child.kill`. Los smoke locales
usan un puente de señales exclusivamente en `tests/smoke/process-observer.mjs`.
En Linux entregan SIGTERM/SIGINT reales. Las pruebas de doble señal/fallo fatal
usan inyección IPC de test en ambos sistemas. Ningún puente entra al bundle ni
al código de las apps.

WSL leyendo node_modules en un disco Windows montado necesitó aproximadamente
55 segundos para cargar Nest. `C02_SMOKE_SLOW_FILESYSTEM=1` permite observar
startup hasta 90 segundos solamente en ese entorno; no modifica el cierre de
5/6 segundos ni los smoke normales de CI.

## Evidencia de ejecución

- Instalación congelada sin scripts: PASS; lockfile sin modificaciones.
- `pnpm run format:check`, `typecheck`, `lint` y `boundaries`: PASS.
- `pnpm run test:unit`: 179 tests, 12 archivos, todos PASS.
- `pnpm run build`: PASS para todo el workspace, incluidas las tres apps.
- `pnpm run smoke:built`: 16 comprobaciones PASS sobre artefactos compilados.
- `pnpm run smoke:web`: build con valores privados sintéticos y smoke PASS.
- Comparación SHA-256 del build normal y del build con variables privadas
  sintéticas: mismos archivos y mismos hashes; PASS.
- `pnpm run test:e2e`: dos pruebas Chromium PASS; inspección desktop y móvil sin
  desbordamiento, render normal y recuperación tras un fallo real del chunk.
- `python -m unittest discover -s .github/ci -v`: 11 comprobaciones PASS.
- Windows: comprobación final con Node 24.21.0, además de la ejecución inicial
  con Node 24.16.0 disponible en el PATH original.
- Linux/WSL, Node 24.21.0: worker con SIGTERM/SIGINT reales PASS; API con
  SIGTERM/SIGINT reales PASS al usar la espera extendida de startup para disco
  montado. El intento inicial agotó startup; no fue un fallo de shutdown.
- GitHub Actions remoto y pruebas C-06 contra servicios reales: no ejecutados.

## Archivos afectados y decisiones pendientes

Se crearon los archivos de bootstrap, composición, lifecycle, health y pruebas
indicados arriba; `platform/configuration/test/entrypoint-config.spec.ts`;
`scripts/check-entrypoints.mjs`; `tests/architecture/entrypoints.spec.ts`;
`tests/smoke/{support,process-observer,build-public-web,api.smoke,worker.smoke,
web.smoke,process-failures.smoke}.mjs`; y este documento.

Se modificaron los main de las tres apps, AppModule, sus scripts dev backend,
HTML/Vite web, exports/loader/schema/README de configuración, package.json raíz,
Vitest, Playwright, el E2E existente, dependency-cruiser, verify.ps1,
verification-checks.json, workflow CI, README y plan por componentes.
Se retiró el antiguo `apps/api/src/app.controller.ts` con `/health` genérico.

Siguen pendientes la aceptación de detalles propuestos de ADR-001, el proveedor
de secretos productivo de ADR-013 y la decisión de entrega/hosting productivo.
No se eligió cloud ni se implementaron C-04, C-06, C-08, C-15 o capacidades
funcionales posteriores. No se conectaron Prisma, Redis, BullMQ, MinIO, Wazuh,
OpenSearch, Entra, Graph o Teams. Ningún health simula una dependencia. No hay
imports entre aplicaciones. No se añadieron dependencias de paquetes ni se
cambió el lockfile. No se hizo commit, push, publicación ni despliegue.
