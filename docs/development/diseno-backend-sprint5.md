# Diseño backend Sprint 5 — patrones, contratos y criterios de código

Estado: **vigente**. Fecha: 2026-10-12. Complementa el
[plan Sprint 5](plan-sprint5-eventos-salud-usuarios-casos.md): aquel dice **qué** se entrega y
en qué orden; este dice **cómo** se construye, con qué patrones y con qué criterio se escribe y
comenta el código. Sigue la arquitectura del repositorio: monolito modular, puertos y adapters,
dominio sin proveedores (C-23), autorización en el backend.

## 1. Qué backend falta y por qué

| Pieza | ¿Hace falta? | Motivo |
| --- | --- | --- |
| Ingesta Wazuh → SOC (fase 0) | **Sí, bloqueante.** Hecha en código; falta activarla en AWS | Sin ella las alertas de M365 no llegan al SOC en el demo |
| Tareas, bitácora y timeline (fase 4) | Sí. **Hecha** | Investigación operativa (I-1) |
| Datos en vivo `GET /api/changes` (S5-D10) | Sí. **Hecha** | Requisito del producto: aparición inmediata sin refrescar |
| Roles por dueño del grupo y asignaciones del deploy | Sí. **Hecha** la resolución por deploy; falta la lectura de dueños por Graph | Requisito del producto: dueño = admin, analista asignada, resto sin acceso |
| Acceso a Wazuh (lector, proxy, usuarios locales) | Sí. **Hecha** y probada en local; falta ejecutarla en AWS | Ingesta y acceso del dueño y de la analista al Dashboard |
| Explorador de eventos `GET /api/events` (fase 1) | Sí | Investigación sobre telemetría sin salir de QAPAQ, sin duplicar el SIEM |
| Salud por fuente (fase 2) | Sí | Distinguir «sin eventos» de «fuente caída»; hoy no hay señal |
| Padrón Entra por Graph (fase 3) | Sí, condicionado al consentimiento | Dueños automáticos y vista de usuarios; sin consentimiento, solo el respaldo del deploy |

**No** se construye en este sprint (y la UI no lo simula):
- solicitudes de rol con aprobación SoD y suspensión (v2 de identidad);
- evidencia con custodia (sin storage privado en el demo);
- observables tipados;
- respuesta externa (SOAR disruptivo).

## 2. Patrones por pieza

### 2.1 Comunes a todo el backend

| Patrón | Dónde | Por qué este y no otro |
| --- | --- | --- |
| **Puertos y adapters (hexagonal)** | `modules/*/src/ports.ts`; adapters en `infrastructure/` y `platform/database` | El dominio se prueba en memoria y no conoce Prisma, Wazuh ni Graph (C-23) |
| **Unit of Work** | `SocUnitOfWork.run` | El estado, el AuditEvent y el outbox entran juntos o no entra ninguno |
| **Transactional Outbox** | `soc_outbox_messages` + `NotificationDispatcher` | Un efecto externo nunca sale de un cambio que se deshizo |
| **Lease + fencing token** | outbox (`claim_id`), cursor de ingesta, sincronización del directorio | Varias réplicas sin coordinador: solo el dueño vigente del lease escribe |
| **Optimistic concurrency (CAS por `revision`)** | alertas, incidentes, tareas, sesiones | El conflicto es un resultado de negocio (409), no una excepción |
| **Idempotency key** | promoción por `recordId`, observaciones de poll, intentos de notificación | Releer y reintentar es seguro por construcción |
| **Composition root** | `apps/api/src/bootstrap.ts` | Único lugar que conoce adapters concretos y proveedores |
| **Anti-corruption layer** | normalización Wazuh (`@qapaq/telemetry/wazuh`), adapter de Graph | El vocabulario del proveedor no entra al dominio |

### 2.2 Ingesta (fase 0)

- **Template Method / motor reutilizable:** el bucle `NotificationDispatcher` (un vuelo a la vez, encadena mientras quede trabajo, parada ordenada) mueve tanto el despacho como la ingesta. La pasada (`createIngestionPass`) es una función inyectada.
- **Strategy:** `toEvent` y `promote` se inyectan. La pasada no sabe de Wazuh, y otra fuente solo aporta otra conversión.
- **Watermark + ventana con solape:** la marca avanza solo con páginas completas y nunca retrocede (`GREATEST`). El solape absorbe eventos tardíos y la idempotencia por `recordId` absorbe el solape.
- **Token source con caché y single-flight:** `EntraClientCredentialsTokenSource` (una petición en vuelo, renovación 60 s antes del vencimiento).

### 2.3 Explorador de eventos (fase 1)

- **Query Object / Specification:** el BFF construye un `EventQuery` validado (rango, filtros, página) y el adapter lo **compila** a DSL de OpenSearch. El navegador nunca envía DSL (events-read-through).
- **Tabla de traducción versionada:** de severidad normalizada a bandas de `rule.level`, de categoría a `rule.groups`. Es la inversa de la normalización y vive junto a ella, con versión, para que ambas cambien juntas.
- **Memento firmado:** el cursor guarda `search_after` y el hash canónico de los filtros, con HMAC y vencimiento. Un cursor con otros filtros se rechaza.
- **Proyección por capability:** `raw` solo con `events.read_raw` (`projectFields`), igual que en alertas.
- **Circuit breaker y backoff:** los da KrakenD (`qos/circuit-breaker`) y el proveedor (reintentos acotados con `Retry-After`). El BFF responde `DEPENDENCY_UNAVAILABLE` sin detalles del proveedor.

### 2.4 Salud por fuente (fase 2)

- **Máquina de estados pura (reducer):** `evaluateSourceHealth(observations, policy, now) → { state, reason }`, con estados `unknown | healthy | degraded | failed | disabled`. Es determinista, sin reloj ni E/S propios, y se prueba por tabla.
- **Policy object por fuente:** los umbrales (intervalos sin éxito para degradar o fallar) son datos, no constantes repartidas. Cambiar el umbral de M365 no toca el reducer.
- **Bitácora de transiciones (event log append-only):** `source_health_transitions` se escribe solo cuando cambia el estado. Es la evidencia de interrupciones, independiente del estado actual.
- **Observer:** cada transición deja un AuditEvent `source.health.changed`; el feed `/api/changes` ya lo distribuye a la UI sin endpoints nuevos.

### 2.5 Identidad y padrón (fase 3)

- **Composite + Strategy de fuentes de rol:** `createRoleGrantResolver` une las asignaciones del deploy, los dueños declarados y los dueños leídos del directorio. Cada fuente es intercambiable; si el directorio falla, se conservan las demás (degradación explícita).
- **Repository + sincronización delta con lease:** `DirectorySync` lee los miembros del grupo con *delta query* de Graph y persiste el `deltaLink` (skill del repositorio). Los dueños se releen completos en cada ciclo porque son pocos y la consulta delta de grupo no los sigue. Reglas:
  - una página parcial nunca borra miembros;
  - un 429 respeta `Retry-After`;
  - un `deltaLink` inválido (410) reinicia con una sincronización completa;
  - un padrón viejo se marca `syncStale`.
- **Cache-aside con vencimiento:** el `GroupOwnerSource` del inicio de sesión lee los dueños persistidos, no llama a Graph en cada login.
- **Auditoría del privilegio derivado:** la primera vez que una identidad obtiene admin por ser dueña, queda un AuditEvent `access.grant.derived` con la fuente (deploy o directorio).

### 2.6 Acceso a Wazuh

- **Configuración convergente e idempotente (desired state):** `apply-access.sh` declara roles, usuarios, mapeos y proxy, y cada ejecución converge al mismo estado. Los mapeos se unen y no se reemplazan, y las contraseñas no se rotan salvo pedido.
- **Self-test con rollback:** la autoprueba de permisos decide si el proxy queda aplicado.

## 3. Criterio de comentarios (SWE)

Comentarios en español, como el resto del repositorio. Un comentario existe para lo que el
código **no puede decir por sí mismo**:

1. **Encabezado de archivo:** qué responsabilidad tiene, qué decisión o requisito implementa (`S5-D1`, `C-23`, `D-10b`) y qué queda deliberadamente fuera.
2. **Contratos de puertos:** semántica que la firma no expresa (idempotencia, «`false` si el claim ya no es vigente», «nunca retrocede», orden de resultados).
3. **Invariantes y razones:** el *por qué* de una regla no obvia. Por ejemplo: «la marca avanza solo con la página completa», «el reloj real y no el del dominio: la retención es tiempo de red».
4. **Fronteras de seguridad:** qué no se registra, qué no sale del proceso, por qué una credencial viaja por archivo y no por argumento.
5. **Modos de falla:** qué pasa si la dependencia cae y por qué esa degradación es la correcta.

No se comenta lo que el nombre ya dice, no se deja código comentado, y un `TODO` solo va con
un identificador de plan o issue. Un comentario desactualizado es un defecto: se corrige en
el mismo cambio que altera el comportamiento.

## 4. Pruebas que cierran cada pieza

| Pieza | Unitarias (memoria) | PostgreSQL real | Integración con proveedor |
| --- | --- | --- | --- |
| Ingesta | ventana, solape, error, lease ajeno, más páginas que el tope, identidad estable | claim concurrente, fencing, `GREATEST`, observación idempotente | contrato del proveedor contra gateway falso; **pendiente:** pasada real contra el Indexer del demo |
| Eventos | compilación de DSL por filtro, multiselección por bandas, cursor alterado | — | contrato del gateway; Indexer real en el demo |
| Salud | reducer por tabla (éxito vacío, errores, umbrales, recuperación) | transiciones append-only, aislamiento por tenant | observaciones reales de la fase 0 |
| Padrón | delta, página parcial, 429, 410, dueño que sale | sincronización con lease, `deltaLink` persistido | tenant sandbox con consentimiento |
| Acceso Wazuh | — | — | OpenSearch 3.7 + API de Wazuh 4.14.7 + nginx (**hecho**); instancia real por el workflow |

Una pieza con dependencia externa queda «lista para activar», no «operativa», hasta tener
evidencia en AWS (ADR-024).

## 5. Orden de construcción restante

1. **Fase 1, eventos:** extensión de `EventQuery`, compilador de filtros, BFF, gateway y pruebas.
2. **Fase 2, salud:** reducer, persistencia de transiciones, endpoint y la sección en `operations/health`.
3. **Fase 3, padrón:** puerto `DirectoryReader`, adapter Graph (delta), `DirectorySync` con lease, `GroupOwnerSource` persistido, endpoints `/api/admin/users`, configuración `QAPAQ_DIRECTORY_SYNC`.
4. Runbook de activación en AWS (ingesta, Wazuh, identidad) y su registro en el checklist de release.
