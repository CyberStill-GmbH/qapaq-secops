# ADR-022 — Notificación de alertas críticas mediante Microsoft Teams

- Estado: **ACCEPTED**
- Fecha: 2026-09-18
- Decisores: Jefatura de Riesgos No Financieros / QAPAQ
- Alcance: MVP y operación posterior

## Contexto

El negocio confirmó que Microsoft Teams es el canal corporativo primario para
avisar alertas `CRITICAL`. QAPAQ debe conservar la alerta, su ciclo de vida, el
acuse y la evidencia; una tarjeta de Teams no puede convertirse en fuente de
verdad ni en mecanismo de autorización.

La entrega externa puede fallar, responder tarde o aceptar una solicitud sin que
una persona vea el mensaje. Acoplarla a la transacción que crea la alerta
arriesgaría pérdida de detecciones, duplicación de alertas o falsos acuses.

## Decisión

1. Usar Microsoft Teams Workflows mediante la plantilla vigente de webhook para
   publicar en un canal SOC dedicado. No usar Office 365/Microsoft 365 Connectors
   heredados.
2. Persistir primero la alerta y, en la misma transacción, una salida
   `NotificationRequested`. Un worker entrega después de confirmar el commit.
3. Mantener la capacidad en `SOAR, Playbooks & Ticketing`; `Alerts, Incidents &
   Cases` publica la intención mediante contrato público. No se crea un noveno
   módulo ni se llama al webhook desde Detection.
4. Aplicar entrega *at least once*, outbox transaccional, clave idempotente
   `alertId + channel + notificationVersion`, cinco intentos y backoff exponencial
   con jitter entre 5 segundos y 5 minutos.
5. Interpretar `SENT` únicamente como aceptación por el endpoint de Teams. La
   lectura, visualización y acción humana no quedan demostradas por esa respuesta.
6. El acuse se registra solo dentro de QAPAQ, con sesión y autorización vigentes.
   La tarjeta inicial contiene un enlace profundo autenticado, nunca un botón que
   confirme directamente el acuse.
7. Tratar la URL del workflow como secreto y resolverla por
   `secret://qapaq/notifications/teams-critical`. No exponerla en código,
   configuración versionada, frontend, inventario de fuentes, logs, traces,
   auditoría ni errores.
8. Exigir canal secundario independiente. La continuidad no se declara satisfecha
   hasta configurarlo y probarlo.
9. Objetivo inicial: p95 desde persistencia de alerta hasta aceptación de Teams
   menor o igual a 60 segundos. Objetivo inicial de acuse: 15 minutos, sujeto a
   confirmación operacional antes de producción.

## Responsabilidades

Infraestructura/Microsoft 365 administra Team, canal, workflow, licencias,
propietarios principal y alterno, membresía, retención, disponibilidad y ciclo de
vida del secreto. QAPAQ construye el payload minimizado, encola, reintenta, evita
efectos duplicados, registra intentos, mide latencia y expone el estado de entrega.

## Consecuencias

- Una caída de Teams no bloquea ingesta ni persistencia de alertas. La salida queda
  pendiente y se reintenta.
- Puede repetirse una tarjeta tras un timeout ambiguo; nunca se duplica por ello
  la alerta o el incidente. `alertId` y `notificationId` permiten reconocerla.
- Teams indisponible con alertas críticas pendientes es `SEV1`; sin pendientes
  críticos empieza como `SEV2`.
- El dashboard muestra `TEAMS_DEGRADED` y la escalación usa el canal secundario
  aprobado.
- El diseño queda aceptado. La activación productiva continúa bloqueada hasta
  cerrar los datos operacionales y superar los veinte escenarios de aceptación.

## Alternativas consideradas

- **Connector heredado de Office 365/Microsoft 365:** descartado por retiro del
  mecanismo y ausencia de una base sostenible para el MVP.
- **Llamada síncrona desde Detection:** descartada porque acopla la persistencia a
  una dependencia externa y confunde detección con entrega.
- **Acuse desde la tarjeta:** descartado porque desplaza autenticación,
  autorización y estado fuera de QAPAQ.
- **Solo inbox interna:** insuficiente frente al requerimiento confirmado de canal
  corporativo primario, aunque la inbox se conserva como fuente de verdad.

## Trade-offs

El outbox y el worker añaden estados, reconciliación y operación de cola, pero
protegen la creación de alertas frente a fallos de Teams. La entrega *at least
once* admite tarjetas repetidas en timeouts ambiguos a cambio de no perder avisos.
Un workflow administrado por Microsoft 365 reduce integración propia, pero exige
propietarios alternos, gestión del secreto, licenciamiento y fallback comprobado.

## Datos operacionales pendientes

- Nombre final del Team y del canal.
- Membresía y propietarios principal y alterno.
- Ratificación del máximo de 15 minutos para acuse.
- Canal secundario y su política de escalamiento.

Estos datos configuran la operación y no reabren la decisión arquitectónica.

## Gate de aceptación

Los veinte escenarios obligatorios están definidos en
[Notificaciones de alertas críticas](../architecture/critical-alert-notifications.md#pruebas-de-aceptación).

## Referencias

- [Requerimientos](../requirements.md)
- [U-006 y U-009](../decisions/unresolved.md)
- [Modelo C4](../architecture/c4-model.md)
- [Operación y continuidad](../architecture/operations-and-continuity.md)
- [Microsoft: enviar mensajes mediante webhooks de Workflows](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks)
- [Microsoft: retiro de Office 365 Connectors en Teams](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/)
