# 19 · Brechas y roadmap

> Estado al 2026-11-11. Análisis de brechas del SOC QAPAQ frente a un SOC de referencia, con el estado
> de cada línea de trabajo. «En curso» significa que otro agente la está construyendo y **aún no hay
> código fusionado** en la rama; se actualiza cuando aterriza. Postura y límites estructurales en
> [21](21-postura-de-seguridad.md).

| # | Brecha | Impacto | Estado | Responsable / dónde |
| --- | --- | --- | --- | --- |
| 1 | **Cobertura de endpoints**: no hay agentes en equipos ni servidores de QAPAQ; solo el propio nodo (`001`) | La mayoría de reglas de endpoint, AD, FIM, SCA y vulnerabilidades no ven el parque real | Abierta. Enrolamiento listo (puertos 1514/1515 abiertos, contraseña, grupos y políticas) | TI de QAPAQ + plataforma; [AGENTS.md](../infra/aws-poweruser/AGENTS.md), [16](16-politicas.md). Otro agente trabaja en detección de conexiones de red y en aprovechar más capacidades de Wazuh |
| 2 | **Correlación y alertas basadas en riesgo** con resolución de entidades (UEBA-lite) | El correlador Go produce patrones y candidatos de riesgo por entidad; no correlaciona correo M365 ni reconstruye conversaciones | Implementado en el repo local; despliegue/estado operativo por verificar. El evaluador offline usa pruebas sintéticas; falta corpus SOC adjudicado y no se afirma reducción medida de falsos positivos | [Servicio Go](../services/qapaq-correlator/), [evaluador y criterios](17-ingenieria-de-deteccion.md#evaluacion-reproducible-sobre-corpus-adjudicado), [programa de confiabilidad §5](25-programa-confiabilidad-e-investigacion.md) |
| 3 | **Retroalimentación del veredicto del analista** para falsos positivos | El veredicto se registra en el triaje, pero no ajusta reglas ni umbrales | Parcial: veredicto en la cola de alertas y cierre auditado por regla con `detections/tools/close-false-positives.mjs`; falta el bucle automático hacia las reglas | Ingeniería de detección; [17](17-ingenieria-de-deteccion.md) |
| 4 | **Métricas del SOC**: MTTD, MTTA, MTTR y SLA por prioridad | Sin medición no hay gestión del servicio | Abierta. SLA P1–P4 definidos en [detection-engineering/03](detection-engineering/03-modelo-operativo.md); la vista de calidad de detección existe, el cálculo de tiempos no | Por asignar |
| 5 | **Inteligencia de amenazas / coincidencia de IOC** | Sin enriquecimiento ni detección por indicadores conocidos | Abierta | Por asignar (candidatas: listas CDB de Wazuh alimentadas por un feed) |
| 6 | **Silencio de fuentes y salud de la plataforma** | Una fuente que deja de enviar pasa inadvertida | En curso (Python). Hoy: «Salud de fuentes» para la ingesta del motor y «Integraciones» con último evento por proveedor | Otro agente; enlace pendiente |
| 7 | **Priorización de vulnerabilidades** con CISA KEV y EPSS | Snyk y Wazuh priorizan solo por CVSS/severidad | En curso (Python) | Otro agente; enlace pendiente |
| 8 | **Respaldos sin IAM y riesgo de nodo único** | Sin DLM ni subida automática a S3; un fallo del nodo o del disco detiene todo el SOC | Abierta. Respaldo manual documentado en [06 §6](06-operacion.md#6-respaldos-y-restauración), sin ensayo de restauración | Plataforma; requiere rol IAM o tarea programada desde una estación |
| 9 | **Cobertura M365 y correo** | ActivityFeed.Read consta como concedido desde 2026-11-10; falta vigilar frescura y validar que el feed cubra cada caso de investigación | Parcial: la investigación/UI de `qapaq_ops` agrupa actividad mediante IDs exactos de mensaje cuando están disponibles; no infiere dirección ni hilo. El correlador Go no implementa correlación de correo. Cobertura del feed y permisos Graph siguen siendo límites separados | Platform + admin de Entra; [18](18-integraciones.md), [modelo y agrupación de investigación](../wazuh/dashboard/plugins/qapaq_ops/common/investigation.ts), [25](25-programa-confiabilidad-e-investigacion.md) |
| 10 | **Deception / canary tokens** | Sin señales de alta fidelidad ante intrusión | Abierta | Por asignar |
| 11 | **Ciclo cerrado Respond ↔ incidentes** | Las ejecuciones de Ankay no quedan en el incidente ni en la auditoría QAPAQ | Abierta. Playbooks exportables con puerta de aprobación (`b84562e`); contención deshabilitada por defecto (decisión B12) | Por asignar; [13](13-ankay-qapaq.md), [14](14-ankay-conexion-qapaq.md) |

## Orden sugerido

1. **#9 y #1** (decisiones de QAPAQ, no de código): conceder permisos de Entra y enrolar agentes
   multiplican la cobertura sin desarrollo.
2. **#8**: respaldo y restauración ensayados antes de depender del SOC.
3. **#6, #7, #2** al fusionarse el trabajo en curso.
4. **#4 y #3**: métricas y bucle de veredicto, para medir y reducir ruido.
5. **#11, #5, #10**.

## Cómo se actualiza

Cada agente que fusione trabajo de una brecha cambia su fila (estado, enlace al documento o al
código) en el mismo commit. Una brecha se cierra solo con evidencia: prueba automatizada o
verificación en el nodo con fecha.

## Entrega push durable de Wazuh (2026-11-11)

El punto 1 de [25](25-programa-confiabilidad-e-investigacion.md#punto-1--ingesta-push-durable-en-el-perfil-vigente)
está en implementación local: API y adapter PostgreSQL para hints minimizados, reintentos con
leases/fencing, lookup del documento original en Indexer y promoción compartida con pull. No se
declara cerrado. La suite unitaria reportó 77 pruebas en 5 archivos y las 8 pruebas Python del emisor
pasaron. Falta la integración PostgreSQL real, validar el mapping con una muestra autorizada redactada,
sincronizar secreto/URL del Manager, canario sintético y medición origen-a-alerta; el
despliegue sigue pendiente.

## Investigación, frescura y entrega de notificaciones (2026-11-11)

- **Frescura (#6):** cambios locales separan `occurredAt`, `observedAt` y `receivedAt`, calculan
  lag de evento fuente a fin de poll y muestran percentiles con tamaño de muestra y skew en la UI.
  La vista Operaciones también muestra lag receipt→handler de la inbox. Aún en pruebas; no mide
  cada etapa de Indexer ni Manager→alerta, no hay canario ni SLO validado y falta ejecutar la
  integración PostgreSQL.
- **Notificaciones:** Web Push contempla todos los destinatarios; la cuota de 12/h aplica a P2 y
  reserva plazas atómicamente entre réplicas. P1 queda fuera de ese cupo. Sigue abierto un fallo de
  ciclo de vida ya corregido localmente: delivered/fallback confirma una hora; un fallo transitorio
  conocido libera; un resultado ambiguo retiene un lease de 2 min y los reintentos usan la misma key.
  Migración `20261111143000_notification_p2_reservation_leases`; 51/51 pruebas SOAR y validaciones
  de build/typecheck/Prisma reportadas como aprobadas. Falta PostgreSQL multi-réplica (`DATABASE_URL`),
  canario y proveedor autorizado. Ver [25](25-programa-confiabilidad-e-investigacion.md).
- **Investigación UX (#4):** los pivotes visibles ahora coinciden con la selección/query, con límite
  de ocho entidades; el test del plugin pasó 20/20 casos en dos archivos con configuración temporal.
  Timeline/CSV siguen en 100 eventos sin paginación; PDF es impresión del navegador. Los grupos
  temporales no prueban hilo, dirección de correo ni causalidad. Si falta `_id`, el origen se busca
  heurísticamente por regla/descripción/tiempo sin exigir unicidad. Sigue pendiente validar el feed
  y el análisis contra M365 autorizado; ver [08](08-frontend-unificado.md) y [25](25-programa-confiabilidad-e-investigacion.md).


## Actualización de correlación, acceso, privacidad e informes (2026-11-12)

- **Correlador y falsos positivos:** el servicio Go correlaciona etapas de borde, SSH, autenticación,
  cambios privilegiados, protección de endpoint y auditoría cloud por entidad. No tiene etapas ni
  reglas para envíos/recepciones M365, IDs de mensaje o destinatarios; esa capacidad vive en la
  investigación/UI de `qapaq_ops`, que agrupa por ID exacto disponible y no infiere dirección ni hilo.
  El CLI [evaluate-corpus](../services/qapaq-correlator/cmd/evaluate-corpus/) calcula métricas
  comparativas y guardas sobre un holdout, pero las pruebas/repositorio usan datos sintéticos: falta
  un corpus SOC adjudicado y no se afirma reducción real de falsos positivos. Conteos TP/FP/revisados,
  ventana y truncamiento del feed se exponen en API, Prometheus y reportes. El matcher admite empates
  de timestamp por resolución de segundos; no cambiar el criterio de orden ni ajustar supresiones sin
  corpus evaluado. Ver [17](17-ingenieria-de-deteccion.md#evaluacion-reproducible-sobre-corpus-adjudicado)
  y [25 §5](25-programa-confiabilidad-e-investigacion.md).
- **Owners SOC:** `directoryOwnerSource` dejo la cache local y consulta el roster durable en cada
  autenticacion tras el primer sync confirmado; Graph solo resuelve el bootstrap previo. API build
  PASS y 18/18 tests `directory-sync`/`directory-activation` reportados. PostgreSQL/replicas,
  permisos/entorno y despliegue siguen pendientes.
- **Privacidad M365:** `eventOf` sanitiza Parameters/ModifiedProperties/response y related excluye esos
  campos; tests de plugin comun + servidor 21/21. Falta fixture autorizado redactado, revision de
  contrato y retencion. No afirmar cobertura de buzon ni despliegue.
- **Informes:** la UI local pagina hasta 10.000 eventos, muestra progreso, permite cancelar y genera
  CSV, XLSX OOXML y HTML imprimible como PDF. Sigue pendiente el job durable PostgreSQL, worker,
  artefacto con ACL y PDF server-side; no se afirma reanudación ni progreso tras cerrar sesión. Ver
  [04](04-identidad-y-acceso.md),
  [08](08-frontend-unificado.md) y [25](25-programa-confiabilidad-e-investigacion.md).
