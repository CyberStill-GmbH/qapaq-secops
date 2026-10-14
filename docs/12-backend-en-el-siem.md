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

**Decisión del dueño (2026-10-14): B.** RDS y S3 se conservan: eliminarlos supondría perder información
vital, y serán la base de evidencia para las auditorías ISO 27001 y de ciberseguridad SBS. A queda solo
como evolución opcional.

**Recomendación original: B ahora y A como evolución opcional.** B cumple la decisión (no hay web ni backend
separados: todo viaja dentro del paquete del SIEM QAPAQ) sin poner en riesgo las garantías de auditoría
que piden la SBS y Legal.

## Pruebas de paridad antes de borrar `apps/api` y `apps/worker`

1. Login Entra, passkey fuera de la red, sesión única y revocación ≤ 5 s en el dashboard.
2. Ciclo completo de alerta → incidente → tareas → notas → cierre, con la auditoría verificable.
3. Aviso a Teams con acuse humano, sin duplicados tras un reinicio.
4. Ingesta M365 → Wazuh → caso con prioridad correcta.
5. Todo lo anterior con Valkey caído (degradado).

## Implementación de B (en curso)

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Release del núcleo | `wazuh/core/build.sh` | Node 24.21.0 propio, verificado por SHA256, más la API y el worker (`pnpm deploy --prod`) y la CA de RDS. Mismos pasos que las imágenes de ECS |
| Servicios del host | `wazuh/core/systemd/*.service` | API en 127.0.0.1:3000 y worker, endurecidos (`ProtectSystem=strict`, sin capabilities) y con `MemoryMax`/`CPUQuota` para no quitarle recursos al Indexer ni al Manager |
| Instalación | `wazuh/core/apply-core.sh` | Release verificado en `/opt/qapaq-core/releases/<sha>` (conserva 3: histórico y rollback). El entorno sale del parámetro SSM y los secretos se **leen** con el rol de la instancia, sin crear ni rotar nada. Activación atómica con rollback si `/health/ready` falla |
| Infraestructura | `infra/aws/core.tf` | Parámetro SSM con el entorno, lectura de secretos para la instancia y red del host a RDS, Valkey y KrakenD |
| Corte de DNS | `siem_app_cutover` (Terraform) | `app.jappi.net.pe`, la URI de callback de Entra, pasa de Vercel al SIEM: **sin tocar el registro de la app en Entra** |
| CI/CD | `.github/workflows/qapaq-dashboard.yml` («QAPAQ SIEM») | Build inmutable por commit y despliegue `security → core → dashboard → edge` |

**Orden del corte:**
1. Terraform: `core.tf` con el workflow `terraform-demo`.
2. `step=core`: el núcleo en el host, que convive con ECS.
3. `step=dashboard` y `step=edge` con `QAPAQ_API=127.0.0.1`.
4. `siem_app_cutover=true` y `SOC_EXTRA_HOSTNAMES=app.jappi.net.pe`.
5. Pruebas de paridad.
6. Retirar los servicios ECS de la API y el worker. Retirar KrakenD cuando el núcleo lea el Indexer
   directo.

**Riesgo aceptado:** un solo host corre el SIEM y el núcleo, así que es un punto único de falla en la
demo. La AMI histórica y los releases conservados permiten volver atrás. Para producción, la imagen del
SIEM pasa a un ASG o a un segundo host (ADR-030).
