# Requisitos no funcionales

`TBD` significa que el responsable indicado debe aportar y aprobar el valor. Un
baseline de diseño no es un SLO logrado. Cada medición registra commit, versiones,
hardware/configuración, dataset, duración y resultado.

## Seguridad

### RNF-001 — Denegación por defecto

- **Escenario/respuesta:** ante toda llamada protegida, incluida manipulación de
  IDs, QAPAQ valida identidad, capability, scope, objeto, campo y estado; cualquier
  dato ausente o inválido produce denegación sin revelar existencia.
- **Métrica/método/ambiente/responsable:** 100% de endpoints/casos de uso catalogados
  con pruebas allow/deny/IDOR en CI y Entra autorizado; Desarrollo implementa,
  Security aprueba la matriz.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-017 · incumplir permite acceso indebido
  y bloquea piloto/producción.

### RNF-002 — Sesión y credenciales seguras

- **Escenario/respuesta:** ante login, renovación o revocación, tokens Entra quedan
  en BFF server-side; cookie es Secure/HttpOnly/SameSite aprobado y la revocación
  alcanza sesiones/jobs antes del efecto.
- **Métrica/método/ambiente/responsable:** 35 escenarios ADR-017/025 aprobados en tenant
  autorizado; timeouts exactos los ratifica Identity/Security.
- **Estado/fuente/impacto:** CONFIRMADO con valores operativos PENDIENTES · U-003 ·
  fallo bloquea endpoints productivos.

### RNF-003 — Gestión externa de secretos

- **Escenario/respuesta:** ante configuración, build, log o error, ningún secreto se
  persiste en repo, DB de negocio, imagen, payload, trace o auditoría; solo `secretRef`.
- **Métrica/método/ambiente/responsable:** cero secretos confirmados por scan y
  revisión; rotación provider spec sin rebuild; Infraestructura provee SecretProvider.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-013/017/022 · filtración bloquea release
  y exige revocación/incidente.

### RNF-004 — Input externo no confiable

- **Escenario/respuesta:** payload, cursor, URL, mensaje o error de proveedor se
  valida por schema/allowlist/tamaño y nunca se evalúa como código o instrucción.
- **Métrica/método/ambiente/responsable:** corpus malicioso y pruebas de SSRF,
  traversal, injection y deserialización pasan en CI/integración; Security/Desarrollo.
- **Estado/fuente/impacto:** CONFIRMADO · threat model T-03/T-04 · incumplir bloquea piloto.

### RNF-005 — Separación de funciones

- **Escenario/respuesta:** ante grant crítico, publicación de regla, export o acción
  futura de alto impacto, iniciador y aprobador cumplen SoD y step-up/JIT aplicable.
- **Métrica/método/ambiente/responsable:** 100% de operaciones catalogadas y pruebas
  de autoaprobación; Security/SOC define catálogo final U-013.
- **Estado/fuente/impacto:** CONFIRMADO con catálogo PENDIENTE · ADR-017 · sin cierre
  no se habilitan operaciones privilegiadas.

## Privacidad y protección de datos

### RNF-006 — Minimización por frontera

- **Escenario/respuesta:** al normalizar, notificar, observar o exportar, solo cruzan
  campos necesarios y autorizados; Teams nunca recibe raw, secretos o PII innecesaria.
- **Métrica/método/ambiente/responsable:** schemas allowlist y pruebas negativas con
  dataset sintético; Privacy/Security ratifica clasificación.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-018/022 · fuga bloquea integración.

### RNF-007 — Datos de prueba sintéticos

- **Escenario/respuesta:** en CI, demos y provider specs se usa actividad controlada
  sin datos personales de empleados, secretos, IP o dominios privados.
- **Métrica/método/ambiente/responsable:** revisión de fixtures/evidencia y secret/PII
  scan; dueño de fuente autoriza el escenario.
- **Estado/fuente/impacto:** CONFIRMADO · requirements R-20 · incumplir invalida evidencia.

## Auditabilidad e integridad

### RNF-008 — Atomicidad estado-auditoría

- **Escenario/respuesta:** si falla la escritura de `AuditEvent`, la mutación local
  sensible revierte; efectos externos registran intención y resultado sin falsa atomicidad.
- **Métrica/método/ambiente/responsable:** 100% de mutaciones sensibles pasan fault
  injection PostgreSQL; Desarrollo/Security.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-021 · fallo bloquea producción.

### RNF-009 — Audit trail append-only verificable

- **Escenario/respuesta:** ante modificación, borrado, inserción, rollback o gap, la
  secuencia/hash y reconciliación detectan inconsistencia y preservan material.
- **Métrica/método/ambiente/responsable:** 24 escenarios ADR-021, rol runtime sin
  UPDATE/DELETE/TRUNCATE; Security/Infraestructura provee firma/WORM.
- **Estado/fuente/impacto:** CONFIRMADO, gate productivo PENDIENTE · U-006 · sin gate
  no se declara custodia productiva.

### RNF-010 — Integridad de raw y exports

- **Escenario/respuesta:** toda lectura/copia verifica SHA-256/manifiesto; una
  alteración o manifest inválido se rechaza y genera incidente.
- **Métrica/método/ambiente/responsable:** 100% de objetos muestreados/verificados y
  pruebas de alteración en storage real aislado; Platform/Security.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-018/021 · evidencia no verificable no
  puede usarse para cierre o export.

## Disponibilidad y continuidad

### RNF-011 — Modos degradados explícitos

- **Escenario/respuesta:** ante dependencia caída o riesgo de integridad, QAPAQ pasa
  al modo seguro aplicable y bloquea operaciones incompatibles sin afirmar éxito.
- **Métrica/método/ambiente/responsable:** matriz dependencia→modo y 25 escenarios
  ADR-020; Platform/Infraestructura.
- **Estado/fuente/impacto:** CONFIRMADO, pruebas PENDIENTES · U-009 · fallo puede
  causar pérdida o mutación insegura.

### RNF-012 — Objetivos de disponibilidad medidos

- **Escenario/respuesta:** para cada servicio/horario aprobado se mide disponibilidad
  y error budget; sin guardia SEV1 se declara `LIMITED PRODUCTION / 8x5`.
- **Métrica/método/ambiente/responsable:** SLO y ventana `TBD`; SOC/Service Owner e
  Infraestructura aportan cobertura, mantenimiento y calendario; medición staging/prod.
- **Estado/fuente/impacto:** PENDIENTE · ADR-020 · impide prometer 24x7/porcentaje.

### RNF-013 — Recuperación sin doble efecto

- **Escenario/respuesta:** tras reinicio/restore, QAPAQ reconcilia checkpoints,
  outbox/inbox, commands `UNKNOWN`, manifests y audit antes de volver a `NORMAL`.
- **Métrica/método/ambiente/responsable:** 100% de ejercicios críticos sin pérdida
  desde durable ni doble efecto; RTO/RPO `TBD`; Infraestructura y Platform.
- **Estado/fuente/impacto:** CONFIRMADO con umbrales PENDIENTES · ADR-020 · producción bloqueada.

## Rendimiento y capacidad

### RNF-014 — Capacidad de ingesta

- **Escenario/respuesta:** bajo perfil representativo sostenido/burst, el pipeline
  mantiene backpressure, checkpoint y recuperación sin pérdida desde durable.
- **Métrica/método/ambiente/responsable:** EPS, tamaño, burst y duración `TBD` por
  PBI-006/benchmark; publicar solo perfil aprobado con ≥30% de headroom; Platform.
- **Estado/fuente/impacto:** plantilla CONFIRMADA, capacidad PENDIENTE · U-002 ·
  impide sizing y promesa de volumen.

### RNF-015 — Latencia operacional

- **Escenario/respuesta:** bajo carga aprobada se miden adquisición→SecurityEvent,
  alerta→vista y persistencia→aceptación Teams sin ocultar colas.
- **Métrica/método/ambiente/responsable:** percentiles/umbrales `TBD`; el baseline
  Teams p95≤60 s es PROPUESTO hasta ratificación; SOC/Platform mide en staging real.
- **Estado/fuente/impacto:** PENDIENTE · ADR-020/022 · sin valor no hay SLO de respuesta.

### RNF-016 — Límites de consulta y exportación

- **Escenario/respuesta:** una búsqueda/export amplia se pagina, limita o pasa a job
  cancelable sin agotar control plane ni el Indexer Wazuh.
- **Métrica/método/ambiente/responsable:** rango, filas, bytes, concurrencia y timeout
  `TBD`; benchmark con datos sintéticos; SOC/Platform resuelve U-015.
- **Estado/fuente/impacto:** PENDIENTE · riesgos A-06/A-11 · bloquea exports productivos.

## Escalabilidad

### RNF-017 — Escalado por API y workers

- **Escenario/respuesta:** al crecer carga, API y workers del mismo release pueden
  escalarse independientemente sin dividir el dominio ni perder idempotencia.
- **Métrica/método/ambiente/responsable:** curva throughput/latencia/cola y punto de
  saturación `TBD`; benchmark L1/L2/L3 en hardware registrado; Platform.
- **Estado/fuente/impacto:** CONFIRMADO como diseño, capacidad PENDIENTE · ADR-016 ·
  extracción a microservicios no es mitigación automática.

## Confiabilidad de ingesta

### RNF-018 — Garantía desde adquisición durable

- **Escenario/respuesta:** desde estado `DURABLE`, retries y reinicios ofrecen
  at-least-once con consumidores idempotentes; antes de durable no se promete cero pérdida.
- **Métrica/método/ambiente/responsable:** cero registros durable perdidos y cero
  efectos dobles en fault injection; Desarrollo/Platform.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-019 · incumplir invalida MVP.

### RNF-019 — Visibilidad de gaps

- **Escenario/respuesta:** cursor vencido, falta de ID/replay, permiso o atraso crea
  gap/cobertura explícita; nunca se transforma en “cero eventos”.
- **Métrica/método/ambiente/responsable:** 100% de escenarios de fuente con estado y
  alerta; ventana real la aporta dueño de fuente.
- **Estado/fuente/impacto:** CONFIRMADO con contratos PENDIENTES · U-005 · sin ello
  el SOC puede asumir cobertura inexistente.

### RNF-020 — Aislamiento de entradas inválidas

- **Escenario/respuesta:** un registro inválido no detiene el lote ni altera datos
  válidos; cuarentena y reproceso conservan lineage/versiones.
- **Métrica/método/ambiente/responsable:** corpus mixto 100% clasificado sin pérdida;
  Desarrollo/SOC.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-011/019 · falla bloquea piloto.

## Observabilidad

### RNF-021 — Señales interoperables y correlacionables

- **Escenario/respuesta:** API/workers emiten OTLP, logs JSON, métricas Prometheus y
  W3C Trace Context con IDs opacos y códigos estables.
- **Métrica/método/ambiente/responsable:** cobertura `TBD` por operación crítica;
  contract/integration con Collector real aislado; Platform/Infraestructura.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-021/025 · backend seleccionado;
  despliegue, sizing y recovery PENDIENTES.

### RNF-022 — Cardinalidad y redacción

- **Escenario/respuesta:** logs/traces/métricas excluyen secretos, raw, PII y labels
  de alta cardinalidad; excepciones de SDK también se redactan.
- **Métrica/método/ambiente/responsable:** cero campos prohibidos y presupuesto de
  series `TBD`; tests de redacción/carga; Security/Platform.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-021 · fuga o explosión de cardinalidad
  bloquea release.

### RNF-023 — Monitoreo externo de caída total

- **Escenario/respuesta:** cuando QAPAQ/Collector no puede auto-reportar, un monitor
  independiente detecta indisponibilidad y enruta alerta fuera del producto.
- **Métrica/método/ambiente/responsable:** frecuencia/destinos/tiempo `TBD`;
  Infraestructura configura y prueba; ejercicio de apagado total.
- **Estado/fuente/impacto:** CONFIRMADO con implementación PENDIENTE · ADR-020/021.

## Interoperabilidad

### RNF-024 — Contrato canónico versionado

- **Escenario/respuesta:** productor/consumidor validan el mismo JSON Schema 2020-12,
  SemVer y corpus; versión desconocida falla de forma compatible y observable.
- **Métrica/método/ambiente/responsable:** 100% de ejemplos válidos/inválidos y
  consumers en contract specs; Desarrollo.
- **Estado/fuente/impacto:** CONFIRMADO / IMPLEMENTATION REQUIRED · ADR-011 · sin
  schema no inicia ingesta funcional.

### RNF-025 — Compatibilidad ECS/OCSF demostrada

- **Escenario/respuesta:** una afirmación de compatibilidad exige mapping versionado,
  perfil, cobertura de campos/semántica y corpus; extensiones no se llaman conformidad.
- **Métrica/método/ambiente/responsable:** reporte de cobertura aprobado por SOC;
  porcentaje/criterio `TBD`; ADR mayor para cambio incompatible.
- **Estado/fuente/impacto:** CONFIRMADO como gate, compatibilidad PENDIENTE · ADR-011.

## Mantenibilidad y calidad

### RNF-026 — Dependencias hacia adentro

- **Escenario/respuesta:** dominio/aplicación no importan NestJS, Prisma, SDK vendor
  ni DTO externo; módulos usan interfaces públicas y composición root.
- **Métrica/método/ambiente/responsable:** cero violaciones en regla de imports y
  revisión; Arquitectura/Desarrollo.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-001/003/015 · violación bloquea PR.

### RNF-027 — Calidad automatizada sin dobles engañosos

- **Escenario/respuesta:** todo cambio ejecuta formato, lint, tipos, specs, build y
  límites aplicables; integración externa solo queda Done con provider spec real.
- **Métrica/método/ambiente/responsable:** 100% checks requeridos PASS, ninguno
  omitido/flaky; Desarrollo/Security; entornos protegidos para credenciales.
- **Estado/fuente/impacto:** CONFIRMADO · Definition of Done/ADR-023 · falta de acceso
  produce BLOCKED, no fake.

### RNF-028 — Evolución de adapters

- **Escenario/respuesta:** un proveedor nuevo implementa port/suite común y mantiene
  autenticación, cursor, mapping y fallos en infraestructura, sin condicionales en dominio.
- **Métrica/método/ambiente/responsable:** suite de conformidad y regla de imports
  PASS; Arquitectura/Desarrollo.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-010/024 · acoplamiento eleva coste futuro.

## Accesibilidad y usabilidad

### RNF-029 — Operación inequívoca bajo degradación

- **Escenario/respuesta:** UI distingue vacío, cargando, error, stale, gap y
  degradado; acciones críticas muestran estado/confirmación sin depender solo de color.
- **Métrica/método/ambiente/responsable:** escenarios UX y comprensión por SOC;
  criterio/tiempo `TBD`; Product Owner/SOC.
- **Estado/fuente/impacto:** PROPUESTO · sin baseline UX aceptado · errores de
  interpretación pueden retrasar respuesta.

### RNF-030 — Accesibilidad verificable

- **Escenario/respuesta:** flujos L1/L2/Admin/Auditor deben ser operables por teclado,
  foco visible, nombres accesibles y contraste/estado comprensibles.
- **Métrica/método/ambiente/responsable:** estándar y nivel WCAG `TBD` por Product
  Owner/Compliance; auditoría automática y manual en navegadores aprobados U-014.
- **Estado/fuente/impacto:** PENDIENTE · sin decisión vigente · puede excluir usuarios
  y generar defectos operativos.

## Portabilidad operativa

### RNF-031 — Ejecución sin proveedor cloud impuesto

- **Escenario/respuesta:** aplicación/containers reciben endpoints y secretRefs por
  configuración, exponen health y no incorporan Terraform ni API cloud al dominio.
- **Métrica/método/ambiente/responsable:** arranque y smoke en entorno local/staging
  aprobado con misma imagen; Infraestructura aporta destino.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-015/023 · hosting productivo PENDIENTE.

## Respaldo, restauración y retención

### RNF-032 — Restore verificable

- **Escenario/respuesta:** restore de PostgreSQL/object/audit verifica versión,
  checksums, secuencia y divergencia antes de habilitar mutaciones.
- **Métrica/método/ambiente/responsable:** RPO/RTO `TBD`, restore periódico y 25
  escenarios ADR-020; Infraestructura/Platform.
- **Estado/fuente/impacto:** CONFIRMADO con objetivos PENDIENTES · producción bloqueada.

### RNF-033 — Retención diferenciada y aprobada

- **Escenario/respuesta:** cada dataset aplica periodo/trigger/tier/hold/purga solo
  después de matriz Legal/Compliance; automatic deletion permanece deshabilitado antes.
- **Métrica/método/ambiente/responsable:** periodo/región/backup `TBD` por
  Legal/Compliance; 20 escenarios ADR-018.
- **Estado/fuente/impacto:** CONDICIONAL · U-004 · activar TTL prematuro arriesga evidencia.

### RNF-034 — Purga y hold reconciliables

- **Escenario/respuesta:** hold prevalece; purga autorizada produce dry-run, receipt,
  deletion ledger y reconciliación de copias/backups sin borrar material retenido.
- **Métrica/método/ambiente/responsable:** 100% de objetos/copies contabilizados;
  Legal/Compliance/Infraestructura.
- **Estado/fuente/impacto:** CONFIRMADO como diseño, operación PENDIENTE · ADR-018.

## Cadena de suministro y releases

### RNF-035 — CI de mínimo privilegio

- **Escenario/respuesta:** PR no recibe secretos ni publica/despliega; Actions se
  fijan por SHA, checkout no persiste credenciales y metadata se trata como input.
- **Métrica/método/ambiente/responsable:** actionlint, CodeQL, Gitleaks, Trivy y
  revisión de workflow PASS; Security/Desarrollo.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-023; implementación vive en PR #2 y no
  se considera integrada hasta merge.

### RNF-036 — Dependencias reproducibles

- **Escenario/respuesta:** workspace usa Node 24.21.0, pnpm 12.4.2 y lockfile
  congelado; no se crea package-lock paralelo; scripts de lifecycle no confiables
  no se ejecutan implícitamente.
- **Métrica/método/ambiente/responsable:** hash de lockfile, instalación frozen y
  `pnpm audit` PASS; Development/Security.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-016/023 · workspace aún no implementado.

### RNF-037 — Artefacto candidato inmutable

- **Escenario/respuesta:** release candidate parte de commit/tag protegido, se
  construye una vez y conserva digest, SBOM, attestation, scans y rollback; no `latest`.
- **Métrica/método/ambiente/responsable:** mismo digest en promociones y ocho
  escenarios ADR-023; registro/identidad/destinos los aporta Infraestructura.
- **Estado/fuente/impacto:** CONFIRMADO, publicación/despliegue PENDIENTES · U-011.

## Endurecimiento transversal 2026-09-28

### RNF-038 — Exclusión mutua de sesión

- **Escenario/respuesta:** ante logins concurrentes, una transacción permite como
  máximo una sesión humana activa y no deja slots huérfanos tras fallo/revocación.
- **Métrica/método/ambiente/responsable:** 100% de carreras/fault injection conservan
  la invariante; Development/Security en PostgreSQL/Redis reales.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-025 · incumplir bloquea acceso productivo.

### RNF-039 — Restricción de red y resistencia a abuso

- **Escenario/respuesta:** acceso fuera de CIDR QAPAQ, proxy no confiable, spray o
  burst falla cerrado y no enumera cuentas; inside/VPN aprobado permanece usable.
- **Métrica/método/ambiente/responsable:** casos inside/outside/IPv4/IPv6/header
  forjado y carga PASS; thresholds medidos; Identity/Infra/Security.
- **Estado/fuente/impacto:** CONFIRMADO con CIDR/umbrales PENDIENTES · ADR-025.

### RNF-040 — No revelación de credenciales de integración

- **Escenario/respuesta:** después del ingreso write-only, ningún humano, response,
  log, DB de negocio, audit, cola o export puede recuperar el plaintext.
- **Métrica/método/ambiente/responsable:** cero exposiciones en tests/scan; rotación
  y revocación PASS; Platform/Security/Infraestructura.
- **Estado/fuente/impacto:** CONFIRMADO, provider/gateway PENDIENTES · ADR-013/025.

### RNF-041 — Observabilidad soberana y segregada

- **Escenario/respuesta:** Grafana/Loki/Prometheus operan en infraestructura bajo
  control QAPAQ, sin SaaS ni egress de telemetría; acceso solo Entra/red QAPAQ.
- **Métrica/método/ambiente/responsable:** inventario de terceros, flujos de red,
  restore, IAM y egress verificados; Infra/Compliance/Security.
- **Estado/fuente/impacto:** CONFIRMADO como decisión, despliegue/dictamen PENDIENTES
  · ADR-025 · un tercero reabre análisis SBS 504-2021 arts. 22–25.

### RNF-042 — Plataforma observable segura y recuperable

- **Escenario/respuesta:** pérdida de componente, disco o credencial degrada de
  forma explícita; restore recupera dashboards/config/datos dentro de objetivos aprobados.
- **Métrica/método/ambiente/responsable:** SLO/RPO/RTO/retención `TBD`, alertas y
  restore ejercitados; Platform/Infraestructura.
- **Estado/fuente/impacto:** CONFIRMADO con sizing PENDIENTE · ADR-020/021/025.

### RNF-043 — Errores comprensibles y seguros

- **Escenario/respuesta:** todo fallo visible tiene código/acción/correlationId y
  nunca filtra stack, secreto, topología o existencia no autorizada.
- **Métrica/método/ambiente/responsable:** 100% de errores catalogados o fallback;
  redaction/no-enumeration y revisión UX; Product/Development/Security.
- **Estado/fuente/impacto:** CONFIRMADO · ADR-025 · mensaje opaco o filtración bloquea release.

### RNF-044 — Gateway de proveedores resiliente y sin estado de negocio

- **Escenario/respuesta:** al caer o actualizar un nodo KrakenD, el balanceador usa
  otro nodo; cursor, raw, manifiesto y jobs no se pierden porque nunca residen en el gateway.
- **Métrica/método/ambiente/responsable:** mínimo dos nodos, caída/rolling update,
  readiness, drain y rollback PASS; Platform/Infra/Security.
- **Estado/fuente/impacto:** CONFIRMADO con topología/BOM PENDIENTES · ADR-026.

### RNF-045 — Presupuestos seguros de proveedor y admisión

- **Escenario/respuesta:** rate limit por réplica, deadline jerárquico, circuit
  breaker y backpressure respetan la cuota; no hay retries ocultos, cache de feeds
  ni publicación downstream antes de commit durable.
- **Métrica/método/ambiente/responsable:** 401/403/429/5xx/timeout/TLS y máximo de
  réplicas PASS; p95/p99, throughput y headroom medidos por ruta; Platform/SOC Dev.
- **Estado/fuente/impacto:** CONFIRMADO con cuotas/umbrales PENDIENTES · ADR-026;
  violar el orden durable bloquea la fuente.
