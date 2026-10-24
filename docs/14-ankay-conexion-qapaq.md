# 14 · Arquitectura: conexión de Ankay Qapaq con QAPAQ SecOps

Propuesta para leer de una sola vez cómo se conecta el SOAR (Ankay Qapaq, [13](13-ankay-qapaq.md)) con el
SIEM QAPAQ. Regla central: **QAPAQ Core gobierna y deja evidencia; Shuffle/Ankay ejecuta.** El
analista llega a la interfaz solo por `/ankay/*` detrás del edge QAPAQ y de una sesión válida. La
ejecución automatizada solo puede salir de QAPAQ Core después del catálogo y la aprobación definidos;
Wazuh, el navegador y otros servicios no llaman al webhook de ejecución directamente.

## 1. Contexto: quién usa qué

```mermaid
flowchart TB
  A((Analista SOC)) -->|pide una acción sobre un incidente| SIEM
  L((Líder SOC)) -->|aprueba con step-up; nunca su propia solicitud| SIEM
  E((Ingeniero de automatización)) -->|diseña y versiona playbooks| ANKAY
  AU((Auditor)) -->|lee la auditoría encadenada| SIEM
  SIEM["SIEM QAPAQ<br/>(Wazuh modificado + núcleo QAPAQ)"] -->|ejecuciones aprobadas| ANKAY["Ankay Qapaq<br/>(Shuffle rebrandeado)"]
  ANKAY -->|resultado| SIEM
  ANKAY -->|acciones| T["Destinos aprobados<br/>Graph M365, firewall, threat intel OSS"]
  SIEM -->|Active Response por adaptador QAPAQ| W[Agentes Wazuh]
  ENTRA[Microsoft Entra ID] -.->|identidad| SIEM
  ENTRA -.->|SSO de la sesión interna| ANKAY
```

| Persona | Entra a | Puede |
| --- | --- | --- |
| Analista SOC | SIEM (`qapaq_ops`) | Pedir acciones del catálogo y ver su estado. La ruta Ankay exige sesión QAPAQ; el rol/capability que habilita el editor debe aplicarse en servidor antes de abrir acceso de diseño |
| Líder SOC | SIEM | Aprobar con step-up (nunca lo que pidió); accede al editor solo si su rol Ankay lo permite |
| Ingeniero de automatización (rol nuevo `qapaq.automation.engineer`, **pendiente de aprobación del dueño**) | Ankay | Diseñar workflows y publicarlos como versión candidata. Una versión entra al catálogo solo con la aprobación del Líder SOC |
| Auditor | SIEM | Leer la auditoría de cada ejecución |

## 2. Despliegue y red

```mermaid
flowchart LR
  U((Navegador)) -->|HTTPS 443| EDGE
  subgraph VPC["VPC 10.0.0.0/16"]
    subgraph SIEMHOST["Host SIEM QAPAQ (subred pública, EIP)"]
      EDGE["nginx edge<br/>host QAPAQ: /ankay/"]
      OSD[Dashboard + qapaq_ops]
      CORE["Núcleo QAPAQ<br/>API 127.0.0.1:3000 + worker"]
      CB["listener privado :8443<br/>solo /api/integrations/ankay/*"]
    end
    subgraph ANKHOST["Host Ankay Qapaq (subred privada, sin EIP)"]
      AFE[Frontend Ankay :443]
      ABE[Backend Shuffle :5001]
      AOR[Orborus + workers]
      AOS[(OpenSearch de Ankay)]
      AG[Agente Wazuh]
    end
    VK[(Valkey)]
    PG[(RDS)]
    NAT[NAT con egress allowlist]
  end
  EDGE -->|auth_request + rol| AFE
  CORE -->|webhook firmado :5001| ABE
  AOR -->|callback firmado| CB --> CORE
  CORE --- VK
  CORE --- PG
  AOR -->|443 solo a destinos aprobados| NAT
  AG -->|1514/1515| SIEMHOST
```

| Flujo | Origen → destino | Puerto | Control |
| --- | --- | --- | --- |
| UI de Ankay | Navegador → `https://<host-QAPAQ>/ankay/` → edge → frontend privado | 443 + red privada | El `auth_request` existente valida la sesión QAPAQ y redirige al login si falta. No hay prueba de autorización por rol en esa ubicación; la política de roles del editor sigue siendo un gate. Sin acceso público directo a Ankay |
| Disparo de ejecución | Núcleo (host SIEM) → backend de Ankay | 5001 | SG solo desde el SG del host SIEM, cabecera de autenticación del webhook y firma HMAC |
| Callback | Worker/Ankay → API privada de QAPAQ Core | HTTPS privado | Salida iniciada desde Ankay; firma HMAC y replay protection requeridas. La API/callback y su contrato no están implementados ni verificados todavía; no se abre un listener 8443 en el edge |
| Acciones externas | Workers → Internet | 443 | Egress por el NAT con allowlist de destinos (Graph, threat intel aprobada). Nada más sale |
| Monitoreo | Agente Wazuh en el host de Ankay → Manager | TCP 1514 tras enrolamiento controlado | El SIEM podrá vigilar logs, FIM e integridad del host cuando exista Manager Azure y el agente esté instalado. El módulo no lo instala ni prueba esta conexión |

### Variante Azure en preparación

Azure usa dos hosts privados separados. `siem_host` albergará Wazuh QAPAQ, Core y el edge; al
configurarlo, el root crea Azure Firewall Standard, DNAT y un Load Balancer interno. El Firewall
filtra HTTPS por los CIDR aprobados y el backend recibe tráfico SNATeado desde la IP privada del
Firewall. `ankay_host` está conectado opcionalmente al root y usa una subnet dedicada con UDR hacia
ese mismo Firewall. Su NSG permite el frontend solo desde el host SIEM y el webhook solo desde el
origen privado de QAPAQ Core; callback y acceso al agente tienen reglas salientes acotadas. No hay
IP pública ni SSH entrante en el host Ankay. OpenSearch y `shuffle-security` permanecen internos a
Compose; el disco administrado separado está protegido con `prevent_destroy`.

La implementación sigue incompleta. Terraform de Ankay solo provisiona VM/red/disco y escribe el
Compose: no instala Docker, no inicia servicios, no instala agente Wazuh y no configura backups. El
workflow actual construye y publica únicamente el frontend rebrandeado; faltan digests aprobados para
backend, Orborus, worker, `shuffle-security` y OpenSearch, y un Compose Azure fijado por SHA. El
bootstrap SIEM aún debe entregar un edge TLS con `auth_request` y la ruta `/ankay/*`; el plan actual
mantiene `siem_host=null` y `ankay_host=null`, así que no existe endpoint publicado ni host Ankay.

Cuando el runtime exista, el edge solo debe apuntar a la IP privada de Ankay después de verificar
sesión válida, rechazo anónimo, autorización por rol, revocación y callback autenticado. No modificar
login ni cookies para habilitarlo. El diagrama AWS/VPC anterior conserva la topología de referencia;
no describe la infraestructura Azure ya cableada en Terraform.

## 3. Secuencia de una acción

```mermaid
sequenceDiagram
  autonumber
  participant AN as Analista (qapaq_ops)
  participant CO as Núcleo QAPAQ
  participant LS as Líder SOC
  participant DB as RDS (auditoría)
  participant Q as Valkey (cola ankay)
  participant AK as Ankay Qapaq
  participant X as Destino (p. ej. Graph)
  AN->>CO: POST /api/incidents/:id/actions {actionId, params} + Idempotency-Key
  CO->>CO: capacidad, scope y validación de params contra el catálogo
  CO->>DB: acción REQUESTED + AuditEvent (misma transacción)
  LS->>CO: POST /api/actions/:id/approve (step-up; aprobador ≠ solicitante)
  CO->>DB: APPROVED + AuditEvent + outbox(executionKey)
  CO->>Q: job {actionId} con jobId = executionKey
  Q->>CO: worker toma el job
  CO->>AK: POST webhook del playbook (versión fijada) con firma HMAC
  AK-->>CO: 200 {execution_id}
  CO->>DB: DISPATCHED + execution_id
  AK->>X: acción (credencial de la app en Ankay)
  AK->>CO: callback firmado {executionKey, status, resumen} (contrato pendiente)
  CO->>DB: SUCCEEDED o FAILED + AuditEvent + timeline del incidente
  CO-->>AN: /api/changes despierta la vista (long-poll)
```

## 4. Estados de una acción

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> APPROVED: aprobación (SoD + step-up)
  REQUESTED --> REJECTED: rechazo
  REQUESTED --> EXPIRED: sin aprobación a tiempo
  APPROVED --> DISPATCHED: webhook aceptado
  APPROVED --> UNKNOWN: timeout del webhook
  DISPATCHED --> SUCCEEDED: callback ok
  DISPATCHED --> FAILED: callback con error
  DISPATCHED --> UNKNOWN: sin callback a tiempo
  UNKNOWN --> SUCCEEDED: reconciliación con la API de Ankay
  UNKNOWN --> FAILED: reconciliación con la API de Ankay
  UNKNOWN --> APPROVED: reconciliado como «nunca ejecutó» (reintento explícito)
  SUCCEEDED --> [*]
  FAILED --> [*]
  REJECTED --> [*]
  EXPIRED --> [*]
```

`UNKNOWN` nunca se reintenta a ciegas (ADR-028). Antes de repetir, el núcleo consulta en Ankay el
estado de la ejecución por `execution_id` y `executionKey`.

## 5. Contrato

**Catálogo** (en QAPAQ, Postgres; versionado y auditado):

| Campo | Ejemplo | Para qué |
| --- | --- | --- |
| `actionId` | `m365.revoke-sessions` | Identificador estable |
| `playbookRef` | ID del workflow de Ankay y su versión fijada | Qué se ejecuta. Nunca lo elige el navegador |
| `paramsSchema` | `{ userRef: entityRef }` | Solo referencias opacas (D-10b): Ankay resuelve el dato con su propia credencial |
| `risk` | `low`, `medium` o `high` | Define la aprobación y el step-up |
| `capability` | `soar.execute.m365` | Quién puede pedirla |
| `approval` | `lead`, más step-up si es `high` | SoD (N5) |
| `timeouts` | webhook 10 s, callback 10 min | Cuándo pasa a `UNKNOWN` |

**Webhook de QAPAQ hacia Ankay:**

```http
POST https://ankay.internal:5001/api/v1/hooks/webhook_<id>
X-Qapaq-Timestamp: 1791990000
X-Qapaq-Execution-Key: 7f3c…        (idempotencia)
X-Qapaq-Signature: sha256=<HMAC(clave, timestamp + "." + cuerpo)>
Authorization: <secreto del webhook en Shuffle>
{ "executionKey": "7f3c…", "actionId": "m365.revoke-sessions", "version": "3",
  "params": { "userRef": "ent_9a1…" }, "incidentRef": "inc_51…", "callback": "https://qapaq-api.internal/api/integrations/ankay/callback" }
```

- El primer paso de cada workflow es una app QAPAQ de validación (Python, versionada en `ankay/apps`, F2).
  Verifica la firma, el timestamp (≤ 5 min) y que `executionKey` no se haya visto antes. Shuffle no
  verifica HMAC de forma nativa.
- Nada de raw, PII, secretos ni cookies en el cuerpo.

**Callback de Ankay hacia QAPAQ:** `POST /api/integrations/ankay/callback`, con la misma firma, que
devuelve `{executionKey, executionId, status, summary}`. El núcleo valida firma, timestamp y estado
esperado y lo registra una sola vez. Un callback repetido responde 200 sin efecto.

**Reconciliación:** el núcleo consulta el estado de la ejecución en la API de Ankay con el
`execution_id`. A verificar en F2: la forma exacta de la respuesta del webhook y del endpoint de
resultados en Shuffle v2.3.0.

## 6. Fronteras de seguridad

| Frontera | Garantía |
| --- | --- |
| Navegador ↔ Ankay | Solo vía edge: sesión QAPAQ en cada request (≤ 5 s tras revocar, N9/N10), rol requerido y CSP de mismo origen (parche 0003) |
| SIEM ↔ Ankay | SG en ambos sentidos, HMAC con timestamp y nonce (`executionKey`), y la clave en Secrets Manager. **No se rota en el despliegue** (A20); su rotación es un procedimiento aparte |
| Credenciales de acción | Las tiene Ankay (p. ej. la app de Graph con permiso mínimo), en Secrets Manager. **QAPAQ nunca tiene escritura sobre Graph** ni Ankay credenciales del Indexer o del Manager. Active Response va por un adaptador QAPAQ con allowlist |
| Datos | Ankay guarda definiciones de workflow y ejecuciones con referencias. La evidencia y la auditoría viven en QAPAQ (RDS, cadena hash; S3 para evidencia) |
| Supply chain | El frontend tiene build verificable desde el commit fijado y publica su fuente AGPL. El runtime completo requiere digests inmutables verificados de los cinco servicios Compose (`shuffle-security`, frontend, backend, Orborus y OpenSearch) y la imagen dinámica `worker`, más Compose con SHA aprobado. El workflow actual solo construye el frontend |
| Monitoreo | Un agente Wazuh en el host es objetivo de operación; instalación y FIM no están preparados en el módulo Azure y dependen de un Manager alcanzable |

## 7. Resiliencia

| Falla | Comportamiento |
| --- | --- |
| Ankay caído o lento | Diseño objetivo: el job queda en la cola con backoff y el breaker se abre. La implementación QAPAQ/Ankay y esta recuperación todavía no están integradas en runtime Azure |
| Timeout ambiguo | `UNKNOWN` y luego reconciliación. Sin reintento ciego |
| Valkey caído | El núcleo despacha desde el outbox en proceso (degradado, docs/11) |
| Callback perdido | La reconciliación por `execution_id` lo recupera |
| Host del SIEM caído | No hay nuevas solicitudes. Lo que Ankay ya ejecuta termina y su callback se reintenta. La AMI histórica y los releases permiten volver atrás |

## 8. Cómo se ve en el SIEM (F4)

Dentro de `qapaq_ops`, en el incidente: un panel **Respuesta** con las acciones del catálogo permitidas
para la persona, su estado en vivo (por long-poll), quién pidió, quién aprobó, el `execution_id` y el
resumen. El Líder SOC tiene una bandeja de aprobaciones. Hay un deep link al editor de Ankay solo para
ingenieros de automatización.

## 9. Decisiones abiertas

1. **Rol `qapaq.automation.engineer`** para el editor de Ankay. Requiere aprobación del dueño y
   asignación en el sistema de identidad de Ankay; la ruta del edge solo exige la sesión QAPAQ.
2. **U-022:** dictamen de Legal sobre AGPL con el frontend modificado.
3. **App de validación HMAC** en Ankay (F2): Python, versionada en el repo.
4. **Listener privado :8443** del edge para los callbacks: se agrega en `wazuh/edge` en F2.
