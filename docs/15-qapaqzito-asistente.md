# 15 · Qapaqzito, el asistente de IA

> Leyenda: **[verificado]** (probado con pruebas automáticas en este repo), **[sin verificar]**
> (existe en el repo, no se probó contra el proveedor real ni en el dashboard desplegado) y
> **[propuesto]**.

**Qapaqzito** es el asistente de IA integrado en QAPAQ SOC, con el conejo Remi de la identidad de marca.
Se comporta como un asistente de consola tipo Amazon Q: un panel lateral que se abre desde la
cabecera, entiende en qué página estás, consulta el SOC por ti con herramientas, muestra qué
consultó y cita las alertas e incidentes en que se apoya. Usa **Claude** por API.

## Qué puede hacer

| Pregunta típica | Herramientas que usa |
| --- | --- |
| «¿Qué alertas P1 hay abiertas?» | `list_alerts`, `get_alert` |
| «Resume el incidente y sus tareas» | `get_incident`, `get_incident_alerts`, `get_incident_timeline`, `get_incident_tasks`, `get_incident_notes` |
| «Busca inicios de sesión fallidos en 24 h» | `search_events` |
| «¿Hay fuentes degradadas?» / «¿cómo va la plataforma?» | `sources_health`, `operations_health` |
| «¿Quién cambió roles esta semana?» / «verifica la auditoría» | `audit_events`, `audit_verify` |
| «¿Qué avisos no tuvieron acuse?» | `list_notifications` |
| Usuarios, sesiones y solicitudes de rol (administración) | `list_users`, `list_sessions`, `list_role_requests` |
| «¿Por qué no puedo ver X?» | `whoami` |

«Toda la información del SOC» significa **todo lo que la persona que pregunta puede ver** con su
rol, no más. Es una decisión de seguridad, no una limitación.

## Cómo está hecho

```mermaid
flowchart LR
  U((Persona)) --> P[Panel Qapaqzito<br/>plugin qapaq_ops]
  P -->|POST /api/assistant/chat<br/>sesión + CSRF| A[API QAPAQ]
  A --> L[Bucle del asistente<br/>modules/assistant]
  L <-->|Messages API| C[(Claude<br/>Bedrock o Anthropic)]
  L -->|herramientas GET| I[inject interno<br/>con la sesión de la persona]
  I --> R[Rutas /api/... de siempre<br/>autorización y redacciones]
```

- **Mismo permiso que la persona.** Cada herramienta compone una URL `GET` de una lista cerrada y la
  ejecuta con la **cookie de sesión de quien pregunta**. La autorización, la proyección de campos y las
  redacciones son las de la API de siempre; Qapaqzito no tiene un acceso privilegiado propio. Solo se
  ofrecen al modelo las herramientas que el rol puede usar, y las demás se rechazan como desconocidas.
- **Solo lectura por construcción.** No hay herramientas con otro método que `GET`, y el cliente interno
  rechaza cualquier ruta fuera de `/api/`. Una acción de respuesta se explica y la solicita un analista
  y la aprueba otra persona en Ankay ([13](13-ankay-qapaq.md)).
- **Datos personales seudonimizados.** Correos e IPv4 se sustituyen por marcadores estables
  (`<usuario_1>`, `<ip_1>`) antes de salir hacia el modelo y se restituyen en la respuesta. Alcance
  honesto: no detecta nombres propios u otros identificadores en texto libre.
- **Contenido de terceros = dato.** Los resultados de herramientas se marcan como datos, no como
  instrucciones; el prompt de sistema manda ignorar y avisar de intentos de inyección.
- **Presupuesto acotado.** Máximo 4 rondas y 8 consultas de herramientas por turno; cada resultado se limita a 14 000 caracteres y todos los resultados del turno comparten un tope de 24 000 caracteres. El historial que se reenvía al modelo conserva hasta 12 mensajes, pero ocupa como máximo 12 000 caracteres y elimina primero los turnos completos más antiguos. Estos límites de caracteres son una cota determinista aproximada, no un conteo exacto de tokens. Cada llamada genera como máximo 4096 tokens de salida y todas las rondas del turno comparten un máximo de 8192 tokens; al agotarlo, Qapaqzito no emite una conclusión nueva. La caché del prefijo estable de sistema/herramientas reduce el costo de las rondas posteriores cuando el proveedor la acepta. El turno tiene 24 s de reloj total en Lambda y hasta 55 s en EC2, más 20 preguntas por persona cada 10 min. El límite de tasa es por instancia; no hay aún presupuesto mensual global compartido.
- **Auditoría.** Cada pregunta deja `assistant.ask` con quién, resultado y herramientas usadas; el
  texto de la conversación **nunca** va a auditoría ni a logs (vive solo en el historial, abajo).

## Proveedores y configuración

| Variable | Valor | Nota |
| --- | --- | --- |
| `QAPAQ_QAPAQZITO_ENABLED` | `true` | Apagado por defecto: sin él no existe el endpoint ni el botón |
| `QAPAQ_QAPAQZITO_PROVIDER` | `bedrock` (defecto) o `anthropic` | Nodo AWS PowerUser (sin IAM para Bedrock): `anthropic` |
| `QAPAQ_QAPAQZITO_MODEL` | `claude-opus-5-5` en Bedrock; `claude-sonnet-5-5` con `anthropic` | En Bedrock se antepone `anthropic.` |
| `QAPAQ_QAPAQZITO_EFFORT` | `medium` (defecto) | `low`…`max`; más esfuerzo = más tokens |
| `QAPAQ_QAPAQZITO_REDACT_PII` | `true` (defecto) | Seudonimización |
| `QAPAQ_QAPAQZITO_API_KEY` | secreto | Solo con `anthropic`. En el despliegue AWS se toma de `QAPAQ_CLAUDE_API` (`/opt/qapaq/secrets/services.env`) y vive solo en `/opt/qapaq/secrets/api.env` (0600) |
| `QAPAQ_QAPAQZITO_TIMEOUT_MS` | `20000` (defecto) | 1000–120000; tiempo por intento HTTP; el SDK reintenta 2 veces con backoff |
| `QAPAQ_QAPAQZITO_RATE_LIMIT` | `20` | Preguntas por persona cada 10 min |
| `QAPAQ_QAPAQZITO_HISTORY_ENABLED` | `true` (defecto) | Historial de conversaciones; `false`: el chat no guarda y `/conversations` responde 404 |
| `QAPAQ_QAPAQZITO_RETENTION_DAYS` | `90` (defecto) | 1–365; las conversaciones sin actividad más antiguas se borran |

**Recomendación: Amazon Bedrock.** Con la arquitectura sin NAT ([02](02-arquitectura.md)) la Lambda no sale a
Internet, y la decisión N1 (operación autogestionada, sin SaaS de terceros para datos del SOC) y la
minimización N2 piden que los datos no salgan de la cuenta. Bedrock cumple ambas con el rol IAM de la
función (sin clave que guardar). El proveedor `anthropic` directo envía datos del SOC a un tercero:
**requiere dictamen de Legal** y salida a Internet.

Modelo: `claude-opus-5-5` es el valor por defecto de este proyecto; para bajar costo se puede usar
`claude-sonnet-5-5` o `claude-haiku-5-5` cambiando solo la variable. Cada pregunta con herramientas suele
costar varias llamadas al modelo (una por ronda); el costo real se debe **medir** con tráfico real, no
estimarlo.

## Historial de conversaciones

Como el asistente de la consola de AWS: cada persona ve la lista de sus conversaciones previas, las
reabre, las continúa, las renombra y las borra (una o todas).

**Modelo de datos.** Una conversación (`StoredConversation`: `id` UUID, `tenantId`, `ownerId` = `subjectId`
de la sesión, `title`, `createdAt`, `updatedAt`, `messages`) guarda sus mensajes (`StoredMessage`: `id`,
`role`, `text`, y en las respuestas `steps`, `citations` y `tone`). Dominio y adaptador en
memoria en `modules/assistant/src/conversations.ts`; adaptador durable en
`modules/assistant/src/infrastructure/postgres-conversation-store.ts` (`@qapaq/assistant/postgres`), tabla
`assistant_conversations` con los mensajes en una columna `jsonb` e índices por
(`tenant_id`, `owner_id`, `updated_at`) y (`tenant_id`, `updated_at`). Se usa PostgreSQL cuando la
persistencia del SOC es `postgres`; en desarrollo y pruebas, memoria.

**Turno atómico.** El servidor guarda la pregunta y la respuesta **después** de obtener la respuesta, en
una sola escritura (alta de la conversación o compare-and-set sobre `message_count`). Si el guardado
falla, la respuesta llega igual con `saved: false`. Con el historial activo el servidor usa el historial
**guardado** e ignora el `history` que envíe el cliente; una conversación nueva empieza vacía.

**Privacidad del proceso.** Los bloques internos `thinking` del proveedor nunca se desenmascaran,
devuelven a la UI ni guardan en el historial. Solo se muestra la actividad observable de herramientas
ejecutadas por el servidor (`steps`) y el progreso SSE. Los bloques firmados que el proveedor exige
para continuar una ronda con herramientas permanecen transitorios durante esa petición. La migración
`20261112120000_remove_qapaqzito_thinking` elimina el campo heredado `reasoning` de conversaciones ya
guardadas; el lector también ignora ese campo como defensa adicional.

**Aislamiento absoluto.** Toda consulta filtra por (tenant, dueño). Nadie más que el dueño lista, lee,
continúa, renombra o borra una conversación, **ni siquiera un administrador**. Un id ajeno, vencido o
inexistente responde lo mismo: `404 RESOURCE_UNAVAILABLE` (no se enumera).

**Límites.** 100 conversaciones por persona (al crear la 101.ª se descarta la menos reciente, auditado);
200 mensajes por conversación (el turno siguiente se rechaza con `422 VALIDATION_FAILED`,
`fields: ["messageLimit"]`, antes de llamar al modelo: hay que empezar otra); 20 000 caracteres por
mensaje (la respuesta del modelo se recorta a ese máximo); título automático = primeros 60 caracteres
de la primera pregunta en una línea; título manual de 1 a 80 caracteres.

**Retención y borrado.** `QAPAQ_QAPAQZITO_RETENTION_DAYS` (defecto 90): al listar y al guardar se purgan, como
mucho una vez por minuto y proceso, las conversaciones del tenant sin actividad en ese plazo; una
vencida aún no purgada ya responde como inexistente. Borrar (una, todas o por retención) es **borrado
real**: es la única tabla donde el rol `qapaq_soc_runtime` tiene `DELETE` (sin `TRUNCATE`), concedido en
`platform/database/bootstrap/post-migrate.sql`.

**Privacidad.** Se guarda el texto tal como lo vio la persona (con correos e IP reales, igual que el resto
del SOC; la seudonimización solo aplica a lo que sale hacia el modelo). Los datos viven dentro de la
cuenta, en el mismo PostgreSQL del SOC, **cifrado en reposo por el motor** (RDS con KMS). Auditoría sin
texto: `assistant.conversation.delete` (id o `all`, `metadata.count`) y `assistant.conversation.purge`
(`retention` o `limit`, `metadata.count`).

**Contrato HTTP** (todo exige sesión; lo que muta, además `x-csrf-token`; todas las respuestas llevan
`correlationId`):

| Método y ruta | Cuerpo / consulta | Respuesta |
| --- | --- | --- |
| `POST /api/assistant/chat` | `{message, page?, conversationId?, history?}` | lo de siempre + `{conversationId, title, saved}` (`null`, `null`, `false` si no se guardó) |
| `GET /api/assistant/conversations` | `?pageSize=1..200&cursor=` | `{items: [{id, title, updatedAt, messageCount}], nextCursor}` (más recientes primero) |
| `GET /api/assistant/conversations/:id` | | `{id, title, createdAt, updatedAt, messages: [{id, role, text, steps?, citations?, tone?, createdAt}]}` |
| `PATCH /api/assistant/conversations/:id` | `{title}` (1–80) | `{id, title}` |
| `DELETE /api/assistant/conversations/:id` | | `{deleted: 1}` |
| `DELETE /api/assistant/conversations` | | `{deleted: n}` (solo lo mío) |

`GET /api/assistant/config` añade `history` (booleano) y `retentionDays`.

**SSE de progreso.** `POST /api/assistant/chat/stream` conserva la sesión y protección CSRF del chat.
Emite `started` con `correlationId`; `progress` para `model_started` (número de ronda) y
`tool_started`/`tool_finished` (etiqueta y resultado `ok`); y termina con `complete` o `error`. `complete`
contiene la respuesta ya saneada, con citas validadas, auditoría registrada e intento de guardado terminado;
no incluye razonamiento. `error` expone un error sanitizado. El contrato comunica avance de etapas y
herramientas, no tokens parciales ni bloques internos `thinking`. La ruta JSON `POST /api/assistant/chat` sigue disponible como fallback.

## Interfaz

### Exportar una respuesta o un expediente

Cada respuesta de Qapaqzito incorpora **Crear informe**. La persona elige entre exportar solo la respuesta o
preparar un expediente de investigación a partir de una alerta/evento citado y las páginas relacionadas que
su propia sesión puede leer. El expediente no se genera parcialmente si la evidencia está denegada o ya no
existe. Sin una cita de alerta/evento se puede exportar la respuesta, pero no se presenta como expediente
probatorio.

- **Excel (.xlsx):** descarga un libro con resumen, fuentes, eventos y actividad agrupada disponible.
- **PDF:** abre una vista A4 lista para imprimir. Primero aparecen el título y el contexto; luego se insertan
  las filas en lotes de 250, cediendo el event loop y actualizando el avance. Al finalizar se abre el diálogo
  de impresión para elegir **Guardar como PDF**. El navegador genera el PDF; no existe un PDF parcial, un
  renderer de servidor ni una descarga que el modelo dispare desde el chat.
- La preparación muestra el avance de lectura y serialización y permite cancelar. Revisar el documento antes
  de compartirlo; el archivo se prepara localmente en la sesión y no queda como trabajo reanudable del servidor.

El asistente orienta a la persona al botón **Crear informe** debajo de su respuesta cuando le pidan exportarla;
no debe decir que carece de una función de exportación ni que no sabe qué contenido usar. La respuesta indica
que el control permite elegir entre **Solo respuesta de Qapaqzito** e **Investigación con evidencia**, y entre PDF
imprimible y Excel. Qapaqzito no afirma que ya descargó el archivo: la exportación se completa desde ese control y
requiere una acción explícita de la persona.

Botón con Remi en la cabecera (atajo Alt+Shift+B), panel lateral con saludo, ejemplos según la página
(alertas, incidentes, fuentes, auditoría), estado «consultando…», lista plegable de lo que consultó,
fuentes citadas con enlace a la consola, copiar, nueva conversación y aviso permanente de IA generativa
y solo lectura. Accesible por teclado, con foco visible y sin animación bajo `prefers-reduced-motion`. El
botón solo aparece si la API lo habilita y la persona tiene permisos de lectura.

El panel consume `POST /api/assistant/chat/stream` por SSE en el código local y muestra gradualmente
el progreso operativo real: inicio de ronda del modelo y comienzo/finalización de herramientas. El
evento `complete` entrega el texto final solo después de aplicar scrub, validar citas, auditar e intentar guardar;
no se envían deltas de texto ni fragmentos de razonamiento. Por eso la actividad se ve avanzar, pero el
texto de la respuesta aparece completo al finalizar. La ruta JSON `POST /api/assistant/chat` permanece
como fallback para proxies que almacenen el stream. Este cambio está en el código local y no se declara
desplegado ni validado en la consola publicada.

El soporte objetivo actual es el runtime EC2 con nginx y `proxy_buffering off`; no se da por sentado que
API Gateway/Lambda preserve SSE. El adaptador Anthropic-compatible de Claude y Bedrock sigue usando
`messages.create`; no se implementó ni verificó `messages.stream` para ninguno de los dos proveedores.
Exponer fragmentos requeriría sanear secretos de longitud variable y seudonimizar PII antes de cada delta,
además de validar la respuesta final.

## Estado

- **[verificado]** El dominio (bucle, presupuesto, seudonimización, inyección, errores): 11 pruebas. La API
  (configuración, adaptador, herramientas, cliente interno, permisos por rol, CSRF, límite de tasa y
  auditoría sin texto): 16 pruebas. La lógica del cliente de la interfaz: 4 pruebas. La interfaz se
  renderizó con React en un navegador de pruebas (saludo y conversación). Historial: almacén en memoria
  (aislamiento, topes, título, orden, paginación, purga) y configuración nueva con pruebas unitarias;
  por HTTP, crear/continuar/listar/leer/renombrar/borrar, aislamiento frente a otra persona y a un
  administrador, CSRF, paginación, historial apagado, guardado fallido (`saved: false`), conversación
  llena, retención y que el historial guardado reemplaza al del cliente
  (`apps/api/test/assistant-history.spec.ts`).
- **[verificado]** El adaptador PostgreSQL del historial y su migración contra PostgreSQL 18.6 real
  (Docker local): `postgres-conversation-store.integration.spec.ts` (5 pruebas) y el permiso `DELETE` del
  runtime en `postgres-roles.integration.spec.ts`. La migración no presenta deriva frente al esquema
  Prisma en `assistant_conversations`. La interfaz del historial en el panel tiene pruebas de su cliente
  (`chat_client.test.ts`).
- **[sin verificar]** Llamadas reales a Claude (Anthropic o Bedrock): las pruebas usan un modelo falso.
  El acceso a los modelos en Bedrock se habilita en la consola de AWS por cuenta y región. La interfaz dentro
  del dashboard de Wazuh desplegado (el typecheck de OSD y el SCSS compilado por OSD no se ejecutaron).
- **[pendiente]** Deltas de texto token a token durante la respuesta. La implementación actual solo transmite
  estados operativos SSE y el mensaje final validado. Exponer fragmentos requerirá resolver cómo aplicar el
  scrub de secretos y la seudonimización de identificadores antes de cada emisión; no se deben mandar
  fragmentos sin esas protecciones. En el diseño serverless, API Gateway HTTP no conserva el streaming de
  respuesta; si ese diseño se retoma, requiere una URL de función con response streaming u otro transporte
  compatible.
- **[propuesto]** límite de tasa global, retroalimentación (👍/👎) con backend, herramienta para
  *proponer* —nunca ejecutar— una acción de Ankay, y la opción `fallbacks` del proveedor ante rechazos del modelo.

## Auditoría de consumo, calidad y progreso (2026-11-12)

El bucle ahora limita un turno a 4 rondas y 8 solicitudes de herramienta, con hasta 4096 tokens por
llamada y 8192 tokens de salida acumulados. El presupuesto restante reduce `max_tokens` en cada ronda;
al agotarse, Qapaqzito devuelve un estado de presupuesto sin inventar una conclusión. Los resultados
individuales siguen limitados a 14 000 caracteres y comparten un máximo de 24 000 caracteres por turno.
El historial conserva hasta 12 mensajes y 12 000 caracteres totales; descarta primero los turnos
completos más antiguos. El límite agregado de caracteres es una cota estable, no una estimación exacta
de tokens. El adaptador ya configura caché para el prefijo estable de sistema/herramientas; su efecto
económico depende de los contadores reales devueltos por el proveedor.

Las regresiones cubren el historial reciente, el tope acumulado de salida, el máximo de consultas, el
presupuesto agregado de datos, el truncamiento explícito y la preservación de citas/etiqueta de datos
externos. Validación local: módulo `@qapaq/assistant`, 32/32 pruebas y typecheck aprobado; API focalizada
de assistant e historial, 34/34 pruebas, y typecheck de `@qapaq/api` aprobado. Esto comprueba los límites
de código, no mide ahorro de costo ni demuestra que la calidad del análisis se mantenga con un proveedor
real. No se afirma ahorro porcentual.

El adaptador recopila `input_tokens`, `output_tokens` y contadores de caché que devuelve el proveedor;
el endpoint de uso agrega esos contadores desde auditoría. La cancelación SSE conserva los contadores de
respuestas que el SDK ya devolvió; otros errores no guardan uso parcial y el panel no representa
necesariamente todo lo consumido en turnos fallidos. No hay en el repo una captura real de un proveedor
que permita declarar ahorro, calidad medida,
latencia de proveedor o aceptación de Anthropic/Bedrock. La siguiente evaluación útil es un canario aislado
con preguntas SOC fijas y no sensibles; conservar por escenario proveedor/modelo/esfuerzo, tokens de
entrada/salida/caché, rondas, latencia, citas válidas y revisión humana de exactitud. Comparar respuestas
con evidencia disponible y etiquetas adjudicadas antes de ajustar presupuestos o proveedor.

El SSE actual comunica inicio de ronda y ejecución de herramientas; el texto aparece en `complete`, tras
el saneamiento, la validación de citas, auditoría e intento de guardado. Mantener ese contrato hasta probar
un saneamiento incremental que conserve secretos de longitud variable, seudonimización y validación de
citas en los deltas. La UI puede mostrar etapas, pero no hay base para simular avance de descarga del texto.
La ruta SSE ahora observa el cierre abrupto de la respuesta HTTP, vacía la cola y destruye el pump; el
`AbortSignal` llega a `runAssistant`, a la llamada SDK de Anthropic/Bedrock y al cliente interno de lectura,
que comprueba la señal antes de cada nueva consulta SOC. La cancelación se distingue de un error del proveedor, no emite `complete`, no persiste
el turno y evita otra ronda del modelo. Se audita como turno fallido, con contadores acumulados de
respuestas ya devueltas. Si el SDK rechaza la llamada abortada, no se extraen contadores del error: puede
contener datos internos y el SDK no garantiza uso parcial en ese camino. Las consultas internas de una
misma tanda de herramientas que ya estaba en curso pueden concluir; el dominio comprueba la señal al
terminar la tanda y no solicita otra ronda. La prueba HTTP real contra un socket desconectado y ambos
proveedores reales siguen pendientes; las pruebas deterministas usan puertos SDK falsos.

No se identifica un cuello de CPU local que justifique Rust. Las llamadas al proveedor y el volumen de
contexto son los puntos medibles; primero instrumentar turnos fallidos y obtener el canario indicado.
Hasta entonces no se atribuye ahorro medido a caché, cambios de esfuerzo, lenguaje o límites. Los
límites preventivos reducen el techo configurado de contexto/salida, pero no sustituyen la comparación
de calidad con preguntas SOC representativas y revisión de citas.

## Validación al arrancar y minimización

`platform/configuration` reconoce todas las variables `QAPAQ_QAPAQZITO_*` (`schema/assistant.schema.ts`) y las
valida al arrancar: un valor inválido o `QAPAQ_QAPAQZITO_PROVIDER=anthropic` sin clave falla con
`CONFIG_VALUE_INVALID`/`CONFIG_REQUIRED_VALUE_MISSING` sin mostrar el valor. Proveedores admitidos:
`bedrock` y `anthropic` (DeepSeek se descartó). Además de la seudonimización de correos e IPv4, el
adaptador elimina credenciales evidentes (Bearer/Basic, JWT, claves AWS/GitHub/Slack/`sk-…`, claves
privadas, `password=`/`token:`/`api_key=`) de todo texto saliente (`apps/api/src/assistant/outbound-scrub.ts`).
Los bloques internos firmados del proveedor se reenvían intactos solo entre rondas del mismo turno
cuando se usan herramientas; nunca llegan a la respuesta, historial, auditoría ni logs.

### Evidencia de correo M365 en informes

En un expediente con eventos de Exchange/Microsoft 365, la sección de coincidencias agrupa eventos solo si comparten un identificador exacto: se prefiere `NetworkMessageId` y se usa `InternetMessageId` cuando el evento no trae el primero. La proximidad temporal o el mismo buzón no crean por sí solos un grupo de mensaje.

El PDF imprimible y el libro XLSX muestran buzones auditados (`MailboxOwnerUPN`), destinatarios presentes en el DTO allowlisted, operaciones de auditoría e IDs de evento. `MailboxOwnerUPN` identifica el buzón de la operación; no necesariamente a la persona que actuó. Si el contrato indica que la lista de destinatarios fue truncada, el informe lo marca. No se recuperan ni se inventan destinatarios ausentes.

La dirección se clasifica de forma conservadora: solo `Send`, `SendAs` y `SendOnBehalf` indican salida. El feed actual de Microsoft 365 Management Activity/Audit no permite afirmar recepción: Microsoft indica que recibir mensajes no se audita por defecto y sus acciones documentadas para el buzón incluyen acciones de envío ([Microsoft Purview: Audit mailboxes](https://learn.microsoft.com/en-us/purview/audit-mailboxes)). Por ello `Receive`, `Deliver`, otras operaciones o la operación ausente se muestran como «Dirección no determinada», salvo que exista un contrato y fuente aprobados que garanticen esa semántica. Una coincidencia por ID no demuestra causalidad ni un hilo de correo; revisar la cronología, los eventos fuente y el contexto antes de comunicar conclusiones.

### Escritura progresiva de informes (2026-11-12)

El XLSX de Qapaqzito usa `showSaveFilePicker` cuando el navegador lo ofrece: el destino se elige en el gesto de la persona antes de consultar la evidencia, y el libro OOXML se escribe por fragmentos con espera de cada escritura. El progreso avanza por filas serializadas y escritura aceptada; la interfaz solo marca 100 % después de cerrar correctamente el archivo. Cancelar aborta el flujo y el destino temporal. La salida está limitada a 50 MiB y 10.000 eventos.

En navegadores sin escritura directa se conserva la descarga por Blob, con el mismo límite de 50 MiB; esa alternativa sí mantiene el archivo completo en memoria y la interfaz lo informa. Cancelar el selector no inicia la consulta.

PDF sigue siendo un expediente HTML local: la ventana de vista previa muestra la cabecera y el contexto, y añade las filas de las tablas en lotes conforme se serializan. Al terminar abre el diálogo de impresión del navegador para guardar el PDF. No hay PDF parcial, renderer servidor ni job durable.

### Cancelación y compatibilidad del chat (2026-11-13)

El panel permite cancelar una consulta en curso con `AbortController`; el cierre del stream llega al servidor y la interfaz conserva el borrador para un reenvío explícito. Cancelar no reintenta ni afirma que el servidor no alcanzó a iniciar el turno. Si el proxy rechaza expresamente SSE antes de aceptar la solicitud (404/405/406/415/501 sin `correlationId` QAPAQ), el cliente usa una sola vez `POST /assistant/chat`. Los errores de red ambiguos, 5xx, respuestas SSE ya recibidas o streams cortados tras iniciar no se reenvían automáticamente para evitar doble invocación. Una respuesta JSON completa ya devuelta por el proxy se valida y se usa directamente.

La disponibilidad de configuración tiene estados distintos: comprobando, disponible (incluye `enabled=false`) y no disponible. Un fallo de lectura no se interpreta como asistente deshabilitado y ofrece reintento. El progreso expone el fallback de transporte como tal; no inventa actividad del modelo ni muestra razonamiento privado.


## Informes generados por Qapaqzito (PDF, Excel, CSV)

- Herramienta `generate_report` (`apps/api/src/assistant/report-tool.ts`): la API obtiene tablas, KPIs, gráficos y cronologías con los `GET` internos y los permisos de la persona; el modelo solo aporta título y narrativa (markdown sin HTML, acotada). Tipos: `alerts`, `investigation` (alerta + eventos relacionados) e `incident`.
- La API arma el ReportSpec v1 y lo envía a `services/qapaq-reports` (`POST /render`, bearer `QAPAQ_REPORTS_TOKEN`, red interna `reports-internal`, 90 s de tiempo máximo, sin reintentos). Sin `QAPAQ_REPORTS_URL` y `QAPAQ_REPORTS_TOKEN` la función está apagada y la herramienta responde `unavailable`.
- El archivo se guarda como artefacto (`assistant_artifacts`, bytea, dueño tenant + subject, vigencia de 24 h, tope de 25 MB y 20 por persona y día; purga cada 10 min). Descarga: `GET /api/assistant/artifacts/:id` (solo el dueño; otro caso 404 neutro; `content-disposition: attachment`, `nosniff`, `no-store`). Listado: `GET /api/assistant/artifacts`.
- SSE de `/api/assistant/chat/stream`: evento `artifact` con la `ArtifactRef` en cuanto se guarda; la respuesta final y el historial incluyen `artifacts`.
- Auditoría: `assistant.artifact.create` y `assistant.artifact.download` con id, tipo, formato, tamaño y hash; nunca el contenido. Al modelo solo vuelve `{ artifactId, filename, rows, pages }`.

### Herramientas del Analista IA (2026-11-14)

Mismo servidor MCP (`POST /api/assistant/mcp`) y mismo bucle de Qapaqzito; no hay un segundo servidor.

- `list_investigations`, `get_investigation_run`, `get_investigation_report`: lecturas `GET` de
  `/api/ai-investigations` con la sesión de la persona; requieren `investigations.read`.
- `start_investigation {alertId}`: **acción** (encola una investigación manual idempotente);
  requiere `investigations.run`, se publica con `readOnlyHint: false` y su descripción obliga a
  pedir confirmación explícita antes de usarla. Auditada como `ai.analyst.investigation.requested`
  (`via: mcp|qapaqzito`). Con el analista apagado responde un error legible y no encola.
- El expediente es dato, no instrucción. Detalle y guardas en
  [27 · Implementación](27-aisoc-mcp-evaluacion-y-plan.md#implementación-2026-11-14).
