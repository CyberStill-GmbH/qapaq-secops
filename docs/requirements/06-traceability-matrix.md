# Matriz de trazabilidad y dependencias

## Objetivo → capacidad → requisito → decisión → prueba

| Objetivo | Capacidad | RF/RNF | Fuente | Evidencia de aceptación | Implementación |
| --- | --- | --- | --- | --- | --- |
| Acceso interno controlado | Entra/BFF/RBAC | RF-001…004/037…039; RNF-001…005/038/039 | ADR-017/025 | provider/E2E 35 escenarios | NO IMPLEMENTADO; gates U-003/U-018 |
| Actividad M365 visible | Microsoft→Wazuh→QAPAQ | RF-005…008; RNF-018/019 | ADR-019/024 | actividad sintética y provider spec | NO IMPLEMENTADO; gate U-005 |
| Ingesta recuperable | checkpoint/replay/idempotencia | RF-008…012; RNF-018…020 | ADR-011/019 | fault injection, restart y corpus | NO IMPLEMENTADO |
| Contrato estable | SecurityEvent 1.0.0 | RF-013…017; RNF-024/025 | ADR-011 | JSON Schema/corpus/mapping report | NO IMPLEMENTADO; U-010 implementation required |
| Señal accionable | prioridad/alerta | RF-018/019/021 | ADR-015/024 | specs deterministas, concurrencia y lifecycle | NO IMPLEMENTADO |
| Investigación trazable | búsqueda/casos/evidencia | RF-020…024/030/031 | ADR-015/017/018 | E2E RBAC, hash, lifecycle, export | NO IMPLEMENTADO |
| Conciencia operacional | dashboard/modos | RF-006/025/033; RNF-011…017/021…023 | ADR-020/021 | fault injection, benchmark, runbooks | NO IMPLEMENTADO; thresholds pendientes |
| Aviso crítico resiliente | Teams | RF-026…028; RNF-006/015 | ADR-022 | 20 escenarios y provider spec | NO IMPLEMENTADO; gate U-012 |
| Evidencia administrativa | auditoría | RF-029/032; RNF-008…010 | ADR-021 | rollback, roles DB, cadena/firma | NO IMPLEMENTADO; gate U-006 |
| Conservación gobernada | retención/restore | RF-012/030/031/033; RNF-032…034 | ADR-018/020 | 20+25 escenarios, restore y matriz | NO IMPLEMENTADO; gates U-004/U-009 |
| Entrega reproducible | CI/release candidate | RNF-026/027/035…037 | ADR-016/023 | checks, digest/SBOM/attestation | CI en PR #2; workspace/release ausentes |
| Extensibilidad | adapters | RF-034; RNF-028 | ADR-010/024 | suite de conformidad/proveedor real | POST-MVP |
| Secretos no revelables | QAPAQ control plane/SecretProvider | RF-040; RNF-003/040 | ADR-013/025/026 | write-only, rotación, scan y provider spec | NO IMPLEMENTADO; gate U-019 |
| APIs de proveedor gobernadas | KrakenD on-premises + admisión durable | RF-043; RNF-044/045 | ADR-026 | HA/failover, límites, TLS/OAuth, no-secrets, commit antes de BullMQ y benchmark | NO IMPLEMENTADO; gate U-019 |
| Observabilidad interna | Grafana OSS/Loki/Prometheus | RF-042; RNF-021…023/041/042 | ADR-021/025 | auth/redacción/fallo/restore/control interno | NO IMPLEMENTADO; gate U-020 |
| Errores accionables | catálogo/UI/API | RF-041; RNF-043 | ADR-025 | contract/UX/a11y/no-enumeration | NO IMPLEMENTADO |
| Respuesta/analítica futura | SOAR/Python | RF-035/036 | U-007/U-008 | gates específicos y benchmark | BLOQUEADO/POST-MVP |

## Matriz de bloqueo

| Dependencia o decisión | Bloquea desarrollo | Bloquea piloto | Bloquea MVP aislado | Bloquea producción |
| --- | --- | --- | --- | --- |
| Workspace/schema SecurityEvent no materializados | Sí, vertical ejecutable | Sí | Sí | Sí |
| Tenant/app Entra sin datos/configuración | No dominio/specs puras | Sí login real | Sí recorrido humano | Sí |
| CIDR/proxy/passkey/Smart Lockout no confirmados | No dominio/specs puras | Sí acceso endurecido | Sí requisito Franco Clavo | Sí |
| Microsoft 365/Wazuh sin acceso/versiones/dataset | No ports/persistencia | Sí | Sí recorrido E2E | Sí |
| PostgreSQL/Redis/OpenSearch/object store aislados ausentes | Sí integration specs | Sí | Sí | Sí |
| Mapping Wazuh y corpus no aprobados | Sí normalización final | Sí | Sí | Sí |
| Team/workflow/secretRef/fallback ausentes | No alerta/caso | Sí notificación real | Sí requisito Teams | Sí |
| Matriz Legal/Compliance sin ratificar | No lifecycle sintético | No si no hay TTL | No con purga manual bloqueada | Sí TTL/purga automática |
| WORM/firma/Collector/canales no provisionados | No writer/contratos | Parcial | No para demo aislada declarada | Sí auditoría/observabilidad productiva |
| Grafana/Loki/Prometheus sin sizing/IAM/restore | No instrumentación | Sí tablero SOC | Sí requisito observabilidad | Sí |
| KrakenD sin BOM/topología/rutas y SecretProvider no seleccionado | No port/contrato | Sí alta/consumo seguro | Sí nuevas credenciales/APIs | Sí |
| Sizing, RPO/RTO/SLO y restore no medidos | No implementación | No piloto funcional limitado | No candidato limitado con gaps | Sí |
| Contrato de publicación/despliegue ausente | No CI/candidato | No ejecución local | No candidato artifact | Sí publicación/CD |
| U-008 SOAR detallado abierto | No MVP | No | No | Solo si se habilitan acciones SOAR |
| Python gate no aprobado | No MVP | No | No | Solo para capacidad Python |
| GHAS/Dependency Review no habilitado | No `pnpm audit`/scans base | No con gap declarado | No con aceptación Security | Puede bloquear política final de supply chain |

## Lectura del estado

- **Listo para desarrollo:** contrato y criterio suficientes para construir specs y
  módulos sin inventar infraestructura.
- **Listo para piloto:** además dispone de proveedor real autorizado, configuración,
  datos sintéticos y provider specs.
- **MVP aislado:** recorrido integral demostrado en entorno controlado, con gaps
  productivos explícitos.
- **Producción:** todos los gates de identidad, fuentes, Legal, auditoría,
  continuidad, capacidad, release y operación están aprobados.
