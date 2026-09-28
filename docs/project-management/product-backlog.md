# Product Backlog ordenado — MVP QAPAQ SecOps

Estado: BASELINE EMERGENTE al 2026-09-18. Product Owner: Ing. Franco Clavo
Santander. Developer principal: Cesar Adrian Guevara Salcedo.

El orden combina valor, riesgo, dependencia y aprendizaje. `P0` es necesario para
el MVP Candidate; `P1` mejora su usabilidad u operación; `P2` queda después del
timebox. El Sprint indicado es forecast inicial y se confirma en Planning.

La materialización técnica PBI → ruta → dependencia → specs está en el
[plan de construcción por componentes](component-delivery-plan.md). Los IDs C-01…
C-23 permiten convertir cada PBI en tasks revisables sin crear componentes vacíos.

## Épica E1 — Base de ingeniería reproducible

### PBI-001 — Materializar workspace y toolchain

Prioridad: P0 · Forecast: Sprint 1 · Tipo: Enabler · Riesgo: alto.

Como Developer, necesito un workspace pnpm con versiones fijadas para construir el
producto de forma reproducible.

Aceptación:

- manifests y lockfile materializan ADR-016 sin `package-lock.json` artificial;
- API NestJS, web React y worker TypeScript arrancan con configuración validada;
- comandos de format, lint, typecheck, unit, integration y build son ejecutables;
- no existe runtime Python en el MVP;
- instalación limpia y build pasan en CI desde el lockfile.

### PBI-002 — CI de PR y evidencia

Prioridad: P0 · Forecast: Sprint 1 · Tipo: Security/Enabler · Riesgo: alto.

Como equipo, necesitamos que cada cambio sea verificable antes de integrarlo.

Aceptación:

- CI usa pnpm congelado y ejecuta los scripts materializados;
- PR no confiable carece de secretos y permisos de escritura/publicación;
- secret, dependency, filesystem y code scanning producen resultados visibles;
- fallos de specs bloquean integración;
- artifact de evidencia identifica commit y comandos, sin secretos.

### PBI-003 — Ambiente de integración con servicios reales

Prioridad: P0 · Forecast: Sprint 1 · Tipo: Enabler · Riesgo: alto.

Como Developer, necesito dependencias reales aisladas para que las integration
specs verifiquen comportamiento y no mocks.

Aceptación:

- PostgreSQL, Redis/BullMQ, object storage compatible y búsqueda local arrancan en
  versiones fijadas; una instancia Wazuh real vive en ambiente de integración
  dedicado con versión registrada;
- health checks esperan disponibilidad real y fallan con diagnóstico;
- datos/volúmenes son desechables y ninguna credencial productiva se incluye;
- CI ejecuta smoke specs de servicios locales; un workflow protegido ejecuta la
  smoke spec Wazuh sin exponer credenciales a PRs;
- arranque, teardown y limpieza son reproducibles.

## Épica E2 — Contrato canónico y frontera extensible

### PBI-004 — Implementar SecurityEvent 1.0.0

Prioridad: P0 · Forecast: Sprint 1 · Tipo: Feature/Security · Riesgo: alto.

Como consumidor interno, necesito un contrato único para no depender del documento
de Wazuh ni de futuros proveedores.

Aceptación:

- JSON Schema Draft 2020-12 ejecutable materializa ADR-011;
- catálogos, taxonomía, severidad e identidad están versionados;
- tipos y validadores TypeScript se generan o verifican contra el schema;
- corpus válido/inválido cubre límites, extensiones, tiempo, identidad y raw;
- versiones mayores desconocidas se rechazan o ponen en cuarentena.

### PBI-005 — Definir y probar el port SecurityEventProvider

Prioridad: P0 · Forecast: Sprint 1 · Tipo: Enabler · Riesgo: alto.

Como arquitectura, necesito una frontera estable para añadir proveedores sin tocar
el dominio ni los consumidores.

Aceptación:

- el port expresa admisión, checkpoint, cobertura, health y errores sin tipos SDK;
- la suite de conformidad es reutilizable por cada adapter;
- una regla automatizada impide imports de infraestructura en dominio/aplicación;
- el composition root registra adapters sin condicionales en el dominio;
- la guía post-MVP describe pasos y evidencia para un proveedor nuevo.

### PBI-006 — Cerrar contrato operativo Microsoft 365/Wazuh

Prioridad: P0 · Forecast: Sprint 1 · Tipo: Spike/Decision · Riesgo: alto.

Como Product Owner, necesito conocer la ruta real autorizada para que el equipo no
implemente contra supuestos.

Aceptación:

- se registra versión/edición Wazuh, dataset Office 365, tenant/region, API,
  permisos, secretRefs, frecuencia, retención, owner y aprobación;
- se confirma si la integración nativa Wazuh soporta el dataset requerido;
- se documentan alert index, identidad/cursor, ventana de replay y límites;
- una conexión mínima real demuestra acceso de solo lectura a las alertas;
- si falta cualquier prerequisito, el PBI queda `BLOCKED` con dueño y fecha; no se
  aprueba con capturas o respuestas simuladas.

## Épica E3 — Ingesta durable Microsoft 365/Wazuh

### PBI-007 — Configurar Microsoft 365 en Wazuh

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Feature/Integration · Riesgo: alto.

Como analista, necesito que actividad autorizada de Microsoft 365 sea recolectada y
analizada por Wazuh.

Aceptación:

- la configuración usa secretRefs y mínimo privilegio;
- actividad sintética controlada generada en Microsoft 365 real llega a Wazuh;
- Wazuh aplica decoder/ruleset y genera una alerta con procedencia;
- expiración, permiso denegado, timeout y recuperación son observables;
- no se incorpora información personal real a la evidencia.

### PBI-008 — Implementar adapter Wazuh read-only

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Feature/Integration · Riesgo: alto.

Como pipeline QAPAQ, necesito leer alertas Wazuh sin acoplar el dominio al Indexer.

Aceptación:

- credencial de mínimo privilegio permite solo health y consulta necesaria;
- consulta acotada maneja paginación, timeout y errores 401/403/429/5xx aplicables;
- documentos Wazuh se validan antes de cruzar infraestructura;
- DTOs Wazuh no aparecen en dominio/aplicación;
- specs se ejecutan contra el Indexer real.

### PBI-009 — Persistir raw, manifiesto y checkpoint

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Feature · Riesgo: alto.

Como operador, necesito aceptación durable antes de avanzar el checkpoint para no
perder evidencia al reiniciar.

Aceptación:

- raw se almacena separado con referencia y SHA-256;
- manifiesto/outbox y checkpoint mantienen el orden durable aceptado;
- caída entre cada frontera se recupera sin adelantar cursor;
- hash inválido o raw ausente impide afirmar integridad;
- acceso y exportación de raw quedan autorizados y auditados.

### PBI-010 — Normalizar alertas Wazuh a SecurityEvent

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Feature · Riesgo: alto.

Como detección QAPAQ, necesito consumir eventos canónicos versionados.

Aceptación:

- mapping `wazuh.alerts.security-event/1.0.0` conserva regla, severidad y procedencia;
- `recordId`, `eventUid`, tiempos, clasificación, raw y pipeline cumplen el schema;
- mapeo de severidad está probado con corpus autorizado;
- campos desconocidos se limitan a `extensions.wazuh`;
- eventos inválidos no se indexan como válidos.

### PBI-011 — Idempotencia, replay y cuarentena

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Feature/Resilience · Riesgo: alto.

Como operador, necesito recuperar fallos sin duplicar efectos ni perder registros.

Aceptación:

- replay conserva `eventUid`, crea `recordId` y registra lineage;
- solo identidad nativa o transporte estable permite descarte automático;
- cuarentena conserva causa, conector, parser/mapping y raw ref;
- reproceso autorizado mueve el evento por el pipeline sin notificación duplicada;
- reinicio, duplicado concurrente y poison event tienen specs reales.

### PBI-012 — Indexar y consultar SecurityEvent

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Feature · Riesgo: medio.

Como analista, necesito buscar eventos admitidos sin consultar directamente los
documentos internos de Wazuh.

Aceptación:

- mapping OpenSearch deriva del contrato y bloquea expansión dinámica ilimitada;
- escritura es idempotente por identidad/revisión;
- consulta tipada aplica rango, filtros permitidos, paginación y autorización;
- caída del índice conserva raw/checkpoint y expone backlog;
- integration specs usan el motor real.

### PBI-013 — Telemetría del pipeline y backend OSS

Prioridad: P0 · Forecast: Sprint 2 · Tipo: Enabler/Observability · Riesgo: alto.

Como operador, necesito distinguir cobertura, atraso, rechazo y fallo.

Aceptación:

- métricas de fetch, durable, normalizado, cuarentena, checkpoint, lag e integridad
  usan labels acotados;
- logs estructurados carecen de raw, tokens y PII innecesaria;
- trace/request IDs cruzan jobs sin usarse como claves de deduplicación;
- health diferencia Wazuh caído, Indexer caído y pipeline atrasado;
- una spec provoca cada estado observable;
- OpenTelemetry Collector entrega logs a Loki y métricas a Prometheus; Grafana OSS
  consulta ambos sin acceso anónimo ni exposición pública de los backends;
- configuración, dashboards y alertas mínimas quedan versionados y restaurables.

## Épica E4 — Flujo SOC mínimo

### PBI-014 — Priorizar alertas base de Wazuh

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Feature/Detection · Riesgo: alto.

Como analista, necesito que QAPAQ traduzca una alerta Wazuh a un candidato trazable
sin duplicar el ruleset base.

Aceptación:

- conserva `ruleId`, versión/grupo, nivel y eventos fuente;
- aplica mapping versionado y reglas QAPAQ solo para priorización/promoción;
- ejecución repetida no crea candidatos duplicados;
- decisión incluye reason codes y versión;
- corpus real demuestra al menos un caso promovido y uno no promovido.

### PBI-015 — Alertas, triaje e incidente mínimo

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Feature/SOC · Riesgo: alto.

Como analista, necesito gestionar una alerta hasta incidente con estados válidos.

Aceptación:

- API implementa transiciones canónicas, concurrencia y autorización;
- cada transición registra actor, razón, timestamp y AuditEvent;
- una alerta puede cerrarse sin incidente o promoverse según regla explícita;
- referencias a SecurityEvent/raw respetan permisos;
- specs E2E cubren flujo permitido, transición inválida y acceso denegado.

### PBI-016 — Autenticación y autorización Entra

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Security/Feature · Riesgo: alto.

Como usuario autorizado, necesito entrar mediante Entra y operar solo dentro de mi
capability y scope.

Aceptación:

- flujo BFF/OIDC, tenant, issuer, audience, PKCE/state/nonce y sesión son validados;
- RBAC/scopes protegen API, objetos y campos sensibles;
- revocación y sesión privilegiada siguen ADR-017;
- specs reales usan configuración Entra autorizada;
- UI oculta acciones por UX, pero la API siempre vuelve a autorizar.

### PBI-017 — Vista operativa mínima

Prioridad: P1 · Forecast: Sprint 3 · Tipo: Feature/Web · Riesgo: medio.

Como analista, necesito consultar eventos/alertas y ejecutar triaje sin acceder al
Indexer directamente.

Aceptación:

- lista/detalle muestran cobertura, fuente, severidad, estado y timestamps;
- búsqueda está acotada y paginada;
- raw no aparece por defecto y su acceso exige capability;
- estados de carga, vacío, parcial, degradado y error son explícitos;
- Playwright recorre login, consulta, triaje y denegación contra el backend real.

### PBI-018 — Notificar alertas CRITICAL en Teams

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Feature/Integration · Riesgo: alto.

Como Riesgos No Financieros, necesito conocer una alerta crítica sin convertir
Teams en fuente de verdad.

Aceptación:

- persistir alerta y outbox es atómico;
- payload allowlisted excluye raw y secretos;
- worker usa secretRef, idempotencia, reintentos y estados explícitos;
- spec real entrega a Teams Workflow autorizado y valida fallback;
- `SENT` significa aceptación del endpoint y el acuse permanece en QAPAQ.

### PBI-019 — Auditoría verificable del flujo

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Security/Audit · Riesgo: alto.

Como auditor, necesito reconstruir quién realizó cada acción relevante.

Aceptación:

- mutación y AuditEvent local son atómicos;
- cuenta runtime no actualiza ni elimina auditoría;
- secuencia/hash detectan alteración, duplicado y gap;
- consulta aplica autorización y redacción;
- rollback/restauración registra inconsistencia visible.

## Épica E5 — Validación del candidato

### PBI-020 — Suite E2E y fallos del MVP

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Quality/Security · Riesgo: alto.

Como equipo, necesitamos demostrar la vertical completa y sus fallos.

Aceptación:

- actividad Microsoft 365 real termina en Wazuh, SecurityEvent, alerta, triaje,
  incidente, auditoría y Teams cuando corresponde;
- caída/reinicio de Wazuh, Redis, PostgreSQL, object storage e índice se ejercita;
- replay no duplica alertas, casos ni notificaciones;
- input hostil, exceso de tamaño, hash inválido y permiso denegado fallan seguro;
- informe lista PASS/FAIL/BLOCKED por escenario, commit y entorno.

### PBI-021 — Capacidad, recovery y release evidence

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Platform/Quality · Riesgo: alto.

Como Product Owner, necesito decidir con evidencia si el candidato puede avanzar.

Aceptación:

- benchmark documenta EPS, tamaño, lag, drenaje y recursos sin prometer cifras no
  medidas;
- restore, replay y checkpoint se demuestran con RPO/RTO observados;
- SBOM, digest, resultados, migraciones y rollback se asocian al mismo commit;
- riesgos residuales, specs bloqueadas y gates externos quedan explícitos;
- Review decide `MVP CANDIDATE`, `LIMITED` o `NOT READY`, nunca producción automática.

### PBI-022 — Verificar incorporación de un proveedor futuro

Prioridad: P1 · Forecast: Sprint 3 · Tipo: Architecture/Quality · Riesgo: medio.

Como arquitectura, necesito demostrar que añadir una API no requiere modificar el
dominio.

Aceptación:

- guía exige inventario, adapter, mapping, secretRef, health, specs y aprobación;
- reglas de imports y suite de conformidad se ejecutan sin crear un adapter fake;
- revisión estática identifica cualquier supuesto Wazuh/Microsoft fuera de
  infraestructura;
- se documentan puntos de extensión y cambios legítimos del composition root;
- Cato/Sophos permanecen sin código hasta contar con contrato y entorno real.

### PBI-026 — Endurecer acceso humano

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Security/Identity · Riesgo: alto.

Como Security, necesito una sesión por usuario, red QAPAQ, passkey y protección de
intentos para reducir secuestro, phishing y acceso externo.

Aceptación:

- dos logins concurrentes producen una sola sesión y el segundo se rechaza;
- Entra Conditional Access y el borde prueban inside/outside, VPN y proxy forjado;
- passkey FIDO2 completa el mismo OIDC y no crea credencial local;
- Smart Lockout y rate limiting genérico se prueban sin enumeración;
- no existe `SUPERADMIN`; break-glass y roles separados conservan SoD.

### PBI-027 — Tableros SOC en Grafana OSS

Prioridad: P0 · Forecast: Sprint 3 · Tipo: Platform/SOC/Compliance · Riesgo: alto.

Como SOC, necesito operar Grafana OSS + Loki + Prometheus bajo control QAPAQ para
observar el sistema sin tercerizar logs ni información operacional.

Aceptación:

- Grafana usa Entra/red QAPAQ; Loki/Prometheus permanecen privados y autenticados;
- dashboards muestran plataforma, cobertura/lag, ingesta, colas, auth y auditoría;
- no-data/stale/degraded/failed son inequívocos y caída total alerta fuera del stack;
- redacción/cardinalidad, RBAC, backup/restore, retención y sizing tienen evidencia;
- inventario/RACI/egress demuestran operación interna y Compliance revisa el
  supuesto de no tercerización de SBS 504-2021 arts. 22–25.

### PBI-028 — Catálogo de errores accionable

Prioridad: P1 · Forecast: Sprint 3 · Tipo: UX/Security/Support · Riesgo: medio.

Como usuario, necesito saber qué significa un error y qué acción segura realizar.

Aceptación:

- API/UI usan código, mensaje, `correlationId`, `helpRef` y retry estables;
- catálogo cubre auth, autorización, input, estado, fuentes, secretos y dependencias;
- errores externos se normalizan y ningún stack/secreto/topología llega a UI;
- accesibilidad, localización fallback y no enumeración tienen pruebas;
- soporte puede correlacionar en Loki sin ampliar acceso del usuario.

### PBI-029 — Alta write-only de credenciales de tecnologías

Prioridad: P0 · Forecast: Sprint 2 (contrato) / Sprint 3 (E2E) · Tipo: Security/Platform · Riesgo: alto.

Como Platform Admin, necesito ingresar una API key una vez y operar después solo
con su referencia para añadir fuentes sin exponer credenciales.

Aceptación:

- control plane QAPAQ expone create/rotate/revoke, nunca read/export de plaintext;
- SecretProvider externo custodia; DB/audit/UI solo conservan ref/fingerprint/metadata;
- identidad del adapter resuelve únicamente su namespace;
- rotación prueba la nueva versión antes de switch/revocación y no hace fallback;
- onboarding sigue exigiendo adapter, mapping, límites, health y suite real.

### PBI-030 — Gateway on-premises para APIs de proveedores

Prioridad: P0 · Forecast: Sprint 2 (contrato/baseline) / Sprint 3 (HA/E2E) · Tipo: Platform/Security · Riesgo: alto.

Como Platform/SOC Development, necesito que los consumos directos de proveedores
atraviesen KrakenD CE on-premises para gobernar egress, autenticación técnica,
límites y fallos sin convertir al gateway o a Redis en sistemas de registro.

Aceptación:

- dos nodos stateless detrás de LB sobreviven caída y rolling update;
- rutas/upstreams/métodos están allowlisted; TLS/OAuth o API key se materializan
  desde SecretProvider sin persistir ni registrar plaintext;
- timeouts, rate limit por réplica y circuit breaker se prueban con
  401/403/429/5xx/TLS/timeout y cuota total calculada;
- adapter valida y persiste raw/manifiesto/checkpoint/outbox antes de que el
  dispatcher publique referencias en BullMQ;
- KrakenD no hace mapping, cursor, replay, retries semánticos, fan-out ni cache de feeds;
- Grafana/Loki/Prometheus muestran gateway y cobertura sin bodies ni labels sensibles;
- el MVP conserva `M365 → Wazuh`; QAPAQ consulta Wazuh Indexer por KrakenD y Graph
  directo permanece futuro hasta decisión autorizada.

## Backlog post-MVP

### PBI-023 — Incorporar segunda fuente autorizada

Prioridad: P2 · Forecast: Post-MVP. Seleccionar Wazuh adicional, Cato o Sophos por
valor y acceso; completar inventario, adapter, mapping y specs reales. No se decide
el proveedor dentro de este timebox.

### PBI-024 — Correlación multifuente

Prioridad: P2 · Forecast: Post-MVP. Solo inicia después de que existan dos fuentes
reales con identidad, tiempo, procedencia y cobertura comprobados.

### PBI-025 — Analítica Python especializada

Prioridad: P2 · Forecast: Post-MVP. Continúa dormante hasta contar con caso,
baseline, benchmark, aislamiento y gate de ADR-007.

## Regla de corte

PBI-001…016, 018…021, 026, 027 y 029 forman el forecast P0 del candidato. PBI-017,
022 y 028 son P1: se incorporan si no ponen en riesgo el Sprint Goal. La Review de
cada Sprint puede reordenar el backlog; no puede eliminar specs, seguridad o
evidencia para conservar una fecha.

[Plan Scrum](README.md) · [Definition of Done](definition-of-done.md)
