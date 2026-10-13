# Plan de cierre operativo QAPAQ SecOps

**Estado:** propuesta de ejecución, ordenada por dependencias. **Corte:** 2026-10-12.
**Alcance:** convertir lo construido en un candidato desplegable y verificable en AWS;
no declara ningún sprint ni gate como Done por adelantado. La duración y capacidad se
confirman en cada Planning; no se inventan fechas ni estimaciones.

Este plan extiende el timebox base de
[Scrum](README.md), conserva la arquitectura y los ADR aceptados, y hace explícitos
los bloqueos descubiertos en la entrega
[C-16…C-28](../development/c-16-c-28-sprint3-delivery.md), el
[inventario de brechas UI](../frontend-design/09-evaluacion-frontend-soc.md),
[persistencia/Entra](../architecture/entra-soc-user-admin.md),
[consulta de eventos](../architecture/events-read-through.md),
[salud de fuentes](../architecture/source-health.md) y el estado de
[AWS demo](../deployment/aws-demo.md). Sustituye el forecast restante de Sprint 3
cuando el PO acepte esta replanificación; no cambia Product Goal, límites de los ADR,
ni obligaciones de aprobación externas.

## Estado de partida

| Estado | Capacidades al corte |
| --- | --- |
| Construidas; aceptación contra sistemas reales pendiente | SOC alert/incident, priorización/correlación, OIDC/BFF, auditoría, outbox/Teams, UI de operación, PostgreSQL adapters, KrakenD, observabilidad y Terraform. Las pruebas reales siguen siendo gates donde el reporte dice `BLOCKED`. |
| UI/contrato iniciado, backend no operativo | `/admin/users` y flujo visual de aprobación; no hay Graph roster, grants ni sesión compartida/API de administración. La vista no debe habilitarse todavía. |
| Diseño aceptado, sin API operativa | Búsqueda de eventos conectada a Wazuh Indexer, salud por source/dataset, y pantallas de cuarentena/credenciales. Dominio, contratos o diseños parciales no equivalen a endpoints. |
| Riesgo P0 abierto | Confirmar fencing/propiedad de lease, límite coherente entre tamaño del lote y lease, y apagado controlado del dispatcher; comprobar persistencia del outbox tras reinicio con PostgreSQL real. |
| Terraform | Foundation ECR/S3/KMS está aplicada según el historial. RDS/Valkey/endpoint/ECS y Wazuh necesitan reconciliarse con el state remoto antes de cualquier `apply`; el plan remoto previo reportó 44 altas sin reflejar la fase de datos que se indicó como aplicada. No usar un state local o plan guardado como autoridad. |

El SOC justifica su plano sobre Wazuh al dar ownership de alertas/casos, investigación
con evidencia, SLA y trabajo de analistas, estado/impacto por fuente, respuesta con
aprobación y auditoría de extremo a extremo. Wazuh conserva agentes, collector,
manager, reglas, alertas e Indexer; QAPAQ no duplica su administración de agentes,
ruleset ni buscador de infraestructura.

## Responsabilidades

| Responsable | Entrega principal |
| --- | --- |
| **Codex** | Frontend, contrato web/BFF acordado, accesibilidad, estados y UX; conceptos visuales; documentación; pruebas de web y revisión de coherencia/seguridad observable. No modifica archivos bajo lock backend de Claude. |
| **Claude Code** | Backend, dominio/adapters, autorización server-side, persistencia/migraciones, workers, Terraform/runtime y provider tests. Debe revisar las entregas de Codex solicitadas en `COORDINACION-CLAUDE-CODEX.md` y registrar aceptación o cambios ahí. |
| **Ambos** | Acordar contrato/capabilities antes de integrar, revisar fallos de frontera y completar evidencia de release. Cada dueño informa comandos y resultados reales; un bloqueado conserva dueño, causa y siguiente acción. |

Los locks y reglas vigentes están en
[`COORDINACION-CLAUDE-CODEX.md`](../../COORDINACION-CLAUDE-CODEX.md). Las pruebas
externas usan datos sintéticos y cuentas sandbox autorizadas. La autorización del
usuario para preparar/aplicar Terraform no reemplaza el control técnico: revisar
cuenta/región, backend remoto, state y delta exacto; parar ante destrucciones o
reemplazos inesperados, exposición pública o costo no incluido en el entorno demo.

## Sprints propuestos

La numeración continúa los tres Sprints históricos. El **Sprint 1 de esta nueva
planificación es el Sprint 4 de continuidad y queda a cargo de Codex**; el **Sprint 2
nuevo es el Sprint 5 de continuidad y queda a cargo de Claude**. Los incrementos
posteriores siguen el orden de dependencias y admiten trabajo cruzado sin cambiar el
owner final.

### Sprint 4 — Cierre de UX y preparación de integración (Codex-led)

**Objetivo:** dejar completa la consola que ya tiene APIs, cerrar el contrato visual de
todas las superficies y preparar la integración de pantallas aún bloqueadas.

- **Codex:** endurecer resumen, colas, detalle/triage, casos, notificaciones y auditoría
  contra paginación, filtros disponibles, permisos, errores, frescura, conflictos y
  loading/empty/degraded. Completar matriz de pantallas por rol/capability, dirección
  visual, imágenes, skills y criterios de aceptación. No representar Eventos/Salud/Admin
  como conectados mientras no existan endpoints.
- **Claude:** revisar las superficies conectadas y sus contratos; publicar decisiones de
  API/capability para eventos, health y Admin; confirmar estado D-7 y correcciones P0 que
  ya existan, sin solaparse en los archivos del frontend.

**Definition of Done:** typecheck, build, specs web y accesibilidad aplicable pasan;
cada acción visible tiene capability backend correspondiente y resultado observable;
ningún KPI/dato viene de una lista incompleta ni de fixture; matriz cubre todas las rutas
vigentes y marca con claridad diseño/endpoint/estado; Claude deja revisión en el MD;
`git diff --check` limpio. Ningún endpoint ausente se marca terminado.

### Sprint 5 — Persistencia SOC y outbox fenced (Claude-led, P0)

**Objetivo:** hacer durable la ruta de alertas/casos/auditoría/notificación y eliminar la
carrera del lease del dispatcher.

- **Claude:** terminar claim owner/fencing token y compare-and-set en publish/retry;
  acotar tamaño/tiempo del lote al lease y deadline; garantizar shutdown que drene o
  libere de forma segura; cablear stores PostgreSQL en API/worker; migración one-off
  separada; rol de aplicación mínimo y TLS verificado con CA/hostname. Probar crasheos,
  takeover por lease vencido, timeout ambiguo, reintento y reinicio.
- **Codex:** revisar los estados operativos visibles de notificación/acuse y asegurar que
  la interfaz distingue `delivered` de `acknowledged`; actualizar contrato y runbook web
  una vez publicados los estados reales.

**Definition of Done:** PostgreSQL 18.6 real aislado en AWS; no hay doble publicación al
perder/recuperar lease; el owner viejo no puede finalizar el trabajo tras takeover;
estado/audit/outbox se confirman atómicamente; worker reinicia sin perder intentos;
migración desde vacío y rollback/restore documentados; TLS `verify-full` probado;
identidad de app no es master; evidencia ligada al SHA y redactada. Cualquier fallo
P0 mantiene el incremento `BLOCKED`.

### Sprint 6 — Identidad operativa y administración Entra (Claude backend, Codex UI)

**Objetivo:** que el admin SOC gestione acceso de QAPAQ sobre el roster de un grupo Entra
configurado, con grants persistidos, presencia de sesión y segregación de funciones.

- **Claude:** Graph read-only delta sync del único group object configurado; tenancy por
  `(tid, oid)`; store PostgreSQL compartido de sesión/grants/sync; migración explícita de
  los cuatro app roles actuales; capabilities server-side; API BFF/allowlist KrakenD;
  requests/aprobaciones con revision CAS, doble aprobación del grant privilegiado,
  expiración, step-up y auditoría. Manejar paging/delta, 429, stale sync y token overage.
- **Codex:** conectar `/admin/users` únicamente al contrato publicado; roster paginado,
  miembro sin grant, sesión activa/reciente/no disponible, historial, formularios de
  razón/ticket, revisión de impacto y bandeja de aprobación según capability.

**Definition of Done:** tenant sandbox real y grupo autorizado; no miembro nunca aparece
ni puede recibir grant; Graph no se llama desde React y ningún token queda guardado;
quitar membresía impide nuevos accesos y cumple SLA de revocación existente; carreras,
self-approval, aprobador repetido, stale sync, 429 y denegaciones pasan; no se habilita
capability antes de persistencia/bootstrap de aprobadores; usuarios/roles solo muestran
los cuatro roles runtime. Consent del tenant corporativo no forma parte de un sprint sin
el permiso administrativo correspondiente.

### Sprint 7 — Ruta real Microsoft 365 → Wazuh → QAPAQ

**Objetivo:** aceptar la primera alerta real y reproducible con mappings, checkpoint e
idempotencia ya implementados.

- **Claude:** comprobar versión/configuración real de Wazuh, suscripciones M365, rule IDs,
  Indexer mapping, TLS/allowlist KrakenD, cursores y permisos; ejecutar evento sintético
  desde tenant sandbox, probar adapter y escribir evidencia sin PII. Resolver gates C-10,
  C-11 y C-12 si la corrida los revela.
- **Codex:** verificar en UI la procedencia visible (M365 → Wazuh → QAPAQ), timestamps,
  reason codes, raw oculto por capability, errores con correlation ID e investigación
  enlazada a alerta/caso; documentar los pasos reproducibles y estados reales.

**Definition of Done:** evento generado en M365 de prueba aparece en Wazuh y después en
QAPAQ con rule/mapping/lineage identificables; replay no duplica evento, alerta, incidente
ni notificación; checkpoint solo avanza tras admisión durable; fallo de gateway/Indexer,
permisos insuficientes y datos malformados producen señales/errores esperados; prueba
contra Wazuh/Indexer reales, nunca un mock como evidencia de aceptación.

### Sprint 8 — Eventos y salud verificable por fuente

**Objetivo:** ofrecer investigación y confianza de cobertura sin presentar una consulta
vacía como prueba de salud.

- **Claude:** extender provider con filtros indexables antes de `search_after`; cursor
  firmado ligado a filtros; tenant/dataset scope; endpoint read-only; job y persistencia
  `SourcePollObservation`/transiciones; observer Wazuh Indexer para suscripciones y
  errores Office365; idempotencia, retención de transiciones de un año, ownership y
  `unknown` honesto cuando no hay poll exitoso verificable. Publicar health agregado y
  observabilidad de operación bajo capabilities explícitas, sin exportar logs crudos al
  BFF ni habilitar acceso por un enlace frontend.
- **Codex:** conectar `/events`, filtros y límite de 31 días efectivo; detalle normalizado
  y lineage; `/platform/health` y cola operativa separada con owner/lag/último intento/
  éxito/evento; resumen de frescura/cobertura visible para analistas; cuarentena/reprocess
  solo si API/permiso existe; exportación con límites explícitos.

**Definition of Done:** contrato y specs prueban query DSL, filtros previos a paginar,
cursor tamper/expiry, sort ties, rango y bytes; Wazuh real confirma mappings. Un poll
exitoso de cero eventos es distinto de ausencia de poll; `unknown` no aparece verde;
errores se deduplican, reintentos respetan Retry-After, recuperación conserva historia;
API prueba tenant isolation y raw permissions; UI no acepta DSL ni muestra datos simulados.

### Sprint 9 — Calidad de detección y gestión de casos

**Objetivo:** que el analista pueda explicar por qué QAPAQ elevó una señal y el detection
engineer pueda medir y versionar cambios sin duplicar reglas de Wazuh.

- **Claude:** cerrar catálogo/versionado de señales QAPAQ, contexto de activos e
  identidades autorizado, razón y calibración reproducibles, supresión/expiración segura,
  correlación idempotente y cobertura por caso de uso; conservar reglas de recolección y
  detección primaria en Wazuh cuando corresponda.
- **Codex:** mejorar incident workspace con timeline, alertas relacionadas, evidencia
  referenciada con hash, owner/SLA y audit trail; diseñar experiencia de revisión de
  reglas solo cuando exista contrato y corpus de evaluación. Estado futuro claramente
  inactivo hasta que el backend lo soporte.

**Definition of Done:** reason code reproducible desde inputs versionados; regresión con
corpus sintético y validación representativa autorizada; se miden falsos positivos,
duplicados y latencia sobre dataset etiquetado con método divulgado; concurrency/CAS y
cross-tenant tests pasan; cada transición de caso genera evento de auditoría; UI nunca
edita/activa una regla inexistente ni presenta cobertura no medida.

### Sprint 10 — SOAR y automatización segura

**Objetivo:** automatizar el trabajo repetible empezando por operaciones reversibles y
notificaciones, con aprobación humana antes de efectos sobre sistemas externos.

- **Claude:** terminar outbox y dispatcher como plataforma común; dedupe, budget,
  backoff, circuit breaker, rate limit, dead-letter/replay auditado, allowlist de
  adapters y policy-as-code. Implementar playbooks primero en dry-run; cada ejecución
  ata versión, parámetros, targets, actor y permisos vigentes. Implementar acción externa
  solo para un caso autorizado y con idempotency key, approval y rollback definidos.
- **Codex:** diseñar catalog/run/approval/outcome screens cuando haya API; mostrar
  diferencia entre plan, dry-run, ejecución confirmada y resultado incierto; requerir
  revisión humana y exponer owner, riesgo, deadline y evidencia.

**Definition of Done:** dry-run no hace llamadas con efecto; ejecución real se prueba en
adapter sandbox autorizado, con scope/tenant allowlisted, doble control para acción de
alto impacto, credential write-only, timeout ambiguo y no duplicidad; autorización se
revalida al ejecutar; rollback/compensación ensayado; cada transición auditable. No se
usa la UI para dar apariencia de remediación automatizada si solo existe una notificación.

### Sprint 11 — Evidencia, controles y operación SBS aplicable

**Objetivo:** conservar evidencia verificable para auditoría interna y preparar controles
operativos sin declarar cumplimiento regulatorio por la existencia del producto.

- **Claude:** cerrar append-only/audit archive, reconciliación, retención y restore; RBAC
  Entra/Grafana para `observability.read_soc` (SOC lead) y
  `observability.read_platform` (platform admin), con resumen limitado de health para
  analyst; auditor no hereda logs operacionales. Proteger Grafana/Loki/Prometheus, red
  privada, secretRefs, métricas de cardinalidad acotada, alertas externas y runbooks SEV;
  controlar retención/borrado con aprobación jurídica.
- **Codex:** UX de reportes/consulta de auditoría e integridad con filtros y exportes
  permitidos; catálogo de errores/helpRef, procedimientos de turno y matriz de evidencia
  por control; documentar la pertinencia SBS con Cumplimiento según régimen de la entidad.

**Definition of Done:** cambio/tamper/gap de auditoría se detecta; retención y restore se
prueban, permisos DB impiden update/delete; reportes trazan fuente, ventana y limitaciones;
logs no filtran tokens/PII; SOC lead y platform admin consultan las vistas de observabilidad
asignadas, analyst ve solo salud del pipeline, auditor no hereda logs, y pruebas confirman
acceso/denegación y tenant isolation; cada control SBS que se cite apunta a texto/vigencia
y dueño que confirma aplicabilidad. No usar frases
«cumple SBS» sin validación de Cumplimiento/Legal.

### Sprint 12 — Release candidate en AWS y decisión de preparación

**Objetivo:** correr la vertical completa y recuperación en infraestructura real aislada,
para emitir `MVP CANDIDATE`, `LIMITED` o `NOT READY` con evidencia.

- **Claude:** reconciliar remote state/plan; aplicar solo delta revisado del entorno demo;
  publicar imágenes por workflow confiable con digest, levantar RDS/Valkey/ECS/KrakenD y
  Wazuh con carga sintética; ejecutar migrations one-off, provider/E2E, fallos, restart,
  restore, carga y smoke; inspeccionar logs, métricas y costos; terminar recursos efímeros
  según runbook tras conservar artifacts autorizados.
- **Codex:** integrar e2e web con el backend desplegado, realizar recorrido por los roles
  aplicables, comprobar estados responsive/accessibility, redactar evidencia final y
  registrar gaps con owner y restricción del release.

**Definition of Done:** commit/SHA e imágenes por digest identificados; state remoto
concilia y Terraform apply demuestra delta esperado sin recursos públicos no aprobados;
salud de targets y dependencias verificada; recorrido real M365 → Wazuh → QAPAQ → alerta/
caso → Teams con acuse; denegación RBAC verificada; tests de restore/replay/drenaje y
capacidad registran método/resultado; SBOM y scans sin blocker o excepción con owner,
caducidad y aprobador; teardown/costo ejecutado y evidencia redactada; decisión derivada
por C-22. Si Entra/Teams real u otra dependencia está bloqueada, el estado es `LIMITED`
o `NOT READY`, no candidato completo.

## Reglas de aceptación transversales

- El estado por ítem es `DONE`, `BLOCKED` o `NOT DONE`; porcentaje no reemplaza criterio.
- Cada DoD se liga a PBI/C-xx, PR, SHA, comando, entorno, versiones y artifact. La
  integración de proveedor requiere proveedor real; una respuesta grabada solo apoya unit
  tests.
- Toda mutación se autoriza en backend, verifica tenant/scope/revision/CSRF cuando aplique
  y crea auditoría. Secretos son referencias externas; evidencia se redacta.
- Un sistema no presenta “operativo” por estar desplegado: exige señal de servicio,
  último éxito y estado por fuente; los desconocidos siguen desconocidos.
- No iniciar MVP productivo hasta cubrir gates de identidad, retención, soporte,
  continuidad, seguridad y capacidad. Demo AWS no equivale a aprobación productiva.

## Documentos relacionados

[Definition of Done base](definition-of-done.md) ·
[Plan por componentes](component-delivery-plan.md) ·
[Frontend por pantalla y rol](../frontend-design/10-vistas-por-rol-y-referencias.md) ·
[AWS demo / costos / límites](../deployment/aws-demo.md) ·
[Runbook PostgreSQL](../deployment/soc-postgres-rollout.md) ·
[Matriz C-22 de gates](c-22/blocked-gates.json)
