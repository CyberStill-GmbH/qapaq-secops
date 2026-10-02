# 07 · Accesibilidad, rendimiento y criterios de calidad

Estado: **especificación de diseño**. Fecha: 2026-10-02.

El nivel WCAG oficial está abierto (U-014). Esta especificación adopta
**WCAG 2.2 AA** como objetivo de diseño hasta que U-014 se resuelva; si la
decisión fija otro nivel, este documento se ajusta.

---

## 1. Accesibilidad

### 1.1 Percepción

- Contraste: 4.5:1 en texto normal, 3:1 en texto ≥ 18 px y en bordes de
  controles. Los tokens de [02 · §2](02-sistema-visual.md#2-color) cumplen;
  `--text-4` queda fuera de todo texto informativo.
- **El color nunca comunica solo**: severidad con glifo + rótulo, estado con
  texto, error con glifo ×.
- Zoom al 200 % sin pérdida de contenido; en ≤ 1024 px el drawer pasa a
  pantalla completa.
- `prefers-reduced-motion` elimina toda animación (regla global ya existente).

### 1.2 Operación

- Todo es alcanzable por teclado; el orden de foco sigue el visual.
- Foco visible siempre: anillo 2 px `--focus-ring`, `offset` 3 px (como el
  login). Nunca `outline: none` sin sustituto.
- Atajos de una letra desactivables desde `/me` (criterio 2.1.4).
- Área de acción mínima 24 × 24 px (2.5.8 AA); los botones de acción en
  filas tienen 32 × 32 px.
- `Dialog` atrapa el foco y lo devuelve al disparador; `Drawer` modal igual.
- Enlace "Saltar al contenido" como primer elemento enfocable.

### 1.3 Comprensión y robustez

- `lang="es"` en el documento (ya presente en `index.html`).
- Todo campo tiene `<label>`; errores ligados con `aria-describedby` y
  `aria-invalid`.
- Cambios asíncronos por región viva `polite`: "23 alertas cargadas",
  "Alerta reconocida", "Error: el elemento cambió". Errores bloqueantes con
  `assertive`.
- Tablas con `<th scope>` y `aria-sort`; la fila activa con
  `aria-selected`.
- Gráficos (si se agregan) con tabla equivalente.

---

## 2. Rendimiento percibido

Presupuestos del frontend, coherentes con los del backend (p95 lectura
< 300 ms, escritura < 500 ms; `toolchain-and-capacity.md`).

| Métrica | Presupuesto |
| --- | --- |
| JS inicial de la consola (gzip) | ≤ 180 KB |
| Primera pantalla útil (LCP) en red corporativa | ≤ 1.5 s |
| Respuesta a interacción (INP) | ≤ 200 ms |
| Render de 200 filas en la tabla | ≤ 50 ms; virtualizar por encima de 500 |
| Esqueleto | solo si la respuesta tarda > 300 ms |
| Fuentes web | 0 (pila del sistema) |

Los listados llegan en páginas de 50 (máximo 200). La tabla virtualiza cuando
"Cargar más" acumula más de 500 filas en memoria.

---

## 3. Navegadores y pantallas

| Objetivo | Valor |
| --- | --- |
| Navegadores | Edge y Chrome de las dos últimas versiones estables (estaciones Windows con Entra); Firefox ESR como secundario |
| Resolución principal | 1920 × 1080 y 2560 × 1440 |
| Mínima soportada | 1280 × 720 con riel colapsado |
| Móvil | Solo lectura de alerta/incidente desde el enlace de Teams (≥ 360 px): drawer a pantalla completa, sin tablas |

---

## 4. Lista de revisión de un PR de interfaz

Un PR de pantalla o componente no se aprueba si falla alguno:

**Contrato**
- [ ] Usa rutas y campos de [01](01-inventario-backend.md), no de `admin.ts`.
- [ ] Todo comando envía `expectedRevision` y maneja 409.
- [ ] Valida en cliente las reglas de [01 · §4](01-inventario-backend.md#4-reglas-de-negocio-que-la-interfaz-debe-aplicar-antes-de-enviar).
- [ ] Pantalla DOMINIO envuelta en `DemoBoundary`.

**Autorización**
- [ ] Acciones sin capability ausentes, no deshabilitadas.
- [ ] Decide por capability, nunca por rol.
- [ ] 404 por permiso e inexistencia idénticos.

**Estados**
- [ ] Carga, vacío, vacío por filtros, parcial, degradado, viejo y error
      implementados y distinguibles.
- [ ] Error con `correlationId` copiable.

**Sistema visual**
- [ ] Sin literales de color, espaciado ni radio en componentes.
- [ ] Ninguno de los antipatrones de [02 · §9](02-sistema-visual.md#9-antipatrones-prohibidos).
- [ ] Como máximo un botón primario por vista y tres usos de ámbar por pantalla.
- [ ] Números y horas con `tabular-nums`; identificadores en mono.

**Accesibilidad**
- [ ] Operable por teclado de principio a fin.
- [ ] axe sin violaciones serias o críticas.
- [ ] Textos desde el catálogo.

---

## 5. Pruebas

| Tipo | Herramienta | Cubre |
| --- | --- | --- |
| Unidad | Vitest | `CommandAvailability` (todas las combinaciones estado × capability × asignación), formateadores, catálogo |
| Componente | Vitest + Testing Library | Primitivas y componentes de estado |
| Extremo a extremo | Playwright contra el BFF local (`local-development`) | Por principal local: `analista@`, `lider@`, `auditor@`, `sinrol@` — lo que ve, lo que no ve, triaje completo, cierre de incidente con alertas pendientes, 409 con dos sesiones |
| Accesibilidad | `@axe-core/playwright` | Cada pantalla en cada estado |
| Visual | capturas de Playwright | Resumen, cola, drawer, diálogo de cierre, en 1920 y 1280 |

No existe principal local para `qapaq.platform.admin`; se necesita para probar
su composición ([08 · B-10](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)).
