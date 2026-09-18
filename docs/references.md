# Fuentes y alcance de investigación

Consultadas el 2026-09-17 y 2026-09-18. Referencias primarias para hechos técnicos. Las
decisiones aceptadas provienen de las resoluciones explícitas de U-001…U-006, U-009 y U-012; las
fuentes externas comprueban disponibilidad o soporte, no compatibilidad del
sistema. No se consultaron sistemas internos de Financiera Qapaq.

## Microsoft Teams Workflows para alertas críticas

- [Enviar mensajes en Teams mediante webhooks de Workflows](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks): creación del workflow, selección del Team/canal y URL de webhook.
- [Retiro de Office 365 Connectors en Microsoft Teams](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/): exige migrar los webhooks heredados a Workflows.
- [Crear un Incoming Webhook con Workflows](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook): describe propiedad del workflow y recomienda co-owner para evitar workflows huérfanos.

Estas fuentes verifican el mecanismo externo. No prueban licencia, configuración,
canal, propietarios, retención ni disponibilidad del tenant QAPAQ.

- [Elastic Common Schema](https://www.elastic.co/docs/reference/ecs): esquema de campos y tipos. Fundamenta evaluación ECS; no impone Elasticsearch ni conformidad.
- [OCSF schema oficial](https://github.com/ocsf/ocsf-schema): categorías, clases y diccionario de normalización de seguridad. Fundamenta comparación, no mapping implementado.
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): efectos idempotentes ante reintentos.
- [BullMQ production](https://docs.bullmq.io/guide/going-to-production): configuración y riesgos operacionales de Redis/cola.
- [Wazuh Indexer](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/index.html): rol de indexación/búsqueda. No prueba compatibilidad del entorno Qapaq.
- [Microsoft Graph signIns v1.0](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0): alcance, permisos y paginación específicos. No generalizar a toda telemetría Microsoft 365.
- [OWASP API Security 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/): riesgos usados como guía de revisión de flujos.
- [Sophos Central APIs](https://developer.sophos.com/intro): portal primario identificado; extracción textual no disponible. Detalle de producto/API queda pendiente.
- [Cato EventsFeed](https://support.catonetworks.com/hc/en-us/articles/360019839477-Cato-API-EventsFeed-Large-Scale-Event-Monitoring): referencia identificada; recuperación de página falló. No se toman cuotas/endpoints como verificados.

U-005 fija fronteras, ownership, orden de pilotos y semántica de procedencia. Estas
referencias no prueban que QAPAQ disponga de edición, licencia, dataset, scopes,
cuotas, cursor, retención o conectividad; esos valores siguen en el inventario.

## Contratos de observabilidad de U-006

- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/): contrato para
  transportar traces, métricas y logs entre fuentes, Collectors y backends; no
  selecciona el backend corporativo.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/): formato estándar para
  propagar contexto de tracing distribuido; no convierte el trace en auditoría.
- [Prometheus metric and label naming](https://prometheus.io/docs/practices/naming/):
  recomienda evitar dimensiones de alta cardinalidad como user IDs y emails.

Estas referencias sustentan interoperabilidad y cardinalidad. La resolución del
usuario fija la separación, ownership, buffers, auditoría y gate productivo.

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

## Identidad y autorización de U-003

- [Microsoft identity platform: authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow): OIDC, Authorization Code, PKCE, `state`, `nonce`, tenant y coincidencia exacta de redirect URI.
- [Microsoft Entra Privileged Identity Management](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-configure): acceso elegible/temporal, aprobación, MFA y justificación para privilegios corporativos.
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html): sesiones, reautenticación, timeouts y autenticadores resistentes a phishing.

Estas fuentes fundamentan controles del protocolo y autenticación. No prueban que
QAPAQ disponga de licencias, PIM, Conditional Access, authentication strengths,
device compliance o configuración conforme; esas son condiciones del gate operativo.

## Retención, privacidad y custodia de U-004

- [Resolución SBS N.° 504-2021](https://intranet2.sbs.gob.pe/dv_int_cn/2046/v2.0/Adjuntos/504-2021.R.pdf): preservación de evidencias para investigación forense; acceso para supervisión/auditoría, estrategia de salida y eliminación definitiva de información confidencial en servicios de terceros. El artículo 25 condiciona autorización previa a limitaciones para cumplir el artículo 24.2; no establece una prohibición general de cloud extranjero ni un plazo universal para logs SOC.
- [Ley N.° 29733](https://www.gob.pe/institucion/congreso-de-la-republica/normas-legales/243470-29733): marco peruano de protección de datos personales.
- [D.S. N.° 016-2024-JUS](https://www.gob.pe/institucion/anpd/normas-legales/6554453-n-016-2024-jus) y [vigencia informada por la ANPD](https://www.gob.pe/institucion/anpd/campa%C3%B1as/128319-nuevo-reglamento-de-proteccion-de-datos-personales): reglamento y entrada en vigencia. La evaluación de notificabilidad y plazo corresponde a Legal/Privacy.
- [Azure Blob immutable storage](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview): retención WORM y legal holds; las políticas deben probarse antes de bloquearse y una política bloqueada no puede acortarse.
- [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final): revisión vigente para sanitización de medios y crypto-erasure.

Estas fuentes delimitan controles y revisión jurídica; no ratifican la matriz
provisional de QAPAQ ni demuestran capacidades configuradas en Azure.

La restricción de datos y el stack vienen de la solicitud, no de estas páginas.
U-002 fija las versiones documentales; manifests, lockfiles, imágenes y CI deberán
materializarlas y validarlas. No se adopta automáticamente la versión `current`.
No se infieren plazos regulatorios fuera de la decisión provisional documentada.
