# Validación de la entrega documental

Validación inicial y actualizaciones: 2026-09-17. Alcance: arquitectura creada en
`docs/`, sin implementación de features ni acceso a servicios de Financiera Qapaq.
Las fechas de decisión 2026-09-18 de U-001…U-007 y U-009…U-012 fueron aportadas por el usuario.

## Comprobaciones vigentes

- Veinticuatro ADR canónicos identificados por encabezado ADR-001…024. ADR-007,
  ADR-011, ADR-015, ADR-016, ADR-017, ADR-022 y ADR-024 están Accepted; ADR-018/019/020/021/023,
  Conditionally Accepted; ADR-001…014 conservan Proposed salvo aspectos
  explícitamente sustituidos. Las tres notas heredadas de temas renumerados no se
  cuentan como ADR adicionales.
- Los veinticuatro ADR contienen Context, Decision, Alternatives, Consequences y
  Trade-offs. U-002 fija las catorce entradas de versión aportadas y mantiene la
  capacidad numérica como PENDING MEASUREMENT.
- Enlaces Markdown locales comprobados contra el filesystem; fences Markdown y
  `docs/verification-checks.json` comprobados. `git diff --check -- docs` no
  reportó errores.
- Trece fuentes Mermaid constan en el repositorio. Las vistas C4 01…03 incorporan
  Microsoft 365/Wazuh y Teams; las vistas 04/10 reflejan la vertical revisada y la
  vista 13 detalla outbox, worker, secreto, workflow y acuse. Las fuentes afectadas
  se renderizaron con Mermaid CLI y se inspeccionaron visualmente;
  no se añadió una dependencia al repositorio.
- Revisión manual de coherencia entre U-002, ADR-016, requisitos, convenciones,
  estructura, API, ingesta, storage, deployment, testing, roadmap y CI/CD.
- El verificador de implementación se ejecutó y reportó `NOT_CONFIGURED` para
  format, lint, unit, integration, typecheck y boundaries. Esto confirma que los
  nombres de scripts aceptados todavía no constituyen tooling ejecutable.

## Actualización por aceptación de U-001

U-001/ADR-015 acepta el alcance integral, ocho módulos, ownership, vocabulario,
lifecycles y orden inicial por resolución explícita del usuario. La primera
vertical es un orden de construcción y no condiciona esa aceptación. La revisión
previa comprobó los diagramas de ciclos de incidente y alerta.

## Actualización por aceptación de U-002

U-002/ADR-016 acepta la baseline de runtime, frameworks, ORM, workspace,
herramientas, límites iniciales, resiliencia, perfiles y gates de benchmark.
La matriz se contrastó el 2026-09-17 con fuentes oficiales y registros de paquetes;
eso acredita disponibilidad individual, no compatibilidad end-to-end.

La CI existente usa descubrimiento y auditoría npm. La documentación registra como
gap su adaptación al workspace pnpm 12.4.2 aceptado. No se modificó el workflow ni
se presentaron scripts, lockfiles o manifests como existentes.

## Actualización por aceptación de U-003

U-003/ADR-017 acepta Microsoft Entra ID single-tenant, OIDC Authorization Code con
PKCE S256, BFF/sesión opaca, scopes, bundles, JIT, doble aprobación, revocación,
raw/exports e identidades de servicio. El estado operacional permanece BLOCKED
UNTIL FEDERATION TESTS PASS; la documentación no afirma tenant, licencias, app
registration, Conditional Access, PIM o federación configurados.

Se contrastaron Authorization Code/PKCE, PIM y criterios de sesión/autenticadores
con Microsoft Learn y NIST SP 800-63B. Se comprobaron enlaces, fences, los ADR
existentes en esa actualización y coherencia con seguridad, RBAC, API, auditoría, amenazas, riesgos, testing,
deployment, roadmap e integraciones.

## Actualización por aceptación condicional de U-004

U-004/ADR-018 acepta la arquitectura de inventario, clasificación, baseline por
dataset, tiers, privacidad en ingesta, holds, custodia, WORM, backups, restore,
purga, exports, residencia y salida. No atribuye un plazo universal a la SBS ni
convierte los cinco años propuestos en obligación regulatoria.

Se contrastaron la preservación forense y los requisitos a terceros de la
Resolución SBS N.° 504-2021, el marco peruano de datos personales, legal holds e
inmutabilidad de Azure Blob y la revisión vigente de NIST SP 800-88. La eliminación
automática permanece bloqueada hasta la ratificación y las 20 pruebas productivas.

## Actualización por aceptación condicional de U-005

U-005/ADR-019 acepta QAPAQ SecOps como plataforma SOC central, Wazuh como
componente/fuente y adapters independientes para Microsoft, Sophos y Cato. Se
crearon la estrategia canónica y un inventario YAML con cuatro entradas `planned`;
todos los datos no aportados permanecen `TO_BE_PROVIDED` y no contienen secretos.

Se verificó coherencia con U-001: los cuatro providers son slices de
`Integrations & Collectors`, no módulos funcionales adicionales. El gate registra
15 escenarios para procedencia, replay, gaps, aislamiento, correlación y secretos.
No se ejecutó una API real ni se afirmó licencia, dataset o conectividad disponible.

## Actualización por aceptación condicional de U-006

U-006/ADR-021 separa observabilidad operacional, audit trail de seguridad y
telemetría externa. Acepta OpenTelemetry/OTLP como contrato neutral, auditoría
transaccional append-only, hash chain, archivo WORM con manifest firmado,
reconciliación, detección de rollback, buffers acotados, fail-closed y routing
independiente de alertas.

Se contrastó la decisión con ADR-012, ADR-018 y ADR-020. No hay conflicto: ADR-021
concreta la estrategia de auditoría, delega retención/holds a U-004 y conserva
restore, severidad y cobertura 8x5/24x7 de U-009. Backend, endpoint, storage,
custodios, signing service, llaves y canales concretos permanecen como
configuración productiva; no como decisión arquitectónica abierta.

El gate añade 24 escenarios para atomicidad, redacción, contexto, cardinalidad,
fallos, integridad, firma, rotación, rollback, reconciliación, fail-closed, alertas,
recovery, holds y RPO/RTO. No se ejecutaron ni se afirmó infraestructura disponible.
La vista C4 de contenedores y el diagrama de auditoría se renderizaron a SVG/PNG y se
inspeccionaron visualmente después de alinear las fronteras de U-006.

## Actualización por aceptación condicional de U-009

U-009/ADR-020 acepta criticidad C1…C4, RPO/RTO/SLO y latencia provisionales,
error budgets, modos operacionales, backpressure, mantenimiento, restore/recovery,
severidad, soporte, ownership, catálogo de runbooks y 25 pruebas productivas.

Se comprobó coherencia con U-002 (capacidad aún medida por benchmark), U-003
(emergencia de identidad), U-004 (retención/deletion ledger/holds) y U-005
(aislamiento/replay por fuente). No se presenta ningún target como resultado real.
Sin guardia SEV1 formal, la documentación exige `LIMITED PRODUCTION / 8x5`.

## Actualización del modelo C4

Se documentaron cuatro niveles enlazados: contexto del sistema, contenedores
conceptuales, componentes del backend y una estructura de código representativa
para el módulo SOC. Los tres primeros usan sintaxis C4 de Mermaid; el cuarto
explicita una propuesta de capas hexagonales porque todavía no existe código de
aplicación que permita documentar clases reales.

Las cuatro fuentes se renderizaron a SVG y PNG con Mermaid CLI y se revisaron
visualmente. No se añadió una vista de despliegue: la topología, los hosts y la
distribución de alta disponibilidad aún no tienen una decisión aprobada.

## Límites

No se ejecutaron tests de aplicación, SAST, pruebas de proveedores, carga, restore
real ni validación de credenciales/licencias. No hay implementación de negocio que
verificar en esta tarea. Tampoco hay evidencia para publicar EPS, sizing productivo
o compatibilidad de la matriz completa.

Renderizar Mermaid no demuestra corrección operacional. Faltan schemas ejecutables,
pruebas de conformidad y configuración productiva de backends y transporte.
La identidad tiene decisión aceptada, pero carece de pruebas de federación. Las
capacidades de retención tienen decisión condicional, pero carecen de matriz
ratificada y pruebas de restore/hold/purga. Las
capacidades concretas de Sophos/Cato permanecen pendientes; consultar
[references.md](references.md).
Continuidad tiene objetivos condicionales, pero aún carece de owners nominales,
guardia aprobada y evidencia de las 25 pruebas.
Auditoría/observabilidad tienen decisión condicional, pero carecen de Collector,
backends, WORM, firma, llaves, canales y evidencia de las 24 pruebas.

Los cambios concurrentes de CI y `.github/ci/discover.py` quedan fuera del alcance
y de los commits documentales de esta actualización.

## Actualización por requerimiento de alertas críticas

La Jefatura de Riesgos No Financieros confirmó Microsoft Teams Workflows como
canal primario para alertas `CRITICAL`. ADR-022 registra la decisión aceptada y
R-23 la hace obligatoria en el MVP. Se comprobó coherencia con U-001, U-006,
U-008 y U-009: la capacidad pertenece a `soar`, se ejecuta por worker después del
commit, conserva auditoría separada y aplica severidad/continuidad existentes.

Se añadieron la vista de comportamiento y las relaciones C4 en contexto,
contenedores y componentes. La revisión de seguridad cubrió fuga del webhook,
payload sensible, enlace profundo, owner huérfano, duplicados y falsa semántica de
`SENT`. La activación sigue bloqueada hasta cerrar cuatro datos operacionales y
ejecutar los veinte escenarios; no se probó un tenant de Microsoft 365.

La comprobación vigente encontró 79 archivos Markdown, 13 fuentes Mermaid y 24 ADR
canónicos. Los enlaces locales, fences, estructura de ADR-007/022 y `git diff --check
-- docs` aprobaron. El verificador devolvió código 2 porque los seis checks de
aplicación siguen `NOT_CONFIGURED`, resultado esperado para una entrega solo
documental.

## Actualización por resolución de U-007

U-007/ADR-007 acepta Python como capacidad dormante y lo elimina del runtime MVP.
La revisión comprobó consistencia con ADR-016: las versiones continúan fijadas
para investigación reproducible o activación futura, pero no obligan a crear
`apps/analytics`, manifests, imagen o proceso productivo.

El C4 de contenedores ya no muestra Analytics dentro del runtime inicial. La
documentación conserva una frontera de artifacts y JSON versionado, un primer caso
candidato offline, presupuesto experimental, controles de seguridad, métricas y
18 pruebas de activación. Wazuh, TypeScript y OpenSearch cubren el MVP; Python no
crea alertas, incidentes ni SOAR directamente. La vista 02 se renderizó con
Mermaid CLI y se inspeccionó después de retirar el contenedor. La revisión de
seguridad cubrió ejecución arbitraria, egress, secretos, poisoning, supply chain,
recursos y resultados no confiables.

## Actualización por decisión parcial de U-011

U-011/ADR-023 separa CI de PR, construcción de candidatos, publicación y
despliegue. Se contrastó la decisión con el workflow observado: ya usa permisos
base de lectura, `pull_request`, Actions por SHA, scanners y no publica; todavía
descubre `package-lock.json`, instala con npm y ejecuta `npm audit`. Por ello la
migración a `pnpm install --frozen-lockfile` y `pnpm audit` queda como trabajo de
implementación junto con el workspace, sin crear un lockfile artificial.

La revisión de seguridad cubrió PR no confiable, metadata, cachés, permisos,
secretos, CODEOWNERS, build-once, digest, SBOM, attestation, OIDC, aprobaciones,
migraciones, health checks y rollback. CI/candidatos están autorizados; no se
afirma que publicación o despliegue funcionen. Esas capacidades siguen bloqueadas
hasta recibir el contrato de Infraestructura y superar los ocho escenarios.

## Actualización por aceptación de U-010

U-010/ADR-011 acepta `qapaq.security-event` 1.0.0 con JSON Schema Draft 2020-12
como fuente normativa. La revisión confirmó separación entre `recordId` y
`eventUid`, deduplicación conservadora, tiempos explícitos, taxonomía y severidad
versionadas, raw separado con SHA-256, extensiones acotadas, cuarentena y evolución
SemVer. ECS 9.5.0 y OCSF 1.9.0 se mantienen como perfiles de salida y no como
afirmaciones automáticas de compatibilidad.

Se contrastaron las versiones y mecanismos con fuentes oficiales de ECS, OCSF,
JSON Schema, RFC 8785 y Wazuh. El flujo de ingesta, storage, integraciones,
observabilidad, seguridad, threat model, pruebas, roadmap y CI/CD quedó alineado.
Las vistas Mermaid 04 y 10 se actualizaron para mostrar SecurityEvent 1.0.0.
La aceptación es documental: schema, mappings, corpus, pruebas de contrato,
cuarentena/reproceso y reporte de cobertura siguen pendientes de implementación.

## Actualización por ADR-024 y plan Scrum

La decisión vigente usa Microsoft 365 como única fuente empresarial del MVP y
Wazuh como sistema base para recolección Office 365, ruleset y alertas. QAPAQ lee el
Indexer con mínimo privilegio, normaliza SecurityEvent y gobierna priorización,
casos, RBAC, auditoría y notificaciones. ADR-024 sustituye el orden previo de
ADR-015/019 sin reducir el alcance post-MVP.

Se documentó un plan de seis semanas, del 2026-09-19 al 2026-10-30, con Product
Goal, accountabilities nominales, Product Backlog único de 25 PBI, Definition of
Done y tres Sprint Backlogs. No se inventó velocidad ni disponibilidad: cada
Planning declara capacidad real. Las integraciones y dependencias solo se consideran
Done mediante specs contra componentes reales y entornos autorizados; falta de
acceso produce estado `BLOCKED`, no una sustitución por fake.

La revisión de seguridad comprobó separación Microsoft/Wazuh/QAPAQ, credenciales
por secretRef, acceso read-only al Indexer, prohibición de DTOs externos en dominio,
raw/hash, autorización, auditoría y gates de provider specs. Las vistas C4 01…03 y
los flujos 04/10 se actualizaron y renderizaron. Las fuentes oficiales de Scrum,
GitHub, Wazuh y Microsoft se registraron en `references.md`.

## Actualización por especificación RF/RNF

La baseline del 2026-09-19 materializa 36 RF, 37 RNF, mapa de 24 capacidades,
matrices RBAC/fuentes/trazabilidad/dependencias, U-001…U-017 y glosario bajo
`docs/requirements/`. Se inspeccionaron README, ADR-001…024, C4, arquitectura,
CI/CD, backlog, testing, inventario, threat model, árbol Git e issues. GitHub no
contiene issues y la rama no contiene código de aplicación; ninguna capacidad se
marcó implementada.

Un verificador local confirmó secuencias RF/RNF, campos obligatorios, una entrada
por U, enlaces y fences. Markdownlint aprobó los once documentos nuevos con la
regla de longitud deshabilitada para permitir matrices; `yaml-lint` aprobó el
inventario y `git diff --check` no encontró errores. El inventario vigente contiene
90 archivos Markdown, 13 fuentes Mermaid y 24 números ADR canónicos. No se
ejecutaron tests de aplicación, proveedores, benchmark ni E2E porque esos
artefactos y entornos no existen en esta rama.

## Actualización por auditoría estructural y componentes Scrum

La auditoría del 2026-09-19 confirmó que el snapshot `4a90cde` contiene únicamente
documentación, `.gitignore` y licencia: no existen workspace, aplicaciones,
módulos, lockfile, migraciones, schemas ejecutables ni specs. Se registraron doce
hallazgos STR-01…STR-12 con impacto y acción. CI continúa en la rama/PR #2 y su
existencia separada no se presenta como control integrado en esta rama.

Se corrigió la distribución física propuesta: API y worker son entrypoints delgados
y la lógica compartida vive en `modules/`, evitando imports entre apps o duplicar
el dominio de notificaciones. Auditoría y capacidades técnicas transversales viven
en `platform/`; los contratos versionados, en `packages/contracts`. Las rutas se
crean solo al entregar contenido ejecutable.

El Scrum ahora mapea C-01…C-23 a rutas, responsabilidades, PBI, dependencias, specs
y evidencia. Cada Sprint declara los componentes y su orden crítico. El plan no
afirma que un único Developer pueda completar todo el mapa en seis semanas: cada
Planning selecciona componentes completos por capacidad y conserva tests reales,
seguridad y Definition of Done.

La comprobación vigente encuentra 92 archivos Markdown, 13 fuentes Mermaid y 24
números ADR canónicos. La revisión local verificó enlaces, fences, secuencia única
C-01…C-23, cobertura de componentes por Sprint y `git diff --check`. No se ejecutan
tests de aplicación porque sus artefactos siguen sin existir.

## Actualización de cadencia y Daily Scrum

El 2026-09-21 se redujo Sprint 2 a dos días laborables, 2026-10-05/06, por decisión
del usuario. Sprint 3 se adelanta al 2026-10-07/20 y el timebox termina el
2026-10-20. El alcance y la Definition of Done de Sprint 2 no se reducen: C-01…C-09,
los accesos Microsoft 365/Wazuh y los servicios reales son un gate previo. Una
dependencia ausente produce `BLOCKED`, no fake, spec omitida o aceptación parcial.

Se añadió un artefacto de Daily Scrum con agenda de 15 minutos, campos, estados,
regla de escalamiento y registro inicial del 2026-09-21. El registro declara la
documentación terminada y conserva C-01…C-09 como implementación pendiente; no
presenta la baseline documental como incremento ejecutable.

El inventario vigente contiene 93 archivos Markdown. Enlaces, fences, fechas del
timebox y `git diff --check` se vuelven a validar con esta actualización.
