# Runbooks iniciales

Estado: catálogo/procedimientos de diseño; requisitos CONDITIONALLY ACCEPTED por
ADR-020 y ADR-021.
No ejecutar comandos reales ni alterar proveedores a partir de estos documentos.
Cada runbook requiere dueño, señales, autorización, límites y evidencia del entorno.

Catálogo mínimo pendiente de materializar: startup/shutdown, restore PostgreSQL y
búsqueda, checkpoint replay, backlog drain, source/identity outage, queue recovery,
credential revocation, disk capacity, certificate expiration, deployment rollback,
SOAR reconciliation y security incident. Cada uno declara trigger, precondiciones,
permisos, pasos, validación, aborto, rollback, owner, escalamiento y evidencia.
Otra persona distinta del autor ejecuta cada runbook crítico antes de producción.

## Docker Desktop no inicia en Windows

Si el backend aborta al inicializar `dockerInference` o `engine.sock`, aplicar el
procedimiento reversible documentado en
[entorno local](development/local-environment.md#recuperación-de-docker-desktop-en-windows).
No usar factory reset: la reparación aísla simultáneamente ambos directorios de
sockets, conserva respaldos y valida daemon, red y contenedores reales.

## Conector degradado o sin eventos

Comprobar última recepción/checkpoint, errores y cobertura, sin revelar tokens.
Distinguir 401/403, throttling, indisponibilidad y «sin actividad». Pausar polling
si continuar empeora fallo; no adelantar cursor. Corregir secreto/permisos mediante
su custodio. Reanudar desde checkpoint con ventana/dedup documentadas.
Éxito: datos frescos, backlog drena y gaps se explican; no basta health HTTP verde.
Un cursor inválido cambia el dataset a `GAP_DETECTED`, conserva el último checkpoint
durable y requiere reconciliar cobertura antes de reanudar. La caída o revocación
de una fuente no debe pausar conectores independientes.

## Backlog, jobs fallidos o Redis perdido

Comparar ingreso/drenaje, edad, errores, memoria y disco. Limitar fuentes/exportaciones
según prioridad aprobada; no borrar cola para ocultar atraso. Poison jobs van a
cuarentena con rawRef y razón. Tras recuperar Redis, reconciliar manifiestos/outbox/
efectos antes de reencolar; no ejecutar replay ilimitado ni duplicar notificaciones.
Éxito: cobertura y efectos reconciliados, lag dentro del objetivo acordado.

## Indexador caído

Marcar búsqueda parcial/degradada y preservar backlog idempotente de indexación;
la correlación de la primera vertical espera la indexación conforme a U-001. Reducir carga y coordinar
con el dueño Wazuh/Indexer sin modificar índices gestionados a ciegas.
Al recuperar, validar conteos/cobertura y mappings antes de restituir consultas.

## Auditoría no disponible o atrasada

Si falla append local de acción crítica, no confirmar mutación. Si falla archivo,
mantener PostgreSQL/outbox y alertar atraso/capacidad. Aplicar Warning a 5 min,
degraded a 15 min, SEV2 a 30 min o 70%, SEV1 a 60 min o 85%, y fail-closed a 95%
o ante riesgo de agotar PostgreSQL. En fail-closed bloquear permisos, reglas,
exports sensibles, configuración, holds, SOAR y raw privilegiado.

Al recuperar, verificar cadena, secuencia, firma, objeto leído y checksum antes de
marcar `ARCHIVED`; drenar el outbox y ejecutar reconciliación completa. No rellenar
auditoría perdida como si se hubiera observado. Una diferencia crea incidente,
bloquea purga y conserva el material afectado.

## Rollback y reconstrucción de auditoría

Después de un restore, obtener el último manifest válido y comparar secuencia/hash
con PostgreSQL. Si divergen, entrar en `RECOVERY`, bloquear operaciones
privilegiadas, identificar eventos archivados ausentes y reconstruir la proyección
consultable desde el archive. Reconciliar por separado el dominio; restaurar audit
no demuestra que el estado de negocio tenga el mismo punto temporal.

## Caída de observabilidad

Confirmar alcance del Collector y de cada backend sin usar el dashboard QAPAQ como
única señal. La aplicación continúa; el buffer se limita a 6 horas o 10 GiB y el
descarte sigue DEBUG, INFO, traces exitosos sampled y observabilidad no crítica.
Verificar que los contadores de pérdida aumenten y que la alerta alcance un canal
externo. Nunca reenviar audit trail por esta cola como workaround.

## Consulta cold / restauración

Autorizar propósito/rango, planear coste/capacidad y verificar hold. Restaurar
particiones seleccionadas a destino temporal autorizado, comprobar digests y
conteos, ofrecer estado/cobertura. Reautorizar descarga; cancelar/expirar trabajo
y limpiar derivados temporales respetando holds. Un fallo no equivale a cero resultados.

## Sospecha de secreto expuesto

Limitar conector/cuenta afectada, avisar a custodio y Seguridad por canal aprobado,
rotar/revocar, revisar alcance y auditoría. No pegar secreto en ticket/log/chat.
Conservar evidencia restringida y redactar derivados; verificar nueva referencia
y reanudar con mínimo permiso. No borrar evidencia por limpiar logs sin política.

## Purga y legal hold

Mientras el gate de ADR-018 esté pendiente, no ejecutar TTL destructivo: toda purga
productiva es manual, aprobada y auditada. Comprobar dataset, versión de política,
trigger, alcance, copias, archivo y holds. Ejecutar dry-run, aprobar el plan y borrar
en orden de dependencias. Si existe conflicto, detener; el vencimiento no es permiso.
Emitir purge receipt con conteos, bytes, métodos, errores y copias pendientes;
actualizar deletion ledger. Un resultado parcial alerta y no se declara exitoso.

## Recuperación del producto

Restaurar en entorno aislado, validar llaves/secret refs, PostgreSQL y catálogo,
raw/archivo, reconstruir índices/colas según contrato, revisar permisos y
checkpoints. Arrancar fuentes controladamente y comparar cobertura. No ejecutar
playbooks/acciones externas durante replay de recuperación. Medir RPO/RTO real
y registrar discrepancias frente al objetivo.
Reaplicar el deletion ledger antes de habilitar acceso para impedir que reaparezcan
usuarios, exports u objetos purgados. Registrar propósito, aprobador, integridad y
objetos restaurados; deshabilitar notificaciones, playbooks y efectos externos.

## Backlog y cambio de modo

Medir ingreso, procesamiento, profundidad, edad máxima y drain time. Si processing
no supera ingreso, declarar `DEGRADED`; YELLOW reduce baja prioridad, ORANGE activa
`INGEST_ONLY` y RED protege capacidad durable con rechazo explícito o aislamiento.
Registrar rango afectado y replay. No descartar silenciosamente.

## Reconciliación SOAR

Tras timeout o recovery, listar commands con resultado `UNKNOWN`, consultar el
proveedor cuando sea seguro y registrar el efecto observado. No reintentar hasta
confirmar que no duplicará una acción. SOAR se reanuda después de datos y detección.

## Caída de Teams o alerta crítica sin acuse

Trigger: `TEAMS_DEGRADED`, salida crítica pendiente, cinco intentos agotados o
acuse vencido. Confirmar que alerta y outbox continúan durables sin revelar el
webhook; clasificar SEV1 cuando exista una crítica pendiente y SEV2 en caso
contrario. Activar el canal secundario aprobado, escalar al SOC Manager, revisar
owner/licencia/workflow/secretRef y reconciliar por `notificationId`. No reenviar
ciegamente ni marcar `SENT` como leído. Validar recuperación, drenar en orden y
conservar auditoría de intentos, escalamiento y resolución.
