# 24 · Operación gobernada de Qapaqzito

Este documento cierra el contrato pendiente para la bandeja de sugerencias, configuración operativa,
presupuesto compartido y documentos versionados. **Especifica el trabajo que falta; no afirma que
estos endpoints, tablas o pantallas estén implementados o desplegados.** La integración conserva B10,
B12 y la aprobación humana separada en Ankay.

## Invariantes

1. `SocAlert.priority` y la severidad de Wazuh son la clasificación operativa original. Qapaqzito escribe
   una recomendación paralela; nunca altera, oculta ni rebaja la clasificación original.
2. Una sugerencia es una afirmación no confiable. Se conserva el modelo, versión de prompt y reglas,
   fecha, IDs de evidencia, prioridad original observada y salida estructurada. No se guarda texto de
   log que no sea necesario para revisar.
3. Solo una persona autorizada puede aceptar, descartar, corregir o reasignar. Toda decisión conserva
   actor, hora, motivo y revisión anterior; no hay autoaprobación del modelo ni del creador.
4. Toda invocación reserva presupuesto en el almacén compartido antes de contactar el proveedor. Si
   no se puede reservar o el límite está alcanzado, no se llama al modelo. Al fallar el proveedor, la
   reserva se libera o liquida según el uso conocido; nunca se reintenta sin idempotencia.
5. Los cambios operativos son revisiones auditables con `expectedRevision`. La UI nunca recibe
   credenciales, valores de secretos ni una ruta para cambiar secretos del proveedor.
6. Un informe tiene identidad, revisiones inmutables, referencias a evidencia y estado de borrador.
   La nota de incidente existente es otro recurso; publicar, exportar o usar como acción requiere una
   capacidad y auditoría propias.
7. Ninguna de estas funciones crea una solicitud Respond ni ejecuta acciones Wazuh. Se conserva el
   circuito de Ankay y su aprobador distinto.

## Bandeja persistente de sugerencias

### Registro y estado

Tabla propuesta `assistant_priority_suggestions` (PostgreSQL, tenant-scoped):

| Campo | Regla |
| --- | --- |
| `id`, `tenant_id`, `alert_id` | UUID; FK restrictiva a alerta; unicidad `(tenant_id, alert_id, suggestion_generation)` |
| `generation_key` | Idempotencia determinista por alerta, versión de política y ventana de análisis |
| `original_priority`, `original_score`, `alert_revision` | Snapshot de la clasificación que vio el modelo; nunca se sobrescribe |
| `suggested_priority`, `confidence`, `reason_codes` | Enum cerrado, confianza 0..1, razones enumeradas; sin DSL o contenido ejecutable |
| `evidence_refs` | JSON validado, solo IDs/timestamps/campos permitidos devueltos por herramientas QAPAQ |
| `model_id`, `provider`, `prompt_version`, `policy_version` | Proveniencia del resultado |
| `status`, `assignee_id`, `review_revision` | `pending`, `assigned`, `accepted`, `corrected`, `dismissed`, `superseded` |
| `created_at`, `updated_at`, `reviewed_at`, `reviewed_by`, `review_reason` | Tiempos del servidor y actor autenticado |

Las transiciones permitidas son `pending → assigned|accepted|corrected|dismissed|superseded`,
`assigned → accepted|corrected|dismissed|pending`, y terminales `accepted|corrected|dismissed`.
Una nueva sugerencia no modifica una revisada: la anterior pasa a `superseded` y se crea otra fila.
Aceptar solo registra el juicio humano en la recomendación. Cambiar la prioridad operativa exige el
comando SOC existente con su propia revisión y auditoría; la UI debe confirmar esa acción por separado.

### API y permisos

Rutas bajo `/api/assistant/suggestions`:

| Método | Capacidad | Contrato |
| --- | --- | --- |
| `GET /` | `alerts.read` | Página por `status`, `priority`, `assignee`, `from/to`, cursor; devuelve original y sugerida por separado, evidencia enlazable y edad |
| `GET /:id` | `alerts.read` | Detalle y proveniencia permitida; filtra evidencia usando las capacidades actuales del actor |
| `POST /:id/review` | `assistant.suggestions.review` | `{decision, expectedRevision, reason?, correctedPriority?}`; CSRF; compare-and-set |
| `POST /:id/assign` | `assistant.suggestions.assign` | `{assigneeId|null, expectedRevision}`; CSRF; destino validado contra miembros admitidos |

La respuesta del modelo se valida en API con esquema estricto, enum y referencias existentes devueltas
por las herramientas. Una salida inválida queda como `unverified`; no entra a la bandeja como
recomendación revisable. La deduplicación de alertas y la priorización determinista siguen activas si
el modelo o la persistencia no están disponibles.

## Configuración operativa desde frontend

La administración usa `assistant.config.read` y `assistant.config.write`, nunca un rol inferido del
nombre de usuario. El backend publica un snapshot tipado y un comando versionado:

- `GET /api/admin/assistant/config` → `{revision, enabled, provider, modelId, promptPolicyVersion,
  limits, redactionPolicy, featureFlags, updatedAt, updatedBy, secretStatus}`.
- `PUT /api/admin/assistant/config` → `{expectedRevision, patch, changeReason}`; solo campos
  permitidos, validación de esquema, `If-Match`/revisión y CSRF.
- `POST /api/admin/assistant/config/validate` → valida modo/modelo contra configuración ya
  autorizada y hace una llamada sintética acotada; no envía alertas reales.

El proveedor/model ID solo se puede escoger de un allowlist instalado por despliegue. Este endpoint
no crea secretos, no permite URL arbitraria ni herramientas escribibles, e impone un `enabled=false`
global de emergencia. Configuración de seguridad, endpoint/red, secretos y permisos IAM permanecen
en infraestructura y Secrets Manager. Si una opción no se puede probar, la pantalla la marca
`unknown` y no permite activarla.

El patch se valida contra los límites del despliegue: `maxTokens`, llamadas de herramienta, tamaño de
contexto, concurrencia, límite mensual, cuotas y umbrales. Cambiar modelo, política de redacción o
presupuesto tiene `changeReason` obligatorio y audit event con solo claves/cambios no sensibles,
revisión y actor. Se rechazan revisiones obsoletas con `STATE_CONFLICT`; no hay último escritor gana.

## Presupuesto compartido y alertas

### Modelo de medición

`assistant_budget_policy` es una fila por tenant y periodo UTC, con límite monetario en micros USD,
moneda, política de reserva, umbrales, `revision`, estado y auditoría. `assistant_usage_ledger` es
append-only: `request_id` único, tenant, actor, categoría, proveedor/model ID, tokens entrada/salida y
cache, tarifa/version de tarifa, importe estimado, importe facturado opcional, hora y estado
`reserved|settled|released|blocked`. `assistant_budget_reservations` mantiene el saldo reservado con
actualización condicional/transacción y clave de idempotencia.

El algoritmo de cada llamada:

1. Validar sesión, capacidad, configuración efectiva y rate limit.
2. Estimar tokens con margen configurable y calcular cota de coste con tarifa versionada y
   `maxTokens`; no usar una tarifa supuesta ni una tarifa de otro proveedor.
3. En una única transacción, bloquear la fila de presupuesto, comprobar
   `settled + reserved + worst_case <= limit`, crear reserva idempotente y ledger `reserved`.
4. Invocar al modelo con `requestId`. Tras la respuesta, liquidar tokens medidos; si se conoce
   solamente parte del uso, conservar el límite superior y etiquetar `estimated`.
5. Ante timeout con resultado ambiguo, mantener reserva hasta reconciliar o vencer con una política
   explícita; no asumir coste cero ni enviar segundo request a ciegas.

Las consultas de coste muestran separado `estimated`, `provider_reported` y `invoiced`. Bedrock o
Anthropic entregan uso/tokens; el coste de factura requiere integración Cost and Usage Report/Cost
Explorer y conciliación por cuenta, región, modelo y periodo. Si esa fuente no está conectada, la UI
dice “estimado” y nunca “facturado”. Descuentos, impuestos, endpoints privados y almacenamiento quedan
fuera del coste estimado hasta que el origen los reporte.

### Alertas y administración

La política tiene `monthlyLimitMicrosUsd`, `perRequestLimitMicrosUsd`, topes de tokens, umbrales por
defecto 50/80/100%, destinatarios por grupo QAPAQ y modo al alcanzar el límite (`block`, obligatorio
para operaciones con coste; solo un modo de degradación determinista puede seguir funcionando).
Cada cruce de umbral produce una notificación idempotente por `(tenant, periodo, threshold)`; no se
manda correo desde el request del modelo. El 100% bloquea nuevas reservas y dispara aviso; el
administrador puede aumentar presupuesto solo con capacidad, motivo y nueva revisión. La pantalla
muestra usado, reservado, restante, solicitudes bloqueadas, tarifa/version, desglose por caso,
modelo y categoría, y estado de conciliación.

## Documentos de incidente versionados

Tablas propuestas `incident_documents` (identidad/estado) e `incident_document_versions` (contenido
inmutable):

- Identidad: `id`, `tenant_id`, `incident_id`, título, tipo (`executive_summary`, `incident_report`),
  estado (`draft`, `ready_for_review`, `approved`, `archived`), revisión actual, propietario y fechas.
- Versión: `(document_id, version)` única; body Markdown sanitizado y límite de tamaño; hash SHA-256,
  autor, `created_at`, prompt/model/policy, fuentes `{kind,id,observedAt}`, revisión padre y motivo.
- Se agrega una versión dentro de una transacción; ninguna ruta edita ni elimina una versión. Una
  corrección crea `version + 1` y conserva lo anterior. El blob grande puede ir a S3 cifrado con KMS,
  object versioning y retención; la BD conserva hash, key opaca, metadata y referencias.

Rutas: `GET /api/incidents/:incidentId/documents`, `POST .../documents` para iniciar un borrador,
`GET .../documents/:id/versions`, `POST .../documents/:id/versions` con `expectedRevision` para una
nueva versión, y `POST .../documents/:id/commands` para transición a revisión/aprobación/archivo.
Capacidades: `incidents.documents.read`, `.write`, `.approve`, `.export`; SoD impide al autor aprobar
su propio documento cuando `approve` está habilitado. El endpoint de Qapaqzito solo entrega borrador y
referencias permitidas: guardar, exportar y aprobar son comandos explícitos auditados. La nota no es
un alias ni un destino automático del documento.

## Frontend y operación

1. **Bandeja:** pestaña `/app/qapaq-suggestions`, filtros persistidos en URL, prioridad original y
   sugerida en columnas distintas, confianza/citas/edad/owner y estados vacíos, degradados y fallidos.
   Revisar abre detalle; corregir pide prioridad y razón; los controles se ocultan por capacidad.
2. **Administración:** subsección Qapaqzito en administración, separada por “Configuración”, “Presupuesto”
   y “Uso”. Vista previa del cambio, revisión esperada, motivo obligatorio, botón de emergencia y
   errores de conflicto. Secretos solo `configured|missing`.
3. **Documentos:** pestaña Documentos del incidente, árbol de versiones, diff legible, referencias
   fuente, autor/fecha/modelo, estado de aprobación y exportación solo si autorizada.
4. **Degradación:** si API o BD falla, avisar que la bandeja no está actualizada; nunca aparentar
   guardar. Las vistas actuales de Alertas/Incidentes y Ankay permanecen disponibles.

## Orden de entrega y gates

1. Contratos/migraciones, aislamiento tenant, capacidades y pruebas concurrentes/idempotentes.
2. Presupuesto transaccional antes de activar invocaciones compartidas; sin store durable queda
   explícitamente bloqueada la modalidad multi-instancia.
3. Sugerencias con dataset sintético, citas verificables y métricas de corrección humana; nunca
   actualizar prioridad automáticamente.
4. Documentos versionados, permisos y SoD; documentos existentes descargados o notas permanecen en
   su recurso actual y no se migran silenciosamente.
5. UI consumiendo solo endpoints implementados; pruebas de contrato, backend y flujo con dos roles.
6. Entorno de integración autorizado, migración con backup/rollback, evidencia release y luego
   canary limitada. AWS requiere recuperar conectividad, inspeccionar cuenta/plan y confirmar que el
   target coincide con un entorno autorizado antes de cualquier `apply`.

La integración MCP externa continúa como lectura. La bandeja no cambia B10; documentos no cambian
B10/B12; ninguna sugerencia crea solicitudes Respond. Para habilitar acciones concretas sigue
requiriéndose la decisión por playbook indicada en B12 y la aprobación separada en Ankay.
