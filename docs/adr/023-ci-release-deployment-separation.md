# ADR-023 — Separación de CI, release y despliegue

- Estado: **CONDITIONALLY ACCEPTED / PARTIALLY RESOLVED**
- Fecha: 2026-09-18
- Responsables: SOC/Development + Security + Infrastructure

## Context

U-011 mezclaba controles que el equipo puede construir en el repositorio con
datos que solo Infraestructura puede entregar. El destino, registro, identidades y
mecanismo de despliegue todavía no existen como contrato aprobado. Esto no debe
impedir CI ni la construcción verificable de candidatos.

El workspace aceptado usa pnpm. Crear `package-lock.json` solo para ejecutar
`npm audit` introduciría dos fuentes de resolución y una señal engañosa.

## Decision

Separar tres capacidades:

1. CI para pull requests.
2. Construcción y certificación de candidatos de release.
3. Publicación y despliegue a ambientes.

CI y construcción de candidatos quedan habilitados para el MVP. Publicación queda
bloqueada hasta recibir un registro autorizado y su autenticación. Despliegue queda
bloqueado hasta que Infraestructura entregue y pruebe el contrato de ambiente.
Ningún workflow usa credenciales, destinos o nombres físicos supuestos.

SOC/Development implementa CI, pruebas, escaneos, build, versionamiento y evidencia.
Security define gates y aprueba excepciones. Infraestructura proporciona registro,
ambientes, identidad, conectividad, mecanismo, aprobadores, health checks, soporte
y restauración. Esta decisión no elige cloud, orquestador ni IaC.

El workspace pnpm usa `pnpm install --frozen-lockfile` y `pnpm audit`. No se crea
`package-lock.json` para satisfacer un control npm. Si `npm audit` fuera un
requisito literal, Security debe aceptar formalmente la equivalencia o modificar
el requisito.

Release parte de un commit integrado en la rama principal protegida y una etiqueta
SemVer protegida `vX.Y.Z`. Se construye una vez y el mismo digest inmutable se
promueve entre ambientes. No se usa `latest` como referencia desplegable.

## Alternatives

- **Esperar a Infraestructura antes de crear CI:** descartado porque bloquea
  controles y evidencia independientes del destino.
- **Un workflow único con destinos provisionales:** descartado porque mezcla
  confianza, permisos y responsabilidades y puede publicar por error.
- **Reconstruir por ambiente:** descartado porque rompe la identidad del artefacto
  certificado.
- **Mantener npm audit con un lockfile artificial:** descartado porque contradice
  el workspace pnpm y crea deriva de dependencias.
- **Credenciales persistentes desde el inicio:** descartado; se prefiere OIDC con
  tokens temporales cuando el destino lo soporte.

## Consequences

- El workflow de CI existente puede evolucionar sin esperar cloud o registro.
- El candidato puede conservarse como artifact de GitHub Actions para validación,
  pero no es una publicación ni una release desplegable.
- No se implementa workflow de despliegue hasta recibir el contrato real.
- El CI actual basado en descubrimiento npm no satisface todavía la decisión pnpm;
  debe migrarse junto con el workspace antes de considerarse conforme.
- GitHub Environments, aprobaciones y OIDC se configuran solo tras confirmar plan,
  capacidades y destinos reales.

## Trade-offs

Separar pipelines añade manifests de evidencia, promoción y coordinación, pero
reduce privilegios y permite avanzar sin inventar infraestructura. Build-once exige
compatibilidad de configuración en runtime y disciplina sobre migraciones. Los
gates estrictos pueden retrasar releases, a cambio de una cadena verificable y
excepciones temporales auditables.

## Gate de cierre

U-011 se cierra completamente cuando se demuestra:

1. Una PR no confiable no lee secretos, escribe, publica ni despliega.
2. CI ejecuta satisfactoriamente los controles definidos.
3. Un candidato genera artifact inmutable, SBOM, digest y attestation.
4. Infraestructura acepta el contrato de publicación/despliegue.
5. El mismo digest se publica y despliega en staging.
6. Health checks detectan un despliegue fallido.
7. Rollback restaura el digest anterior.
8. La evidencia completa queda disponible para auditoría.

Hasta entonces la decisión arquitectónica está aceptada, pero U-011 permanece
parcialmente resuelta y publicación/despliegue continúan bloqueados.

[Política canónica](../ci-cd.md) · [Despliegue](../deployment.md) ·
[U-011](../decisions/unresolved.md)
