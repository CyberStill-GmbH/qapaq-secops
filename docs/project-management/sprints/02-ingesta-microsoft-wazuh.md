# Sprint 2 — Ingesta Microsoft 365/Wazuh

Fechas: 2026-10-05 a 2026-10-06 · Planning: 2026-10-05 · Review/Retro: 2026-10-06.
Timebox: dos días laborables.

## Sprint Goal

Convertir una actividad autorizada de Microsoft 365 en una alerta Wazuh y admitirla
de forma durable como SecurityEvent consultable, con checkpoint, replay, integridad
y cuarentena demostrados.

## Forecast inicial

1. PBI-007 — configurar Microsoft 365 en Wazuh.
2. PBI-008 — adapter Wazuh read-only.
3. PBI-009 — raw, manifiesto y checkpoint.
4. PBI-010 — mapping Wazuh → SecurityEvent.
5. PBI-011 — idempotencia, replay y cuarentena.
6. PBI-012 — indexación y consulta.
7. PBI-013 — telemetría y baseline Grafana OSS/Loki/Prometheus, transversal.
8. PBI-029 — contrato write-only de credenciales; E2E se completa en Sprint 3.
9. PBI-030 — contrato y baseline KrakenD on-premises; C-28 aporta en esta rama config fijada, allowlist, validación oficial y gate CI; balanceador, credenciales/identidad real, integración Indexer, HA operativa, rotación y aceptación E2E se completan/gatean en Sprint 3.

PBI-007 es dependencia externa crítica. Si no están disponibles tenant, permiso,
Wazuh o red al Planning, se mantiene `BLOCKED`; no se reemplaza por fake. Por
decisión del Product Owner del 2026-09-25, el desarrollo local de Sprint 2 puede
iniciar con el contrato C-08 y su suite ejecutable. La integración real se difiere
al E2E final del MVP: no se afirma el Sprint Goal ni el MVP Candidate hasta recorrer
la fuente autorizada.

## Componentes a construir

| Orden | Componentes | Resultado físico |
| --- | --- | --- |
| 1 | C-10 | Adapter Wazuh, registro de fuente, paginación y errores de frontera |
| 2 | C-11 | Admisión durable con raw/ref/hash, manifiesto y checkpoint |
| 3 | C-12 | Mapping Wazuh → SecurityEvent validado y versionado |
| 4 | C-13 | Inbox, idempotencia, replay, cuarentena y reproceso |
| 5 | C-14 | Proyección OpenSearch y consulta tipada/autorizable |
| Transversal | C-15 | Logs/métricas/health, Collector, Loki/Prometheus y provisioning Grafana |
| Transversal | C-24 | Control plane QAPAQ write-only y SecretProvider, sin plaintext persistido |
| Transversal | C-28 | KrakenD CE + LB/config: rutas Wazuh/proveedor, TLS/OAuth, límites y telemetría |

C-10 consume Wazuh Indexer por C-28; C-28 → C-10 → C-11 → C-12 → C-13 → C-14
es la ruta crítica de datos. Cada componente debe cerrar
su failure path antes del siguiente; C-15 no se difiere hasta el final. PBI-007 y
las provider specs contra Wazuh real siguen bloqueados sin sistemas corporativos
reales; los contratos locales permiten desarrollar y comprobar límites sin simular
una aceptación real. Consultar
el [plan por componentes](../component-delivery-plan.md).

## Gate previo obligatorio

Al terminar la Review de Sprint 1 deben estar listos los contratos y código base
C-01…C-09 para el trabajo local de Sprint 2. La falta actual de Wazuh/tenant no
bloquea ese desarrollo por la decisión de aplazamiento del 2026-09-25; los PBI y
pruebas que exigen esos sistemas se registran `BLOCKED` y se acumulan como gate del
E2E final. El 2026-10-05 no se usa para instalar dependencias pendientes.

## Plan de trabajo por día

### Día 1 — 2026-10-05

- Planning de 30 minutos y verificación ejecutable del gate;
- avanzar el adapter y validar su contrato localmente;
- si Wazuh/tenant y permisos ya están disponibles, confirmar configuración y
  generar actividad sintética autorizada; si no, registrar PBI-007/provider specs
  como `BLOCKED` sin crear fixtures que aparenten aceptación;
- persistir raw/ref/hash y registrar manifiesto antes del checkpoint;
- implementar mapping versionado y validación previa a indexación;
- mantener DTOs Wazuh dentro de infraestructura.

### Día 2 — 2026-10-06

- probar duplicados, restart, cursor/checkpoint y replay;
- implementar cuarentena y reproceso con lineage;
- indexar/consultar SecurityEvent con filtros y límites;
- instrumentar cobertura, lag, error e integridad;
- levantar el baseline autogestionado Grafana OSS/Loki/Prometheus para integración,
  con versiones fijadas, backends privados y dashboard mínimo del pipeline;
- cerrar el contrato create/rotate/revoke de credenciales sin endpoint de lectura;
- validar configuración KrakenD, egress/rutas allowlisted y failure modes básicos;
- demostrar que la respuesta Wazuh queda durable en C-11 antes de publicar una
  referencia en BullMQ; KrakenD no escribe directamente a la cola;
- ejecutar E2E desde Microsoft 365 hasta consulta QAPAQ si la dependencia externa
  está disponible; en caso contrario, trasladar explícitamente ese gate a la
  aceptación final del MVP;
- realizar Review y Retrospective con evidencia del mismo commit.

## Dependencias de entrada

- todos los PBI P0 de Sprint 1 Done;
- tenant/dataset Microsoft 365 autorizado y secretRef vigente;
- Wazuh configurado con integración Office 365 y ruleset verificable;
- Indexer accesible con mínimo privilegio;
- storage, PostgreSQL y Redis disponibles en el ambiente de integración.
- balanceador/KrakenD internos y egress al Wazuh Indexer; BOM y certificados
  pueden quedar gated, pero la ruta no se declara productiva sin ellos.

## Specs obligatorias

- actividad real Microsoft 365 → evento/alerta Wazuh;
- 401/403, timeout, throttling aplicable y recuperación;
- ruta KrakenD, TLS inválido, 429/5xx, circuit breaker y caída de un nodo;
- caída antes/después de raw, manifiesto, publicación y checkpoint;
- mapping completo y rechazo de documento inválido/sobredimensionado;
- replay, duplicado concurrente, identidad débil y poison event;
- caída/reinicio de Indexer y object storage;
- consulta autorizada, paginada y sin raw por defecto.

## Criterios de Review

La Review genera una actividad controlada en Microsoft 365, demuestra su alerta en
Wazuh y sigue la evidencia hasta SecurityEvent y consulta QAPAQ. Después reinicia el
worker o repite la ventana para comprobar que no duplica efectos. Un evento inválido
debe aparecer en cuarentena con causa y raw verificable.

Evidencia esperada:

- IDs y timestamps correlacionables en todas las etapas;
- mapping/corpus versionados y aprobados;
- resultados de specs reales y fallos inyectados;
- métricas de cobertura/lag/cuarentena;
- riesgos y deuda reordenados en el único Product Backlog.

## Regla de salida

Sin Microsoft 365 y Wazuh reales el Sprint Goal queda no logrado, aunque componentes
internos individuales cumplan Done. Esos incrementos siguen siendo utilizables; la
integración bloqueada vuelve al Product Backlog con evidencia exacta. Sprint 3 puede
avanzar en lifecycle/auditoría sobre SecurityEvents producidos por la instancia
Wazuh real de integración, pero la Review final no declara MVP Candidate hasta
cerrar el recorrido Microsoft 365.

[Product Backlog](../product-backlog.md) · [Plan por componentes](../component-delivery-plan.md) ·
[Definition of Done](../definition-of-done.md)
