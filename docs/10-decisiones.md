# 10 · Decisiones vigentes

Este registro único reemplaza ADR-001…027 y U-001…U-021. Los textos originales siguen en git
(`git show 050f9fa:docs/adr/`). Para cambiar una decisión se edita la fila y se agrega la fecha;
no se crean archivos nuevos.

Estados: **Vigente**, **Gate** (decidida, pero falta evidencia antes de producción) y
**Abierta**.

## Negocio (detalle en [01](01-producto.md#decisiones-de-negocio-que-se-conservan))

| ID | Decisión | Estado | Origen |
| --- | --- | --- | --- |
| N1 | Operación autogestionada: sin SaaS de logs ni de observabilidad (SBS 504-2021, arts. 22–25) | Gate: dictamen de Legal | compliance SBS |
| N2 | Minimización de datos personales (Ley 29733) | Vigente | ADR-018/022 |
| N3 | Wazuh detecta y QAPAQ coordina. No hay un segundo SIEM | Vigente | ADR-015/024 |
| N4 | Primera vertical M365 → Wazuh → QAPAQ → Teams | Vigente | ADR-024 |
| N5 | SoD: nadie aprueba lo que pidió, sin `ADMIN` universal | Vigente | ADR-017 |
| N6 | Teams solo avisa. El acuse vive en QAPAQ | Vigente | ADR-022 |
| N7 | Sin purga automática hasta que Legal ratifique la retención | Gate | ADR-018 |
| N8 | No publicar SLO, EPS ni KPIs sin medición | Vigente | ADR-016 |
| N9 | Una sola sesión activa por persona. Un login nuevo reemplaza la sesión anterior en la consola y en el dashboard | Vigente (falta hacerla atómica) | ADR-017 |
| N11 | **Auditable para ISO 27001 y ciberseguridad SBS.** Se conserva toda la evidencia (RDS, S3, auditoría con cadena hash y snapshots) y el diseño se ajustará a sus controles | Vigente (próximo scope) | 2026-10-14 (dueño) |
| N10 | Cualquier cambio de acceso (rol, grupo, cuenta deshabilitada) revoca la sesión al instante | Gate: falta el cambio de rol en QAPAQ | ADR-017, 2026-10-13 |

## Arquitectura

| ID | Decisión | Estado | Fecha |
| --- | --- | --- | --- |
| A1 | Monolito modular hexagonal en TS (NestJS 12/Fastify 5, Prisma 7, Postgres 18). Los módulos no importan frameworks | Vigente | 2026-09 (ADR-001/003/016) |
| A2 | Contrato canónico `SecurityEvent` 1.0.0 | Vigente | ADR-011 |
| A3 | Mutación, auditoría y outbox en una transacción. Auditoría append-only con cadena hash | Vigente | ADR-012/021 |
| A4 | Secretos solo por `secretRef` y control plane write-only | Vigente | ADR-013/027 |
| A5 | **Sin fork del manager ni del Indexer de Wazuh.** El overlay QAPAQ se versiona en `wazuh/` sobre la versión oficial fijada | Vigente | 2026-10-13 |
| A6 | **QAPAQ SecOps ES Wazuh con identidad QAPAQ.** La UI de Wazuh 4.14.8 (OSD 2.19.6) se rebrandea de principio a fin como overlay versionado en `wazuh/dashboard/` (parches mínimos, assets QAPAQ, plugins separados `qapaq_ops` y `qapaq_i18n`). **`apps/web` se descarta** | Vigente | 2026-10-13 (dueño) |
| A7 | **El login TS de QAPAQ es la identidad del dashboard** (nginx `auth_request` más proxy auth). OIDC nativo de OSD queda solo como fallback | Vigente | 2026-10-13 |
| A8 | KrakenD **se mantiene mientras lo use la ingesta** (API → Indexer) y el ALB. Se retira solo cuando la API lea el Indexer por el proxy nginx. No se agregan capas nuevas | Vigente (revisada) | 2026-10-13 |
| A9 | **Valkey vuelve como pieza de resiliencia** (2026-10-14, decisión del dueño): caché con lazy loading e invalidación explícita, estado efímero compartido entre réplicas y colas BullMQ consumidas por el worker. Postgres sigue siendo la verdad; sin Valkey, el sistema degrada a su comportamiento actual. Diseño en [11](11-cache-y-colas.md). Valkey creado en AWS con `noeviction` | Vigente | 2026-10-14 |
| A10 | **Retirar Grafana, Loki y Prometheus.** CloudWatch para métricas de infraestructura. Logs de API y ALB a Wazuh (cumple N1) | Vigente | 2026-10-13 (sustituye ADR-025 en lo de observabilidad) |
| A11 | Retención hot/warm/cold con ISM y snapshots a S3 (no Azure) | Vigente (gate N7 para el borrado) | 2026-10-13 (sustituye ADR-008/018 en el mecanismo) |
| A12 | ML con OpenSearch Anomaly Detection. Python solo si un caso medido supera a RCF | Vigente | 2026-10-13 (sustituye ADR-007) |
| A13 | **El SOAR propio de QAPAQ no se construye.** El SOAR será **Ankay Qapaq**: Shuffle desplegado en la red interna y rebrandeado como QAPAQ, con conexión directa desde el SIEM para escalar alertas y automatizar. Va **después** del lanzamiento del SIEM QAPAQ. Las notificaciones a Teams con acuse humano (N6) siguen en la API | En implementación: F0 (rebrand del frontend) hecha; plan en [13](13-ankay-qapaq.md) | 2026-10-14 (dueño) |
| A14 | Ingesta push (`custom-qapaq`) más pull de reconciliación | Vigente (fase 2) | 2026-10-13 |
| A15 | Fuentes nuevas por módulos de Wazuh, no por adaptadores TS | Vigente | 2026-10-13 |
| A16 | Lanzamiento sobre **Wazuh 4.14.8** (lo que corre en AWS). La imagen anterior queda como histórico: AMI `ami-096d5a424506d1999` (`qapaq-secops-wazuh-historico-4.14.8-20261013`). Wazuh 5 llega como cluster nuevo cuando haya GA | Vigente | 2026-10-13 (dueño) |
| A22 | **El backend QAPAQ vive dentro del SIEM** (opción B): el núcleo corre como servicio del host del SIEM junto al dashboard, con RDS, S3 y Valkey. Se retiran los servicios ECS de la API y el worker tras la paridad ([12](12-backend-en-el-siem.md)) | Vigente, en implementación | 2026-10-14 (dueño) |
| A17 | CI, candidato, publicación y despliegue separados. Imágenes inmutables `git-<sha>` | Vigente | ADR-023 |
| A18 | **Sin capas de complejidad nuevas.** Se reutiliza lo que hay: host Wazuh como edge, API y Postgres actuales y long-poll; nada de SSE, colas nuevas ni servicios extra para el lanzamiento | Vigente | 2026-10-13 (dueño) |
| A19 | **UI en español** con el plugin `qapaq_i18n`: glosario curado más la API Translator on-device de Chrome. **Nunca** se usa un servicio de traducción externo (N1/N2) | Vigente | 2026-10-13 |
| A20 | **No se rotan secretos** al desplegar: los scripts reutilizan las credenciales publicadas (`QAPAQ_ROTATE` sigue en false) | Vigente | 2026-10-13 (dueño) |
| A21 | Apply en AWS: el pipeline oficial es el workflow `terraform-demo`. Desde Windows solo se permite `-target` revisado, porque los CRLF y `dirname()` con `\` generan diffs falsos (reemplazo de la EC2 de Wazuh y rutas rotas en SSM) | Vigente | 2026-10-13 |

## Abiertas

| ID | Pregunta | Owner | Cierra cuando |
| --- | --- | --- | --- |
| U-008 | Guardas de transición, catálogo SOAR y cardinalidades alerta–incidente | SOC/Security | Catálogo de [07](07-deteccion-ml-y-soar.md) aprobado con tests de transición |
| U-004 | Matriz de retención firmada | Legal/Compliance | Firma más pruebas de purga |
| U-017 | KPIs de negocio del MVP | Product Owner | Fórmula, fuente y owner aprobados |
| U-018 | CIDR de la red confiable, proxies y claims de passkey | Identity/Infra | E2E dentro, fuera y por proxy |
| U-022 | ¿Aceptar Shuffle (AGPL, sin modificar) o usar StackStorm (Apache-2.0)? | Legal | Dictamen |
| U-023 | ¿Migración de datos 4.x → 5.x por snapshot? (las RC se contradicen) | Platform | Prueba en sandbox |

## Decisiones de Codex integradas (PR #31, 2026-10-13)

Texto completo en `reference/decisiones/` y `reference/`. Se reconcilian con las instrucciones del dueño
posteriores al PR:

| ID | Decisión | Estado frente a la dirección vigente |
| --- | --- | --- |
| ADR-028 | Shuffle como SOAR no-code por webhook, con QAPAQ como dueño del catálogo, las aprobaciones, la idempotencia y la auditoría | **Vigente.** El producto se llama **Ankay Qapaq** (A13) y es el siguiente scope |
| ADR-029 | QAPAQ SecOps como plataforma SIEM/XDR; **Ayni Qapaq** como espacio colaborativo de investigación (inspirado en TheHive) | **Vigente**, salvo la consola: el dueño decidió que la UI es la de Wazuh rebrandeada (A6), no una consola propia. Ayni Qapaq vive en las vistas de incidentes del plugin `qapaq_ops` |
| ADR-030 | Arquitectura resiliente objetivo: LB de entrada, réplicas sin estado, KrakenD interno, scheduler y pollers con leases, Redis/BullMQ para jobs pequeños, admisión durable y tiers HOT/WARM/COLD (`reference/qapaq-secops-resilient-architecture.md`) | **Objetivo vigente por etapas.** Valkey y el worker vuelven en esta actualización con el rol definido en [11](11-cache-y-colas.md) (A9) |
