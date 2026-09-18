# Notificaciones de alertas críticas

Estado: arquitectura **ACCEPTED** por [ADR-022](../adr/022-microsoft-teams-critical-alert-notifications.md).
Implementación e integración productiva: **BLOCKED** hasta completar el gate.

## Contrato funcional

Microsoft Teams es el canal corporativo primario para notificaciones `CRITICAL`.
QAPAQ sigue siendo el sistema de registro, triaje, acuse, escalamiento y ciclo de
vida. El mensaje de Teams es una proyección minimizada y no una copia de evidencia.

Flujo canónico:

```text
Detection & Correlation
  → persist Alert + NotificationRequested en una transacción
  → notification outbox
  → Notification Worker
  → Microsoft Teams Workflow
  → canal SOC dedicado
```

La transacción no espera a Teams. Detection no conoce el webhook. `soc` crea o
deduplica la alerta y publica la intención; la capacidad de notificaciones de
`soar` elige canal, política y versión, y el worker entrega mediante un port.

## Canal y workflow

Infraestructura/Microsoft 365 crea el workflow con la plantilla vigente para
recibir un webhook y publicar en un canal. Nombres conceptuales:

- producción: `SOC - Alertas Críticas`;
- pruebas: `SOC - Pruebas de Alertas`.

QAPAQ confirma los nombres finales. El canal productivo será restringido, sin
invitados por defecto, limitado a SOC y escalamiento, con propietarios alternos,
retención corporativa y sin uso de chat general. Pruebas usan un canal separado.

La URL del workflow es un secreto. Solo el adapter la obtiene mediante
`secret://qapaq/notifications/teams-critical`; se rota y revoca sin cambiar código.
No se registra ni retorna en interfaces, inventarios, logs, traces, auditoría o
mensajes de error.

## Payload minimizado

Campos permitidos cuando existan y estén autorizados:

- severidad, título, `alertId`, `incidentId`, `notificationId` y estado;
- hora de detección, sistemas fuente y alias del activo;
- identidad minimizada, resumen y contexto MITRE ATT&CK;
- analista o cola responsable, acción recomendada y referencia al runbook;
- enlace profundo autenticado hacia QAPAQ.

Se excluyen raw, tokens, API keys, cookies, passwords, archivos, evidencia,
información financiera completa, PII innecesaria, parámetros SOAR sensibles,
URLs de evidencia y cualquier dato que permita evadir RBAC. El enlace profundo
abre QAPAQ y exige autenticación/autorización; el acuse ocurre allí.

## Entrega, estados y deduplicación

Estados canónicos:

```text
PENDING → SENDING → SENT
                 ↘ FAILED_RETRYABLE → PENDING
                 ↘ FAILED_TERMINAL
SENT → ACKNOWLEDGED | SUPERSEDED
```

`SENT` significa que el endpoint aceptó la solicitud; no prueba visualización,
lectura, acción o acuse. El envío es *at least once*. La clave es:

```text
notificationId = alertId + channel + notificationVersion
```

Máximo cinco intentos; primer reintento a 5 segundos; retraso máximo 5 minutos;
backoff exponencial con jitter. Un timeout ambiguo puede repetir la tarjeta, pero
no crea otra alerta ni incidente. La tarjeta incluye `alertId` y `notificationId`.

Una alerta crítica nueva se notifica inmediatamente. Eventos correlacionados
duplicados actualizan contador y no generan un mensaje por evento. Se renotifica
ante cambio material de severidad, identidad o activo; compromiso confirmado;
fallo de contención; acción SOAR crítica; cambio de incidente; o vencimiento de
acuse. La resolución solo se notifica si una política aprobada lo exige.

## Acuse y escalamiento

El temporizador comienza al persistir la alerta. Objetivo inicial de acuse: 15
minutos. Si vence: crear recordatorio, escalar al SOC Manager, activar el canal
secundario aprobado y auditar cada decisión. Ese máximo debe ratificarse con SOC e
Infraestructura antes de producción.

Objetivo de entrega: p95 desde la persistencia de la alerta hasta la aceptación
de Teams menor o igual a 60 segundos.

## Degradación y continuidad

Si Teams falla, la alerta permanece disponible, la salida sigue durable, continúan
los reintentos y el dashboard muestra `TEAMS_DEGRADED`. Con alertas críticas
pendientes se abre incidente operacional `SEV1` y se usa el canal secundario. Sin
pendientes críticos comienza como `SEV2`. Nunca se descarta una salida pendiente.

Teams no es por sí solo una estrategia de continuidad. No se puede afirmar
continuidad hasta configurar y probar un canal secundario independiente.

## Auditoría

Eventos requeridos:

```text
TEAMS_NOTIFICATION_REQUESTED
TEAMS_NOTIFICATION_SENT
TEAMS_NOTIFICATION_FAILED
TEAMS_NOTIFICATION_RETRIED
CRITICAL_ALERT_ACKNOWLEDGED
CRITICAL_ALERT_ESCALATED
CRITICAL_ALERT_NOTIFICATION_SUPPRESSED
```

Campos: `alertId`, `incidentId`, `notificationId`, `channelAlias`, `attempt`,
`result`, `errorCode`, `timestamp` y actor cuando aplique. Nunca incluir la URL.

## Métricas

```text
teams_notifications_requested_total
teams_notifications_sent_total
teams_notifications_failed_total
teams_notification_duration_seconds
teams_notification_queue_depth
teams_notification_oldest_age_seconds
critical_alert_acknowledgment_seconds
critical_alert_unacknowledged_total
```

IDs de alerta, incidente o notificación no son labels.

## Estructura objetivo del MVP

```text
apps/worker/notifications/
  application/
    request-notification.use-case
    deliver-notification.use-case
    escalate-unacknowledged.use-case
  domain/
    notification
    notification-policy
    notification-attempt
  infrastructure/
    microsoft-teams-workflow.adapter
```

La ruta es una guía para la implementación, no evidencia de archivos existentes.
El adapter implementa un port; no se permite `fetch(webhookUrl)` dentro de
`DetectionService`.

## Pruebas de aceptación

Antes de producción se demuestra:

1. Una alerta `CRITICAL` confirmada persiste antes de solicitar la notificación.
2. Un rollback de la alerta no deja una salida huérfana.
3. Una caída después del commit conserva la salida para reanudación.
4. Teams indisponible no bloquea ingesta ni creación de alertas.
5. Un fallo transitorio reintenta con backoff y jitter.
6. Un fallo terminal queda visible y auditable.
7. Un timeout ambiguo no duplica alerta ni incidente.
8. Reprocesar la misma salida conserva el mismo `notificationId`.
9. Cinco intentos agotan la política y escalan el fallo.
10. `SENT` no se presenta como leído o acusado.
11. El acuse exige sesión y capability vigentes en QAPAQ.
12. Un usuario sin scope no puede abrir la alerta desde el enlace profundo.
13. El payload no contiene raw, secretos, evidencia ni PII no permitida.
14. Logs, traces, auditoría y errores nunca contienen la URL del workflow.
15. Duplicados correlacionados se suprimen conforme a la política.
16. Un cambio material autorizado produce una nueva versión de notificación.
17. El vencimiento de acuse genera recordatorio y escalamiento auditados.
18. Con una alerta crítica pendiente y Teams caído se declara `SEV1` y se activa el canal secundario.
19. La rotación o revocación del secreto no requiere reconstruir la aplicación.
20. El p95 persistencia→aceptación se mide y cumple el objetivo de 60 segundos bajo carga aprobada.

## Gate productivo

Registrar Team/canal final, membresía, propietarios principal y alterno, retención,
licencias, workflow, `secretRef`, rotación, máximo de acuse y canal secundario.
Ejecutar los veinte escenarios en entorno autorizado. Hasta entonces la capacidad
puede desarrollarse con fakes y contract tests, pero no se declara operativa.

[Flujo](../diagrams/13-critical-alert-notification.mmd) ·
[Operación](operations-and-continuity.md) · [Seguridad](security.md)
