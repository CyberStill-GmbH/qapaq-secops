# 03 · Arquitectura de información

Estado: **especificación de diseño**. Fecha: 2026-10-02.

Define la estructura de la consola: el marco que rodea toda pantalla, la
navegación, las rutas y qué ve cada rol. Las pantallas en sí están en
[04](04-pantallas.md).

---

## 1. Marco de la aplicación

```
┌────────────┬───────────────────────────────────────────────────────────────┐
│            │ Barra superior · 52 px                                        │
│  Riel      │ [Migas]                    [Estado pipeline] [⌘K] [Sesión ▾] │
│  232 px    ├───────────────────────────────────────────────────────────────┤
│            │ Banner global (solo si hay degradación) · 36 px               │
│  Q  SecOps ├───────────────────────────────────────────────────────────────┤
│            │ Cabecera de página                                            │
│  OPERACIÓN │  Título · 20/28                        [Acción primaria]      │
│  ▍Resumen  │  Descripción de una línea · actualizado hace 12 s             │
│   Alertas  ├───────────────────────────────────────────────────────────────┤
│   Incident.│ Barra de filtros (pestañas de estado · filtros · tiempo)      │
│   Notific. ├───────────────────────────────────────────────┬───────────────┤
│            │                                               │               │
│  ANÁLISIS  │  Contenido (tabla principal)                  │  Drawer de    │
│   Eventos  │                                               │  detalle      │
│            │                                               │  480 px       │
│  GOBIERNO  │                                               │               │
│   Auditoría│                                               │               │
│            │                                               │               │
│  ───────── │                                               │               │
│  Mi sesión │                                               │               │
│  [demo]    │                                               │               │
└────────────┴───────────────────────────────────────────────┴───────────────┘
```

### 1.1 Riel lateral

- Fondo `--surface-rail`, borde derecho `--border-default`.
- Arriba: marca Q (la misma imagen del login, 28 px) y el texto "SecOps" en
  `--type-heading`. Sin eslogan.
- Grupos con `--type-label`: **OPERACIÓN**, **ANÁLISIS**, **PLATAFORMA**,
  **GOBIERNO**. Un grupo sin ítems visibles **no se renderiza**, ni su rótulo.
- Ítem: icono 18 px + rótulo 13 px, alto 36 px. Activo: texto `--text-1`,
  fondo `--surface-2` e **indicador ámbar de 2 px** a la izquierda.
- Contador opcional a la derecha del ítem, en mono tabular `--text-3`: número
  de alertas abiertas, notificaciones sin acuse. Nunca un punto rojo sin número.
- Abajo: "Mi sesión" y, mientras haya mocks, el chip **Demostración** en ámbar.
- Colapsable a 56 px con `[`; el estado se recuerda por navegador.

### 1.2 Barra superior

De izquierda a derecha:

1. **Migas**: `Sección / Elemento`. El elemento actual en `--text-1`, no
   enlazado. Los identificadores en mono abreviado.
2. **Indicador de pipeline** (`PipelineStatusPill`): `HealthMark` + texto corto
   ("Ingesta al día", "Ingesta con retraso · 7 min", "Sin datos de salud").
   Siempre visible. Clic → panel de salud. Mientras C-15 no tenga API, muestra
   el estado de `/health/ready` del BFF con el rótulo honesto "API disponible"
   y **no** el de la ingesta ([06 · §3](06-patrones-de-interaccion.md#3-estados-de-datos)).
3. **Paleta de comandos** `Ctrl K`: campo en píldora con el atajo visible.
4. **Menú de sesión**: identificador del usuario, rol(es), método de
   autenticación (`amr`), cerrar sesión.

### 1.3 Banner global

Una sola franja bajo la barra superior, solo cuando hay una condición que
invalida lo que el usuario ve en **cualquier** pantalla:

| Condición | Texto |
| --- | --- |
| Pipeline `degraded`/`failed` | "La ingesta está degradada desde 14:02. *Sin alertas nuevas no significa sin actividad.* Ver cobertura" |
| Teams caído con críticas pendientes | "Las notificaciones a Teams fallan. Hay 2 alertas P1 que solo se ven en esta consola." |
| Modo demostración | No usa el banner; usa el chip del riel y de la barra superior |

Fondo `--surface-1`, borde inferior en el color de estado, glifo y texto. No se
puede cerrar mientras la condición persiste.

---

## 2. Navegación y rutas

Rutas bajo el `basePath` configurado. Cada ruta declara la capability que
**habilita el ítem del riel**. Sin esa capability, la ruta responde con la
pantalla "No disponible" (igual que una ruta inexistente).

| Grupo | Ítem | Ruta | Capability | Nivel |
| --- | --- | --- | --- | --- |
| OPERACIÓN | Resumen | `/` | cualquier sesión | API (parcial) |
| OPERACIÓN | Alertas | `/alerts` · `/alerts/:id` | `alerts.read` | API |
| OPERACIÓN | Incidentes | `/incidents` · `/incidents/:id` | `incidents.read` | API |
| OPERACIÓN | Notificaciones | `/notifications` | `notifications.read` | API |
| ANÁLISIS | Eventos | `/events` · `/events/:recordId` | `events.read` | DOMINIO |
| PLATAFORMA | Salud y cobertura | `/platform/health` | *pendiente de catálogo* | DOMINIO |
| PLATAFORMA | Cuarentena | `/platform/quarantine` | *pendiente de catálogo* | DOMINIO |
| PLATAFORMA | Credenciales | `/platform/credentials` | `secrets.write` | DOMINIO |
| GOBIERNO | Auditoría | `/audit` | `audit.read` | API |
| GOBIERNO | Integridad | `/audit/integrity` | `audit.verify` | API |
| — | Mi sesión | `/me` | cualquier sesión | API |
| — | Error | `/errors/:code` | pública | API (catálogo local) |

Ítems de nivel DOC (reglas, accesos, playbooks, casos) **no aparecen** en el
riel hasta que exista dominio. Ver [08 · §3](08-brechas-y-decisiones.md#3-funcionalidad-planificada-sin-backend).

**El estado de la vista vive en la URL.** Filtros, pestaña de estado, ventana
temporal y elemento abierto en el drawer se reflejan en la consulta
(`/alerts?status=new&open=0192…`). Un analista puede pegar la URL en el canal
del turno y el compañero ve lo mismo. El cursor de paginación **no** va en la
URL (es opaco y caduca).

Los enlaces de Teams llevan a `/incidents/:id` o `/alerts/:id`
(`modules/soar/src/teams-payload.ts`). Esas rutas deben abrir la lista con el
drawer abierto sobre ese elemento, y tras iniciar sesión volver a ellas.

---

## 3. Composición por rol

Se compone por capability. La tabla traduce las capabilities de cada rol real
([01 · §2.1](01-inventario-backend.md#21-roles-y-capabilities-efectivas)) a lo
que aparece.

| | Analista | Líder SOC | Auditor | Admin. plataforma |
| --- | :-: | :-: | :-: | :-: |
| Resumen | ● | ● | ● reducido | ● reducido |
| Alertas | ● | ● | — | — |
| Incidentes | ● | ● + cerrar | ● lectura | — |
| Notificaciones | ● | ● | — | — |
| Eventos (DOMINIO) | ● | ● + raw | — | — |
| Auditoría | — | ● | ● + datos sensibles | ● |
| Integridad | — | — | ● | ● |
| Credenciales (DOMINIO) | — | — | — | ○ cuando `secrets.write` sea efectiva |

● visible · ○ condicionado · — ausente (no se renderiza).

### 3.1 Qué ve primero cada rol en el Resumen

El Resumen responde una pregunta distinta por rol. Se ordena por capability,
no por nombre de rol, para que un usuario con dos roles vea la unión.

| Si tiene… | Primera sección | Pregunta |
| --- | --- | --- |
| `alerts.triage` | **Mi cola**: alertas asignadas a mí y alertas `new` sin asignar | ¿Qué atiendo ahora? |
| `incidents.close` | **Incidentes listos para cerrar** (`resolved`) y abiertos por severidad | ¿Qué está atascado? |
| `notifications.read` | **Críticas sin acuse humano** | ¿Alguien vio la P1? |
| `audit.verify` | **Integridad de la cadena** (último `verify`) | ¿Puedo confiar en el registro? |
| `audit.read` | **Actividad sensible reciente**: inicios de sesión denegados, cierres de incidente | ¿Qué pasó y quién? |

Detalle de cada sección: [04 · §1](04-pantallas.md#1-resumen).

---

## 4. Teclado

Inspirado en las colas de Splunk ES y Sentinel. Atajos visibles en tooltips y
en `?`.

| Tecla | Acción | Ámbito |
| --- | --- | --- |
| `Ctrl K` | Paleta de comandos: ir a pantalla, abrir por ID, acciones del elemento abierto | global |
| `g` luego `a` / `i` / `n` / `e` / `u` | Ir a Alertas / Incidentes / Notificaciones / Eventos / Auditoría | global |
| `/` | Foco en el filtro de la tabla | listas |
| `j` / `k` | Fila siguiente / anterior | listas |
| `Enter` | Abrir la fila en el drawer | listas |
| `Esc` | Cerrar drawer o diálogo, devolver foco a la fila | global |
| `a` | Reconocer (si el comando está disponible) | drawer de alerta |
| `t` | Abrir formulario de triaje | drawer de alerta |
| `x` | Seleccionar fila | listas |
| `[` | Colapsar o expandir el riel | global |
| `?` | Lista de atajos | global |

Los atajos de una letra se desactivan dentro de campos de texto. Ningún atajo
**ejecuta** una acción irreversible: `t` abre el formulario, no triaja.

---

## 5. Paleta de comandos

Una sola entrada para todo lo que se puede hacer sin ratón.

- **Ir a**: pantallas visibles para el usuario (las mismas del riel; nunca
  sugiere una que no tiene).
- **Abrir por identificador**: pegar un `id` de alerta o incidente, o un
  `correlationId` (abre `/audit` filtrado por esa correlación cuando el
  usuario tiene `audit.read`).
- **Acciones del elemento abierto**: los comandos válidos según estado,
  capability y asignación (las mismas reglas del drawer).

Resultados agrupados con `--type-label`; el seleccionado con `--surface-2`.
Sin iconos de colores, sin "sugerencias de IA".
