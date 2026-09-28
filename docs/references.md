# Fuentes y alcance de investigación

Consultadas el 2026-09-17 y 2026-09-18. Referencias primarias para hechos técnicos. Las
decisiones aceptadas provienen de las resoluciones explícitas de U-001…U-007,
U-009…U-012 y la revisión de vertical registrada en ADR-024; las
fuentes externas comprueban disponibilidad o soporte, no compatibilidad del
sistema. No se consultaron sistemas internos de Financiera Qapaq.

## Microsoft Teams Workflows para alertas críticas

- [Enviar mensajes en Teams mediante webhooks de Workflows](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks): creación del workflow, selección del Team/canal y URL de webhook.
- [Retiro de Office 365 Connectors en Microsoft Teams](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/): exige migrar los webhooks heredados a Workflows.
- [Crear un Incoming Webhook con Workflows](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook): describe propiedad del workflow y recomienda co-owner para evitar workflows huérfanos.

Estas fuentes verifican el mecanismo externo. No prueban licencia, configuración,
canal, propietarios, retención ni disponibilidad del tenant QAPAQ.

- [Elastic Common Schema 9.5.0](https://www.elastic.co/docs/reference/ecs): esquema de campos y tipos fijado como referencia de perfil; no impone Elasticsearch ni conformidad.
- [Campos event de ECS](https://www.elastic.co/docs/reference/ecs/ecs-event) y [notas de versión](https://www.elastic.co/docs/release-notes/ecs): semántica temporal/clasificación y trazabilidad de la versión fijada.
- [OCSF schema 1.9.0](https://github.com/ocsf/ocsf-schema/releases/tag/v1.9.0): categorías, clases y diccionario fijados como referencia de perfil, no como mapping implementado.
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12): dialecto normativo elegido para `qapaq.security-event` 1.0.0.
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html): representación determinista usada cuando la identidad lógica debe derivarse.
- [Wazuh event logging](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html): diferencia alertas y archives y documenta que archives está deshabilitado por defecto y aumenta almacenamiento.
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

## Baseline de acceso y observabilidad de ADR-025

- [Passkeys FIDO2 en Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-fido2-compatibility): soporte de passkeys sincronizadas y ligadas a dispositivo; no prueba habilitación QAPAQ.
- [Conditional Access y ubicaciones de red](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-assignment-network): named locations y CIDR públicos para decisiones de acceso.
- [Smart Lockout](https://learn.microsoft.com/en-us/entra/identity/authentication/howto-password-smart-lockout): bloqueo inteligente y valores base; la política efectiva del tenant sigue pendiente.
- [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/): credenciales de clave pública ligadas al relying party.
- [Autenticación de Loki](https://grafana.com/docs/loki/latest/operations/authentication/): Loki no incluye capa de autenticación; exige proxy/mTLS apropiado.
- [OTLP hacia Loki](https://grafana.com/docs/loki/latest/send-data/otel/): ingesta de logs por OpenTelemetry Collector.
- [Modelo de seguridad de Prometheus](https://prometheus.io/docs/operating/security/): endpoints no deben exponerse públicamente sin controles.
- [Entra en Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/entraid/): autenticación single-tenant y asignación de roles/grupos.
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html): centralización, rotación y auditoría de secretos.

Estas fuentes sustentan mecanismos, no configuración real. Grafana OSS/Loki/
Prometheus es una decisión interna para evitar tercerizar observabilidad y mantener
control sobre logs SOC; la SBS no prescribe productos.

## Tercerización y control de observabilidad ante SBS

- [Resolución SBS N.° 504-2021, texto actualizado](https://intranet2.sbs.gob.pe/dv_int_cn/2046/v4.0/Adjuntos/504-2021.R.pdf): arts. 22–25 regulan servicios de terceros y servicios significativos de procesamiento; art. 12.6.c exige capacidades SOC de detección/respuesta y monitoreo.
- [Resolución SBS N.° 1515-2021](https://intranet2.sbs.gob.pe/dv_int_cn/2079/v1.0/Adjuntos/1515-2021.R.pdf): modifica estrategia de salida y plazo de información del art. 24.

Estas normas explican por qué QAPAQ evita contratar el servicio de observabilidad.
No obligan a usar el stack seleccionado. La conclusión “no tercerizado” solo se
sostiene si hosting, operación, almacenamiento, backups y accesos son internos.

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

## CI, release y despliegue de U-011

- [GitHub Actions: uso seguro](https://docs.github.com/en/actions/reference/security/secure-use): permisos mínimos, tratamiento de input no confiable, riesgos de workflows privilegiados, pinning por SHA y CODEOWNERS.
- [GitHub Actions: OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers): intercambio federado por credenciales temporales y protección de ambientes.
- [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments): aprobaciones, ramas/tags, secretos y reglas de protección, sujetos al plan contratado.
- [pnpm audit](https://pnpm.io/cli/audit): auditoría de vulnerabilidades para el package manager y lockfile aceptados.

Las fuentes sustentan los mecanismos. No prueban que el plan de GitHub, registro,
identidades, ambientes o conectividad de QAPAQ estén configurados.

## Scrum y gestión del trabajo

- [Scrum Guide 2020](https://scrumguides.org/scrum-guide.html): define Product Goal,
  Sprint Goal, Product Backlog, Sprint Backlog, Increment y Definition of Done.
- [Scrum.org — Product Backlog](https://www.scrum.org/resources/introduction-product-backlog):
  sustenta un único backlog ordenado y emergente.
- [Scrum.org — Definition of Done](https://www.scrum.org/resources/definition-done):
  fundamenta el estándar compartido de calidad del incremento.
- [GitHub Projects: campos e iteraciones](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields):
  referencia para Status, Iteration y metadata estructurada.
- [GitHub milestones](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/about-milestones):
  seguimiento de issues y PR por Sprint.

Estas fuentes fundamentan la estructura del plan. No proporcionan velocidad,
capacidad ni disponibilidad del equipo; esos valores se declaran en Planning.

## Vertical Microsoft 365/Wazuh

- [Wazuh — Monitoring Office 365](https://documentation.wazuh.com/current/cloud-security/office365/index.html):
  integración soportada para monitorizar actividad Office 365.
- [Wazuh — Office 365 audit logs](https://documentation.wazuh.com/current/cloud-security/office365/monitoring-office365-activity.html):
  actividades y alertas visibles en el módulo Office 365.
- [Wazuh rules syntax](https://documentation.wazuh.com/current/user-manual/ruleset/ruleset-xml-syntax/rules.html):
  ruleset, condiciones, frecuencia y niveles que generan alertas.
- [Wazuh Indexer API](https://documentation.wazuh.com/current/user-manual/indexer-api/index.html):
  consulta y gestión de datos/alertas del Indexer; el acceso QAPAQ será read-only.
- [Microsoft Graph sign-ins v1.0](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0):
  referencia para una posible ruta futura directa, no implementada en el primer MVP.

Las páginas oficiales demuestran mecanismos disponibles. No prueban edición,
licencia, permisos, versión o configuración del entorno QAPAQ; PBI-006 debe
confirmarlos mediante acceso autorizado.
