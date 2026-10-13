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
| A6 | **El dashboard de Wazuh es el frontend único.** QAPAQ entra por un plugin y `/soc` | Vigente | 2026-10-13 |
| A7 | **El login TS de QAPAQ es la identidad del dashboard** (nginx `auth_request` más proxy auth). OIDC nativo de OSD queda solo como fallback | Vigente | 2026-10-13 |
| A8 | **Retirar KrakenD del runtime.** La API lee el Indexer por el proxy nginx allowlist | Vigente | 2026-10-13 (sustituye ADR-026) |
| A9 | **Retirar Valkey/Redis, BullMQ y `apps/worker`.** El outbox y los leases viven en Postgres | Vigente | 2026-10-13 (sustituye ADR-006) |
| A10 | **Retirar Grafana, Loki y Prometheus.** CloudWatch para métricas de infraestructura. Logs de API y ALB a Wazuh (cumple N1) | Vigente | 2026-10-13 (sustituye ADR-025 en lo de observabilidad) |
| A11 | Retención hot/warm/cold con ISM y snapshots a S3 (no Azure) | Vigente (gate N7 para el borrado) | 2026-10-13 (sustituye ADR-008/018 en el mecanismo) |
| A12 | ML con OpenSearch Anomaly Detection. Python solo si un caso medido supera a RCF | Vigente | 2026-10-13 (sustituye ADR-007) |
| A13 | SOAR: QAPAQ aprueba y audita; ejecutan Wazuh AR y Shuffle. QAPAQ no tiene credenciales de escritura de Graph | Gate: fencing, step-up y aval de Legal sobre AGPL | 2026-10-13 |
| A14 | Ingesta push (`custom-qapaq`) más pull de reconciliación | Vigente (fase 2) | 2026-10-13 |
| A15 | Fuentes nuevas por módulos de Wazuh, no por adaptadores TS | Vigente | 2026-10-13 |
| A16 | Wazuh 4.14.8 para lanzar. Wazuh 5 como cluster nuevo cuando haya GA | Vigente | 2026-10-13 |
| A17 | CI, candidato, publicación y despliegue separados. Imágenes inmutables `git-<sha>` | Vigente | ADR-023 |

## Abiertas

| ID | Pregunta | Owner | Cierra cuando |
| --- | --- | --- | --- |
| U-008 | Guardas de transición, catálogo SOAR y cardinalidades alerta–incidente | SOC/Security | Catálogo de [07](07-deteccion-ml-y-soar.md) aprobado con tests de transición |
| U-004 | Matriz de retención firmada | Legal/Compliance | Firma más pruebas de purga |
| U-017 | KPIs de negocio del MVP | Product Owner | Fórmula, fuente y owner aprobados |
| U-018 | CIDR de la red confiable, proxies y claims de passkey | Identity/Infra | E2E dentro, fuera y por proxy |
| U-022 | ¿Aceptar Shuffle (AGPL, sin modificar) o usar StackStorm (Apache-2.0)? | Legal | Dictamen |
| U-023 | ¿Migración de datos 4.x → 5.x por snapshot? (las RC se contradicen) | Platform | Prueba en sandbox |
