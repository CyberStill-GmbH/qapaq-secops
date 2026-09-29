# ADR-027 — Control plane write-only para el lifecycle de secretos

- Estado: **ACCEPTED / C-24 IMPLEMENTED**
- Fecha: 2026-09-28
- Alcance: `platform/configuration`, metadata PostgreSQL y adapters de secret backend
- Relacionados: ADR-003, ADR-009, ADR-012, ADR-013, ADR-025; PBI-029

## Contexto

QAPAQ debe dar de alta, rotar y revocar credenciales de integraciones sin convertirse
en vault, proxy de lectura ni mecanismo de exportación. El puerto C-03 existente
resuelve `secretRef` para consumidores runtime. Reutilizar ese puerto en una API
administrativa haría posible leer el valor desde el control plane y mezclaría dos
identidades con privilegios distintos.

Los secretos pueden ser de baja entropía. Un hash simple permitiría verificar
diccionarios offline si la base de metadata se exfiltrara. Además, una operación
contra un backend externo y una transacción PostgreSQL no pueden ser atómicas.

## Decisión

Se mantienen dos fronteras explícitas:

- `SecretProvider` de C-03 resuelve una referencia exclusivamente en el runtime que
  consume la credencial, con identidad y namespace restringidos;
- `SecretLifecycleProvider` de C-24 expone únicamente `create`, `rotate` y `revoke`.
  No contiene lectura, exportación, listado de valores ni DTO de respuesta sensible.

`SecretControlPlane` recibe `SecretMaterial` de un solo uso, calcula un fingerprint
`HMAC-SHA-256` versionado con una clave independiente obtenida mediante C-03, entrega
los bytes al adapter y los sobrescribe al finalizar. La clave HMAC tiene al menos
256 bits y no se persiste junto con la metadata. El HMAC permite comparar versiones;
no cifra ni permite recuperar el valor y evita que una base aislada sirva para
comprobar candidatos sin poseer la clave.

PostgreSQL conserva solo identidad lógica, referencia externa, versión del backend,
fingerprint, lifecycle, ownership, timestamps, recibos de idempotencia, auditoría y
reconciliaciones. Cada mutación exitosa escribe metadata, receipt y auditoría en una
misma transacción. `revision` implementa optimistic locking. Historial, operaciones
y auditoría no se actualizan destructivamente.

Cuando el provider termina pero PostgreSQL falla, o un timeout deja el estado
externo desconocido, la operación no informa éxito: crea una reconciliación segura
y devuelve un error tipado. Auditoría y reconciliación no tienen FK al secreto para
poder registrar fallos de alta anteriores a la existencia de su fila. Si PostgreSQL
está totalmente indisponible, log y métrica allowlisted preservan la señal operativa;
no se finge durabilidad.

El adapter productivo y su backend, endpoint, identidad, certificado, workload
identity, fuente de credenciales y política permanecen `TO_BE_PROVIDED`. El fake se
limita a pruebas. El mismo contract suite debe ejecutarse sobre el adapter real en
el E2E de Sprint 3.

## Consecuencias

- una credencial jamás sale en respuesta, log, audit, métrica, evento o cola de C-24;
- un administrador del control plane no adquiere capacidad runtime de lectura;
- un auditor puede leer metadata, nunca valores;
- `REVOKED -> ACTIVE` está prohibido; reactivar requiere un alta nueva;
- no existe atomicidad ficticia entre provider y DB: los estados ambiguos son
  explícitos y operables;
- perder la clave HMAC impide comparar fingerprints históricos, pero no afecta la
  custodia del secreto externo; rotarla requiere una decisión y plan de migración.

## Alternativas descartadas

- reutilizar el resolver C-03 en el control plane: amplía privilegios y habilita
  extracción;
- guardar el valor cifrado en PostgreSQL: convierte QAPAQ en custodio y amplía
  backups, claves y superficie de compromiso;
- SHA-256 sin clave: facilita comprobación offline de secretos débiles;
- lock distribuido: añade infraestructura sin necesidad; transacción e optimistic
  locking resuelven la concurrencia local;
- elegir un backend concreto sin decisión de Infraestructura: inventaría una
  dependencia productiva.

## Validación

La suite C-24 verifica lifecycle, RBAC, idempotencia, carreras, fallos parciales,
contrato portable, ausencia de APIs de valor/export y canario ausente de DB, logs,
audit, respuestas, eventos y telemetría. La integración PostgreSQL ejecuta las
migraciones y el adapter real; el backend externo real se valida en Sprint 3.

[Evidencia y runbook C-24](../project-management/c-24/README.md)
