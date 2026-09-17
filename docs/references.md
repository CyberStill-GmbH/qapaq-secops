# Fuentes y alcance de investigación

Consultadas el 2026-09-17. Referencias primarias para hechos técnicos; las elecciones
arquitectónicas son recomendaciones propias y están marcadas PROPOSAL. No se
consultaron sistemas internos de Financiera Qapaq.

- [Elastic Common Schema](https://www.elastic.co/docs/reference/ecs): esquema de campos y tipos. Fundamenta evaluación ECS; no impone Elasticsearch ni conformidad.
- [OCSF schema oficial](https://github.com/ocsf/ocsf-schema): categorías, clases y diccionario de normalización de seguridad. Fundamenta comparación, no mapping implementado.
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): efectos idempotentes ante reintentos.
- [BullMQ production](https://docs.bullmq.io/guide/going-to-production): configuración y riesgos operacionales de Redis/cola.
- [Wazuh Indexer](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/index.html): rol de indexación/búsqueda. No prueba compatibilidad del entorno Qapaq.
- [Microsoft Graph signIns v1.0](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0): alcance, permisos y paginación específicos. No generalizar a toda telemetría Microsoft 365.
- [OWASP API Security 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/): riesgos usados como guía de revisión de flujos.
- [Sophos Central APIs](https://developer.sophos.com/intro): portal primario identificado; extracción textual no disponible. Detalle de producto/API queda pendiente.
- [Cato EventsFeed](https://support.catonetworks.com/hc/en-us/articles/360019839477-Cato-API-EventsFeed-Large-Scale-Event-Monitoring): referencia identificada; recuperación de página falló. No se toman cuotas/endpoints como verificados.

La restricción de datos y el stack vienen de la solicitud, no de estas páginas.
Las versiones de software/estándares deben fijarse al implementar; no se adopta
automáticamente la versión «current» de una documentación consultada.
No se infieren plazos de retención ni obligaciones regulatorias de estas fuentes.
