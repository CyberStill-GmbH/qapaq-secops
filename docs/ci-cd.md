# CI, release y despliegue

Estado: **CONDITIONALLY ACCEPTED / PARTIALLY RESOLVED** por
[U-011/ADR-023](adr/023-ci-release-deployment-separation.md). CI y construcción de
candidatos están habilitados. Publicación y despliegue están bloqueados hasta que
Infraestructura entregue sus contratos.

## Separación y ownership

| Capacidad | Estado | Responsable principal |
| --- | --- | --- |
| CI de pull requests | Habilitada para MVP | SOC/Development |
| Construcción y certificación | Habilitada | SOC/Development + Security |
| Publicación en registro | Bloqueada | Infrastructure entrega contrato |
| Despliegue | Bloqueado | Infrastructure entrega contrato |

SOC/Development implementa y mantiene pruebas, escaneos, build, versionamiento y
evidencia. Security gobierna gates y excepciones. Infraestructura proporciona
registro, retención, destinos, mecanismo de despliegue, identidad, conectividad,
aprobadores, health checks, soporte y restauración. No se seleccionan cloud,
orquestador ni herramienta IaC.

## Estado observado del repositorio

FACT: `.github/workflows/ci.yml` usa GitHub-hosted runners y ejecuta en push, PR,
merge queue, manual y schedule. Tiene `contents: read` por defecto, no usa
`pull_request_target`, fija Actions por SHA y ejecuta CodeQL, Gitleaks, Trivy,
descubrimiento, un verificador y un gate agregado. No publica ni despliega.

FACT: GitHub Code Security no está habilitado para este repositorio privado. CodeQL
analiza TypeScript/JavaScript y Python, escribe SARIF por lenguaje y lo conserva 30
días como artifact del run. Se usa `upload: never` para evitar que una publicación
SARIF no disponible invalide un análisis correcto. El artifact faltante falla de
forma cerrada. Si se habilita Code Security, se cambia a publicación SARIF y se
restaura `security-events: write` exclusivamente en el job CodeQL.

FACT: el workflow descubre el workspace pnpm materializado, exige las versiones
fijadas en `.nvmrc` y `packageManager`, instala con
`pnpm install --frozen-lockfile --ignore-scripts`, ejecuta `pnpm audit` y corre el
verificador integral. Un `package-lock.json`, una versión no aprobada o entradas
incompletas provocan fallo cerrado.

GAP: aún no existen imágenes registradas en `.github/ci/containers.json`; por ello
el escaneo de contenedores se omite y el resumen lo declara `NOT_CONFIGURED`. El
job pasa a ser obligatorio automáticamente cuando se registre el primer
`Dockerfile` real.

## CI de pull requests

Toda PR ejecutará, como mínimo:

- instalación reproducible con `pnpm install --frozen-lockfile`;
- formato, lint y tipos;
- unit tests y build;
- integración que no requiera secretos;
- CodeQL, Gitleaks y Trivy filesystem;
- dependency review y `pnpm audit`;
- validación de migraciones y workflows.

Cuando se implemente U-010, CI valida el JSON Schema 2020-12, ejemplos válidos e
inválidos, corpus compartido, compatibilidad SemVer y mappings versionados. También
impide declarar compatibilidad ECS/OCSF si el perfil y su reporte de cobertura no
se validan. El schema normativo y sus artefactos derivados deben cambiar juntos.

Los workflows de PR usan `pull_request`, `permissions: contents: read` como base,
sin secretos ni identidades de despliegue. No publican ni despliegan, no comparten
caché con procesos privilegiados y fijan Actions externas a SHA completo. Títulos,
ramas y metadata son input no confiable. Cambios en workflows, migraciones,
autenticación, autorización o controles de seguridad requieren CODEOWNERS.

## Candidatos de release

Una release solo parte de un commit integrado en la rama principal protegida y una
etiqueta SemVer protegida `vX.Y.Z`. El pipeline construye una vez:

- artifact o imagen OCI inmutable;
- digest SHA-256;
- SBOM;
- resultados de pruebas y escaneos;
- procedencia o attestation;
- manifest de release;
- listado de migraciones;
- versión anterior conocida para rollback.

El mismo digest se promueve entre ambientes. No se reconstruye por ambiente ni se
usa `latest`. Sin registro aprobado, el candidato puede guardarse como artifact de
GitHub Actions para validación, sin llamarlo publicación o release desplegable.

## Gates de seguridad

Bloquean la release:

- pruebas obligatorias fallidas;
- secretos confirmados por Gitleaks;
- vulnerabilidades Critical o High nuevas sin excepción aprobada;
- alertas CodeQL High o Critical nuevas;
- SBOM, digest o attestation ausentes;
- migración no probada;
- ausencia de rollback o aprobaciones requeridas.

Un falso positivo se cierra con evidencia. Una excepción de vulnerabilidad registra
componente, identificador, alcance, riesgo, control compensatorio, responsable y
vencimiento máximo de 30 días; requiere Security y Service Owner. No existen
excepciones para secretos confirmados.

## Ambientes, identidad y concurrencia

Se definen lógicamente `development`, `staging` y `production`, sin asignar hosting:

- development: desde rama principal;
- staging: aprobación SOC o responsable técnico;
- production: aprobación de Infrastructure y Service Owner, sin autoaprobación;
- máximo un despliegue simultáneo por ambiente;
- producción nunca desde PR o rama arbitraria.

Tras recibir destinos se usan GitHub Environments con variables/secretos separados,
protecciones y ramas/tags permitidos, sujeto a las capacidades del plan contratado.
Cada ambiente usa identidad distinta y mínima. Se prefiere federación OIDC con
credenciales temporales; una alternativa de larga duración requiere aprobación
explícita cuando el destino no soporte OIDC.

## Migraciones

Prisma usa su mecanismo de despliegue; `db push` está prohibido en ambientes
controlados. Antes de producción, una migración:

- se prueba en staging sobre estructura equivalente;
- mantiene compatibilidad con la versión anterior;
- aplica expand/contract para cambios destructivos;
- se ejecuta una sola vez bajo exclusión mutua;
- registra inicio, resultado y versión.

Rollback normal vuelve al digest anterior. No ejecuta down migrations automáticas
en producción. Si el schema impide volver, se aplica corrección hacia adelante o
el procedimiento de restauración de U-009.

## Health checks y rollback

La aplicación expondrá `/health/live`, `/health/ready` y `/health/startup` cuando
el arranque lo requiera, sin secretos ni topología sensible. Después de desplegar
se verifican versión, disponibilidad, base, colas, migraciones y acceso mínimo al
motor de búsqueda. Fallo de readiness, smoke, migración o umbral operacional
provoca rollback al digest anterior.

Rollback se demuestra primero en staging y conserva artifact anterior,
responsable, tiempos y resultado. No se afirma rollback operativo hasta ejecutar
la prueba contra el destino aprobado.

## Evidencia de release

Conservar por release:

```text
commit y tag
run de GitHub Actions
SHAs de Actions
hash del lockfile
resultados de pruebas y escaneos
SBOM y digest
artifact digest y attestation
aprobaciones
migraciones aplicadas
destino lógico
health checks
resultado de despliegue o rollback
```

La evidencia no contiene secretos y sigue la retención aprobada.

## Contrato pendiente de Infraestructura

Para activar publicación y despliegue, Infraestructura entrega:

- registro autorizado y retención;
- destinos development/staging/production;
- mecanismo de despliegue;
- identidad y trust OIDC, o alternativa aprobada;
- conectividad desde GitHub-hosted runners;
- aprobadores por ambiente;
- consulta de health checks;
- responsables de soporte y restauración.

No se crea workflow de deployment con valores ficticios o credenciales provisionales.

## Criterios de cierre

Los ocho escenarios de [ADR-023](adr/023-ci-release-deployment-separation.md#gate-de-cierre)
deben demostrarse. Hasta entonces CI y candidatos pueden evolucionar, mientras
publicación y despliegue permanecen bloqueados.

## Referencias

- [GitHub Actions: uso seguro](https://docs.github.com/en/actions/reference/security/secure-use).
- [GitHub Actions: OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers).
- [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [pnpm audit](https://pnpm.io/cli/audit).
- [CodeQL](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options).
- [Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
- [Gitleaks](https://github.com/gitleaks/gitleaks).
- [Trivy](https://github.com/aquasecurity/trivy).
