# Baseline de acceso, credenciales y observabilidad SOC

Estado: **REQUIREMENT ACCEPTED / IMPLEMENTATION GATED**. Origen: requerimientos
solicitados por Franco Clavo el 2026-09-28. La aceptación fija el resultado y los
controles mínimos; no demuestra que Entra, la red, el gestor de secretos ni la
plataforma de observabilidad estén provisionados.

## Resumen de evaluación

| Requerimiento | Decisión de arquitectura | Sprint | Riesgo que evita |
| --- | --- | --- | --- |
| Multisesión bloqueada | una sola sesión humana activa por usuario; creación/reemplazo atómicos | 3, PBI-016/026 | secuestro y persistencia paralela |
| Superadmin | no se crea un rol universal; break-glass vive en Entra y los privilegios QAPAQ conservan SoD | 3, PBI-016 | bypass total no auditable |
| Intentos de ingreso | Smart Lockout de Entra más rate limit genérico en el borde QAPAQ | 3, PBI-026 | password spray, fuerza bruta y enumeración |
| Solo red QAPAQ | Conditional Access con ubicación nombrada y segundo control en ingress/BFF | 3, PBI-026 | acceso desde redes no administradas |
| Passkey | método FIDO2/passkey de Entra dentro de OIDC; QAPAQ no custodia claves privadas | 3, PBI-026 | phishing y credencial paralela |
| Observabilidad SOC interna | Grafana OSS + Loki + Prometheus, autogestionados, con OpenTelemetry Collector | 2/3, PBI-013/027 | operación ciega y dependencia SaaS |
| Manual de errores | catálogo versionado por código estable, explicación, acción y `correlationId` | 3, PBI-028 | mensajes opacos o exposición técnica |
| Alta simple de tecnologías | onboarding declarativo, KrakenD on-premises, port común y credencial write-only vía SecretProvider | 2/3, PBI-029/030/022 | secretos dispersos, egress no gobernado y adapters acoplados |

La solicitud de “superadmin” ya está cubierta funcionalmente por bundles separados
(`ACCESS_ADMIN`, `PLATFORM_ADMIN`, `SOC_MANAGER`) y cuentas break-glass de Entra.
No se añade `SUPERADMIN`: contradiría mínimo privilegio, separación de funciones y
la prohibición de bypass administrativo de ADR-017.

## 1. Sesión humana única

El límite cambia de tres a **una sesión activa por usuario**. La sesión es la misma
sesión opaca BFF de ADR-017; no se cuentan refreshes, pestañas ni conexiones del
mismo navegador como sesiones distintas.

- PostgreSQL mantiene un único slot activo por `user_id` mediante restricción o
  índice único aplicable a sesiones no revocadas.
- Crear sesión toma lock transaccional sobre el usuario/slot. La política inicial
  es `REJECT_NEW`: si existe una sesión activa, el nuevo login se rechaza con
  `AUTH_SESSION_ALREADY_ACTIVE`; no revela dispositivo, IP ni ubicación.
- `ACCESS_ADMIN` puede revocar; el usuario puede cerrar su sesión actual. Un futuro
  flujo `REPLACE_EXISTING` exige step-up y decisión explícita, no se presume.
- Expiración, logout, suspensión, cambio crítico de grants y break-glass liberan o
  revocan el slot atómicamente. Redis acelera consulta, pero PostgreSQL conserva la
  invariante para evitar carreras entre réplicas.
- Deben probarse dos callbacks simultáneos, caída entre inserción/revocación,
  sesión expirada, logout y revocación administrativa.

## 2. Intentos, red corporativa y passkeys

### Intentos y bloqueo temporal

Entra es dueño de password, passkey y bloqueo de cuenta. QAPAQ no replica un
contador de contraseñas que pueda bloquear a una víctima. Identity debe comprobar
Smart Lockout con umbral máximo 10 y duración mínima 60 segundos, o una política
más estricta aprobada. Los valores efectivos y la licencia se registran como
evidencia, no se hardcodean en la aplicación.

QAPAQ limita `/auth/start`, callback y endpoints anónimos por una combinación
privacy-preserving de IP normalizada, cookie de pre-sesión y operación. El límite
es distribuido, devuelve `429` y `Retry-After`, aplica jitter/backoff, expira y
produce métricas sin email/UPN como label. La respuesta es igual para usuario
existente, inexistente, bloqueado o no admitido. Los umbrales finales dependen de
benchmark y threat test; no se inventan en este documento.

### Solo red QAPAQ

Todo usuario humano, incluido cualquier administrador, debe cumplir ambos controles:

1. Conditional Access de Entra bloquea la enterprise app fuera de una named
   location con los CIDR públicos de salida de oficinas/VPN QAPAQ;
2. ingress/reverse proxy y BFF validan que la conexión procede de la allowlist
   corporativa antes de iniciar y al usar la sesión.

Los CIDR, propietarios, VPN y proceso de cambio son `TO_BE_PROVIDED`. Solo se confía
en `Forwarded`/`X-Forwarded-For` del proxy propio allowlisted; una petición directa o
cadena ambigua falla cerrada. IP es una señal de contexto, no identidad: se mantienen
Entra, MFA/passkey, dispositivo administrado cuando aplique y autorización local.
Las cuentas break-glass se excluyen de Conditional Access solo según el procedimiento
de Identity, pero QAPAQ exige activación, alerta, sesión única y revisión posterior.

### Passkey

La passkey es un método FIDO2/WebAuthn gestionado por Microsoft Entra. El usuario
elige passkey en la pantalla de Entra y vuelve a QAPAQ por OIDC Authorization Code
con PKCE. OAuth 2.0 autoriza; OIDC autentica. QAPAQ valida `acr`/`amr` o el contexto
equivalente aprobado para confirmar la fuerza requerida y nunca registra una
credencial WebAuthn propia, clave privada o fallback local.

La passkey es una forma rápida y resistente a phishing de completar el mismo login,
no una segunda cuenta ni un endpoint que omita tenant, red, admisión, sesión única,
RBAC o auditoría. Identity debe habilitar la política de métodos, bootstrap y
recuperación antes de que la prueba se considere PASS.

## 3. Credenciales de integraciones y alta de tecnologías

KrakenD CE on-premises es el API Gateway de tráfico de proveedores; **no sustituye
al gestor de secretos ni recibe directamente el alta humana**. El control plane
QAPAQ expone el alta write-only y distribuye referencias/configuración aprobada:

```text
Platform Admin + step-up + aprobación
  → API QAPAQ de configuración (write-only, TLS, límites, schema)
  → SecretProvider / gestor externo
  → secretRef + fingerprint/metadata en QAPAQ
  → identidad técnica materializa solo en runtime para adapter/KrakenD
```

- La operación de alta acepta el valor una sola vez y jamás existe `GET` del valor.
  La respuesta muestra únicamente `secretRef`, fingerprint no reversible, fecha,
  owner y estado. “Quemado” significa no revelable por UI/API/log/audit, no que el
  runtime deje de poder usarlo.
- El gateway, BFF, colas, PostgreSQL, OpenSearch, Loki y evidencia nunca conservan
  el plaintext. Buffers se limpian lo antes posible; errores y body logging se
  redactan. Un administrador configura/revoca/rota, pero no puede leer el secreto.
- Solo la identidad técnica del adapter tiene `resolve` sobre su namespace. Cada
  tecnología tiene secreto independiente, mínimo privilegio, expiración, rotación,
  revocación y auditoría por referencia.
- La rotación es create-new → provider spec → switch atómico → revoke-old. No hay
  fallback al secreto anterior tras revocarlo.
- Agregar tecnología sigue requiriendo inventario, contrato real, adapter, mapping,
  cursor/replay, límites, health y suite de conformidad. Centralizar claves reduce
  fricción y exposición, pero no vuelve plug-and-play una API semánticamente distinta.

KrakenD queda seleccionado por [ADR-026](../adr/026-on-premises-krakend-provider-api-gateway.md):
dos o más nodos stateless detrás de balanceador, rutas/upstreams allowlisted,
OAuth2 Client Credentials o API key inyectada en runtime, timeouts, rate limiting,
circuit breaker y telemetría hacia el stack interno. El adapter conserva cuota
exacta, cursor, replay, retries semánticos y admisión durable. La respuesta externa
se guarda como raw/manifiesto/checkpoint/outbox antes de publicar referencias en
Redis/BullMQ. El gestor productivo de secretos sigue abierto; no se implementa un
vault casero ni cifrado reversible en una tabla de negocio. Ver la
[arquitectura del gateway](provider-api-gateway.md).

## 4. Grafana OSS + Loki + Prometheus

Se selecciona este stack autogestionado para observabilidad operacional interna:

```text
QAPAQ API/workers ──OTLP──> OpenTelemetry Collector ──logs──> Loki
       │                              │
       └── /metrics o Collector ──────┴──metrics──> Prometheus

SOC/Platform ──Entra + red QAPAQ──> Grafana OSS ──query──> Loki/Prometheus
Prometheus/Alertmanager ──alertas──> canal operacional externo a QAPAQ
```

Grafana provisiona datasources y dashboards como código. Los dashboards mínimos
son: salud/SLI de plataforma, cobertura y lag de fuentes, admisión/cuarentena,
jobs/colas, autenticación/denegaciones agregadas, auditoría del writer/archive y
vista ejecutiva SOC. Cada panel indica fuente, ventana, última actualización y
estado `NO_DATA`/`STALE`/`DEGRADED`; “sin eventos” nunca representa una fuente caída.

Controles obligatorios:

- Grafana usa Entra single-tenant, grupos/roles allowlisted, sin login anónimo ni
  admin inicial permanente; secretos de datasource se provisionan por referencia.
- Loki no tiene autenticación incluida: queda detrás de proxy autenticado/mTLS y
  no se expone a Internet. Prometheus, exporters y `/metrics` viven en red privada,
  con TLS/autenticación donde cruce una frontera.
- Labels son allowlisted y de baja cardinalidad. `userId`, email, IP, requestId,
  traceId y eventId no son labels; pueden ser campos redactados de log cuando sean
  necesarios y autorizados.
- Logs excluyen raw, tokens, cookies, API keys, bodies y PII innecesaria. Se prueban
  redacción, tenant isolation, query authorization, retención, cuotas y DoS de query.
- Prometheus y Loki tienen almacenamiento persistente, backup/restore, límites y
  retención ratificados. Ser OSS elimina licencia de software, no coste operativo.
- Alertas por caída total salen por un canal independiente; Grafana no sustituye el
  Security Audit Trail append-only ni SecurityEvent/OpenSearch.

El trío solicitado cubre métricas y logs, no un backend de trazas. QAPAQ mantiene
W3C Trace Context y `traceId`/`spanId` en logs para correlación. Incorporar Tempo u
otro almacén de trazas requiere decisión de capacidad/retención; no bloquea el
baseline Grafana/Loki/Prometheus ni autoriza descartar la instrumentación OTLP.

La decisión para evitar tercerización, los límites de la afirmación “control total” y matriz de
artículos SBS están en el
[análisis de observabilidad autogestionada](../compliance/sbs-observability-rationale.md).
La Resolución SBS N.° 504-2021 no prescribe estos productos; sus artículos 22–25
regulan el supuesto de servicios de terceros que esta arquitectura busca evitar.
El stack interno es el medio elegido para conservar control total de logs e
información SOC; la operación real debe confirmarlo.

## 5. Catálogo de errores

El contrato normativo está en [catálogo de errores](../error-catalog.md). Toda
respuesta visible incluye código estable, mensaje seguro, `correlationId`, acción
sugerida y, cuando sea seguro, `retryAfter`; la UI ofrece explicación contextual y
enlace al catálogo. Detalle técnico, stack, proveedor y secreto permanecen en logs
redactados accesibles solo al operador autorizado.

## Gates y evidencia pendientes

No se declara estas capacidades operativas hasta cerrar:

- CIDR IPv4/IPv6, VPN/egress, proxy confiable, owner y prueba inside/outside;
- tenant/app, grupos, política passkey, Conditional Access, Smart Lockout y claims
  de fuerza autenticadora observados;
- carrera de sesión única y revocación distribuida;
- BOM/topología/rutas KrakenD, gestor de secretos, identidades técnicas y rotación;
- versiones fijadas, sizing, HA, TLS, retención, backup/restore y alertas externas
  de Grafana/Loki/Prometheus/Collector;
- catálogo de errores revisado por Product/SOC y pruebas de no enumeración;
- threat test, provider specs, E2E y runbooks ligados al mismo commit/ambiente.

## Referencias técnicas

- [Passkeys FIDO2 en Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-fido2-compatibility).
- [Conditional Access y ubicaciones de red](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-assignment-network).
- [Smart Lockout de Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity/authentication/howto-password-smart-lockout).
- [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/).
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/).
- [Ingesta OTLP de logs en Loki](https://grafana.com/docs/loki/latest/send-data/otel/).
- [Autenticación de Loki](https://grafana.com/docs/loki/latest/operations/authentication/).
- [Modelo de seguridad de Prometheus](https://prometheus.io/docs/operating/security/).
- [Autenticación Entra en Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/entraid/).
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
