# Informe de avance — 2026-09-28

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 28 de septiembre de 2026

**Asunto:** Daily Scrum — Inicio de Sprint 2 (Ingesta durable Microsoft 365/Wazuh)

Preparado para el Daily Scrum de **2026-09-28**, primer día laborable después
del cierre de Sprint 1 (viernes 2026-09-25). Facilitador: Cesar Adrian Guevara
Salcedo. Formato y vocabulario según [Daily Scrum](../daily-scrum.md) y
[Definition of Done](../definition-of-done.md).

**Verificación de origen:** este informe se renovó contra `main` el 2026-09-28
en el commit **`e976ba8`** (`docs: define on-prem KrakenD provider gateway`),
que incorpora dos commits nuevos del mismo día: `56eead2`
(`docs(security): add access and SOC observability requirements`) y `e976ba8`.
Ambos traen decisiones nuevas de Franco fechadas hoy — ADR-025 y ADR-026 — que
amplían el alcance ya comprometido de Sprint 2. La versión anterior de este
informe, redactada antes de que estos commits llegaran a `main`, quedaba
desactualizada en el forecast del Sprint; esta versión la reemplaza.

## Aviso de calendario — confirmar con Product Owner

El plan [Sprint 2 — Ingesta Microsoft 365/Wazuh](../sprints/02-ingesta-microsoft-wazuh.md)
sigue fechado **2026-10-05 → 2026-10-06**. Sprint 1 cerró sus nueve componentes
(`C-01`…`C-09`) el 2026-09-25, ocho días laborables antes de su fecha límite
original (2026-10-02). Este informe abre Sprint 2 **hoy, 2026-09-28**, por
adelanto del calendario original, no porque el documento de Sprint ya haya sido
re-fechado formalmente. Se necesita una Sprint Planning corta (30 minutos, como
indica el propio plan) para: confirmar el forecast con Franco, decidir si el
timebox de dos días se mantiene o se amplía al tener más días laborables
disponibles antes de octubre, y actualizar las fechas en el documento de Sprint.
Este Daily no sustituye esa Planning; documenta el arranque de trabajo mientras
se confirma.

## Decisiones nuevas de hoy — ADR-025 y ADR-026

Franco Clavo aportó dos decisiones el 2026-09-28 que amplían el alcance ya
comprometido de Sprint 2, no lo reemplazan:

**ADR-025 — Endurecimiento de acceso, secretos y observabilidad SOC**
(`Conditionally Accepted`): una sola sesión humana activa por usuario (rechazo
transaccional del segundo login); sin rol `SUPERADMIN`, conservando
separación de funciones y break-glass gobernado en Entra; Smart Lockout de
Entra más rate limiting anónimo propio; acceso humano restringido a la red
QAPAQ vía Conditional Access e ingress/BFF; passkey FIDO2 dentro del flujo
OIDC existente; credenciales de adapters ingresadas una sola vez por un
control plane **write-only** (create/rotate/revoke, nunca lectura), custodiadas
por `SecretProvider` externo; observabilidad autogestionada con Grafana OSS +
Loki + Prometheus (sin exposición directa, sin Grafana anónimo); catálogo de
errores estable para UI/API. El sustento normativo referencia el SGSI-C de la
Resolución SBS N.° 504-2021 y exige un gate de Legal/Compliance antes de
cerrarse. U-003 (identidad/autorización) sube de 27 a **35 escenarios mínimos**
de aceptación por este ADR.

**ADR-026 — KrakenD Community Edition on-premises como gateway de proveedores**
(`Accepted / Implementation Gated`): al menos dos nodos stateless detrás de un
balanceador interno gobiernan el egress hacia APIs de proveedores (Microsoft
Graph, Cato, Sophos futuros) — rutas/upstreams allowlisted, TLS/OAuth o API
key materializados en runtime desde `SecretProvider`, timeouts/rate
limit/circuit breaker por ruta. **Invariante crítica:** KrakenD no escribe a
BullMQ ni decide idempotencia/replay/cobertura; la respuesta de un proveedor
debe quedar durable en PostgreSQL (manifiesto + inbox + checkpoint + outbox)
**antes** de publicar cualquier referencia en Redis/BullMQ. El MVP vigente no
inserta KrakenD entre Microsoft 365 y Wazuh — esa frontera la opera
Infraestructura sin cambio.

Ninguna de las dos decisiones tiene todavía implementación: versión/digest de
KrakenD, balanceador y `SecretProvider` de producción figuran `TO_BE_PROVIDED`
en [`source-inventory.yaml`](../../integrations/source-inventory.yaml) (nuevo
bloque `provider_gateway`). Son decisiones de diseño aceptadas, no componentes
construidos.

### Impacto en el forecast de Sprint 2

El plan de Sprint 2 se actualizó (`sprints/02-ingesta-microsoft-wazuh.md`) con
dos PBI y dos componentes nuevos, ambos **P0**:

| PBI | Componente | Alcance en Sprint 2 | Alcance diferido a Sprint 3 |
| --- | --- | --- | --- |
| PBI-029 — alta write-only de credenciales | **C-24** | Contrato create/rotate/revoke, sin GET/export/plaintext | E2E completo |
| PBI-030 — gateway KrakenD on-premises | **C-28** | Contrato y baseline (config validation, 401/403/429/5xx/timeout) | HA, rotación, failure modes, benchmark, dashboards por ruta |

La ruta crítica de datos cambia de **C-10 → C-11 → C-12 → C-13 → C-14** a
**C-28 → C-10 → C-11 → C-12 → C-13 → C-14**: KrakenD se ubica delante de la
consulta a Wazuh/proveedor. C-15 (observabilidad transversal) se amplía para
incluir el Collector, Prometheus, Loki y el provisioning mínimo de Grafana. Los
componentes de endurecimiento de acceso (C-25), dashboards SOC (C-26) y
catálogo de errores en la UI (C-27) quedan planificados para Sprint 3, no
Sprint 2.

## Gate previo — cierre de Sprint 1 verificado

El plan de Sprint 2 exige que C-01…C-09 estén listos para habilitar el trabajo
local. Estado real en `main` (`e976ba8`) al momento de este Daily:

| Componente | Estado | Nota |
| --- | --- | --- |
| C-01, C-02, C-03, C-05, C-07 | `DONE` | Sin condiciones |
| C-04 — persistencia de admisión | `DONE` | Confirmado en CI (run `36154234794`) |
| C-06 — entorno de integración | `DONE` | E2E real Wazuh/OpenSearch en Railway; excepción de capacidad de pruebas aceptada |
| C-08 — contrato operativo Wazuh | `DONE` **solo para habilitar Sprint 2**, por excepción explícita del Product Owner (2026-09-25) | La integración real contra Manager/Indexer autorizados **no se ha ejecutado**; sigue como gate obligatorio del E2E final del MVP |
| C-09 — CI seguro y ownership | `IMPLEMENTED / BLOCKED_BY_REPOSITORY_ADMINISTRATION`, no `DONE` | CI y evidencia en verde; sin protección de rama ni CODEOWNERS activos, por decisión aceptada del Product Owner mientras haya un único mantenedor |

El gate previo se considera **suficiente para iniciar el trabajo local de
Sprint 2** (así lo autoriza la decisión del PO del 2026-09-25), no para
declarar Wazuh/Microsoft 365 operativos. Esa distinción gobierna todo lo que
sigue.

## Sprint Goal

Convertir una actividad autorizada de Microsoft 365 en una alerta Wazuh y
admitirla de forma durable como `SecurityEvent` consultable, con checkpoint,
replay, integridad y cuarentena demostrados.

## Forecast del Sprint

| Orden | PBI | Componente | Depende de |
| --- | --- | --- | --- |
| 1 | PBI-007 — Configurar Microsoft 365 en Wazuh | — (dependencia externa) | Tenant, permisos y Wazuh reales |
| 2 | PBI-030 — Gateway KrakenD (contrato/baseline) | C-28 | C-03, C-06, C-24 |
| 3 | PBI-008 — Adapter Wazuh read-only | C-10 | C-05, C-08, C-28 |
| 4 | PBI-009 — Raw, manifiesto y checkpoint | C-11 | C-04, C-06, C-10 |
| 5 | PBI-010 — Mapping Wazuh → SecurityEvent | C-12 | C-05, C-10, C-11 |
| 6 | PBI-011 — Idempotencia, replay y cuarentena | C-13 | C-11, C-12 |
| 7 | PBI-012 — Indexación y consulta | C-14 | C-12, C-13 |
| 8 | PBI-013 — Telemetría, Collector, Loki/Prometheus, Grafana | C-15 (transversal) | C-10…C-14 |
| 9 | PBI-029 — Alta write-only de credenciales (contrato) | C-24 | C-03, C-08 |

Ruta crítica de datos: **C-28 → C-10 → C-11 → C-12 → C-13 → C-14**. C-15 y C-24
se incorporan de forma transversal, no se posponen a una tarea final. PBI-007
sigue siendo la única dependencia externa crítica para el Sprint Goal: si
tenant, permisos, Wazuh o red no están disponibles, queda `BLOCKED` — no se
reemplaza con datos simulados. PBI-029 y PBI-030 son P0 nuevos, pero su
alcance en Sprint 2 es de contrato/baseline; su E2E completo se difiere a
Sprint 3 por diseño, no por incumplimiento.

## Estado de la dependencia externa (PBI-007) al inicio de Sprint 2

- Microsoft 365 tiene `status: enabled` en
  [`source-inventory.yaml`](../../integrations/source-inventory.yaml) desde el
  2026-09-24, pero esa marca es una **decisión administrativa del Product
  Owner**, no una verificación técnica: `approved_scopes`, `approval_ticket`,
  `dataset`, `api_version` y `region` siguen sin valor real, y no hay una
  conexión de lectura demostrada contra Microsoft 365 (ver
  [decisión](../../decisions/unresolved.md#decisión-microsoft-365-pasa-a-enabled-sin-el-gate-técnico-completo-de-pbi-006)).
- El contrato `SecurityEventProvider` de C-08 está implementado y probado
  (26/26 tests) **contra un cliente simulado**; ningún Manager o Indexer Wazuh
  real fue consultado. El proyecto Railway aislado creado para probar C-08
  (`qapaq-c08-wazuh-e2e-20260925`) quedó vacío, sin servicios desplegados.
- **Conclusión para Sprint 2**: PBI-007 abre el Sprint como `BLOCKED`. C-10
  (adapter Wazuh) puede avanzar en diseño, tipos y specs contra el contrato
  local de C-08, pero sus "Provider specs contra Microsoft 365/Wazuh e Indexer
  reales" (columna de evidencia de salida del
  [plan de componentes](../component-delivery-plan.md#sprint-2--ingesta-durable-microsoft-365wazuh-dos-días))
  no pueden cerrarse hasta que Franco confirme acceso real.

## Plan de hoy (equivalente a Día 1 del plan de Sprint, alcance ampliado)

1. Confirmar con Franco la fecha real de Sprint Planning, si el timebox de
   Sprint 2 se mantiene en dos días, y el alcance formal de PBI-029/PBI-030
   dentro de ese timebox (contrato/baseline, no E2E).
2. Iniciar **C-28** (gateway KrakenD, contrato/baseline): configuración
   versionada, rutas allowlisted, validación de config y manejo de
   401/403/429/5xx/timeout — sin desplegar infraestructura real todavía
   (`TO_BE_PROVIDED` en `source-inventory.yaml`).
3. Iniciar **C-10** (`modules/connectors`, adapter Wazuh) apoyado en el
   contrato `SecurityEventProvider` de C-08, diseñado para consumir el
   Indexer a través de C-28.
4. Validar ambos contratos localmente (unit + contract suites); no se afirma
   aceptación contra Wazuh, proveedores ni KrakenD reales mientras PBI-007 y
   la infraestructura de C-28 estén `BLOCKED`/`TO_BE_PROVIDED`.
5. Registrar PBI-007 como `BLOCKED` en el Product Backlog, con dueño (Franco)
   y sin fecha simulada.
6. Mantener el límite de WIP en dos componentes activos: **C-28** y **C-10**
   como foco de hoy; C-24 (credenciales write-only) y C-11 esperan a que uno
   de los dos cierre su contrato local.

## Resultado de verificación y decisión de avance — 2026-09-28

Se ejecutaron las suites con el Node fijado por el repositorio (`24.21.0`),
pnpm `12.4.2`, Docker Desktop `29.4.3` y Compose `5.1.3`:

| Gate local | Resultado | Alcance demostrado |
| --- | --- | --- |
| Unit/contract `modules/connectors/test` | PASS, 47/47 en 3 archivos | Adapter, port y reglas de arquitectura C-10 contra dobles de prueba |
| Configuración C-03 usada por C-10 | PASS, 49/49 | Validación de runtime/configuración |
| Contract suite C-28 | PASS, 6/6 | Allowlist, métodos, autenticación, límites, timeouts y configuración |
| `validate.ps1` + checker de la imagen oficial KrakenD | PASS, `Syntax OK` | Sintaxis/configuración de la versión fijada por tag |
| Runtime C-10 → C-28 → Indexer controlado | PASS | Imagen KrakenD en Docker local, JWKS efímero y mock Indexer; 401/403/429/5xx, timeout, reset, 404/método, filtrado, métricas y recuperación |

El benchmark corto del harness informó 1,540 solicitudes en 2 s, 770 req/s,
p50 4.51 ms, p95 8.36 ms, p99 16.67 ms y 0% de errores. Es un smoke loopback
con mocks, no un SLO ni un resultado de sizing/capacidad.
El [registro JSON de evidencia](../c-10/assets/2026-09-28-c10-c28-contract-run.json)
declara que el árbol estaba modificado; los resultados pertenecen al árbol local
verificado y no deben atribuirse a un checkout limpio de CI.

**Decisión:** sí se puede pasar ahora a **C-11 y C-24** para implementación y
contratos locales, respetando el WIP de dos componentes. C-11 es el siguiente
paso de la ruta de ingesta durable; C-24 habilita la frontera write-only que
necesita la promoción futura de C-28. Esta decisión solo cierra el gate de
contratos locales de C-10/C-28.

PBI-007 **sigue `BLOCKED`**: el diagnóstico real de CesarQAPAQ encontró tokens
sin roles y `401 AF10001` al consultar suscripciones de Office 365; falta
`ActivityFeed.Read` con admin consent y revalidación autorizada. El registro está
en [PBI-007](../pbi-007/README.md) y el ADR-024 define la vertical. No se declara
aceptación de Microsoft 365, proveedores, Manager/Indexer reales ni infraestructura
KrakenD real. Los insumos de producción C-28 siguen `TO_BE_PROVIDED`; E2E/HA y
capacidad real permanecen como gates.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: Microsoft 365 en Wazuh sin tenant/permisos/red reales | `BLOCKED`, bloquea el Sprint Goal completo | Franco Clavo Santander | Confirmar acceso real o mantener el PBI bloqueado con fecha objetivo explícita |
| C-08: integración real contra Wazuh Manager/Indexer autorizado | `BLOQUEADO`, gate obligatorio del E2E final del MVP | Cesar / Franco | Provisionar acceso real (tenant, credenciales, Docker o Railway funcional) |
| C-28: KrakenD sin versión/digest/balanceador/SecretProvider reales | `TO_BE_PROVIDED`, bloquea el HA/E2E de PBI-030 (Sprint 3) | Infraestructura / Cesar | Fijar versión y digest en el BOM; provisionar balanceador on-premises |
| ADR-025: 35 escenarios de identidad/acceso sin ambiente autorizado para probarlos | Condicional hasta pasar en ambiente real | Identity / Security / Cesar | Provisionar Conditional Access, Smart Lockout y passkey en un tenant de prueba |
| C-09: sin protección de rama ni CODEOWNERS activos | Riesgo de proceso aceptado, no resuelto técnicamente | Cesar / Franco | Reevaluar si se incorpora un colaborador externo real |
| Fechas de Sprint 2 desactualizadas en el documento de plan (siguen en 2026-10-05/06 pese al alcance ampliado de hoy) | Riesgo de proceso, bajo impacto | Cesar / Franco | Re-fechar tras la Sprint Planning |

## Confianza en el Sprint Goal

ÁMBAR al abrir Sprint 2: el gate previo de Sprint 1 está satisfecho con sus
excepciones documentadas. El baseline de contratos locales C-28/C-10 pasó y la
siguiente pareja de WIP es C-11/C-24, sin depender de Wazuh ni KrakenD productivos.
El Sprint Goal original — admitir una
alerta Wazuh real originada en Microsoft 365 — sigue condicionado enteramente
a PBI-007, que abre el Sprint `BLOCKED`. El alcance de hoy se amplió con dos
PBI P0 nuevos (credenciales write-only, gateway KrakenD) cuyo compromiso en
Sprint 2 es explícitamente de contrato/baseline, no de aceptación E2E — eso
reduce el riesgo de sobrecompromiso, pero añade dos frentes de trabajo nuevos
al mismo timebox que todavía no se ha re-confirmado con Franco. Si Franco no
confirma acceso real a Microsoft 365/Wazuh durante Sprint 2, el Sprint Goal
formal no se alcanza aunque C-10…C-15, C-24 y C-28 avancen en local; ese
resultado parcial se registra como incremento utilizable, no como Sprint Goal
cumplido, según la regla de salida del propio plan de Sprint 2.

[Daily Scrum](../daily-scrum.md) · [Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Plan de componentes](../component-delivery-plan.md) · [Product Backlog](../product-backlog.md) ·
[Definition of Done](../definition-of-done.md) ·
[ADR-025 — Endurecimiento de acceso y observabilidad](../../adr/025-security-access-observability-hardening.md) ·
[ADR-026 — Gateway KrakenD on-premises](../../adr/026-on-premises-krakend-provider-api-gateway.md) ·
[Informe de cierre de Sprint 1 (2026-09-25)](2026-09-25-informe-de-cierre.md)
