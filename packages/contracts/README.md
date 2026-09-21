# `@qapaq/contracts`

## `qapaq.security-event` 1.0.0

`SecurityEvent` es la frontera canónica entre adaptadores de fuentes de seguridad y
el dominio de QAPAQ SecOps. El archivo
`src/security-event/security-event.schema.json` es la fuente normativa wire. Los
tipos TypeScript se generan desde él y una prueba impide publicar una versión con
deriva entre schema, tipos o catálogos.

`recordId` identifica una recepción física y debe ser UUIDv7. Un replay conserva
`eventUid`, que identifica el evento lógico dentro de su fuente, pero recibe un
`recordId` nuevo. `tenant.id` es el ámbito lógico opaco usado para aislamiento y
autorización; no presupone un cliente SaaS, una filial ni una unidad organizativa.

Los tiempos son UTC RFC 3339: `occurredAt` describe cuándo ocurrió la actividad,
`observedAt` cuándo la vio la fuente o recolector y `receivedAt` cuándo la recibió
QAPAQ. No se exige orden entre ellos. `provenance.timestampQuality` declara si el
tiempo viene de la fuente, fue derivado o estimado.

`severity.normalized` permite decisiones comunes y la familia `original*` conserva
el dato del proveedor. `mappingId` y `mappingVersion` identifican la transformación;
el contrato no contiene rangos específicos de ningún proveedor.

Una alerta requiere `detection.rule`, que representa de forma genérica la regla de
origen. `raw` contiene una referencia opaca, SHA-256 de los bytes exactos, media type
y tamaño. No contiene el payload, credenciales ni una URL firmada. La cadena
`provenance.ingestionPath` puede expresar, por ejemplo, Microsoft 365 → Wazuh →
adaptador QAPAQ sin confundir el origen con la fuente inmediata.

Las extensiones usan claves reverse-DNS (`com.wazuh`) y solo valores JSON. La versión
1.0.0 limita el bloque serializado a 16 KiB, profundidad a 4, propiedades totales a
64, arrays a 64 elementos, claves a 128 caracteres y strings a 4096 caracteres.
También rechaza claves de prototipo y claves que pretendan transportar raw o
secretos. Ningún campo obligatorio puede depender de una extensión.

### API pública

```ts
import {
  isSecurityEvent,
  parseSecurityEvent,
  validateSecurityEvent,
  type SecurityEvent,
} from '@qapaq/contracts';

const result = validateSecurityEvent(input);
if (!result.valid) console.error(result.errors);

const event: SecurityEvent = parseSecurityEvent(input);
if (isSecurityEvent(input)) input.schemaVersion;
```

El validador no genera IDs, no aplica defaults, no convierte tipos, no elimina
propiedades y no consulta red, almacenamiento ni variables secretas.

### Ejemplo mínimo

El fixture `src/security-event/fixtures/valid/10-empty-entities.json` es el ejemplo
mínimo ejecutable. El corpus completo incluye procedencia Microsoft 365 → Wazuh →
QAPAQ, severidad desconocida, ausencia de identidad humana, ID derivado, detección y
extensiones acotadas.

### Versionado y comprobación

- PATCH: corrección sin cambio semántico.
- MINOR: ampliación compatible demostrada por corpus.
- MAJOR: cambio incompatible.

```sh
pnpm --filter @qapaq/contracts test:contract
pnpm --filter @qapaq/contracts typecheck
pnpm --filter @qapaq/contracts build
```

ECS y OCSF son referencias para perfiles posteriores. Este contrato no declara
conformidad con esos estándares.
