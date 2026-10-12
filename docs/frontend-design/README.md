# Diseño de frontend · QAPAQ SecOps

Estado: **especificación de diseño** verificada contra el código del repositorio.
Última actualización: 2026-10-12.

Especificación de la interfaz de la consola SOC: qué pantallas existen, qué
datos muestran, cómo se ven y cómo se comportan. Parte de lo que el backend
**hace hoy**, no de lo planificado. Toma la identidad visual de la pantalla de
inicio de sesión existente.

Sustituye al análisis del 2026-10-01 (commit `cef5d9d`), que suponía C-17 y
C-18 inexistentes, ocho bundles de rol y nombres de capability y estados que
no coinciden con el código.

---

## Documentos

| # | Documento | Responde |
| --- | --- | --- |
| 01 | [Inventario funcional del backend](01-inventario-backend.md) | ¿Qué rutas, campos, estados y reglas existen realmente? |
| 02 | [Sistema visual](02-sistema-visual.md) | ¿Cómo se ve? Color, tipografía, densidad, movimiento, identidad, antipatrones y referencias de SOC reales |
| 03 | [Arquitectura de información](03-arquitectura-de-informacion.md) | ¿Cómo se organiza? Marco, navegación, rutas, composición por rol, teclado |
| 04 | [Pantallas](04-pantallas.md) | ¿Qué tiene cada pantalla? Disposición, columnas, acciones, formularios, aceptación |
| 05 | [Componentes](05-componentes.md) | ¿Con qué piezas se construye? Inventario cerrado con medidas y estados |
| 06 | [Patrones de interacción](06-patrones-de-interaccion.md) | ¿Cómo se comporta? Autorización, estados de datos, errores, concurrencia, confirmación, código de estilos |
| 07 | [Accesibilidad y calidad](07-accesibilidad-y-calidad.md) | ¿Cuándo está bien hecho? WCAG, rendimiento, navegadores, lista de revisión, pruebas |
| 08 | [Brechas y decisiones](08-brechas-y-decisiones.md) | ¿Qué falta en el backend y qué contradicciones hay que cerrar? |
| 09 | [Evaluación del frontend SOC](09-evaluacion-frontend-soc.md) | ¿Qué falencias tiene la implementación actual y qué hace falta para una consola SOC y administración operativas? |
| 10 | [Vistas por rol y referencias](10-vistas-por-rol-y-referencias.md) | ¿Qué puede ver cada perfil, qué está conectado y qué conceptos son futuros? |

Diseño de la siguiente vista conectada: [Eventos e investigación](eventos-investigacion.md).

Referencias generadas antes de implementar las vistas: [eventos/salud/cuarentena](references/eventos-salud-cuarentena-concepto.png), [operación SOC/casos](references/operacion-soc-y-casos-concepto.png), [admin Entra/auditoría](references/admin-entra-y-auditoria-concepto.png), [detección/SOAR futuro](references/deteccion-y-soar-futuro-concepto.png), [eventos y salud anterior](references/eventos-y-salud-concepto.png) y [usuarios Entra anterior](references/usuarios-entra-concepto.png). Son conceptos con información sintética; no son evidencia funcional ni assets finales de producto.

Orden de lectura para quien construye: 01 → 06 → 04 → 05. Para quien diseña:
02 → 03 → 04.

---

## Resumen en una página

**Qué existe.** La consola SOC activa usa rutas BFF para inicio de sesión con Entra (OIDC +
PKCE, sesión opaca en cookie), alertas con seis comandos, incidentes con seis
comandos, notificaciones críticas a Teams con acuse humano, y auditoría con
verificación de cadena. Hay cuatro roles (`qapaq.soc.analyst`,
`qapaq.soc.lead`, `qapaq.auditor`, `qapaq.platform.admin`) y 16
capabilities, incluidas las de observabilidad y `notifications.dispatch`.

**Qué no existe todavía.** `/operations` ya consume health agregado con RBAC para
frescura de alertas, outbox y runtime. La salud del pipeline por dataset/fuente
(C-5), la búsqueda de eventos, cuarentena y credenciales aún no tienen recorrido
HTTP operativo. Reglas de detección, accesos, playbooks, casos, SLA y exportaciones solo están en
documentación. `apps/web/src/components/admin/*` y `mock-admin.ts` son legado
desmontado que usa un contrato de demo (`/api/v1/*`) que el BFF no sirve. La
nueva vista `/admin/users` pertenece a la consola SOC activa, pero queda oculta
hasta que existan las rutas BFF, sincronización Entra, store persistente y
capabilities de identidad de
[entra-soc-user-admin.md](../architecture/entra-soc-user-admin.md).

**Cómo se ve.** Negro `#080808`, cuatro niveles de gris, un único acento
ámbar reservado a la marca y al ítem activo, tipografía del sistema (Segoe UI)
con tracking negativo en titulares, botones en píldora con el primario blanco.
Densidad de herramienta: tablas como vista principal y detalle en panel
lateral, como en Splunk ES, Sentinel y Elastic Security. Severidad por forma,
rótulo y color a la vez.

**Reglas que no se negocian.**

1. Sin capability, la acción **no existe** en pantalla; no se muestra
   deshabilitada.
2. "Sin datos" y "no estamos recibiendo datos" son estados distintos e
   inconfundibles.
3. Toda regla de negocio se valida antes de enviar, porque el BFF devuelve
   errores genéricos.
4. Todo comando lleva la revisión que el usuario está viendo; un conflicto
   recarga sin perder lo escrito.
5. Todo error muestra un `correlationId` copiable.
6. Nada de demostración llega a producción.

---

## Relación con otros documentos

[Identidad y autorización](../architecture/identity-and-authorization.md) ·
[RBAC](../rbac.md) · [Catálogo de errores](../error-catalog.md) ·
[Modelo de datos](../architecture/data-model-mer.md) ·
[Plan de componentes](../project-management/component-delivery-plan.md) ·
[Entrega Sprint 3](../development/c-16-c-28-sprint3-delivery.md)
