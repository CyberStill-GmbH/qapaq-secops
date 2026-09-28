# Sprint 3 — Operación SOC y evidencia del candidato

Fechas: 2026-10-07 a 2026-10-20 · Planning: 2026-10-07 · Review/Retro: 2026-10-20.

## Sprint Goal

Transformar el SecurityEvent validado en un flujo SOC mínimo autorizado y auditable,
y emitir una decisión de preparación sustentada en E2E, fallos, capacidad y recovery.

## Forecast inicial

1. PBI-014 — priorización de alertas base Wazuh.
2. PBI-015 — alerta, triaje e incidente mínimo.
3. PBI-016 — autenticación/autorización Entra.
4. PBI-018 — notificación CRITICAL en Teams.
5. PBI-019 — auditoría verificable.
6. PBI-020 — suite E2E y fallos.
7. PBI-021 — capacidad, recovery y release evidence.
8. PBI-017 — vista operativa y PBI-022 — extensibilidad, solo si el P0 está protegido.
9. PBI-026 — sesión única, red QAPAQ, passkey y protección de intentos.
10. PBI-027 — tableros SOC y hardening/recovery del stack OSS.
11. PBI-029 — E2E write-only; PBI-028 — catálogo de errores si el P0 está protegido.
12. PBI-030 — HA, seguridad, observabilidad y E2E KrakenD antes de BullMQ.

El forecast es deliberadamente revisable: Planning selecciona PBIs completos según
capacidad observada en Sprint 1/2. PBI-020 y PBI-021 no se recortan para incorporar
UI adicional. Un flujo por API puede constituir el incremento usable si la vista
PBI-017 no cabe, siempre que Product Owner lo acepte antes de Planning.

## Componentes a construir

| Orden | Componentes | Resultado físico |
| --- | --- | --- |
| 1 | C-18, C-19, C-25 | Autorización Entra endurecida y auditoría transaccional desde el inicio |
| 2 | C-16 | Priorización QAPAQ sobre alertas Wazuh con reason codes |
| 3 | C-17 | Lifecycle mínimo de alerta, triaje e incidente/caso |
| 4 | C-20 | Outbox, worker y adapter Teams con fallback y acuse QAPAQ |
| 5 | C-22 | E2E, fallos, recovery, capacidad y release evidence del mismo commit |
| Transversal | C-26 | Grafana SOC, hardening, alertas externas, backup/restore y evidencia SBS |
| Transversal | C-24 | E2E de alta/rotación/revocación write-only de credenciales |
| Transversal | C-28 | KrakenD HA, failure modes, cuotas, benchmark y dashboards por ruta |
| Condicional | C-21, C-23, C-27 | Vista, extensibilidad y catálogo UX, después del P0 |

C-18/C-19 no son tareas de cierre: protegen C-17 y C-20. C-22 acumula evidencia
desde los primeros PR y no se comprime para incorporar UI. Las dependencias y
specs por componente están en el
[plan por componentes](../component-delivery-plan.md).

## Plan de trabajo

### Primera semana

- implementar priorización sin duplicar el ruleset Wazuh;
- materializar lifecycle de alerta/incidente y AuditEvent atómico;
- integrar Entra BFF/RBAC con entorno autorizado;
- probar sesión única, red QAPAQ, passkey Entra y throttling sin enumeración;
- implementar outbox/worker Teams y payload mínimo;
- completar specs de seguridad y autorización.

### Segunda semana

- recorrer E2E completo y escenarios de fallo/recovery;
- ejecutar benchmark y drenaje con configuración documentada;
- verificar restart/replay sin alertas, casos o mensajes duplicados;
- recopilar digest, SBOM, CI, migraciones, rollback y riesgos;
- demostrar dashboards/alertas, redacción, acceso, backup/restore y control interno
  de Grafana OSS/Loki/Prometheus; completar alta write-only y catálogo de errores;
- demostrar failover/rolling update de KrakenD, límites calculados por réplica y
  admisión durable antes de cualquier publicación downstream;
- realizar Review ejecutable y decisión de preparación.

## Dependencias de entrada

- SecurityEvent consultable, replay y cuarentena de Sprint 2;
- app registration Entra, tenant, redirect URIs y claims aprobados;
- CIDR QAPAQ, VPN/egress, proxies confiables, Conditional Access, passkey y Smart Lockout aprobados;
- Teams Workflow, canal, secretRef, propietario y fallback aprobados;
- Grafana/Loki/Prometheus/Collector con versiones, storage, IAM y red interna;
- KrakenD CE/LB on-premises, SecretProvider e identidades técnicas para E2E;
- reviewer de Seguridad para auth, mapping y notificación;
- entorno con recursos suficientes para benchmark/recovery.

## Specs obligatorias

- promoción idempotente de Wazuh alert a QAPAQ alert;
- lifecycle válido, transición inválida, concurrencia y denegación;
- OIDC/BFF, tenant/issuer/audience, state/nonce/PKCE, scopes, revocación, sesión
  única, inside/outside de red, passkey, Smart Lockout y rate limiting;
- no revelación de credenciales en create/rotate/revoke y ausencia de read/export;
- KrakenD: config/rutas/egress allowlisted, TLS/OAuth, 401/403/429/5xx/timeout,
  circuit breaker, caída de nodo, cuota agregada y commit durable antes de BullMQ;
- Grafana/Loki/Prometheus: auth, red privada, redacción, cardinalidad, caída y restore;
- atomicidad estado/audit/outbox y prohibición de update/delete de auditoría;
- Teams real, timeout ambiguo, reintentos, duplicado, fallback y acuse QAPAQ;
- recorrido E2E Microsoft 365 → Wazuh → QAPAQ → Teams;
- caídas de servicios, restore, replay, drenaje y carga documentada.

## Criterios de Review

La Review se ejecuta contra el candidato del commit identificado. Debe mostrar un
evento controlado de Microsoft 365, alerta Wazuh, SecurityEvent, promoción, triaje,
incidente/auditoría y notificación crítica. Se repite un tramo para demostrar
idempotencia y se muestra una denegación real de permisos. Luego se revisan
benchmark, recovery, specs bloqueadas y riesgos.

## Decisión de cierre del timebox

El Product Owner registra una de estas salidas:

- `MVP CANDIDATE`: todos los P0 cumplen Done y no hay gate crítico bloqueado para
  el ambiente objetivo.
- `LIMITED`: existe incremento usable, pero uno o más gates impiden promoción; se
  enumeran alcance habilitado, restricciones, dueño y fecha.
- `NOT READY`: no se demuestra la ruta crítica o existe riesgo P0 sin control.

Ninguna salida implica despliegue productivo automático. La decisión incluye commit,
entorno, resultados, riesgos aceptados por autoridad competente y siguiente Product
Goal. Trabajo incompleto vuelve al Product Backlog; no recibe porcentaje Done.

## Retrospective final

Además de la mejora habitual, evalúa: capacidad real del equipo, tiempo bloqueado,
calidad de accesos, estabilidad de specs, supuestos Wazuh/Microsoft filtrados fuera
de infraestructura y viabilidad del siguiente proveedor. Esta evidencia reordena
PBI-023/024 y el plan posterior.

[Product Backlog](../product-backlog.md) · [Plan por componentes](../component-delivery-plan.md) ·
[Definition of Done](../definition-of-done.md)
