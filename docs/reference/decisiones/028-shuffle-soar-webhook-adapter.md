# ADR-028 · Shuffle como motor SOAR no-code

- Estado: aceptada como decisión de producto; integración técnica pendiente.
- Alcance: orquestación de playbooks con Shuffle en la edición QAPAQ Wazuh.
- No modifica la fuente de verdad de incidentes, permisos ni auditoría.

## Decisión

Usar Shuffle como motor no-code de flujos mediante webhook. QAPAQ conserva los
controles y el estado de ejecución: capability por acción, alcance del recurso,
aprobación, versión del playbook autorizado, clave idempotente, correlación, resultado
ambiguo y auditoría. Wazuh conserva agentes, detección y Active Response.

El flujo inicia desde un evento/outbox persistido. Un worker QAPAQ realiza una llamada
saliente al webhook de un workflow Shuffle; el navegador nunca conoce la URL ni el
secreto. Shuffle no recibe credenciales del Indexer o Manager y no escribe directamente
en sus índices o APIs. Las acciones Wazuh pasan por un adapter QAPAQ con allowlist y
autorización vigentes. La respuesta de Shuffle vuelve con `executionId`, correlación y
estado; los timeouts se registran como resultado desconocido y no se reintentan a ciegas.

La primera versión no migra el editor de playbooks a QAPAQ ni implementa otro motor.
La UI Wazuh mostrará catálogo/versiones, estado y aprobaciones del lado QAPAQ cuando esas
rutas estén portadas. El editor visual se opera en Shuffle para usuarios autorizados.

## Contrato mínimo del adaptador

- `playbookId` pertenece al catálogo autorizado; `playbookVersion` queda fijada antes de
  ejecutar y no se acepta un ID arbitrario enviado por el browser.
- `executionKey` es estable para deduplicar una misma intención y se transmite como
  correlation/idempotency key cuando Shuffle lo permite.
- El payload contiene únicamente referencias opacas y campos mínimos; raw, secretos,
  cookies y tokens nunca se incluyen.
- Aprobación, actor, scope, razón y vencimiento quedan ligados a la misma versión y a los
  parámetros aprobados. Cambiar target invalida la aprobación.
- Los estados incluyen `queued`, `running`, `succeeded`, `failed`, `unknown` y
  `cancelled`; `unknown` requiere reconciliación antes de una repetición.
- Cada recepción/callback se valida con autenticación de servicio, firma o secreto
  administrado, timestamp, nonce/idempotencia y límites de tamaño; el webhook no se
  publica en el frontend.
- Respuestas destructivas requieren capability separada y aprobación explícita; Wazuh
  Active Response sigue siendo el ejecutor de acciones de endpoint aprobadas.

## Consecuencias y gates

Se reutiliza Shuffle para no construir un editor/ejecutor general. QAPAQ mantiene la
política de seguridad y el ledger de ejecución, por lo que perder Shuffle no elimina el
estado ni permite repetir una acción a ciegas. Antes de producción se requiere instancia
Shuffle soportada, identidad/red privada, secret provider, workflow de prueba, callback o
reconciliación, límites/rate controls y pruebas de duplicado, timeout, replay, revocación,
rollback y pérdida de una réplica. U-008 permanece abierto para completar el catálogo,
transiciones y aprobación de acciones concretas.
