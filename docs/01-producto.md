# 01 · Producto

> Estado: el código de `modules/`, `apps/` y `platform/` y el overlay `wazuh/` son **hechos**. El
> despliegue serverless en AWS es **propuesto** ([02](02-arquitectura.md)). El marco regulatorio es
> **a confirmar con QAPAQ** (Compliance/Legal): lo citado aquí es el punto de partida, no un dictamen.

## Qué es

**QAPAQ SOC** es una **plataforma SOC unificada sobre Wazuh** para una fintech: una sola URL, un solo
login Entra y un solo shell visual (el dashboard de Wazuh con marca QAPAQ), al que QAPAQ añade lo que
Wazuh no tiene. Se ejecuta **serverless en AWS**; solo el núcleo Wazuh tiene servidor.

Dos módulos llevan nombre propio: **Ayni Qapaq** (colaboración de casos y tareas) y **Ankay**
(respuesta gobernada sobre Step Functions, [13](13-ankay-qapaq.md)).

| Wazuh ya hace (no lo reconstruimos) | QAPAQ añade (el diferencial) |
| --- | --- |
| Agentes, recolección, decoders, reglas, alertas | **Ayni Qapaq**: alerta → incidente con dueño, estado, tareas, bitácora append-only y timeline |
| Indexer (OpenSearch) y búsqueda/visualización | **Correlación contextual** por entidad (usuario/IP) y cadena de compromiso M365, con prioridad P1–P4 explicada |
| Módulo Office 365, FIM, vulnerabilidades, SCA | **Admisión Entra** (vía Cognito): acceso por grupo SOC, passkey fuera de la red, revocación inmediata al salir del grupo |
| Active Response en agentes | **Ankay (SOAR gobernado)**: aprobación por segunda persona, sin autoaprobación, todo auditado |
| Retención básica por índice | **Retención hot 7 d + snapshots a S3**, archivo inmutable (Object Lock, Glacier) y restauración temporal acotada |
| — | **Auditoría con integridad**: cadena hash por tenant, verificable desde la UI |
| — | **Avisos con acuse humano**: Teams Workflows y push al dispositivo, con reintentos e idempotencia |
| Refresco por intervalo en Discover | **Cambios en vivo** de la cola y los casos sin recargar la página |

Regla de diseño: **no construir un segundo SIEM**. Si algo es detección o recolección, va a Wazuh
(reglas, decoders, integraciones). Si es trabajo humano coordinado, gobierno o evidencia, va a QAPAQ.

## Roles

Los roles vienen del token de Entra (app roles), que Cognito federa ([04](04-identidad-y-acceso.md)).
Son los mismos para la consola y el dashboard.

| Rol Entra | En la UI | Puede |
| --- | --- | --- |
| `qapaq.soc.analyst` | Analista SOC | Tomar y triar alertas, trabajar incidentes, pedir acciones de respuesta |
| `qapaq.soc.lead` | Líder SOC | Lo anterior, más asignar, cerrar incidentes y **aprobar** acciones de respuesta |
| `qapaq.auditor` | Auditor | Leer casos, auditoría e integridad. Sin escritura |
| `qapaq.platform.admin` | Administrador de plataforma | Sesiones, padrón SOC, configuración. No aprueba respuesta |

Hay 25 capacidades finas. La fuente de verdad es `modules/access/src/capabilities.ts`.

Las capacidades se piensan para los perfiles operativos SOC L1, SOC L2, SOC Manager, Detection
Engineer, Access Admin, Auditor y Viewer, que hoy se agrupan en los 4 roles de arriba.

## Decisiones de negocio que se conservan

Estas decisiones no son técnicas. Sobreviven a cualquier cambio de stack y las ratifican
Compliance/Legal, no Desarrollo.

| # | Decisión | Por qué | Consecuencia técnica |
| --- | --- | --- | --- |
| N1 | **Operación autogestionada, sin tercerizar el procesamiento SOC** | Res. SBS 504-2021 (mod. 1515-2021), arts. 22–25 (a confirmar con QAPAQ). Contratar un SaaS de logs u observabilidad lo convierte en servicio de terceros significativo, con trámite y controles ante la SBS | Todo corre en las cuentas AWS de QAPAQ con componentes OSS operados por QAPAQ. Ningún log, backup ni telemetría va a un SaaS (Grafana Cloud, Datadog, Elastic Cloud, etc.). AWS se trata como el proveedor de nube ya evaluado por QAPAQ; cualquier proveedor adicional reabre el análisis legal |
| N2 | **Protección de datos personales** | Ley 29733 y D.S. 016-2024-JUS (a confirmar con QAPAQ): IP, UPN y trazas son datos personales | Minimización por frontera: Teams y las notificaciones nunca llevan raw ni PII innecesaria. Datos sintéticos en CI y demo. Residencia de datos y transferencia transfronteriza (región AWS) por decidir con Legal |
| N3 | **Wazuh es la autoridad de detección; QAPAQ es la autoridad de trabajo y evidencia** | Evitar construir y mantener un segundo SIEM | Reglas y recolección en Wazuh; casos, aprobaciones y auditoría en QAPAQ |
| N4 | **Primera vertical: Microsoft 365 → Wazuh → QAPAQ → Teams** | Es la fuente con mayor riesgo y ya conectada | Las fuentes nuevas (Cato, Sophos, AWS, Intune) entran como módulos de Wazuh, no como adaptadores QAPAQ |
| N5 | **Separación de funciones** | Control interno y auditoría | Quien pide una acción de respuesta o un privilegio no la aprueba. No existe un rol `ADMIN` universal |
| N6 | **Teams no es fuente de verdad** | Teams solo avisa | `SENT` significa que Teams aceptó el mensaje. El acuse humano se registra en QAPAQ |
| N7 | **Sin purga automática hasta ratificar la retención** | Retención, legal hold y residencia los decide Legal | La matriz de [05](05-datos-y-retencion.md) es provisional. Los snapshots a S3 se hacen ya; el borrado definitivo espera la firma |
| N8 | **Sin cifras inventadas** | Credibilidad ante auditoría | No se publican EPS, SLO, RPO/RTO ni KPIs de negocio sin una medición (KPIs pendientes: cobertura, aging de alertas, tiempo de investigación, adopción) |
| N12 | **PCI-DSS, solo si QAPAQ procesa datos de tarjeta** | El SOC puede ingerir logs con PAN o trazas de entornos de tarjeta (a confirmar con QAPAQ) | Si aplica: enmascarar PAN antes de indexar, retención de logs de 12 meses (3 en línea) y segmentación de la cuenta de carga. Si no aplica, se documenta la exclusión |

## Fuera de alcance

Construir un SIEM, un motor de reglas o agentes propios. Usar Kafka, Kubernetes, contenedores
para la API o microservicios (la API es una Lambda, [02](02-arquitectura.md)).
Ejecutar Python en el runtime: el ML lo pone OpenSearch, ver [07](07-deteccion-ml-y-soar.md).
Escribir en Graph salvo mediante el executor SOAR aprobado.
