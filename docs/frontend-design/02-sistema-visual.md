# 02 · Sistema visual

Estado: **especificación de diseño**. Fecha: 2026-10-02.

La consola continúa la pantalla de inicio de sesión
([`login.css`](../../apps/web/src/app/login.css),
[`styles.css`](../../apps/web/src/app/styles.css),
[`HeroArt.tsx`](../../apps/web/src/components/login/HeroArt.tsx)). El usuario no
debe notar un cambio de producto entre la pantalla de acceso y la primera
pantalla de trabajo. El lenguaje es el del login: negro casi puro, grises
neutros, tipografía de sistema con tracking negativo en titulares, controles en
píldora con borde de 1 px y un único acento cálido.

Lo que cambia es la **densidad**. El login es una pantalla de una sola decisión;
la consola es una herramienta que se usa ocho horas seguidas. Por eso la consola
toma la paleta y la tipografía del login, pero **no** su escala, su aire ni sus
efectos de luz.

---

## 1. Principios

| # | Principio | Consecuencia verificable |
| --- | --- | --- |
| P1 | **El dato es la interfaz.** | Ningún elemento decorativo ocupa más superficie que el dato que acompaña. No hay ilustraciones, mascotas ni imágenes de stock dentro de la consola. |
| P2 | **Negro, gris y un acento.** | El color de estado (severidad, salud) es el único color saturado de la pantalla. Si algo es de color y no es un estado, es un defecto. |
| P3 | **Densidad de herramienta, no de folleto.** | Una tabla operativa muestra al menos 18 filas en 1080 px de alto en densidad `compacta`. |
| P4 | **Superficie por luminosidad, no por sombra.** | La profundidad se expresa con 4 niveles de gris. No hay `box-shadow` en tarjetas, paneles ni filas; solo en capas flotantes (§7). |
| P5 | **Movimiento solo para explicar un cambio de estado.** | Nada se anima "para dar vida". Toda animación tiene una causa en el dato (llegó, cambió, se fue) o en la navegación (abrir, cerrar). |
| P6 | **Texto concreto.** | Cada rótulo dice qué es el dato y en qué unidad. Nunca "Insights", "Overview" sin objeto, "¡Todo listo!" ni signos de exclamación. |

---

## 2. Color

Los valores salen del login y de [`admin-theme.css`](../../apps/web/src/app/admin-theme.css).
Se declaran como variables CSS en `src/design/tokens.css`. **Ningún componente
contiene un literal de color** (ver [06 · §8](06-patrones-de-interaccion.md#8-reglas-de-código-de-estilos)).

### 2.1 Superficies

Cuatro niveles. Cada nivel sube luminosidad; nunca se usa transparencia sobre
contenido para "simular" un nivel.

| Token | Valor | Uso |
| --- | --- | --- |
| `--surface-0` | `#080808` | Fondo de la aplicación. Mismo valor que el login y `theme-color`. |
| `--surface-rail` | `#050505` | Riel de navegación lateral. Más oscuro que el fondo para que el contenido "venga hacia adelante". |
| `--surface-1` | `#0d0d0f` | Paneles, tablas, cabeceras de sección. |
| `--surface-2` | `#131315` | Fila en hover, celda seleccionada, campo de formulario. Igual que el hover del botón Entra. |
| `--surface-3` | `#1a1a1c` | Capas flotantes: menú, popover, diálogo, drawer. Igual que el hover del símbolo Q. |
| `--surface-selected` | `#17140f` | Fila seleccionada o elemento activo. Gris con un punto de ámbar, no ámbar. |

### 2.2 Texto

| Token | Valor | Contraste sobre `#080808` | Uso |
| --- | --- | --- | --- |
| `--text-1` | `#f4f4f5` | 18.6:1 | Titulares, valor de una celda, dato principal |
| `--text-2` | `#b0b0b5` | 9.4:1 | Texto secundario, subtítulos, descripciones |
| `--text-3` | `#8f8f95` | 6.1:1 | Metadatos, cabeceras de tabla, marcas de tiempo relativas |
| `--text-4` | `#6e6e74` | 3.8:1 | **Solo** texto ≥ 18 px o texto decorativo no informativo (separadores `·`) |
| `--text-inverse` | `#080808` | — | Texto sobre botón primario blanco |

`--text-4` no se usa nunca en un dato que el analista tenga que leer. El
`#67676b` que hoy usan las migas de pan no alcanza 4.5:1 y se sustituye por
`--text-3`.

### 2.3 Bordes

| Token | Valor | Uso |
| --- | --- | --- |
| `--border-subtle` | `#1f1f22` | Separador entre filas de tabla |
| `--border-default` | `#29292d` | Contorno de paneles y secciones |
| `--border-control` | `#49494e` | Contorno de botones y campos (igual que el botón Entra) |
| `--border-control-hover` | `#85858b` | Hover de control |
| `--border-strong` | `#929297` | Control activo o con foco por puntero |
| `--focus-ring` | `#f5f5f5` | Anillo de foco por teclado: 2 px, `offset` 3 px. Igual que el login. |

### 2.4 Acento de marca

| Token | Valor | Dónde sí | Dónde no |
| --- | --- | --- | --- |
| `--brand-amber` | `#c49a5a` | Indicador de 2 px del ítem activo del riel; marca Q; chip de modo demostración | Botones, enlaces, gráficos, severidad, fondos de tarjeta |
| `--brand-amber-text` | `#e0bd80` | Texto del chip de modo demostración | Cualquier otro texto |

El ámbar es la luz del login. En la consola aparece **como máximo en tres
lugares por pantalla**. Si un diseño necesita un cuarto, el diseño está mal.

### 2.5 Estado y severidad

El backend expone **dos escalas distintas** que no se deben fundir
([01 · §3](01-inventario-backend.md#3-enumeraciones-exactas)):

- `priority` de alerta: `P1`…`P4`.
- `severity` de incidente: `critical`, `high`, `medium`, `low`.

Ambas comparten la misma rampa de color para que P1 y `critical` se lean igual,
pero el rótulo es siempre el del backend.

| Paso | Token | Valor | Luminosidad relativa | Alerta | Incidente | Glifo |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `--sev-1` | `#ff5f57` | media-alta | `P1` | `critical` | ◆ rombo lleno |
| 2 | `--sev-2` | `#f0904a` | alta | `P2` | `high` | ▲ triángulo |
| 3 | `--sev-3` | `#d8c35c` | muy alta | `P3` | `medium` | ■ cuadrado |
| 4 | `--sev-4` | `#7f95aa` | media-baja | `P4` | `low` | ● círculo |

Regla de lectura: **rótulo + glifo + color**, siempre los tres. El glifo cambia
de forma por paso para que la severidad se distinga en escala de grises, en
daltonismo y en un proyector de sala de crisis. El rombo es la única forma
"aguda" llena, reservada para lo peor.

Fondo tenue de severidad (para la franja izquierda de una fila o el fondo de un
chip): mismo tono al 12 % sobre `--surface-1`. Nunca una fila entera pintada.

**Salud y resultado** (servicios, notificaciones, auditoría):

| Token | Valor | Significado | Glifo |
| --- | --- | --- | --- |
| `--state-ok` | `#5fb98a` | Operativo, entregado, verificado, `succeeded` | ✓ |
| `--state-warn` | `#d8c35c` | Degradado, indeterminado, en reintento | ! |
| `--state-fail` | `#ff5f57` | Caído, fallido, cadena de auditoría rota, `denied` | × |
| `--state-neutral` | `#8f8f95` | Pendiente, sin verificar, sin datos | – |
| `--state-info` | `#8fb3d9` | Informativo, en curso | i |

El glifo es el de la `HealthMark` del login (círculo de 15 px con símbolo
centrado). La consola reutiliza ese componente, no inventa otro.

### 2.6 Lo que el color no hace

- **No hay gradientes** en la consola. La única excepción es la luz del panel
  de marca del login, que no se reutiliza dentro de la aplicación.
- **No hay color de "categoría"** (azul para red, verde para identidad…). Las
  categorías se distinguen por texto.
- **No hay fondos de color en tarjetas de métrica.** Un número crítico se marca
  con el glifo y el color del texto del número, no con una tarjeta roja.
- **No hay modo claro en la primera entrega.** Un SOC trabaja en salas con poca
  luz y en turnos nocturnos; el login ya fija `color-scheme: dark`. Los tokens
  se estructuran para admitir un modo claro después sin tocar componentes.

---

## 3. Tipografía

### 3.1 Familias

| Token | Pila | Uso |
| --- | --- | --- |
| `--font-sans` | `'Segoe UI', Inter, ui-sans-serif, system-ui, sans-serif` | Toda la interfaz. Es la pila del login. |
| `--font-mono` | `'Cascadia Mono', 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace` | Identificadores, hashes, IPs, `correlationId`, `revision`, secuencia de auditoría, códigos de error, JSON |

No se cargan fuentes web. La pila del sistema es más rápida, coincide con el
login y en las estaciones Windows del SOC resuelve a Segoe UI y Cascadia Mono,
que ya están instaladas.

`font-variant-numeric: tabular-nums` es **obligatorio** en tablas, marcas de
tiempo, contadores y métricas. Una columna de números que "baila" al
actualizarse es ilegible en una cola en vivo.

### 3.2 Escala

Escala corta. Cinco tamaños cubren la consola; el resto es un defecto.

| Token | Tamaño / interlineado | Peso | Tracking | Uso |
| --- | --- | --- | --- | --- |
| `--type-display` | 28 / 36 | 480 | -0.035em | Solo el título de la pantalla vacía o de error a pantalla completa (mismo carácter que el `h1` del login) |
| `--type-title` | 20 / 28 | 480 | -0.025em | Título de página |
| `--type-heading` | 15 / 22 | 550 | -0.01em | Título de sección, de panel, de drawer |
| `--type-body` | 13 / 20 | 400 | 0 | Cuerpo, celdas de tabla, formularios |
| `--type-small` | 12 / 16 | 400 | 0 | Metadatos, ayudas de campo, marcas de tiempo |
| `--type-label` | 11 / 14 | 600 | +0.06em, mayúsculas | Cabeceras de grupo del riel y de tabla. **Nunca** en un dato. |

Pesos permitidos: 400, 480, 550, 600. El 480 es el del login: da al titular un
tono serio sin la pesadez del 700. **No se usa 700 ni 800** en ningún sitio.

Mono: un paso por debajo del texto que acompaña (12 px en una celda de 13 px),
porque el monoespaciado se ve ópticamente más grande.

### 3.3 Reglas de escritura

- Mayúscula inicial solo en la primera palabra: "Abrir incidente", no "Abrir
  Incidente".
- Sin signos de exclamación. Sin emojis. Sin "¡Ups!".
- Verbos de acción en infinitivo en botones: "Reconocer", "Cerrar alerta".
  Nunca "Enviar" o "Aceptar" genéricos cuando la acción tiene nombre.
- Unidades explícitas: "hace 4 min", "5 de 5 intentos", "30 min de
  inactividad".
- Los valores del backend se traducen con un catálogo
  ([01 · §3](01-inventario-backend.md#3-enumeraciones-exactas)); el valor crudo
  (`true_positive`) aparece en mono solo en vistas técnicas (auditoría, JSON).

---

## 4. Espaciado, rejilla y densidad

### 4.1 Escala

Base de 4 px: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 ·
`--space-5` 20 · `--space-6` 24 · `--space-8` 32 · `--space-12` 48.

No hay valores intermedios (6, 10, 14, 18). El login tiene algunos (`13px 15px`,
`22px`) porque es una composición única; la consola no.

### 4.2 Densidad

Dos densidades, elegibles por el usuario y recordadas por navegador (preferencia
cosmética, no estado operativo):

| Densidad | Alto de fila | Relleno de celda | Tipo de celda | Por defecto en |
| --- | --- | --- | --- | --- |
| `compacta` | 32 px | 6 × 12 | 13 px | Colas, auditoría, notificaciones |
| `cómoda` | 40 px | 10 × 12 | 13 px | Listas de incidentes, formularios |

El objetivo táctil de 44 × 44 px (§[07](07-accesibilidad-y-calidad.md)) se
cumple en controles de acción; una fila de 32 px no es un control táctil, su
botón de acción sí tiene área de 44 px por relleno.

### 4.3 Rejilla de pantalla

- Riel lateral fijo de **232 px** (expandido) o **56 px** (colapsado).
- Barra superior de **52 px**.
- Contenido con margen lateral de 24 px; máximo útil **sin límite** en
  pantallas de trabajo: un SOC usa monitores de 27" y la tabla debe crecer.
- Pantallas de lectura larga (detalle de error, ayuda) se limitan a 72
  caracteres de medida.
- Drawer de detalle: **480 px** por defecto, redimensionable entre 400 y 720 px.

### 4.4 Radios

| Token | Valor | Uso |
| --- | --- | --- |
| `--radius-pill` | `999px` | Botones, chips, campo de búsqueda global. Es la firma del login. |
| `--radius-control` | `7px` | Selects, campos de texto, textarea |
| `--radius-panel` | `9px` | Paneles, diálogos, el bloque `auth-contract` del login |
| `--radius-none` | `0` | Tablas y filas: una tabla con esquinas redondeadas por fila parece una lista de tarjetas |

---

## 5. Iconografía

- Trazo único de **1.65 px**, extremos redondeados, caja de 24 con dibujo en 18.
  Es el estilo de [`admin-ui.tsx`](../../apps/web/src/components/admin/admin-ui.tsx).
- Monocromos, `currentColor`. **Nunca** un icono dentro de un círculo o cuadrado
  de color (el patrón "icono en burbuja pastel" es la marca más reconocible de
  una interfaz genérica).
- Un icono acompaña a un rótulo; no lo sustituye, salvo en el riel colapsado y
  en botones de herramienta con `aria-label` y tooltip.
- Inventario cerrado. Un icono nuevo exige un uso que ningún icono existente
  cubra.

---

## 6. Movimiento

| Token | Valor | Uso |
| --- | --- | --- |
| `--motion-fast` | 120 ms | Hover, foco, cambio de color |
| `--motion-base` | 160 ms | Apertura de menú, popover, cambio de pestaña. Igual que las transiciones del login. |
| `--motion-panel` | 220 ms | Drawer y diálogo |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | La curva del login, para todo lo que entra |

Permitido:

- Entrada del drawer desde la derecha (`translateX` 16 px + opacidad).
- Fila nueva en una cola en vivo: fondo `--surface-selected` que se desvanece en
  1.2 s. **No** se desplaza la tabla: la fila nueva aparece arriba solo si el
  usuario está arriba; si no, un aviso "3 alertas nuevas · Ver" lo informa
  sin mover lo que está leyendo.
- Cambio de estado de una fila: el chip de estado cruza de un valor a otro en
  `--motion-base`.

Prohibido dentro de la consola:

- El desenfoque de entrada (`filter: blur`) del login. Es un gesto de bienvenida,
  no de herramienta.
- Contadores que "suben" desde cero, pulsos en badges, brillos, esqueletos con
  shimmer de gradiente. El esqueleto es un bloque `--surface-2` estático con una
  variación de opacidad de 0.6 a 1 en 1.4 s.
- Cualquier animación con `prefers-reduced-motion: reduce`. El login ya lo
  respeta; la consola hereda la misma regla global de
  [`login-motion.css`](../../apps/web/src/app/login-motion.css).

---

## 7. Elevación y capas

| Capa | `z-index` | Superficie | Sombra |
| --- | --- | --- | --- |
| Contenido | 0 | `--surface-0/1` | ninguna |
| Barra superior y riel | 10 | `--surface-0` / `--surface-rail` | ninguna; borde inferior `--border-default` |
| Banner de degradación global | 20 | `--surface-1` | ninguna |
| Drawer | 30 | `--surface-1` | `-16px 0 32px rgb(0 0 0 / 50%)` |
| Popover, menú, combobox | 40 | `--surface-3` | `0 8px 24px rgb(0 0 0 / 60%)` |
| Diálogo + velo | 50 | `--surface-3`; velo `rgb(0 0 0 / 64%)` | `0 16px 48px rgb(0 0 0 / 70%)` |
| Toast | 60 | `--surface-3` | igual que popover |

Sin `backdrop-filter` ni vidrio esmerilado. El velo es negro opaco al 64 %: el
contenido de atrás no debe competir con una confirmación de cierre de
incidente.

---

## 8. Identidad: cómo se reconoce QAPAQ SecOps

Lo que hace que la consola sea reconocible sin logotipo:

1. **El negro `#080808` y el tracking negativo** de los titulares, idénticos al
   login.
2. **Botones en píldora** con borde de 1 px gris; el primario es **blanco con
   texto negro** (inversión total), como la acción principal en interfaces de
   la familia de Grok. Hay como máximo **un** botón primario por vista.
3. **El glifo de severidad por forma** (◆ ▲ ■ ●), propio del producto.
4. **Mono para todo lo que se copia**: el analista aprende que lo que está en
   mono es un identificador que puede pegar en otra herramienta.
5. **El indicador ámbar de 2 px** del ítem activo: la única luz cálida de la
   pantalla, eco del panel de marca.
6. **La `HealthMark`** del login como único idioma de salud.

---

## 9. Antipatrones prohibidos

Lista de rechazo en revisión. Cada uno es un rasgo típico de interfaces
generadas o de plantilla, y cada uno resta seriedad a una herramienta de
seguridad.

| # | Prohibido | Por qué | En su lugar |
| --- | --- | --- | --- |
| A1 | Gradientes morados, azules o "aurora" en fondos, botones o tarjetas | Ruido; no comunica dato | Superficie plana `--surface-*` |
| A2 | Tarjetas con `border-radius` ≥ 16 px y sombra suave | Estética de plantilla de marketing | Panel de 9 px, borde de 1 px, sin sombra |
| A3 | Icono dentro de un círculo pastel en cada tarjeta | Decoración que no distingue nada | Icono monocromo junto al rótulo, o ninguno |
| A4 | Fila de 4 KPIs gigantes con flechas ↑ 12 % sin periodo ni base | Número sin contexto; la flecha inventa una tendencia | Métrica con periodo explícito, valor absoluto y enlace a la lista que la compone (§[05 · MetricTile](05-componentes.md)) |
| A5 | Saludo personal ("Buenos días, Ana 👋") | Ocupa la zona de mayor atención con nada | La primera línea de la pantalla es el dato más urgente |
| A6 | Emojis en rótulos, estados o mensajes | Informalidad; ambigüedad de lectura | Glifo del sistema + texto |
| A7 | Glassmorphism, `backdrop-filter: blur` | Baja el contraste del texto sobre contenido | Superficie opaca |
| A8 | Gráfico de dona para un dato de dos valores | Ocupa mucho para decir poco | Texto: "12 de 40 sin triar" + barra fina |
| A9 | Texto de relleno: "Insights", "Supercharge", "Seamless", "Potencia tu SOC" | Ninguna información | Rótulo concreto con unidad |
| A10 | Estados vacíos con ilustraciones | Infantiliza; ocupa la pantalla | Una línea de texto que explica por qué está vacío y qué hacer |
| A11 | Botones deshabilitados con tooltip "No tienes permiso" | Enumera capacidades (R2) | El botón no se renderiza |
| A12 | Animaciones de entrada escalonadas en cada tarjeta | Retrasa la lectura | Render inmediato; esqueleto solo si tarda > 300 ms |
| A13 | Badges de "NUEVO", "PRO", "BETA" | Marketing dentro de una herramienta | Nada |
| A14 | Centrado del contenido de trabajo | Las tablas se leen desde la izquierda | Alineación a la izquierda; números a la derecha |
| A15 | Datos falsos verosímiles en producción ("98.7 % uptime") | Un SOC no puede distinguir demo de realidad | Chip de modo demostración visible en la barra superior mientras haya un mock (ya existe: `mock-chip`) |
| A16 | Iconos de colores distintos por sección del riel | Compite con la severidad | Iconos `--text-3`; activo `--text-1` |
| A17 | Cursiva para énfasis, subrayado decorativo | Lectura irregular | Peso 550 o color `--text-1` |
| A18 | Paletas por defecto de librerías de gráficos | Rompe P2 | Gráficos en grises con la serie relevante en el color de estado que le corresponde |

---

## 10. Referencias de SOC reales

Se estudió la disposición de consolas en uso en centros de operación. De cada
una se toma un patrón concreto, no su estética.

| Producto | Patrón adoptado | Dónde se aplica |
| --- | --- | --- |
| Splunk Enterprise Security · *Incident Review* | Tabla densa como pantalla principal, detalle expandible sin salir de la lista, acciones masivas sobre selección | Cola de alertas ([04 · §3](04-pantallas.md#3-alertas)) |
| Microsoft Sentinel · *Incidents* | Lista a la izquierda, panel de detalle a la derecha con propietario, estado y severidad editables en cabecera | Drawer de alerta e incidente |
| Microsoft Defender XDR | Selector de tiempo y filtros persistentes en una sola barra, siempre arriba de la tabla | Barra de filtros |
| Elastic Security · *Alerts* | Contadores por estado como pestañas sobre la tabla ("Abiertas 42 · Reconocidas 8 · Cerradas") | Pestañas de estado de alertas |
| Google SecOps (Chronicle) | Línea de tiempo vertical con actor, acción e instante, sin edición | Historial de alerta e incidente (desde auditoría) |
| CrowdStrike Falcon | Severidad leída antes que el título, en la primera columna, con forma y color | Columna de prioridad |
| PagerDuty | Distinción explícita entre *entregado* y *reconocido por una persona* | Notificaciones ([04 · §6](04-pantallas.md#6-notificaciones)) |

Patrones comunes a todas, y por eso obligatorios aquí:

1. La **tabla** es la vista principal; el gráfico es secundario.
2. El **detalle se abre al lado** de la lista, no en otra página, para no perder
   la posición en la cola.
3. El **estado del pipeline** está siempre visible en la barra superior: un
   analista no debe tener que ir a buscar si los datos están llegando.
4. **Atajos de teclado** para la cola (siguiente, anterior, abrir, reconocer).
5. **Marca de tiempo absoluta disponible** en todo instante relativo, con zona
   horaria.
