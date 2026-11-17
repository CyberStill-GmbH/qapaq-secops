# 12 · El backend QAPAQ y el SIEM QAPAQ

> Leyenda: **[verificado]**, **[sin verificar]** (existe en el repo, no probado en AWS) y
> **[propuesto]**. Este documento sustituye la decisión B del 2026-10-14 (núcleo QAPAQ dentro del host
> del SIEM) por la arquitectura serverless de [02](02-arquitectura.md).

## Qué se conserva y qué cambia

**Se conserva** la decisión del dueño (2026-10-14): no hay frontend ni backend QAPAQ *separados* del
SIEM. El usuario ve un solo producto, el SIEM QAPAQ (Wazuh con marca QAPAQ y plugin `qapaq_ops`), con un
solo login Entra. RDS/Aurora y S3 se conservan: son la base de evidencia para ISO 27001 y SBS.

**Cambia** dónde corre el backend. Ya no es NestJS en ECS ni un servicio `qapaq-core` en el host del
SIEM: es la **misma API** empaquetada en **Lambda** detrás de API Gateway HTTP, y el núcleo Wazuh
(único servidor) queda libre de procesos QAPAQ.

- **Hecho:** `apps/web` eliminado; su UI vive en el plugin `qapaq_ops`.
- **Existe [sin verificar en AWS]:** `apps/api` (NestJS 12 sobre Fastify 5), con login Entra, sesión
  única y revocación, casos (Ayni Qapaq), auditoría con cadena hash y avisos. `apps/worker` es un
  cascarón sin consumidores ([11](11-cache-y-colas.md)).
- **Existe y queda obsoleto [propuesto retirar]:** `wazuh/core/` (`build.sh`, `apply-core.sh`,
  `systemd/qapaq-core-*.service`), que instalaba la API y el worker en el host del SIEM. El
  `*-azure.sh` pertenece al camino archivado.

## Qué queda dentro de Wazuh y qué va a Lambda

| Capacidad QAPAQ | Destino |
| --- | --- |
| Detección, reglas M365, ML, retención y snapshots | **Wazuh** (`wazuh/office365`, `wazuh/indexer/*`) |
| UI completa, marca y español | **Wazuh** (`wazuh/dashboard`, `qapaq_ops`, `qapaq_i18n`) |
| Login Entra, sesión única y revocación ≤ 5 s | Cognito federado con Entra más la API en Lambda ([04](04-identidad-y-acceso.md)). El plugin `qapaq_ops` llama a `/api` por el mismo origen (CloudFront) |
| Casos (Ayni Qapaq), tareas, notas append-only, timeline y correlación P1–P4 | Lambda (`modules/soc`, `modules/detection`) con Aurora |
| Auditoría con cadena hash | Aurora (trigger append-only) y anclaje del hash en S3 Object Lock |
| Avisos Teams y push con acuse, sincronización de Graph | Lambdas disparadas por SQS y EventBridge Scheduler ([11](11-cache-y-colas.md)) |
| Respuesta con aprobación | Step Functions (Ankay, [07](07-deteccion-ml-y-soar.md)) |

## Decisión de almacenamiento (revisada)

El dashboard 4.14.8 corre en Node 18 y Prisma 7 exige Node 20+; por eso la opción B original
colocaba el núcleo como proceso aparte. En serverless el problema desaparece: el backend corre en
su propio runtime Lambda (Node 20+), no dentro del Dashboard.

| Opción | Estado |
| --- | --- |
| **B'. Lambda + Aurora Serverless v2 (PostgreSQL)** | **Propuesta como camino.** Reutiliza casi todo el código y las pruebas; conserva atomicidad mutación+auditoría+outbox, la cadena hash y el trigger append-only |
| A. Todo en el Indexer de Wazuh (event sourcing) | Evolución opcional, como en la versión original: exige reescribir la persistencia de `modules/soc` y rediseñar la atomicidad. No se planea |

Riesgos propios de B' a medir antes de comprometer: conexiones a Aurora desde Lambda (RDS Proxy),
arranque en frío del monolito NestJS (tamaño del bundle, `esbuild`, posible SnapStart) y el
tiempo de reanudación de Aurora Serverless v2 si se escala a cero ACU (la primera petición tras
inactividad espera). Si la reanudación es inaceptable para el analista, se fija un mínimo de ACU.

## Empaquetado en Lambda [propuesto]

| Pieza | Qué hace |
| --- | --- |
| Adaptador | Punto de entrada nuevo en `apps/api` que monta la app Fastify/Nest en un manejador Lambda para API Gateway HTTP. El dominio no cambia |
| Procesos en segundo plano | Los loops en proceso (`ingestion-poller`, `directory-sync`, `notification-dispatcher`) salen de la API y se invocan desde SQS/Scheduler |
| Red | Lambdas en VPC con acceso al Indexer y Aurora por ruta privada; sin NAT, con endpoints de VPC |
| Secretos | Solo `secretRef` a Secrets Manager; el rol de cada función limita qué lee |
| Release | Artefacto inmutable por commit (zip arm64) y despliegue con Terraform |
| Reglas de borde | `bootstrap` y ciclo de vida de la API (`lifecycle.ts`, `composition-root.ts`) se revisan: asumen un proceso largo con apagado ordenado |

## Pruebas de paridad antes de retirar `apps/worker` y el despliegue en ECS/host

1. Login Entra (Cognito), sesión única y revocación ≤ 5 s en el dashboard.
2. Ciclo completo de alerta → incidente → tareas → notas → cierre, con la auditoría verificable.
3. Aviso a Teams con acuse humano, sin duplicados tras una repetición de mensaje SQS.
4. Ingesta M365 → Wazuh → caso con prioridad correcta.
5. Todo lo anterior con la caché vacía o caída (degradado, [11](11-cache-y-colas.md)).
6. Arranque en frío y p95 de las rutas del dashboard dentro del presupuesto acordado.

## Orden de corte [propuesto]

1. Terraform del plano serverless (Fase 2 de [09](09-plan-de-lanzamiento.md)): Aurora, Lambda, API
   Gateway, Cognito, SQS, CloudFront.
2. Migraciones con el migrador existente (`platform/database`) contra Aurora.
3. El plugin `qapaq_ops` apunta a `/api` por CloudFront.
4. Pruebas de paridad.
5. Retirar `apps/worker`, `platform/gateway` y `wazuh/core` del despliegue.

**Riesgo aceptado:** el nodo Wazuh es un punto único de falla (ASG `min=max=1`, restauración desde
snapshots). Su RTO se mide en la Fase 1 y se registra en [06](06-operacion.md). A diferencia de
la decisión anterior, una falla del SIEM ya **no** arrastra el login, los casos ni la auditoría,
que viven en el plano serverless.
