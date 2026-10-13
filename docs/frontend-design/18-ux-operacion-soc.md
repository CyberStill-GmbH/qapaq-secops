# 18 · UX de operación SOC

**Estado:** especificación de experiencia (2026-10-13). **Alcance:** el *flujo de trabajo* de
quien opera el SOC — cómo se detecta, tria, investiga, responde, cierra y audita — y los
patrones transversales que lo sostienen. Complementa las specs visuales por vista (11–15) y el
estudio de referencia (17). Se inspira en la UX de respuesta a incidentes de **TheHive**
(comportamiento, no CSS; TheHive es AGPL) adaptada a los contratos y roles reales de QAPAQ.

> Fuente de verdad de capacidades y límites por rol: `10-vistas-por-rol-y-referencias.md`.
> La autorización la decide el servidor; la UI refleja capabilities de sesión («ausente, no
> deshabilitado»).

---

## 0 · El bucle operativo (de principio a fin)

```
   Detección            Triaje              Investigación           Respuesta          Cierre         Auditoría
 (Wazuh/M365)   →   (cola de alertas)  →   (incidente/caso)    →  (notificar/actuar) → (guardas)  →  (cadena)
   /sources           /alerts               /incidents            /notifications       /incidents     /audit
```

La consola **no cambia de shell por rol**: filtra navegación y acciones por capabilities. Cada
fase tiene una vista dueña y un conjunto de acciones gated. El diseño prioriza **escaneo veloz,
una acción clara por pantalla y estados explicables** — no paneles decorativos.

Principio rector (turno real): *«¿qué es lo más urgente, qué sé de ello, y qué hago ahora?»*
debe responderse sin leer manuales ni abrir cinco pestañas.

---

## 1 · Detección y salud (¿puedo confiar en lo que veo?)

Antes de triar, la persona necesita saber si las fuentes están entregando. `/sources` y la
franja de salud del Resumen responden eso con **honestidad de estado**:

- **Cero eventos ≠ sano y ≠ roto:** es neutral. Nunca pintar verde por ausencia de error ni rojo
  por una consulta vacía (doc 10).
- Cada fuente declara **última ejecución, último éxito, último evento, fallos consecutivos y
  ventana (24 h)**. La medición de suscripciones M365 (`Audit.*`) es *contexto de investigación*,
  **no** determina la salud de la fuente.
- Estados `unknown`/`disabled` son neutrales y se explican, no se ocultan.

UX: la salud es un prerrequisito visible, no un tablero aparte que nadie mira. Si una fuente está
`Fallida`, el error es accionable (razón + referencia), no un badge mudo.

---

## 2 · Triaje — cola de alertas (`/alerts`)

Objetivo: convertir ruido en decisiones rápidas. Inspiración TheHive (cola → promoción), adaptada.

**Escaneo:**
- Orden por **prioridad P1–P4** con **franja de color de 3px** a la izquierda de la fila +
  **glifo + rótulo** (◆P1…●P4). Nunca solo color.
- Columnas densas y estables (tabular-nums): prioridad, título/regla, fuente, hora relativa (con
  hora absoluta en `title`), estado.
- **Pestañas por estado** (Nueva/Reconocida/Triada/Escalada/Cerrada) para no mezclar trabajo
  hecho con pendiente.

**Decidir sin salir de la cola:**
- Fila → **drawer de detalle** a la derecha (no navegación completa): se tria una y se sigue con
  la siguiente sin perder el contexto de la lista.
- El drawer calcula su **bloque de acciones por capability**: `alerts.triage` (reconocer/triar),
  `alerts.assign` (asignar), raw solo con `events.read_raw`. Lo que no se tiene **no aparece**.
- **Acciones masivas** para operar varias alertas con el mismo veredicto (selección + barra de
  acción que resume el impacto antes de confirmar).

**Promoción a investigación:** una alerta (o varias correlacionadas) deriva en incidente. La
correlación se muestra como relación navegable, no como dato plano.

UX anti-error: ninguna acción de estado usa *optimistic update*; se envía con `expectedRevision`
y la UI refleja el resultado real (doc 06 §5). Si cambió por detrás, se avisa y se recarga.

---

## 3 · Investigación — incidente/caso (`/incidents/:id`)

Es el corazón tipo TheHive: un **workspace tabulado** alrededor del caso.

**Cabecera del caso:** identidad (id, título), **LifecycleStepper de 5 fases** (Abierto →
Contenido → Erradicado → Resuelto → Cerrado) con la fase actual marcada, prioridad, asignación.

**Pestañas:**
- **Resumen / Alertas vinculadas:** qué disparó el caso; relación alerta↔incidente navegable.
- **Tareas:** lista con `required`, asignación (`assigneeId`), acciones válidas por estado, y
  **cancelación con motivo (10–500 caracteres)**. El cierre se bloquea si hay tareas requeridas
  abiertas (guarda explicada, no un botón gris sin razón).
- **Bitácora (append-only):** notas que no se editan; una corrección es **otra nota**. Autor y
  hora siempre visibles. (Equivale a los *case logs* de TheHive, con inmutabilidad.)
- **Timeline:** distingue **ocurrencia en la fuente** de **registro en QAPAQ**. Evento + hora +
  actor + estado + razón. Depende de `audit.read`.

**Evidencia/observables (cuando se habilite):** tratarlos como **tabla de primera clase** (tipo,
valor, tags/taxonomía, acción por capability) — el patrón más valioso de TheHive. Nunca como
prosa. Las acciones de enriquecimiento (estilo *analyzers*) van gated y con dry-run; hoy no hay
catálogo operativo (no exponer botones sin API real).

**Cierre:** diálogo nivel 3 (con motivo) que **resume el impacto** y muestra las guardas
pendientes. Requiere `incidents.close`. «Resuelto» ≠ «Cerrado»; una remediación propuesta no es
un cierre.

---

## 4 · Respuesta — notificaciones (`/notifications`)

Patrón PagerDuty/TheHive adaptado: **entregar ≠ atender**.

- Estados honestos: `Entregada · sin acuse`, `Entrega no confirmada`, `Canal alterno`, `Fallida`,
  `Acusada por una persona`. El color del chip sigue el tono (ok/warn/fail/info/neutral), con
  rótulo.
- **Acuse** por persona (`notifications.read`). El despacho normal lo hace el worker; **«Despachar
  ahora»** es excepcional y solo con `notifications.dispatch` (líder/admin): confirmación que
  resume a quién y por qué.
- **Avisos push** (`/settings/notifications`): opt-in por dispositivo (VAPID), prueba y baja. El
  service worker recupera pendientes autenticados; **no** almacena contenido.

UX: nunca sugerir que una notificación entregada fue atendida. La remediación de endpoints **no**
está implicada por un despacho de notificación (doc 10).

---

## 5 · Auditoría e integridad (`/audit`, `/audit/integrity`)

- Densidad compacta, lectura sin cambios de estado (`audit.read`); datos sensibles con
  **política de redacción** (`audit.read_sensitive`).
- **Verificación de cadena** (`audit.verify`): la integridad se *comprueba*, con resultado
  explicado, no un sello decorativo.
- Todo evento conserva `correlationId` para cruzar con un error que vio la persona.

---

## 6 · Patrones transversales (lo que hace usable todo lo anterior)

### 6.1 Teclado primero (operación de turno)
- **`Ctrl/Cmd + K`**: paleta «Ir a» — salta a cualquier vista permitida y a acciones comunes.
  Solo lista lo que la sesión permite.
- **`[`**: colapsa/expande el riel. **`Escape`**: cierra drawer/paleta/diálogo.
- Orden de tabulación lógico; foco visible (único uso de sombra permitido).

### 6.2 Estados de datos (siempre explicables)
Cargando (skeleton tras 300 ms) · Vacío (instruye) · Vacío por filtros · Parcial · Degradado ·
Viejo/stale · Error (con `correlationId` + reintentar). Un panel que falla **no** tumba los
demás (cada sección captura su error).

### 6.3 Confirmación proporcional al impacto (doc 06 §6)
- **Nivel 1 – directo:** acciones reversibles/bajo impacto (acusar, filtrar).
- **Nivel 2 – confirmación en línea (≈4 s, deshacer):** cambios de estado comunes (triar).
- **Nivel 3 – diálogo con motivo:** alto impacto o irreversible (cerrar incidente, revocar
  sesión, despacho manual). Siempre **resume el impacto** antes de ejecutar.

### 6.4 Concurrencia y verdad del servidor
- `expectedRevision` en comandos de estado; sin *optimistic update*. CSRF en mutaciones.
- La UI relee la sesión; las capabilities mandan. Acción sin capability: **ausente**, no
  deshabilitada ni enumerada (no se revela lo que no se tiene).

### 6.5 Actualización en vivo
- Intervalos sobrios (p. ej. 15 s/30 s) o manual según vista; realce breve de filas nuevas
  (`soc-live-arrival`), anulado con `prefers-reduced-motion`. Nunca animación sin acción.

### 6.6 Errores
- Catálogo contractual; cada error muestra texto accionable + `correlationId` copiable. Nada de
  stack traces ni mensajes internos.

---

## 7 · Qué toma QAPAQ de TheHive (y qué no)

**Toma (concepto):** cola→caso, workspace tabulado, bitácora append-only con timeline, evidencia
como datos, severidad/estado como chips consistentes, promoción de alerta a investigación.

**No toma:** su base Material (sombras, ripples, acentos saturados), ni su CSS/markup (AGPL). El
look es el de QAPAQ (doc 11/17): negro `#080808`, bordes+superficie, sin sombras, ámbar solo en
selección, tipografía de sistema, densidad de turno.

---

## 8 · Antipatrones (rechazar en revisión)

- KPIs vacíos, tendencias desde una página parcial, cifras sin ventana de tiempo.
- «Online»/verde por ausencia de error; fuente «sana» por consulta vacía; caso «cerrado» por
  una remediación solo propuesta.
- Controles sin acción conectada; acciones visibles sin capability; confirmaciones que no
  resumen impacto; errores sin instrucción ni `correlationId`.
- Respuesta automática con privilegio implícito (sin dry-run, alcance, aprobadores, rollback).
- Ruido visual: glow/neón, gradientes, animación sin respuesta a acción, severidad solo por color.

---

## 9 · Checklist de UX por fase

- [ ] **Salud** visible antes de triar; cero eventos = neutral.
- [ ] **Alertas**: prioridad por franja+glifo+rótulo; triaje desde drawer; acciones por
      capability; masivas con resumen de impacto; sin optimistic update.
- [ ] **Incidente**: stepper de 5 fases; tareas con guardas; bitácora append-only; timeline que
      separa ocurrencia de registro.
- [ ] **Notificaciones**: entregada ≠ acusada; despacho manual excepcional y gated.
- [ ] **Auditoría**: verificación de cadena con resultado explicado; redacción de sensibles.
- [ ] **Transversal**: `Ctrl+K`/`[`/`Esc`; 7 estados de datos; confirmación por nivel; errores
      con `correlationId`; vivo con `prefers-reduced-motion` respetado.

## 10 · Trazabilidad
- Roles/capabilities/límites: `10-vistas-por-rol-y-referencias.md`.
- Pantallas y disposición: `04-pantallas.md`. Patrones transversales: `06-patrones-de-interaccion.md`.
- Tokens/shell/«Mi sesión»: `11-mi-sesion-y-shell-spec.md`. Referencias externas: `17-estudio-de-referencia.md`.
- Specs por vista: `12`…`15` (Resumen/Operaciones, Alertas/Incidentes, Eventos/Fuentes/Notificaciones, Auditoría/Usuarios/Sesiones/Acceso).
