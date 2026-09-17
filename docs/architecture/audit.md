# Auditoría y cadena de custodia

Estado: PROPOSAL · [ADR-012](../adr/012-audit-trail.md).

## Tres conceptos

SecurityEvent representa telemetría externa; ApplicationLog sirve a diagnóstico;
AuditEvent demuestra acciones dentro de la plataforma. No se reemplazan entre sí.
Los logs pueden muestrearse; la auditoría crítica no se descarta por sampling.

AuditEvent propuesto: id, actorId/actorType (human, service o system), action,
resourceType/resourceId, timestamp UTC, sourceIp validada según proxies confiables,
userAgent acotado, sessionId de referencia no bearer, correlationId, reason,
outcome y metadata permitida. previousState/newState son diffs allowlisted
redactados, nunca volcado íntegro de entidad. Guardar policyVersion y delegación
para jobs cuando aplique; una denegación puede no tener actor autenticado.

## Acciones y atomicidad

Auditar RBAC/usuarios, configuración, reglas y su activación, conectores, exportación
de evidencia, políticas/retención, hold/purga, administración, cierre/reapertura de
incidentes y cambios críticos de casos. También denegaciones relevantes y acceso
a raw/evidencia, según política de privacidad y volumen.

Mutación operacional y AuditEvent local se insertan en la misma transacción
PostgreSQL, a través de un writer de auditoría con la unidad de trabajo. Si no
puede persistirse la auditoría crítica, rollback y respuesta de fallo. Outbox
transaccional envía posteriormente al archivo protegido; no usar solo un evento
en memoria posterior al commit.

Un fallo/denegación sin commit de negocio usa transacción de auditoría separada;
nunca queda borrado por el rollback del negocio. Acciones externas registran
intención y resultado/unknown sin fingir atomicidad con el proveedor. Exportación
se audita al solicitar, autorizar y entregar, incluyendo hash/manifiesto.

## Resistencia a manipulación

Rol de runtime permite append, no UPDATE/DELETE de registros auditables. Lectura y
exportación requieren capabilities independientes. Mantenimiento/purga requieren
cuenta separada, política de retención/hold y trazabilidad; no triggers que el mismo
superusuario pueda desactivar como única defensa.

Exportar lotes con digest/manifiesto y encadenamiento o firma a object storage con
controles inmutables cuando el proveedor lo soporte. Separar administración de
llaves y datos; verificar regularmente conteos, secuencia, manifests y entregas.
Un hash en la misma base no protege frente al administrador que modifica ambos.
WORM, firma y custodia de llaves son capacidades a confirmar, no existentes.

PostgreSQL guarda auditoría operacional acotada por política y particionamiento
futuro; archivo conserva el horizonte aprobado. No retener sin límite hasta
saturar el control plane. Al retrasarse archivo, alertar, aplicar backpressure
y bloquear nuevas mutaciones críticas antes de agotar el buffer durable acordado.

## Evidencia y privacidad

Mantener origen, colector/parser/versiones, tiempos observados, digests y cada
exportación/restauración. Referencias no permiten saltar controles del store.
Acceso a evidencias de otro case se verifica aunque se conozca el ID. Un legal hold
abarca originales y derivados relevantes. La cadena de custodia describe el manejo,
no certifica admisibilidad legal por sí sola.

No registrar secretos, tokens, contraseñas ni PII innecesaria. Si la evidencia raw
los contiene, restringirla; su digest/ID es suficiente para auditoría general.
Usar actor técnico persistente para procesos automáticos y actor humano originador
cuando exista, sin impersonación silenciosa.

[Flujo de auditoría](../diagrams/09-audit.mmd).
