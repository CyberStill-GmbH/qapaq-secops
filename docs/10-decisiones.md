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
| N10 | Cualquier cambio de acceso (rol, grupo, cuenta deshabilitada) revoca la sesión al instante | Gate: falta el cambio de rol en QAPAQ | ADR-017, 2026-10-13 |

## Arquitectura

| ID | Decisión | Estado | Fecha |
| --- | --- | --- | --- |
| A1 | Monolito modular hexagonal en TS (NestJS 12/Fastify 5, Prisma 7, Postgres 18). Los módulos no importan frameworks | Vigente | 2026-09 (ADR-001/003/016) |
| A2 | Contrato canónico `SecurityEvent` 1.0.0 | Vigente | ADR-011 |
| A3 | Mutación, auditoría y outbox en una transacción. Auditoría append-only con cadena hash | Vigente | ADR-012/021 |
| A4 | Secretos solo por `secretRef` y control plane write-only | Vigente | ADR-013/027 |
| A5 | **Sin fork del manager ni del Indexer de Wazuh.** El overlay QAPAQ se versiona en `wazuh/` sobre la versión oficial fijada | Vigente | 2026-10-13 |
| A6 | **QAPAQ SecOps es Wazuh con identidad QAPAQ.** El Dashboard modificado, assets de marca, login y plugin se versionan en `wazuh/dashboard/`. La interfaz única se sirve en `https://qapaq-secops.jappi.net.pe`; `apps/web` y Vercel se retiran cuando el cutover esté validado | Vigente; retirada/cutover pendientes | 2026-10-13 (dueño), revisada 2026-10-14 |
| A7 | **El login TS de QAPAQ es la identidad del dashboard** (nginx `auth_request` más proxy auth). OIDC nativo de OSD queda solo como fallback | Vigente | 2026-10-13 |
| A8 | **KrakenD se conserva** mientras la ingesta QAPAQ → Wazuh Indexer dependa del gateway. No retirarlo como parte de quitar `apps/web` | Vigente; validar con el runtime actual antes de cualquier retiro | 2026-10-13, revisada 2026-10-14 |
| A9 | **Valkey HA y worker ECS con BullMQ** aportan caché de TTL breve y señales recuperables para drenar el outbox. PostgreSQL sigue siendo durable; el API conserva polling de respaldo | Vigente en la arquitectura/código de esta rama; apply AWS pendiente | 2026-10-14 |
| A10 | **Retirar Grafana, Loki y Prometheus.** CloudWatch para métricas de infraestructura. Logs de API y ALB a Wazuh (cumple N1) | Vigente | 2026-10-13 (sustituye ADR-025 en lo de observabilidad) |
| A11 | Retención hot/warm/cold con ISM y snapshots a S3 (no Azure) | Vigente (gate N7 para el borrado) | 2026-10-13 (sustituye ADR-008/018 en el mecanismo) |
| A12 | ML con OpenSearch Anomaly Detection. Python solo si un caso medido supera a RCF | Vigente | 2026-10-13 (sustituye ADR-007) |
| A13 | **El SOAR propio de QAPAQ no se construye.** El SOAR será **Ankay Qapaq**: Shuffle desplegado en la red interna y rebrandeado como QAPAQ, con conexión directa desde el SIEM para escalar alertas y automatizar. Va **después** del lanzamiento del SIEM QAPAQ. Las notificaciones a Teams con acuse humano (N6) siguen en la API | Próximo scope | 2026-10-13 (dueño) |
| A14 | Ingesta push (`custom-qapaq`) más pull de reconciliación | Vigente (fase 2) | 2026-10-13 |
| A15 | Fuentes nuevas por módulos de Wazuh, no por adaptadores TS | Vigente | 2026-10-13 |
| A16 | Lanzamiento sobre **Wazuh 4.14.8** (lo que corre en AWS). La imagen anterior queda como histórico: AMI `ami-096d5a424506d1999` (`qapaq-secops-wazuh-historico-4.14.8-20261013`). Wazuh 5 llega como cluster nuevo cuando haya GA | Vigente | 2026-10-13 (dueño) |
| A17 | CI, candidato, publicación y despliegue separados. Imágenes inmutables `git-<sha>` | Vigente | ADR-023 |
| A18 | Mantener el lanzamiento acotado al Dashboard Wazuh, API y PostgreSQL existentes. Valkey y worker ECS se aceptan solo para la resiliencia definida en A9; no añadir servicios fuera de ese alcance | Vigente | 2026-10-13 (dueño), revisada 2026-10-14 |
| A19 | **UI en español** con el plugin `qapaq_i18n`: glosario curado más la API Translator on-device de Chrome. **Nunca** se usa un servicio de traducción externo (N1/N2) | Vigente | 2026-10-13 |
| A20 | **No se rotan secretos** al desplegar: los scripts reutilizan las credenciales publicadas (`QAPAQ_ROTATE` sigue en false) | Vigente | 2026-10-13 (dueño) |
| A21 | Apply en AWS: el pipeline oficial es el workflow `terraform-demo`. Desde Windows solo se permite `-target` revisado, porque los CRLF y `dirname()` con `\` generan diffs falsos (reemplazo de la EC2 de Wazuh y rutas rotas en SSM) | Vigente | 2026-10-13 |
| A22 | El plugin sirve la API bajo el mismo origen en `/qapaq-api/`. El callback `https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback` debe registrarse y verificarse previamente en Entra; no se rota el client secret | Gate externo antes de habilitar el login en el nuevo hostname | 2026-10-14 |

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
| ADR-030 | Arquitectura resiliente: gateway de ingesta, worker con leases, Valkey/BullMQ para señales pequeñas, almacenamiento durable y tiers HOT/WARM/COLD (`reference/qapaq-secops-resilient-architecture.md`) | **Vigente por etapas.** Esta rama integra caché corta, señales BullMQ, worker ECS y polling de respaldo. PostgreSQL sigue siendo la fuente durable. La configuración está pendiente de plan revisado y apply; no se declara desplegada |
