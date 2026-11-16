# 14 · Conexión de Ankay con QAPAQ SecOps

> Estado (2026-11-08): el motor **vigente** de Ankay es el basado en Shuffle (sección 8),
> desplegado en el nodo AWS PowerUser con SSO (§8.1). El diseño sobre **Step Functions** (secciones
> 1–7) es el objetivo, no desplegado. Contexto en [13](13-ankay-qapaq.md); arquitectura en
> [02](02-arquitectura.md).

Regla central: **la QAPAQ API gobierna y deja evidencia; Step Functions ejecuta.** Una acción solo sale de
la QAPAQ API después del catálogo y la aprobación; ni el navegador, ni Wazuh, ni otro servicio inician una
ejecución directamente.

## 1. Contexto: quién usa qué

```mermaid
flowchart TB
  A((Analista SOC)) -->|pide una acción sobre un caso| UI
  L((Líder SOC)) -->|aprueba con step-up; nunca su propia solicitud| UI
  E((Ingeniero de automatización)) -->|diseña y versiona playbooks en Git| SFN
  AU((Auditor)) -->|lee la auditoría encadenada| UI
  UI["Consola QAPAQ<br/>(Dashboard Wazuh + qapaq_ops)"] --> API[QAPAQ API · Lambda]
  API -->|StartExecution| SFN["Ankay<br/>(Step Functions)"]
  SFN -->|resultado| API
  SFN -->|acciones| T["Destinos aprobados<br/>Graph M365, firewall, threat intel"]
  SFN -->|Active Response| MGR[Wazuh Manager] --> W[Agentes Wazuh]
  COG[Cognito + Entra ID] -.->|identidad| UI
```

| Persona | Entra a | Puede |
| --- | --- | --- |
| Analista SOC | Consola QAPAQ (`qapaq_ops`) | Pedir acciones del catálogo y ver su estado |
| Líder SOC | Consola QAPAQ | Aprobar con step-up (nunca lo que pidió) |
| Ingeniero de automatización (rol nuevo `qapaq.automation.engineer`, **pendiente de aprobación del dueño**) | Repositorio y consola AWS con rol de solo despliegue vía CI | Diseñar máquinas de estados como código y publicarlas como versión candidata. Una versión entra al catálogo solo con la aprobación del Líder SOC |
| Auditor | Consola QAPAQ | Leer la auditoría de cada ejecución |

## 2. Despliegue y red

```mermaid
flowchart LR
  U((Navegador)) -->|HTTPS| CF[CloudFront + WAF]
  CF -->|/api| APIGW[API Gateway HTTP] --> API[Lambda · QAPAQ API]
  API -->|StartExecution<br/>name = executionKey| SFN[Step Functions]
  SFN -->|invoca| LA[Lambdas de acción]
  LA -->|443, VPC endpoints| EXT[Graph, threat intel]
  LA -->|API privada| MGR[Wazuh Manager<br/>subred privada]
  SFN -->|SendTask / SNS| SNS[SNS]
  API --- AUR[(Aurora Serverless v2)]
  SFN --- S3[(S3 Object Lock)]
```

| Flujo | Origen → destino | Control |
| --- | --- | --- |
| Solicitud y aprobación | Navegador → CloudFront → API Gateway → Lambda | Cognito (JWT), capacidad y scope en servidor, step-up para aprobar |
| Inicio de ejecución | Lambda QAPAQ API → Step Functions | Rol IAM de solo `states:StartExecution` sobre las máquinas del catálogo |
| Aprobación | Lambda QAPAQ API → `SendTaskSuccess` / `SendTaskFailure` | El token vive en Aurora, nunca en el navegador |
| Acciones externas | Lambdas de acción → proveedor | Egress solo por endpoints de VPC y destinos aprobados; credenciales por `secretRef` en Secrets Manager con permiso mínimo |
| Active Response | Lambda en VPC → API del Manager | Ruta privada, comando de la allowlist, rol propio; sin credenciales del Indexer |
| Monitoreo | Ejecuciones → CloudWatch | Alarmas por fallo o `UNKNOWN` |

No hay listener de callback ni HMAC propio: la integración API ↔ Step Functions se autentica con IAM y la
espera de aprobación usa `waitForTaskToken`.

## 3. Secuencia de una acción

```mermaid
sequenceDiagram
  autonumber
  participant AN as Analista (qapaq_ops)
  participant API as QAPAQ API
  participant DB as Aurora (auditoría)
  participant SF as Step Functions
  participant LS as Líder SOC
  participant X as Destino (p. ej. Graph)
  AN->>API: POST /api/incidents/:id/actions {actionId, params} + Idempotency-Key
  API->>API: capacidad, scope y validación de params contra el catálogo
  API->>DB: acción REQUESTED + AuditEvent (misma transacción)
  API->>SF: StartExecution(name = executionKey, playbook fijado)
  SF->>API: estado con waitForTaskToken (guarda el token, avisa por SNS)
  LS->>API: POST /api/actions/:id/approve (step-up; aprobador ≠ solicitante)
  API->>DB: APPROVED + AuditEvent
  API->>SF: SendTaskSuccess(token)
  SF->>X: acción (rol y credencial mínimos)
  SF->>SF: verificar efecto
  SF->>API: resultado (último estado)
  API->>DB: SUCCEEDED o FAILED + AuditEvent + timeline del caso
  API-->>AN: /api/changes actualiza la vista
```

## 4. Estados de una acción

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> APPROVED: aprobación (SoD + step-up)
  REQUESTED --> REJECTED: rechazo (SendTaskFailure)
  REQUESTED --> EXPIRED: TimeoutSeconds sin aprobación
  APPROVED --> RUNNING: la máquina de estados ejecuta
  RUNNING --> SUCCEEDED: ejecución SUCCEEDED
  RUNNING --> FAILED: ejecución FAILED o ABORTED
  RUNNING --> UNKNOWN: timeout o estado no concluyente
  UNKNOWN --> SUCCEEDED: reconciliación con DescribeExecution
  UNKNOWN --> FAILED: reconciliación con DescribeExecution
  UNKNOWN --> APPROVED: reconciliado como «nunca ejecutó» (reintento explícito)
  SUCCEEDED --> [*]
  FAILED --> [*]
  REJECTED --> [*]
  EXPIRED --> [*]
```

`UNKNOWN` nunca se reintenta a ciegas (ADR-028). Antes de repetir, la API consulta `DescribeExecution` y
`GetExecutionHistory` por `executionKey` (el nombre de la ejecución) y concilia.

## 5. Contrato

**Catálogo** (Aurora; versionado y auditado):

| Campo | Ejemplo | Para qué |
| --- | --- | --- |
| `actionId` | `m365.revoke-sessions` | Identificador estable |
| `playbookRef` | ARN de la máquina de estados y su versión fijada | Qué se ejecuta. Nunca lo elige el navegador |
| `paramsSchema` | `{ userRef: entityRef }` | Solo referencias opacas (D-10b): la Lambda de acción resuelve el dato con su propia credencial |
| `risk` | `low`, `medium` o `high` | Define la aprobación y el step-up |
| `capability` | `soar.execute.m365` | Quién puede pedirla |
| `approval` | `lead`, más step-up si es `high` | SoD (N5) |
| `timeouts` | aprobación (`TimeoutSeconds`), ejecución | Cuándo pasa a `EXPIRED` o `UNKNOWN` |

**Entrada de la ejecución** (`StartExecution`, `name = executionKey`):

```json
{ "executionKey": "7f3c…", "actionId": "m365.revoke-sessions", "version": "3",
  "params": { "userRef": "ent_9a1…" }, "incidentRef": "inc_51…", "requestedBy": "usr_…" }
```

- Nada de raw, PII, secretos ni cookies en la entrada: el historial de la ejecución queda archivado.
- Cada estado escribe su resultado a la auditoría; un estado repetido es idempotente por `executionKey`.
- Un HTTP 200 de una integración solo acredita recepción; el estado «Verificar efecto» comprueba el
  resultado real contra el proveedor.

## 6. Fronteras de seguridad

| Frontera | Garantía |
| --- | --- |
| Navegador ↔ API | Cognito, sesión revocable (≤ 5 s, N9/N10), capacidad y scope en servidor, step-up para aprobar |
| API ↔ Step Functions | IAM: la API solo inicia y reanuda las máquinas del catálogo; las máquinas no pueden invocar otras sin permiso explícito |
| Credenciales de acción | Las tiene el rol de cada Lambda de acción (p. ej. Graph con permiso mínimo), vía Secrets Manager. **La API nunca tiene escritura sobre Graph** ni las acciones credenciales del Indexer. Active Response va por el Manager con allowlist |
| Datos | La entrada lleva referencias. La evidencia y la auditoría viven en Aurora (cadena hash) y S3 Object Lock |
| Supply chain | Las máquinas de estados y Lambdas se construyen en CI con versiones y hashes fijados; ASL versionado en Git |

## 7. Resiliencia

| Falla | Comportamiento |
| --- | --- |
| Lambda de acción falla | `Retry` con backoff en pasos idempotentes; luego `Catch` a compensación o `UNKNOWN` |
| Timeout ambiguo | `UNKNOWN` y reconciliación con `DescribeExecution`; sin reintento ciego |
| Inicio fallido | El evento queda en SQS con reintentos y DLQ |
| Aprobador no responde | `TimeoutSeconds` lleva la solicitud a `EXPIRED` y avisa |
| Wazuh Manager no disponible | El paso de Active Response falla cerrado y queda registrado; no hay acción parcial silenciosa |

## 8. Motor vigente basado en Shuffle

**Desplegado** en el nodo AWS PowerUser (2026-11-04): `shuffle-backend`, `shuffle-orborus`,
`shuffle-opensearch`, el frontend rebrandeado `ankay-qapaq-frontend` y el puente `ankay-sso`
(`infra/aws-poweruser/host/compose.respond.yaml`), servidos en `/ankay/` solo con sesión QAPAQ y
embebidos en el SIEM (app «SOAR»). El despacho automático desde el núcleo QAPAQ descrito abajo **no**
está implementado: hoy los playbooks se ejecutan desde la consola de Respond con aprobación humana y
sus resultados no vuelven al incidente ([19 #11](19-brechas-y-roadmap.md)).

Diseño original del despacho (no implementado):

- Edge con `auth_request` sirviendo `/ankay/*` hacia el frontend rebrandeado de Shuffle, con
  SSO desde la sesión QAPAQ (§8.1).
- Despacho: núcleo QAPAQ → cola Valkey → webhook de Shuffle con HMAC (`X-Qapaq-Signature`), `executionKey` y
  una app de validación en Python; callback firmado hacia un listener privado `:8443` (contrato no
  implementado).
- Estados `REQUESTED → APPROVED → DISPATCHED → SUCCEEDED/FAILED/UNKNOWN`, con reconciliación por la API de
  Shuffle.
- Variante Azure: dos hosts privados (`siem_host` y `ankay_host`), Azure Firewall con DNAT y UDR;
  Terraform solo preparaba VM, red, disco y Compose. Estaba desactivada (`siem_host=null`,
  `ankay_host=null`).

Cobertura en el repo: `ankay/` (frontend), `infra/wazuh/shuffle/` (adaptador de alertas nivel 12+),
`infra/azure/modules/ankay_host/`, y los playbooks de triage en
`docs/security/ankay-playbooks/`. Todo se retira en la fase M5 de [13](13-ankay-qapaq.md).

### 8.1 SSO desde QAPAQ SecOps (decisión B11)

Decisión del dueño (2026-11-03, [10 · B11](10-decisiones.md)): una vez dentro del SOC se entra a QAPAQ
Respond sin segundo login y se puede volver al SIEM. Sustituye la regla anterior de que la autenticación
propia de Shuffle siguiera controlando el acceso dentro de `/ankay/`. La regla central (§1) sigue
valiendo para las acciones del catálogo de la QAPAQ API; Shuffle es el estado heredado hasta M5.

```mermaid
sequenceDiagram
  participant N as Navegador (sesión QAPAQ)
  participant E as Edge nginx
  participant A as QAPAQ API
  participant P as Puente respond-sso
  participant S as Shuffle backend
  N->>E: GET /ankay/login (o /ankay/sso)
  E-->>N: 302 /ankay/sso
  N->>E: GET /ankay/sso
  E->>A: auth_request /api/auth/introspect
  A-->>E: 204 + x-qapaq-user, x-qapaq-roles
  E->>P: /sso + x-qapaq-* (del introspect) + X-Qapaq-Edge-Token
  P->>S: getusers / register / updateuser (API key de servicio)
  P->>S: login con contraseña aleatoria que solo conoce el puente
  P-->>N: Set-Cookie session_token (HttpOnly, Secure, SameSite=Strict, Path=/ankay) + 302 next
```

| Tema | Regla |
| --- | --- |
| Confianza | El puente no publica puertos y exige `X-Qapaq-Edge-Token` (secreto en archivo, comparación en tiempo constante). El edge pisa `x-qapaq-user`/`x-qapaq-roles` con lo que devuelve el introspect; lo que mande el navegador no llega |
| Roles | `qapaq.platform.admin` → admin; `qapaq.soc.lead` / `qapaq.soc.analyst` → user; `qapaq.auditor` → org-reader (Shuffle le niega ejecutar, editar y programar); otro rol → 403 y se revoca su sesión de Shuffle. En el SIEM, la app «Ankay» sigue pidiendo `incidents.write` |
| Secretos | La API key es de la cuenta de servicio admin `ankay-sso@qapaq.internal` (creada por `bootstrap.mjs`); las contraseñas de las personas son aleatorias, viven en memoria del puente y se rotan con la API de admin. Al navegador solo llega la cookie de sesión de Shuffle. El admin inicial de Shuffle no se rota: si también es persona de QAPAQ, entra con su contraseña y solo con rol admin |
| Cookies | Todas las de sesión de Shuffle quedan en `Path=/ankay` con `HttpOnly; Secure; SameSite=Strict` (también las que emita el backend: `proxy_cookie_path`/`proxy_cookie_flags`). El frontend ya no copia el token a una cookie legible por JavaScript (`frontend/sso-overlay.mjs`) |
| Logout | Login y logout de QAPAQ borran las cookies de Shuffle; el logout además avisa al puente (mirror de nginx) para cerrar la sesión en Shuffle. El «Logout» propio de Shuffle se oculta |
| Navegación | Botón «Volver al SIEM» (`/app/qapaq-alerts`, `target=_top`) en todas las páginas de Ankay; funciona embebido y en pestaña aparte. Nada navega `top` sin un clic |
| Idioma y marca | `frontend/i18n/qapaq-i18n.js` traduce en el DOM los textos de interfaz por coincidencia exacta y cambia «Shuffle» visible por «Ankay», sin tocar la lógica ni los nombres de apps del backend |

Despliegue: `infra/local/compose.ankay.yaml` (local) y `infra/aws-poweruser/scripts/deploy-respond.sh`
(AWS) construyen el puente, corren `bootstrap.mjs` y montan el token en el edge.

Equivalencias en la migración:

| Heredado (Shuffle) | Propuesto (Step Functions) |
| --- | --- |
| Cola Valkey `ankay` con `jobId = executionKey` | `StartExecution` con `name = executionKey` |
| Webhook firmado con HMAC y app de validación | IAM entre la API y Step Functions |
| `DISPATCHED` y callback firmado | Estados de la ejecución y `SendTaskSuccess` |
| Reconciliación por la API de Shuffle | `DescribeExecution` y `GetExecutionHistory` |
| Frontend Shuffle bajo `/ankay/` | Panel en `qapaq_ops` y timeline en Ayni Qapaq |
| Orborus, workers y OpenSearch propio | Lambdas de acción |

## 9. Decisiones abiertas

1. **Rol `qapaq.automation.engineer`:** requiere aprobación del dueño y mapeo en Cognito/Entra.
2. **Aprobación en `qapaq_ops`:** definir si la bandeja del Líder SOC vive en el plugin o en Ayni Qapaq.
3. **Adaptador Active Response:** forma exacta de la API del Manager y la allowlist de comandos (M3).
4. **Cuenta de ejecución:** si las máquinas de estados corren en `qapaq-soc-workload` o en una cuenta de
   respuesta separada.
