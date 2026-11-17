# 09 · Plan de lanzamiento (serverless en AWS)

> Este plan describe la arquitectura serverless **propuesta**; no representa el entorno dev actual.
> El dev vigente usa una EC2 y un ALB administrados por `infra/aws-poweruser/`; la release y sus
> límites de verificación están en [22](22-registro-de-cambios.md). No hay que interpretar este
> plan como evidencia de que la arquitectura serverless ya existe. Arquitectura: [02](02-arquitectura.md).
> El camino Azure (EUS2) queda **archivado**, sin valor de plan: [`docs/archive/azure`](archive/azure/README.md).

Cada fase termina con evidencia (SHA, comando, versiones y resultados redactados) en el PR del
entorno. Los tiempos son estimaciones sin medir.

## Fase 0 · Cuentas y landing zone

| Tarea | Acepta cuando |
| --- | --- |
| AWS Organizations con `qapaq-soc-workload`, `qapaq-log-archive` y `qapaq-security-tooling` | Las tres cuentas existen y las SCP impiden desactivar CloudTrail y Object Lock |
| IAM Identity Center federado con Entra; sin usuarios IAM de larga vida | Un administrador entra con Entra y MFA; no hay claves de acceso estáticas |
| CloudTrail de organización, GuardDuty y Security Hub con administrador delegado | Los hallazgos de prueba aparecen en `qapaq-security-tooling` |
| Estado de Terraform remoto con bloqueo y cifrado KMS; OIDC de GitHub Actions hacia roles acotados | `terraform plan` corre en CI sin credenciales guardadas |
| CI verde en el repo (`unit`, `boundaries`, `C-02`) | Los checks pasan en la rama |

## Fase 1 · Núcleo Wazuh en EC2 y backups

| Tarea | Acepta cuando |
| --- | --- |
| VPC sin NAT, endpoints (S3, Secrets Manager, KMS, CloudWatch), NLB para agentes | Una instancia privada resuelve esos servicios sin salida a Internet |
| Nodo EC2 Graviton en ASG `min=max=1`, volumen EBS cifrado con KMS | Terminar la instancia: el ASG la reemplaza y el volumen se reacopla |
| Instalación del núcleo con el release de `wazuh/` (Manager, Indexer, Dashboard 4.14.8 / OSD 2.19.6) | Un agente de prueba se registra y sus alertas aparecen en Discover |
| Backups: snapshots EBS diarios (DLM) y snapshots del Indexer a S3 (ISM) con retención hot 7 d | `_plugins/_ism/explain` muestra la política y un snapshot manual responde OK |
| **Prueba de restauración**: reemplazo de nodo más restauración de snapshot | Se mide el RTO real y se registra en [06](06-operacion.md) |
| Marca QAPAQ, plugin `qapaq_ops` y reglas M365 aplicados (`wazuh/dashboard`, `wazuh/office365`) | Login y header con marca QAPAQ; las reglas M365 pasan logtest |

**Resultado:** SIEM Wazuh con marca QAPAQ, recuperable, accesible solo por red privada.

## Fase 2 · Plano QAPAQ serverless

La API existente (NestJS sobre Fastify, `apps/api`) se empaqueta en **Lambda mediante un
adaptador** (un punto de entrada nuevo en `apps/api`; el dominio en `modules/*` no cambia, lo valida
`pnpm boundaries`).

| Tarea | Acepta cuando |
| --- | --- |
| Adaptador Lambda para `apps/api` y API Gateway HTTP con autorizador JWT de Cognito | `/health/ready` responde por API Gateway; el arranque en frío medido queda registrado |
| Cognito federado con Entra (OIDC), MFA y revocación | Login y rol correctos para admin y analista; revocar saca la sesión en ≤ 5 s medido por la ruta `introspect` ([04](04-identidad-y-acceso.md)) |
| Aurora Serverless v2 (PostgreSQL) en subredes privadas; migraciones con el migrador existente (`platform/database`) | Migraciones aplicadas sin destruir datos; la cadena de auditoría verifica con `GET /api/audit/verify` |
| Conexión a Aurora desde Lambda con RDS Proxy o equivalente | Una ráfaga de invocaciones no agota las conexiones |
| Colas: SQS + DLQ en lugar de BullMQ; Scheduler en lugar de los loops del worker ([11](11-cache-y-colas.md)) | Notificaciones y sondeo de ingesta funcionan sin proceso persistente; un mensaje fallido llega a la DLQ |
| Ingesta cloud-native: EventBridge → SQS → Lambda normaliza a `SecurityEvent` | Un hallazgo de GuardDuty de prueba crea una alerta en QAPAQ |
| Push `custom-qapaq` + endpoint `POST /api/ingest/wazuh` (wake-up local existe; entrega durable para serverless pendiente) | En el perfil serverless propuesto, el evento autenticado queda en SQS antes de aceptar; medir p95 <=5 s desde la aceptacion durable hasta alerta QAPAQ y confirmar una sola alerta entre push y pull. El objetivo distinto del perfil EC2 actual esta en [25](25-programa-confiabilidad-e-investigacion.md) |
| CloudFront + WAF con `/` al Dashboard y `/api` a API Gateway | `curl` sin sesión da 302 al login; con sesión abre el dashboard con su rol |
| Auditoría: anclaje periódico del hash en S3 Object Lock (modo compliance) con réplica a `qapaq-log-archive` | Un manifiesto firmado se verifica; nadie en la cuenta de carga puede borrarlo |
| Lectura API → Indexer por ruta privada VPC sin KrakenD | La fuente «Wazuh Indexer · alertas» se pone en verde |
| Retirar KrakenD, Valkey y el worker BullMQ del diseño | Ningún componente persistente restante fuera del núcleo Wazuh |

**Resultado:** una URL, un login Entra, Wazuh con marca QAPAQ y casos QAPAQ sobre servicios gestionados.

## Fase 3 · Ankay en Step Functions

| Tarea | Acepta cuando |
| --- | --- |
| Fencing token en el outbox de acciones | Test: el dueño viejo no publica después de un takeover |
| Step-up para aprobar | Aprobar sin reautenticación reciente devuelve 401 `STEP_UP_REQUIRED` |
| Máquina Standard con `waitForTaskToken` y ejecución nombrada por el id de la solicitud | Pedir dos veces la misma acción crea una sola ejecución |
| `endpoint.block-ip` vía Wazuh Active Response | En un agente sandbox: pedido → aprobado por otra persona → IP bloqueada → timeline y auditoría |
| `m365.revoke-sessions` (Lambda → Graph) | Contra un usuario sintético del tenant sandbox |
| Express para enriquecimiento de alto volumen | `enrich.ip-reputation` corre sin aprobación y sin efectos externos |

Diseño en [13](13-ankay-qapaq.md) y [14](14-ankay-conexion-qapaq.md).

## Fase 4 · Endurecimiento y evidencia regulatoria

| Tarea | Acepta cuando |
| --- | --- |
| **P0 · MFA resistente a phishing** y retiro de `QAPAQ_DEMO_MFA_EXCEPTION_UNTIL` (Conditional Access / Authentication Strength; verificar `amr`) | Login, rol y revocación validados para admin y analista; la excepción no existe en ningún entorno |
| Detectores de Anomaly Detection más lectura de resultados en `modules/detection` | Una ráfaga sintética de descargas sube la prioridad con la razón visible |
| Cambios en vivo ([08](08-frontend-unificado.md)) | Una alerta nueva aparece en la consola en el plazo acordado |
| Prueba de recuperación completa y simulacro de falla del nodo Wazuh | RTO/RPO medidos dentro del objetivo de [06](06-operacion.md) |
| Evidencia para ISO 27001 y SBS: inventario de controles, retención, Object Lock y registros de acceso | Paquete de evidencia generado desde CI y revisado por el dueño |
| Evaluación de crecimiento: Indexer de tres nodos y Wazuh 5 (clúster nuevo; 4.x no se actualiza in-place) | Decisión registrada en [10](10-decisiones.md) |

**Producción queda bloqueada** hasta cerrar el P0 de MFA y la prueba de recuperación.

## Fuera del plan

Threat intelligence con MISP, antifraude, fuentes nuevas por adaptador TS e ITSM. Cada uno entra
solo con una decisión nueva en [10](10-decisiones.md).
