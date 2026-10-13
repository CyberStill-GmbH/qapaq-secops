# 17 · Estudio de referencia — TheHive · Vercel · Railway · Cloudflare

**Estado:** notas de diseño (2026-10-13). **Qué es:** destilado de patrones de productos
maduros para *inspirar* el sistema QAPAQ. **Qué NO es:** permiso para copiar CSS/markup ni
clonar un look. Regla de `10-vistas-por-rol-y-referencias.md`: «estudiar comportamientos y
contratos; implementar el concepto adecuado a QAPAQ; registrar licencia/atribución al reutilizar».

> Importante sobre licencias: **TheHive es AGPL-3.0.** Se estudia su *comportamiento* (cómo
> organiza casos/observables), nunca se copia su código ni su CSS. Vercel/Railway/Cloudflare son
> productos propietarios: tampoco se copian assets ni estilos; se estudian principios públicos.

El objetivo es que la consola se vea **intencional y de una sola pieza**, no un Frankenstein.
QAPAQ ya tiene sistema propio (negro `#080808`, ámbar de selección, bordes+superficie, sin
sombras, tipografía de sistema); lo de abajo lo **refuerza**, no lo reemplaza.

---

## TheHive (SOC / respuesta a incidentes · AGPL)

**Qué hace bien (comportamiento a estudiar):**
- **Detalle de caso con pestañas** (Resumen / Observables / Tareas / TTPs / Timeline). QAPAQ ya
  lo refleja en `IncidentWorkTabs` (Tareas/Bitácora/Timeline).
- **Observables como tabla de primera clase** con tipo, tags (taxonomías), y acciones de
  enriquecimiento (analyzers). Enseña a tratar la evidencia como datos navegables, no prosa.
- **Severidad y TLP como chips** con rótulo + color, consistentes en toda la app.
- **Cola de alertas → promoción a caso**: flujo claro de triaje a investigación.

**Qué tomar para QAPAQ (concepto, no CSS):**
- Mantener el **detalle como workspace tabulado** y la **bitácora append-only** con timeline que
  distingue ocurrencia de registro (ya en doc 10).
- Si se habilitan observables/evidencia, que sean **tabla con tipo + acción por capability**, no
  texto libre.

**Qué NO imitar:**
- Su base Material (sombras, ripples, acentos saturados) choca con el sistema sin-sombra de
  QAPAQ. Nada de elevación Material ni colores saturados.

---

## Vercel (plataforma de despliegue · propietario)

**Principios públicos a estudiar:**
- **Restricción radical:** blanco/negro, **bordes finos** (1px) para separar, casi sin sombras,
  tipografía limpia, mucho aire *disciplinado*.
- **Mono para valores técnicos** (hashes, dominios, IDs).
- **Estado por punto/rótulo** sobrio (Ready / Error / Building), nunca neón.
- **Jerarquía por tamaño y peso**, no por color.

**Qué tomar para QAPAQ:**
- Reforzar la **disciplina de borde**: separar paneles con `1px --border-default` sobre
  `--surface-1`, sin sombras — exactamente el camino actual.
- **Mono (`--font-mono`) para todo valor técnico** (subjectId, tenant, digests, capability ids,
  correlationId). Ya es la dirección; hacerlo universal y consistente (clase `.soc-code`).
- Contención del color: color = estado/severidad/selección, nunca decoración (ya normado).

**Qué NO imitar:**
- El fondo **blanco** por defecto: QAPAQ es dark-first (`#080808`). Ni la generosidad de espacios
  de una landing: la consola es densa, de turno.

---

## Railway (plataforma de despliegue · propietario)

**Principios públicos a estudiar:**
- **Timelines de despliegue/actividad** muy legibles: qué pasó, cuándo, en qué estado, con logs
  a un clic.
- **Tarjetas redondeadas** con estado claro y **buenos estados vacíos** (explican el siguiente
  paso).
- Comunicación de estado honesta por deploy (Building / Live / Crashed / Removed).

**Qué tomar para QAPAQ:**
- El **timeline** de Railway valida el enfoque de `/incidents/:id` (timeline) y las
  «transiciones recientes» de `/sources`: evento + marca de tiempo + estado + razón.
- **Estados vacíos que instruyen** (sin inventar salud): «Sin actividad en 24 h», con contexto.

**Qué NO imitar:**
- Su **acento neón/gradientes** y el tono lúdico. QAPAQ prohíbe glow/gradientes; el acento es el
  ámbar sobrio solo en selección.

---

## Cloudflare (dashboard de seguridad/red · propietario)

**Principios públicos a estudiar:**
- **Densidad de dashboard** sostenible: tablas densas legibles, navegación agrupada por dominio.
- **Analítica con ventana de tiempo definida** siempre visible (último N; nunca una cifra sin
  período).
- **Estado del servicio a la vista** y navegación lateral por secciones.

**Qué tomar para QAPAQ:**
- La **ventana de tiempo explícita** es ley en QAPAQ: `/sources` mide en **24 h**; `/events`
  limita a **31 días**; cualquier conteo declara su período (anti «tendencia desde página
  parcial»).
- **Navegación agrupada** (Operación / Configuración / Análisis / Gobierno) — ya existe en el
  riel; mantener los eyebrows uppercase.
- Densidad de tabla al estilo dashboard, con `tabular-nums` (ya global).

**Qué NO imitar:**
- Su **naranja de marca** como acento de UI, ni KPIs grandes sin definición (prohibido por doc 10).

---

## Síntesis: reglas QAPAQ reforzadas por el estudio

1. **Separar con borde + superficie, nunca con sombra** (Vercel). `1px --border-default` sobre
   `--surface-1`.
2. **Mono universal para valores técnicos** (Vercel) → clase `.soc-code` reutilizable.
3. **Toda métrica con ventana de tiempo explícita** (Cloudflare). Sin período no se muestra cifra.
4. **Timelines legibles** (Railway/TheHive): evento + hora + estado + razón; distinguir
   ocurrencia de registro.
5. **Detalle como workspace tabulado**, evidencia como tabla por capability (TheHive).
6. **Estados vacíos que instruyen** sin inventar salud (Railway), con honestidad de estado.
7. **Densidad de turno** (Cloudflare) con navegación agrupada y `tabular-nums`.
8. **Color contenido**: estado/severidad/selección. Cero neón, cero gradiente, cero color de
   marca ajena (contra todos los anteriores salvo donde QAPAQ ya es sobrio).

## Lo que explícitamente se descarta de cada referencia

- Material/sombras/ripples de TheHive.
- Fondo claro y aire de landing de Vercel.
- Neón/gradiente/tono lúdico de Railway.
- Naranja de marca y KPIs sin definición de Cloudflare.

El resultado buscado: la disciplina de borde y tipografía de Vercel + la densidad y ventanas de
tiempo de Cloudflare + los timelines y estados vacíos de Railway + la estructura de caso de
TheHive, **todo expresado con los tokens propios de QAPAQ** (doc 11) y sin un solo pixel copiado.
