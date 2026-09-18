# Fuentes y alcance de investigación

Consultadas el 2026-09-17. Referencias primarias para hechos técnicos. Las
decisiones aceptadas provienen de las resoluciones explícitas de U-001/U-002; las
fuentes externas comprueban disponibilidad o soporte, no compatibilidad del
sistema. No se consultaron sistemas internos de Financiera Qapaq.

- [Elastic Common Schema](https://www.elastic.co/docs/reference/ecs): esquema de campos y tipos. Fundamenta evaluación ECS; no impone Elasticsearch ni conformidad.
- [OCSF schema oficial](https://github.com/ocsf/ocsf-schema): categorías, clases y diccionario de normalización de seguridad. Fundamenta comparación, no mapping implementado.
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): efectos idempotentes ante reintentos.
- [BullMQ production](https://docs.bullmq.io/guide/going-to-production): configuración y riesgos operacionales de Redis/cola.
- [Wazuh Indexer](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/index.html): rol de indexación/búsqueda. No prueba compatibilidad del entorno Qapaq.
- [Microsoft Graph signIns v1.0](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0): alcance, permisos y paginación específicos. No generalizar a toda telemetría Microsoft 365.
- [OWASP API Security 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/): riesgos usados como guía de revisión de flujos.
- [Sophos Central APIs](https://developer.sophos.com/intro): portal primario identificado; extracción textual no disponible. Detalle de producto/API queda pendiente.
- [Cato EventsFeed](https://support.catonetworks.com/hc/en-us/articles/360019839477-Cato-API-EventsFeed-Large-Scale-Event-Monitoring): referencia identificada; recuperación de página falló. No se toman cuotas/endpoints como verificados.

## Baseline de U-002

- [Node.js releases](https://nodejs.org/en/about/previous-releases): estado LTS de Node 24 y recomendación de usar líneas LTS en producción.
- [NestJS 12 migration guide](https://docs.nestjs.com/migration-guide): requisitos de Node y cambios de NestJS 12.
- [React versions](https://react.dev/versions): línea publicada de React 19.3.
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/): versiones soportadas y release 18.6.
- [Python downloads](https://www.python.org/downloads/): publicación de Python 3.14.7.
- [Redis downloads](https://redis.io/downloads/): línea estable Redis 8.10 y release 8.10.1.
- [OpenSearch version history](https://docs.opensearch.org/latest/version-history/): línea OpenSearch 3.7.
- [pnpm releases](https://github.com/pnpm/pnpm/releases): pnpm 12.4.2.
- [Prisma releases](https://github.com/prisma/prisma/releases): Prisma ORM 7.10.0 estable.
- [BullMQ releases](https://github.com/taskforcesh/bullmq/releases): BullMQ 5.81.5.
- [uv releases](https://github.com/astral-sh/uv/releases): uv 0.12.15.

El registro npm se consultó para TypeScript 6.0.3, `@nestjs/core` 12.x, Fastify
5.12.1, React 19.3.0, Vite 8.3.0, BullMQ 5.81.5, Prisma 7.10.0 y pnpm 12.4.2.
La disponibilidad individual de esos paquetes no demuestra que la matriz completa
compile ni pase pruebas; esa verificación corresponde a la implementación.

La restricción de datos y el stack vienen de la solicitud, no de estas páginas.
U-002 fija las versiones documentales; manifests, lockfiles, imágenes y CI deberán
materializarlas y validarlas. No se adopta automáticamente la versión `current`.
No se infieren plazos de retención ni obligaciones regulatorias de estas fuentes.
