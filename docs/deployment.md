# Operación y entrega de software

Estado observado el 6 de octubre de 2026: CI/release y plan Terraform pasan en
GitHub Actions, pero no hay apply reciente acreditando Fases 3–5. El último run
de Terraform [#19](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/37418984196)
propuso 44 altas, 0 cambios y 0 bajas; el paso Apply quedó omitido. Por eso este
checkout no demuestra si recursos declarados en ejecuciones anteriores siguen en
AWS. La [arquitectura cloud demo](architecture/aws-demo.md) documenta target,
tradeoffs y los gates de cada fase.

El workflow `Terraform Demo` usa OIDC y un backend S3 remoto. El bucket de state
es bootstrap externo a este stack. Para afirmar que AWS quedó vacío se debe
ejecutar un plan de destrucción sobre el state remoto vigente y auditar recursos
fuera del state; no basta con observar un plan sin cambios o con altas.
El [runbook DevOps](operations/devops-secrets-and-teardown.md) registra el
estado observado de Vercel, los límites de secretos, la autorización Microsoft
365 y el procedimiento de retiro.

## Responsabilidades

Desarrollo entrega artefactos versionados, migraciones, contratos, configuración
documentada, health y runbooks. Infraestructura provisiona compute/red, stores,
certificados, llaves, IdP técnico, backups y egress. Seguridad define/valida
políticas; SOC acuerda prioridades y continuidad. Terraform contiene módulos
para red, security groups, foundations y runtime, y usa un backend remoto. El
state vigente y el destino real deben comprobarse con OIDC antes de aplicar o
retirar recursos.

La unidad de producto es el monolito modular. API y runner pueden ejecutarse
separados con el mismo release para aislar carga; número de instancias y HA dependen
de volumen/RPO/RTO. U-007 excluye Python del runtime y despliegue del MVP. U-001 asigna a Desarrollo
la entrega de aplicación local, contenedores y contratos de despliegue; tecnología
y configuración concreta siguen pendientes. Infraestructura decide producción;
Kubernetes y su administración están fuera del alcance de la aplicación.

## Dependencias mínimas y contratos operacionales

Las versiones aceptadas están en ADR-016: Node 24.21.0, PostgreSQL 18.6,
Redis 8.10.1, BullMQ 5.81.5 y OpenSearch 3.7.x. Object storage con
permisos, durabilidad y capacidades documentadas; SecretProvider; conectividad a
fuentes autorizadas. No asumir URLs, redes ni cuentas concretas.

Microsoft Entra ID requiere tenant/app registration, redirect URIs exactas,
credencial backend, grupo de admisión y políticas MFA/Conditional Access validadas.
El almacén de sesiones debe soportar revocación, expiración y cifrado de tokens.
Ningún endpoint productivo se habilita antes del gate operacional de ADR-017.
Ningún lifecycle destructivo se habilita antes del gate de ADR-018: matriz
ratificada, regiones/backups/holds aprobados y 20 escenarios demostrados.
Ninguna ingesta productiva pasa a `enabled` antes del gate ADR-019/024: inventario
real, scopes/secretRef autorizados y los 15 escenarios de fuentes adaptados a la
vertical Microsoft 365 → Wazuh → QAPAQ demostrados en el entorno autorizado.
Producción completa permanece bloqueada por ADR-020 hasta aprobar targets y owners,
demostrar restore/replay/drenaje y ejecutar runbooks críticos. Sin guardia SEV1,
declarar `LIMITED PRODUCTION / 8x5`.
ADR-021 añade Collector OTLP, storage WORM, signing service, custodia de llaves,
dos destinos de alerta y 24 pruebas como dependencias del gate; QAPAQ consume sus
contratos, pero Infraestructura/Security los provisionan y operan.
ADR-007 exige caso medible, benchmark, contratos, aislamiento, rollback y 18
pruebas antes de desplegar un worker Python.
ADR-022 añade Team/canal restringido, Teams Workflow, propietarios alternos,
retención, licencia, `secretRef`, rotación y canal secundario. La notificación
productiva permanece bloqueada hasta superar sus veinte escenarios.

Cuentas distintas por función/entorno, TLS y egress limitado, rotación de secretos,
backups/restore probados, cuotas, reloj sincronizado y espacio de archivo. Redis
de colas no comparte eviction imprevisible con cache general. HOT/COLD/EVIDENCE
son políticas antes de ser infraestructuras desplegadas. Los perfiles locales
aceptados no constituyen sizing productivo.

## GitHub Actions, release y CD

[ADR-023](adr/023-ci-release-deployment-separation.md) habilita CI y construcción
certificable de candidatos. PR usa pnpm reproducible, pruebas y escaneos sin
secretos ni permisos de publicación. Release construye una vez y conserva digest,
SBOM, attestation, migraciones, rollback y evidencia.

Publicación y despliegue siguen bloqueados hasta que Infraestructura entregue
registro, ambientes, mecanismo, identidad, conectividad, aprobadores, health checks
y soporte. El mismo digest se promoverá; no se reconstruye por ambiente ni se usa
`latest`. Detalle y estado observado en [CI/CD](ci-cd.md).

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
ingesta por fuente. ADR-020 fija orden C1…C4, RPO/RTO provisionales, ejercicios y
25 pruebas; publicar solo resultados medidos.
Ver [runbooks](runbooks.md).

Despliegue productivo registra owner, ventana, impacto, pruebas, migración compatible,
health/smoke, aborto, rollback y observación. Una migración irreversible requiere
backup verificado, restore ensayado, aprobación y roll-forward.
