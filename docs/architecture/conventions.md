# Naming y convenciones de código

Convenciones de dominio/código: PROPOSAL. Toolchain y flags mínimos: ACCEPTED por
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md). No tooling materializado.

## Lenguaje y nombres

Código/contratos usan inglés; documentación de equipo en español. Directorios y
archivos kebab-case; tipos/clases PascalCase; variables/funciones camelCase;
Python snake_case y clases PascalCase. Capability en resource.action estable;
eventos de hechos en pasado con versión explícita, por ejemplo incident.closed.v1,
solo como convención, no contrato publicado.

Nombres reflejan intención: CloseIncident, SecurityEventProvider, SophosAdapter.
No sufijos Manager/Helper genéricos ni servicios con responsabilidad ilimitada.
IDs opacos como strings; fechas de intercambio UTC y zona explícita; duraciones
con unidad. No mezclar timestamp vendor con timestamp de ingesta.

## TypeScript/NestJS

TypeScript 6.0.3 con `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`
y `noFallthroughCasesInSwitch`. No any en fronteras sin validación previa, ni type assertion como
sustituto de parsing. DTO runtime separado de entidad persistida. Mapear errores de
dominio/aplicación a códigos seguros en presentation; no lanzar HttpException
desde domain. Pasar contexto de actor/correlación explícito. Las operaciones
protegidas declaran capability/resource mediante `@Policy`; no comparan roles en
controllers ni aceptan identidad implícita desde contexto global.

Inyección mediante tokens en composition root; domain no depende del contenedor.
Ports para IO, tiempo o aleatoriedad cuando faciliten pruebas/reemplazo real; no
una interfaz vacía por cada clase. Transacciones cortas sin requests a vendors
dentro. Concurrencia optimista para edición de casos/reglas y claves únicas para
efectos idempotentes. Evitar catch silencioso y retries infinitos.

## Python y React

Python 3.14.7 con uv/uv.lock, Ruff, mypy o Pyright y pytest. Tipos y validación
de contratos; librerías analíticas no deciden permisos del SOC.
Sin pickle ni comandos construidos con texto de eventos. Versionar reglas y
dependencias para reproducibilidad.

React: organización por features, estado de UI separado de dominio; ninguna
credencial de vendor en cliente. Tratar texto/HTML de eventos como hostil. Reusar
contratos de presentación, no entidades ORM; estados loading/empty/error/partial/
stale distintos. Permisos de UI solo mejoran experiencia de uso.

## Datos y cambios

Migraciones versionadas y revisadas, ownership por módulo; plan expand/contract
cuando cambia un contrato compartido. No ORM auto-sync en producción.
Configuración validada al arrancar, secretos por referencia; fail-fast en requisitos
mínimos, degradación explícita para integraciones opcionales.

Fixtures sintéticos autocontenidos con hostname example y rangos reservados de
documentación. Evitar copiar incidentes reales incluso «anonimizados» sin revisión.
No snapshots masivos de respuestas con PII.

Cada cambio referencia requisito/ADR, agrega prueba proporcional y declara lo no
ejecutado. Se aceptan oxlint, Prettier, `tsc`, Vitest, Playwright, Testcontainers
y k6. No afirmar que los scripts existen hasta materializarlos y ejecutarlos.
