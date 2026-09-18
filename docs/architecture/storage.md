# Datos operacionales, telemetría y retención

Estado: diseño de tiers PROPOSAL; política de lifecycle CONDITIONALLY ACCEPTED por
[ADR-018](../adr/018-retention-privacy-custody.md). [ADR-004](../adr/004-postgresql-operational-data.md),
[ADR-005](../adr/005-opensearch-wazuh-telemetry.md),
[ADR-008](../adr/008-hot-warm-cold-retention.md).

## Ownership por clase de dato

PostgreSQL: users, roles, permissions, user_roles, role_permissions; activos y
referencias externas; alertas resumidas, incidentes, casos, comentarios,
investigaciones y referencias de evidencia; reglas/versiones, integraciones,
configuración y referencias de secretos; políticas, auditoría operacional,
reportes, dashboards, saved queries y notificaciones. Playbooks solo como límite
futuro, sin tablas vacías ahora.

También admite catálogo de lotes/archivos, restauraciones, outbox/inbox de efectos
operacionales y checkpoints. Dimensionar escrituras de control por lote: guardar
cada SecurityEvent como JSONB en PostgreSQL contradice el objetivo del diseño.
ADR-016 acepta Prisma 7.10.0 y migraciones; el schema físico, particionado e
índices transaccionales siguen pendientes.

Wazuh conserva su telemetría según sus mecanismos. Qapaq consulta mediante port;
una proyección normalizada propia solo se crea en índices/namespace compatibles
y permitidos, sin modificar índices gestionados por Wazuh. El indexer almacena
documentos JSON para búsqueda; su disponibilidad y capacidad reales se deben
inventariar. [Wazuh Indexer](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/index.html).

Object storage: raw recibido, archivo normalizado, evidencias y exportaciones
temporales, con permisos y ciclos de vida separados. Azure Blob y S3 compatible
son adapters posibles; capacidades de WORM, versionado, cifrado y restore no se
asumen iguales entre proveedores.

## Hot / warm / cold

- Hot: índices recientes consultables, ingestión activa y latencia operativa. Política de rollover por carga medida.
- Warm: índices menos activos/read-only u optimizados, mismo contrato de búsqueda con presupuesto diferente. Es una política lógica: no exige nodos o producto adicional inicialmente.
- Cold: objetos históricos con manifiesto, schemaVersion, fuente, rango temporal, conteo, digest, ubicación lógica y clasificación. Sin asumir SQL instantáneo sobre blobs.

Raw comprimido preserva bytes y facilita replay; JSON comprimido simplifica
intercambio, pero escanea más. Parquet es candidato para derivados normalizados y
lectura columnar; no reemplaza raw forense ni garantiza una reconstrucción byte a
byte. Snapshots del motor sirven para recuperación compatible, no como único
formato independiente de archivo.

## Archivo seguro

Planificar lote cerrado → escribir objetos/manifiesto → verificar conteo/digests y
lectura → registrar catálogo → comprobar hold y cobertura → autorizar expiración
hot/warm según política. Hacer el proceso reanudable e idempotente. Si el índice
fue eliminado antes de verificar archivo, hay riesgo de pérdida no reparable.

La [política canónica](retention-privacy-custody.md) define inventario,
clasificación, plazos provisionales y triggers por dataset. No presenta esos
periodos como obligaciones legales. Raw, derivados, audit, backups y exports
tienen ciclos distintos. Un hold granular bloquea todas las copias en su scope.
La purga aprobada emite deletion ledger y purge receipt, nunca borrado silencioso.

## HistoricalEventQueryService

Port de aplicación: consulta tipada con rango temporal, filtros permitidos,
paginación y contexto de acceso. El planner consulta catálogo y divide rangos sin
exponer rutas físicas. Aplica permisos antes de leer y al entregar resultados.

Hot/warm devuelven páginas ordenadas por tiempo + ID estable. Cold puede devolver
jobId y estado pending/restoring/ready/failed, cobertura de rango, fuentes faltantes
y antigüedad. Resultados parciales requieren indicación explícita; no dar total
exacto si no se recorrió toda la cobertura. Deduplicar solapamientos por identidad
y versión; usar snapshot/cursor consistente y especificar expiración.

Propuesta inicial de cold: restaurar solo particiones/rangos necesarios a índices
temporales con TTL y cuota, consultar con el mismo port y purgar al terminar si no
hay hold. Consulta directa de Parquet se evalúa más adelante si restaura demasiado.
No introducir un nuevo motor distribuido solo para esta abstracción.

Revalidar permiso al consultar estado y descargar; un job creado por un usuario
no otorga acceso eterno. Cancelación y cuotas limitan coste. Evidencia descargada
incluye manifiesto y digest, sin URL pública ni credenciales.

## Capacidad y recuperación

Medir EPS medio/pico, tamaño de raw y normalizado, expansión del índice, replicas,
días por tier y porcentaje de relecturas. Estimación de partida:
bytes/día = EPS × 86400 × bytes/evento; añadir separadamente índice, replicas,
raw, archivo, restore temporal, backup y margen de crecimiento. No dar cifras sin
mediciones; reservar capacidad de drenaje superior al ingreso sostenido. Los
perfiles y gates aceptados están en
[toolchain y capacidad](toolchain-and-capacity.md).

Backups no son archivo ni alta disponibilidad. ADR-018 acepta una baseline
provisional y exige que el restore reaplique el deletion ledger antes de acceso.
Ensayar PostgreSQL, catálogo, raw y referencias; verificar consistencia con índices
reconstruibles y checkpoints. ADR-020 fija RPO/RTO provisionales y exige medirlos;
la topología sigue con Infraestructura. Redis puede
reconstruir pendientes desde manifiestos/outbox; eso requiere reconciliador probado.

[Diagrama de tiers](../diagrams/07-storage-tiers.mmd).
