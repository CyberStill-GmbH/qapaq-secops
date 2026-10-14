# 12 · Llevar el backend QAPAQ dentro del SIEM QAPAQ

**Decisión del dueño (2026-10-14):** QAPAQ SecOps no tendrá frontend ni backend propios separados.
Todo vive en el **SIEM QAPAQ**, un Wazuh modificado según las reglas de la financiera. No se reinventa la
rueda: se recibe Wazuh y se lo convierte en lo que la financiera necesita.

- **Hecho:** `apps/web` eliminado (`4eab88f`). Su UI vive en el plugin `qapaq_ops`.
- **Pendiente:** `apps/api` (NestJS en ECS) y `apps/worker` siguen siendo la fuente de datos del plugin:
  login Entra con sesión única y revocación, casos (Ayni Qapaq), auditoría con cadena hash, avisos con
  acuse y Valkey. **Se eliminan cuando el SIEM sirva lo mismo**, con las pruebas de paridad de abajo.
  Borrarlos antes rompería el login y los casos.

## Qué queda dentro de Wazuh

| Capacidad QAPAQ | Destino dentro del SIEM QAPAQ |
| --- | --- |
| Detección, reglas M365, ML, retención y snapshots | **Ya está en Wazuh** (`wazuh/office365`, `wazuh/indexer/*`) |
| UI completa, marca y español | **Ya está en Wazuh** (`wazuh/dashboard`, `qapaq_ops`, `qapaq_i18n`) |
| Login Entra, passkey fuera de la red, sesión única y revocación ≤ 5 s | Lado servidor del plugin `qapaq_ops` (OIDC con el código framework-free de `modules/access`), con la sesión en Valkey |
| Casos (Ayni Qapaq), tareas, notas append-only, timeline y correlación P1–P4 | Lado servidor de `qapaq_ops` reutilizando `modules/soc` y `modules/detection` (TS sin framework) |
| Auditoría con cadena hash | Igual, con el almacenamiento elegido abajo |
| Avisos Teams y push con acuse, ingesta y sync de Graph | Worker del SIEM: proceso del mismo paquete, colas en Valkey (docs/11) |

## La decisión que falta: dónde se guardan los casos y la auditoría

El dashboard de Wazuh 4.14.8 corre en **Node 18**. Prisma 7, que usa hoy `platform/database`, exige
Node 20 o superior. Por eso el almacenamiento define el esfuerzo:

| Opción | Cómo | Ventajas | Costos y riesgos |
| --- | --- | --- | --- |
| **A. Todo en el Indexer de Wazuh** (event sourcing) | Cada cambio de un caso es **un único documento** append-only en `qapaq-ayni-events` (estado, auditoría y aviso juntos, así que un write es atómico). Las vistas se proyectan en `qapaq-ayni-cases`. La cadena hash va dentro de cada evento | Elimina RDS y la API de ECS: menos capas y menos costo. Es «todo en Wazuh» de verdad | Reescribir la persistencia de `modules/soc`. Sin transacciones multi-documento hay que rediseñar A3 (atomicidad) y las garantías append-only ante la SBS (rol write-only más ISM `read_only`). **Varias semanas** |
| **B. Núcleo QAPAQ como componente del paquete SIEM** | El mismo código de dominio corre como servicio `qapaq-core` (Node 24) instalado junto al dashboard en el host o la imagen del SIEM, con Postgres. El plugin lo llama por localhost. Se elimina NestJS y ECS | Reutiliza casi todo el código y las pruebas. Conserva A3, la cadena hash y el trigger append-only tal como están. **Días** | Sigue existiendo Postgres. Un proceso más en el host del SIEM |

**Recomendación: B ahora y A como evolución opcional.** B cumple la decisión (no hay web ni backend
separados: todo viaja dentro del paquete del SIEM QAPAQ) sin poner en riesgo las garantías de auditoría
que piden la SBS y Legal.

## Pruebas de paridad antes de borrar `apps/api` y `apps/worker`

1. Login Entra, passkey fuera de la red, sesión única y revocación ≤ 5 s en el dashboard.
2. Ciclo completo de alerta → incidente → tareas → notas → cierre, con la auditoría verificable.
3. Aviso a Teams con acuse humano, sin duplicados tras un reinicio.
4. Ingesta M365 → Wazuh → caso con prioridad correcta.
5. Todo lo anterior con Valkey caído (degradado).
