# C-24 — control plane write-only de credenciales

Fecha: 2026-09-29 · PBI: [PBI-029](../product-backlog.md) · ADR: [013](../../adr/013-secret-management.md), [025](../../adr/025-security-access-observability-hardening.md) · RF: [RF-040](../../requirements/02-functional-requirements.md)

Estado de entrega: **contrato de Sprint 2 completo y verificado en local; sin
superficie HTTP montada y sin proveedor productivo**. El E2E pertenece a Sprint 3,
tal como fija el [plan por componentes](../component-delivery-plan.md).

## Alcance

Alta (`create`), rotación (`rotate`) y revocación (`revoke`) de credenciales de
integración, con persistencia limitada a referencia, fingerprint y metadata no
sensible. No existe ninguna operación de lectura del valor, en ninguna capa.

```text
Platform Admin (autorizado, step-up pendiente de C-18)
      │
      ▼
SecretControlPlane          ← application, platform/configuration
      │  create / rotate / revoke / readMetadata
      ├──────────────► SecretWriter          (puerto write-only)
      │                      └─► gestor externo: ÚNICO lugar con el valor
      ├──────────────► SecretMetadataStore   (metadata + AuditEvent, atómico)
      ├──────────────► SecretAuthorizer      (capability, deny por defecto)
      └──────────────► SecretAuditSink       (intentos: denegación y fallo)

PostgreSQL: secret_ref · fingerprint · provider · status · version · revision
            timestamps · owner · labels          →  NUNCA el valor
```

## Por qué `SecretWriter` es un puerto distinto de `SecretProvider`

C-03 ya define `SecretProvider.resolve(reference)`, que el **runtime** usa bajo la
identidad técnica del adapter. C-24 no lo extiende: añade un puerto separado y
solo de escritura. La separación hace que la propiedad de seguridad la imponga el
sistema de tipos y no la disciplina de quien programe después —el control plane no
tiene ninguna ruta hacia `resolve`, y una spec verifica que no lo importa.

Consecuencia deliberada, ya advertida por ADR-025: *un secreto write-only sigue
siendo resoluble por la identidad técnica*. «No revelable» describe a personas y
APIs humanas, no al runtime que debe usar la credencial.

## Ciclo de vida y máquina de estados

Estados persistidos: `active` y `revoked`. La **rotación no es un estado**: es un
incremento de versión sobre un secreto vivo, de modo que la referencia y sus
consumidores no cambian. `expired` es un estado **derivado** de `expires_at` y del
instante de la consulta; no se persiste porque no existe todavía un planificador
que lo transicione, y persistirlo crearía un estado que nada actualiza.

| Desde | Operación | Hacia | Nota |
| --- | --- | --- | --- |
| — | `create` | `active` v1 | falla si la referencia ya está registrada |
| `active` | `rotate` | `active` v+1 | exige vista `active`: un secreto expirado o revocado no rota |
| `active` (aunque expirado) | `revoke` | `revoked` | revocar un secreto expirado sí es válido |
| `revoked` | cualquiera | — | terminal; garantizado también por trigger en PostgreSQL |

La secuencia completa de ADR-025 —crear nueva versión, **probarla contra el
proveedor**, conmutar y revocar la anterior— depende de un adapter real. En esta
entrega `rotate` cubre el contrato y la versión; el paso de prueba previa a la
conmutación queda como gate del E2E de Sprint 3 y **no se afirma cumplido**.

## Semántica de fallo y modelo de consistencia

No hay transacción distribuida entre el gestor externo y PostgreSQL. El orden es
proveedor primero, metadata después, y cada desenlace tiene un resultado explícito:

| Situación | Código interno | Público | Estado resultante |
| --- | --- | --- | --- |
| El proveedor rechaza la credencial | `SECRET_PROVIDER_REJECTED` | 422 `INTEGRATION_CREDENTIAL_REJECTED` | nada persistido |
| El proveedor no responde | `SECRET_PROVIDER_UNREACHABLE` | 503 `INTEGRATION_CREDENTIAL_UNAVAILABLE` | nada persistido; reintentable |
| Timeout con resultado incierto | `SECRET_RECONCILIATION_REQUIRED` | 503 | el proveedor **puede** tener una versión que QAPAQ no registra |
| El proveedor escribió y la metadata falló | `SECRET_RECONCILIATION_REQUIRED` | 503 | idem; requiere reconciliación humana |
| La auditoría no puede escribirse | `SECRET_AUDIT_WRITE_REQUIRED` | 503 `AUDIT_WRITE_REQUIRED` | la mutación **no** queda visible |
| Revisión cambiada por otra operación | `SECRET_ROTATION_CONFLICT` | 409 `RESOURCE_STATE_CONFLICT` | sin cambio |

**No se compensa automáticamente.** Revocar tras un timeout destruiría una versión
que podría estar en uso; el sistema prefiere un estado declarado como reconciliable
a una acción destructiva sobre evidencia incierta.

**Idempotencia.** `requestId` es la clave: una repetición exacta devuelve el mismo
resultado sin volver a llamar al proveedor. `requestId` viaja además como
`idempotencyKey` hacia el gestor externo, para que un reintento de red no cree dos
versiones.

**El material se quema aunque la operación falle.** `SubmittedSecret` entrega su
contenido una sola vez; un reintento exige que el operador vuelva a enviarlo por
TLS, en vez de conservar plaintext en memoria esperando un segundo intento.

## Autorización

Deny por defecto: cualquier resultado que no sea una concesión explícita —incluida
una excepción del autorizador— deniega y produce `integration.secret.denied.v1`.

| Operación | Capability |
| --- | --- |
| create | `integration.secret.create` |
| rotate | `integration.secret.rotate` |
| revoke | `integration.secret.revoke` |
| metadata | `integration.secret.metadata.read` |

`integration.secret.rotate` ya figuraba como capability crítica en
[identidad y autorización](../../architecture/identity-and-authorization.md); las
otras tres siguen su patrón y son **PROPOSAL** hasta que cierre la decisión abierta
U-013. **No existe `integration.secret.read_value`** y no debe crearse: la operación
que autorizaría tampoco existe en ningún puerto. Una spec lo verifica.

El actor es `PLATFORM_ADMIN`. `AUDITOR` obtiene solo metadata. Step-up, aprobación y
SoD son requisitos de RF-040 que dependen de C-18/Entra y **no están implementados**.

## Auditoría

Toda mutación exige su `SecretAuditEvent` en la misma firma del store, que debe
aplicarlo atómicamente: si el evento no se escribe, la mutación no queda visible.
La invariante de ADR-012 queda así impuesta por el tipo, no por recordar llamarla.

Acciones: `integration.secret.created.v1`, `.rotated.v1`, `.revoked.v1`,
`.denied.v1`, `.failed.v1`. El cambio de material se representa exclusivamente con
`beforeFingerprint`/`afterFingerprint`; nunca hay snapshot del valor.

## Fingerprint

`hmac-sha256:v1:<keyId>:<128 bits base64url>`, con HMAC-SHA-256 y clave custodiada
fuera de la tabla de metadata.

Se descarta `sha256(secreto)`: una credencial de baja entropía sería recuperable por
fuerza bruta offline desde un volcado de la base. Con HMAC, quien obtiene la base no
puede recomputar el fingerprint sin la clave. Se trunca a 128 bits —suficiente para
detectar un cambio de valor, menos útil para correlacionar entre sistemas— y el
`keyId` se deriva por HMAC de una etiqueta fija, de modo que rotar la clave sea
detectable sin exponer material.

## Persistencia

`integration_secret_metadata` e `integration_secret_operations`
([migración](../../../platform/database/prisma/migrations/20260929000000_c24_secret_control_plane/migration.sql)).
Además de no declarar ninguna columna de valor, la base impone:

- `fingerprint` con formato y longitud fija: la columna no puede alojar un secreto;
- `labels` acotadas por `c24_labels_are_safe` —máximo 16 claves, 128 caracteres por
  valor, sin claves con forma sensible— para que el único campo libre no sirva de
  almacén encubierto;
- identidad inmutable (`id`, `secret_ref`, `namespace`, origen) por trigger;
- revisión estrictamente monótona: una escritura concurrente perdida es detectable;
- `revoked` terminal: no puede volver a `active` ni siquiera por UPDATE directo;
- registro de idempotencia append-only.

No se usa `pgcrypto` ni ningún cifrado reversible: guardar ciphertext propio
recrearía el «vault casero» que ADR-025 rechaza.

## Threat model

| # | Escenario | Resultado |
| --- | --- | --- |
| T1 | Volcado completo de PostgreSQL | referencias, fingerprints y metadata; ningún valor, y sin la clave HMAC no se recomputan fingerprints |
| T2 | Compromiso de solo lectura de la base | idem T1 |
| T3 | Credenciales de `AUDITOR` comprometidas | solo metadata |
| T4 | Cuenta `PLATFORM_ADMIN` comprometida | puede crear, rotar y revocar según capabilities; **no puede recuperar ningún valor**, histórico ni vigente |
| T5 | Compromiso de la infraestructura de logs | sin valores: el portador se serializa como `[REDACTED]` también bajo `util.inspect` |
| T6 | Compromiso de trazas/APM | sin valores; el material no sale del closure de escritura |
| T7 | Compromiso de backups de la aplicación | sin plaintext, por construcción del schema |
| T8 | Compromiso del frontend | no existe endpoint capaz de revelar un secreto almacenado |

Riesgo residual explícito: la identidad técnica del adapter sí puede resolver el
valor en runtime (ADR-025). Comprometerla es un escenario distinto, cubierto por
mínimo privilegio por namespace y por la rotación, no por C-24.

## Invariantes verificadas

| ID | Invariante | Cómo se impone |
| --- | --- | --- |
| INV-01 | La persistencia no contiene plaintext | schema sin columnas de valor + spec de forma del registro + contrato de migración |
| INV-02 | El control plane no expone el valor tras el envío | superficie de la clase fijada por spec |
| INV-03 | Ninguna operación soportada recupera un secreto enviado | ausencia de método y de capability, verificada |
| INV-04 | El ciclo de vida exige autorización explícita | deny por defecto; excepción del autorizador = denegación |
| INV-05 | Toda mutación produce auditoría | el store exige el evento en su firma; fallo de auditoría revierte |
| INV-06 | Logs, auditoría y telemetría sin plaintext | spec de centinela sobre respuesta, metadata, auditoría, errores y trazas |
| INV-07 | La referencia es el único vínculo durable con el material | fingerprint HMAC no reversible |
| INV-08 | La rotación no produce divergencia silenciosa | revisión monótona + conflicto detectado |
| INV-09 | Un secreto revocado no vuelve a considerarse activo | estado terminal en dominio y en trigger |
| INV-10 | La metadata no expone credenciales internas del proveedor | recibo sin campos del proveedor; etiquetas con allowlist |

## Evidencia ejecutada — 2026-09-29

| Verificación | Comando | Resultado |
| --- | --- | --- |
| Contrato + ciclo de vida + fallos | `pnpm exec vitest run --config vitest.config.ts platform/configuration/test` | PASS |
| Contrato de migración | `pnpm exec vitest run --config vitest.config.ts platform/database/test/c24-migration-contract.spec.ts` | PASS (7) |
| Suite unitaria del workspace | `pnpm run test:unit` | PASS |
| Typecheck | `pnpm run typecheck` | PASS |
| Lint | `pnpm run lint` | PASS |
| Fronteras | `pnpm run boundaries` | PASS |
| Schema Prisma | `pnpm --filter @qapaq/database exec prisma validate` | válido |

## Límites conocidos de esta entrega

1. **Sin superficie HTTP.** No se monta controlador. `modules/access` y su
   PolicyGuard llegan en C-18, no hay autenticación de usuario, y la decisión
   abierta U-013 exige cerrar el catálogo capability→endpoint *antes* de implementar
   endpoints protegidos. Exponer hoy una ruta que escribe credenciales sin
   autenticación real sería una regresión de seguridad, no un avance. El contrato de
   presentación —rutas, códigos y mapeo público— queda especificado abajo.
2. **Sin proveedor productivo.** El gestor de secretos sigue sin seleccionarse
   (ADR-013, U-019). El puerto es agnóstico y no se introduce dependencia de Vault,
   Key Vault ni equivalentes.
3. **Adapter Prisma no incluido.** El schema, las restricciones y el contrato de
   migración sí; la implementación del store contra PostgreSQL y su verificación con
   base real pertenecen al E2E de Sprint 3. La migración **no se ha aplicado** a una
   instancia real: Docker Desktop sigue caído en el host de desarrollo.
4. **Step-up, aprobación y SoD no implementados.** Son requisitos de RF-040
   dependientes de Entra y C-18.
5. **Namespace productivo sin convención cerrada** (U-019): el código no fija una y
   acepta cualquier namespace válido del formato de C-03.

## Contrato HTTP propuesto para Sprint 3

| Método y ruta | Capability | Éxito | Errores |
| --- | --- | --- | --- |
| `POST /configuration/secrets` | `integration.secret.create` | 201 metadata | 400, 403, 409, 422, 503 |
| `POST /configuration/secrets/{id}/rotate` | `integration.secret.rotate` | 200 metadata | 400, 403, 404, 409, 422, 503 |
| `POST /configuration/secrets/{id}/revoke` | `integration.secret.revoke` | 200 metadata | 400, 403, 404, 409, 503 |
| `GET /configuration/secret-metadata/{id}` | `integration.secret.metadata.read` | 200 metadata | 403, 404 |

El nombre `secret-metadata` en la lectura es deliberado: reduce la probabilidad de
que alguien asuma que `GET /configuration/secrets/{id}` devuelve un valor. En
OpenAPI, el campo de entrada se marca `writeOnly` y los schemas de request y
response son distintos; ningún schema de respuesta admite material secreto.

## E2E de Sprint 3 — escenario preparado

1. `PLATFORM_ADMIN` se autentica con step-up vigente.
2. Crea la credencial de un conector; la respuesta trae referencia y fingerprint.
3. Inspección directa de PostgreSQL: ninguna fila contiene el valor.
4. El adapter resuelve por `SecretProvider` y autentica contra el proveedor real.
5. Rotación: se crea la nueva versión y **se prueba antes** de conmutar.
6. El runtime usa la versión nueva; la anterior deja de ser válida, sin fallback.
7. Revocación: el runtime ya no autentica.
8. El trail de auditoría está completo y encadenado.
9. Un centinela sintético no aparece en logs, trazas, auditoría, colas ni backups.

Precondiciones: gestor de secretos seleccionado y provisionado, identidad técnica
por namespace, C-18 (PolicyGuard) y C-19 (auditoría) disponibles, PostgreSQL real
con la migración aplicada.

[Configuración de runtime (C-03)](../../../platform/configuration/README.md) ·
[C-08 — contrato operativo Wazuh](../c-08/README.md) ·
[Catálogo de errores](../../error-catalog.md) ·
[Auditoría](../../architecture/audit.md) ·
[Baseline de acceso y observabilidad](../../architecture/security-access-observability-baseline.md)
