# Operación y entrega de software

Estado: requisitos/propuesta, no infraestructura provisionada ni manifests.

## Responsabilidades

Desarrollo entrega artefactos versionados, migraciones, contratos, configuración
documentada, health y runbooks. Infraestructura provisiona compute/red, stores,
certificados, llaves, IdP técnico, backups y egress. Seguridad define/valida
políticas; SOC acuerda prioridades y continuidad. No Terraform en este repo ahora.

La unidad de producto es el monolito modular. API y runner pueden ejecutarse
separados con el mismo release para aislar carga; número de instancias y HA dependen
de volumen/RPO/RTO. Python opcional no introduce servicio autónomo inicial. U-001 asigna a Desarrollo
la entrega de aplicación local, contenedores y contratos de despliegue; tecnología
y configuración concreta siguen pendientes. Infraestructura decide producción;
Kubernetes y su administración están fuera del alcance de la aplicación.

## Dependencias mínimas y contratos operacionales

Las versiones aceptadas están en ADR-016: Node 24.21.0, PostgreSQL 18.6,
Redis 8.10.1, BullMQ 5.81.5 y OpenSearch 3.7.x. Object storage con
permisos, durabilidad y capacidades documentadas; SecretProvider; conectividad a
fuentes autorizadas. No asumir URLs, redes ni cuentas concretas.

Cuentas distintas por función/entorno, TLS y egress limitado, rotación de secretos,
backups/restore probados, cuotas, reloj sincronizado y espacio de archivo. Redis
de colas no comparte eviction imprevisible con cache general. Hot/warm/cold son
políticas antes de ser tres infraestructuras distintas. Los perfiles locales
aceptados no constituyen sizing productivo.

## GitHub Actions

La [CI de seguridad](ci-cd.md) está configurada localmente; la ejecución remota y
la CD siguen pendientes. Los siguientes requisitos de release se mantienen como propuesta.

PR: checks de calidad/unit/contract, integración afectada, imports, SAST,
dependency scanning y secret scanning. Container scanning si se generan imágenes.
No secretos productivos para forks/PR no confiable; permisos mínimos por job,
acciones fijadas a revisiones revisadas y dependencias con lockfiles.

Release: construir una vez, identificar artefacto/commit, SBOM y evidencia de
scans, aprobación según riesgo y mecanismo de publicación acordado. No elegir
servicio de hosting ni desplegar desde esta documentación.

Migraciones expand/contract y orden productor/consumidor compatible. Rollback de
binario solo si schema/eventos siguen compatibles; evitar down migration destructiva
como plan automático. Reversión de datos requiere procedimiento probado y backup,
no promesa genérica.

## Recuperación y degradación

Inventariar qué se reconstruye: índices desde archivos/normalizados, cola desde
manifiestos/outbox, vistas desde hechos retenidos según contrato. PostgreSQL,
catálogo, raw y llaves requieren backup coherente; pérdida de llaves puede hacer
inútil el archivo cifrado. No reejecutar acciones externas peligrosas durante restore.

Ensayar restauración aislada, reconciliar rangos/cursors, revalidar acceso y reabrir
ingesta por fuente. RPO/RTO, frecuencia de backup y responsables siguen U-009.
Ver [runbooks](runbooks.md).
