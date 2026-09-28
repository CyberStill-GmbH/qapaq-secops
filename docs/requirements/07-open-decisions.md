# Registro consolidado de decisiones y asuntos abiertos

Este registro resume U-001…U-012 sin sustituir
[`decisions/unresolved.md`](../decisions/unresolved.md), que conserva el detalle y
la evidencia de aceptación. Los nuevos vacíos empiezan en U-013. “Sin fecha
acordada” se usa cuando no existe compromiso verificable.

| ID | Estado | Pregunta o decisión concreta | Responsable | Evidencia necesaria | Revisión | Criterio de cierre |
| --- | --- | --- | --- | --- | --- | --- |
| U-001 | RESUELTA | ¿Cuál es el alcance, ownership, módulos y vocabulario? | SOC/Arquitectura/Security | ADR-015 aceptado | 2026-09-18 | Cumplido; cambios requieren ADR |
| U-002 | RESUELTA; medición pendiente | ¿Qué toolchain/límites y cómo se publica capacidad? | Development/Platform | ADR-016; benchmark aún ausente | sin fecha acordada | Toolchain aceptado; capacidad se publica solo con benchmark/headroom |
| U-003 | DECISIÓN RESUELTA; gate bloqueado | ¿Cómo autenticar/autorizar y cuándo habilitar producción? | Security/SOC/Identity | tenant, app, CA/MFA/passkey, matriz y 35 escenarios | sin fecha acordada | Federación y pruebas autorizadas PASS |
| U-004 | CONDICIONAL | ¿Qué retención, región, privacidad, holds y purga aplican por dataset? | Legal/Compliance/Security/Infraestructura | matriz normativa, inventario, backups y 20 escenarios | sin fecha acordada | Ratificación firmada y pruebas PASS; hasta entonces no TTL automático |
| U-005 | CONDICIONAL | ¿Qué contrato real habilita Microsoft 365→Wazuh→QAPAQ? | Infraestructura/dueños/SOC Dev | edición, dataset, permisos, endpoint, límites, replay y 15 escenarios | Sprint 1 según forecast; no aprobación garantizada | ficha sin TBD y vertical autorizada PASS |
| U-006 | CONDICIONAL | ¿Cómo separar observabilidad/auditoría y probar integridad productiva? | Security/Compliance/Infra/Platform | Collector, WORM, firma, custodios, canales y 24 escenarios | sin fecha acordada | rollback/archive/reconciliación/alertas PASS |
| U-007 | RESUELTA; capacidad dormante | ¿Cuándo usar Python? | Development/Platform/Security | caso medible, baseline, schemas, aislamiento, benchmark y 18 pruebas | sin fecha acordada | Solo se activa si supera TypeScript/Wazuh/OpenSearch y gate |
| U-008 | ABIERTA | ¿Cuáles son guardas, cardinalidades, cierre/reapertura, catálogo SOAR, approvals e idempotencia externa? | SOC/Security/Product Owner | state machines, matriz de capabilities y contratos por acción | sin fecha acordada | ADR/contratos aceptados y specs de transiciones/`UNKNOWN` |
| U-009 | CONDICIONAL | ¿Qué SLO/RPO/RTO, soporte, modos y recovery son demostrables? | Service Owner/Infra/Platform/SOC | owners, calendario, benchmarks, restores y 25 escenarios | sin fecha acordada | objetivos ratificados y recovery medido |
| U-010 | RESUELTA; implementación pendiente | ¿Cuál es el contrato SecurityEvent? | Development/SOC/Security | schema 1.0.0, corpus, mapping Wazuh, replay/raw y reporte ECS/OCSF | Sprint 1/2 según forecast | doce criterios ADR-011 PASS |
| U-011 | PARCIAL | ¿Cómo separar CI, candidato, publicación y despliegue? | Development/Security/Infraestructura | CI/candidato; registro, identidad, ambientes, health y rollback | sin fecha acordada | ocho escenarios ADR-023; publicación/CD tras contrato Infra |
| U-012 | RESUELTA; gate bloqueado | ¿Cómo notificar alertas críticas por Teams? | SOC/Infra/M365/Security | Team/canal, owners, workflow, secretRef, máximo de acuse, fallback y 20 pruebas | sin fecha acordada | provider/E2E y fallback PASS |
| U-013 | ABIERTA NUEVA | ¿Cuál es el catálogo final capability→endpoint→recurso→scope y conjunto otorgable por rol? | Security/SOC/Access Owner | OpenAPI/casos de uso, matriz firmada y specs allow/deny/SoD | antes de implementar endpoints protegidos | cada operación tiene policy y tests; no `ADMIN` universal |
| U-014 | ABIERTA NUEVA | ¿Qué estándar/nivel de accesibilidad y navegadores corporativos son obligatorios? | Product Owner/Compliance/IT Workplace | política corporativa, usuarios objetivo y matriz de navegadores | sin fecha acordada | baseline aceptada y método de prueba definido |
| U-015 | ABIERTA NUEVA | ¿Qué límites de búsqueda, export, cold restore y concurrencia protegen capacidad y datos? | SOC/Platform/Security | volumen/casos reales y benchmark de queries/exports | antes de export productivo | límites, timeout, paginación, aprobación y coste aceptados |
| U-016 | ABIERTA NUEVA | ¿Se habilitarán Dependency Graph y GitHub Advanced Security para Dependency Review? | Security/administrador GitHub/Finanzas | licencia/configuración o excepción formal con control alternativo | sin fecha acordada | action oficial operativa o riesgo/control alternativo aceptado |
| U-017 | ABIERTA NUEVA | ¿Qué KPIs observables determinan éxito de negocio del MVP? | Product Owner/SOC Manager | baseline actual y objetivos de cobertura, aging, investigación y adopción | Sprint Planning/Review; valor final sin fecha acordada | KPIs, fórmula, fuente, owner y periodo aprobados sin inventar SLO técnicos |
| U-018 | ABIERTA NUEVA | ¿Cuáles son los CIDR IPv4/IPv6, VPN, proxies confiables y claims de passkey/fuerza para el acceso QAPAQ? | Identity/Infra/Security | named location, diagrama, owner y E2E inside/outside/proxy | antes de habilitar login Sprint 3 | 35 escenarios ADR-017/025 PASS |
| U-019 | PARCIAL | KrakenD CE on-premises está seleccionado; ¿qué SecretProvider, identities, BOM/topología y namespaces productivos completan alta/rotación? | Infra/Platform/Security | gestor, versión/digest KrakenD, LB, rutas, IAM, HA, recovery y provider specs | contrato Sprint 2; E2E Sprint 3 | sin GET/export/plaintext; failover, cuota, rotación y revocación PASS |
| U-020 | ABIERTA NUEVA | ¿Qué versiones, sizing, retención, HA, backup y soporte operan Grafana OSS/Loki/Prometheus? | Infra/Platform/SOC/Compliance | BOM fijado, capacidad, IAM, egress, restore, RACI y dictamen de operación interna | baseline Sprint 2; cierre Sprint 3 | fallos/restore/acceso PASS y control total demostrado |
| U-021 | ABIERTA NUEVA | ¿Qué backend y retención se usarán para trazas, si se requieren búsquedas completas? | Platform/SOC/Security | caso, volumen, utilidad y evaluación Tempo/alternativa | post-baseline; sin fecha acordada | decisión explícita; hasta entonces trace/span IDs en logs |

## Regla de uso

Un asunto resuelto puede conservar un gate operacional. El gate no reabre la
decisión, pero impide afirmar piloto o producción. Un valor `TBD` se registra en el
issue/PBI con owner y evidencia; no se reemplaza por un default ficticio.
