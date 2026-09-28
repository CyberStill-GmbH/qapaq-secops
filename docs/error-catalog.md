# Catálogo de errores de QAPAQ

Estado: **BASELINE DE CONTRATO** · Owner: Product + SOC + Development + Security.

Este catálogo convierte un fallo en información segura y accionable. El código es
estable y apto para soporte; el mensaje puede mejorar sin cambiar semántica. Ningún
mensaje confirma que una cuenta/recurso existe ni muestra stack, query, endpoint
interno, token, cookie, secreto, IP completa o payload proveedor.

## Respuesta API y presentación

```json
{
  "error": {
    "code": "AUTH_SESSION_ALREADY_ACTIVE",
    "message": "Ya existe una sesión activa.",
    "correlationId": "01K...",
    "retryable": false,
    "helpRef": "ERR-AUTH-004"
  }
}
```

La UI muestra mensaje, acción recomendada, `correlationId` copiable y enlace a
`helpRef`. `details` solo contiene campos allowlisted no sensibles. Un error 5xx
nunca reutiliza el texto crudo de una excepción. `correlationId` correlaciona logs,
pero no autoriza ni funciona como ID de recurso.

## Catálogo inicial

| Help ref / code | HTTP | Qué significa para el usuario | Qué hacer | Reintento |
| --- | ---: | --- | --- | --- |
| ERR-AUTH-001 / `AUTH_REQUIRED` | 401 | La sesión no existe o dejó de ser válida. | Iniciar sesión nuevamente desde la red QAPAQ. | después de autenticar |
| ERR-AUTH-002 / `AUTH_SIGN_IN_FAILED` | 401 | No se pudo completar el ingreso. | Reintentar; si persiste, entregar el correlationId a soporte. | sí, acotado |
| ERR-AUTH-003 / `AUTH_NETWORK_NOT_ALLOWED` | 403 | La conexión no proviene de una red QAPAQ autorizada. | Conectar a oficina/VPN aprobada. | al cambiar de red |
| ERR-AUTH-004 / `AUTH_SESSION_ALREADY_ACTIVE` | 409 | Ya existe una sesión activa para el usuario. | Cerrar la sesión anterior o pedir revocación a Access Admin. | no |
| ERR-AUTH-005 / `AUTH_METHOD_NOT_ALLOWED` | 403 | El método de autenticación no cumple la política. | Ingresar con passkey/FIDO2 o método indicado por Identity. | sí |
| ERR-AUTH-006 / `AUTH_TEMPORARILY_THROTTLED` | 429 | Hay demasiados intentos en un periodo corto. | Esperar el tiempo indicado. | `Retry-After` |
| ERR-AUTHZ-001 / `ACCESS_DENIED` | 403/404 | La operación no está permitida en el ámbito actual. | Verificar asignación con el responsable. | no |
| ERR-INPUT-001 / `REQUEST_INVALID` | 400 | Uno o más datos no cumplen el formato permitido. | Corregir solo los campos marcados por la UI. | tras corregir |
| ERR-STATE-001 / `RESOURCE_STATE_CONFLICT` | 409 | El recurso cambió o no admite esa transición. | Recargar y revisar su estado. | tras recargar |
| ERR-RATE-001 / `RATE_LIMITED` | 429 | La operación excedió el límite temporal. | Esperar o reducir frecuencia/rango. | `Retry-After` |
| ERR-DEPENDENCY-001 / `DEPENDENCY_UNAVAILABLE` | 503 | Una dependencia necesaria no responde de forma segura. | Revisar estado; preservar correlationId. | con backoff |
| ERR-INGEST-001 / `SOURCE_DEGRADED` | 503 | La fuente está degradada; “sin eventos” no confirma cobertura. | Consultar cobertura/gap y runbook. | operador |
| ERR-SECRET-001 / `INTEGRATION_CREDENTIAL_REJECTED` | 422 | La credencial no pudo validarse o usarse. | Rotar por el flujo write-only; nunca pegarla en ticket. | después de rotar |
| ERR-SECRET-002 / `INTEGRATION_CREDENTIAL_UNAVAILABLE` | 503 | El gestor no entregó la credencial al adapter. | Revisar SecretProvider por referencia, sin revelar valor. | con backoff |
| ERR-AUDIT-001 / `AUDIT_WRITE_REQUIRED` | 503 | La operación se bloqueó porque no pudo auditarse. | Escalar con correlationId. | operador |
| ERR-INTERNAL-001 / `UNEXPECTED_ERROR` | 500 | Ocurrió un error no previsto y no se confirmó la operación. | No asumir éxito; consultar estado y soporte. | según estado |

## Reglas de mantenimiento

- Un código nuevo exige owner, escenario, HTTP, mensaje seguro, acción, retry,
  telemetría, runbook y pruebas de redacción/no enumeración.
- No reutilizar un código con otra causa. Deprecar con compatibilidad y changelog.
- La API conserva `code`; UI localiza texto por catálogo y siempre tiene fallback.
- Soporte busca por `correlationId` en Loki, con acceso autorizado y rango acotado.
- Errores de proveedor se normalizan en la frontera; sus bodies nunca llegan a UI.
- La documentación de usuario no incluye topología, CIDR, thresholds defensivos,
  nombres de cuenta, fingerprints completos ni detalles explotables.
