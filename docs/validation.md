# Validación de la entrega documental

Validación inicial y actualizaciones: 2026-09-17. Alcance: arquitectura creada en
`docs/`, sin implementación de features ni acceso a servicios de Financiera Qapaq.
Las fechas de decisión 2026-09-18 de U-001/U-002/U-003 fueron aportadas por el usuario.

## Comprobaciones vigentes

- Diecisiete ADR canónicos identificados por encabezado ADR-001…017. ADR-015,
  ADR-016 y ADR-017 están Accepted; ADR-001…014 conservan Proposed salvo aspectos
  explícitamente sustituidos. Las tres notas heredadas de temas renumerados no se
  cuentan como ADR adicionales.
- Los diecisiete ADR contienen Context, Decision, Alternatives, Consequences y
  Trade-offs. U-002 fija las catorce entradas de versión aportadas y mantiene la
  capacidad numérica como PENDING MEASUREMENT.
- Enlaces Markdown locales comprobados contra el filesystem; fences Markdown y
  `docs/verification-checks.json` comprobados. `git diff --check -- docs` no
  reportó errores.
- Once fuentes Mermaid constan en el repositorio. La validación previa renderizó
  las once; U-003 actualizó contexto y autenticación. Sus fuentes pasaron revisión
  estructural, pero el render temporal no concluyó porque `mermaid-cli` no pudo
  adquirirse dentro de la ventana acotada. No se añadió dependencia al repositorio.
- Revisión manual de coherencia entre U-002, ADR-016, requisitos, convenciones,
  estructura, API, ingesta, storage, deployment, testing, roadmap y CI/CD.
- El verificador de implementación se ejecutó y reportó `NOT_CONFIGURED` para
  format, lint, unit, integration, typecheck y boundaries. Esto confirma que los
  nombres de scripts aceptados todavía no constituyen tooling ejecutable.

## Actualización por aceptación de U-001

U-001/ADR-015 acepta el alcance integral, ocho módulos, ownership, vocabulario,
lifecycles y orden inicial por resolución explícita del usuario. La primera
vertical es un orden de construcción y no condiciona esa aceptación. La revisión
previa comprobó los diagramas de ciclos de incidente y alerta.

## Actualización por aceptación de U-002

U-002/ADR-016 acepta la baseline de runtime, frameworks, ORM, workspace,
herramientas, límites iniciales, resiliencia, perfiles y gates de benchmark.
La matriz se contrastó el 2026-09-17 con fuentes oficiales y registros de paquetes;
eso acredita disponibilidad individual, no compatibilidad end-to-end.

La CI existente usa descubrimiento y auditoría npm. La documentación registra como
gap su adaptación al workspace pnpm 12.4.2 aceptado. No se modificó el workflow ni
se presentaron scripts, lockfiles o manifests como existentes.

## Actualización por aceptación de U-003

U-003/ADR-017 acepta Microsoft Entra ID single-tenant, OIDC Authorization Code con
PKCE S256, BFF/sesión opaca, scopes, bundles, JIT, doble aprobación, revocación,
raw/exports e identidades de servicio. El estado operacional permanece BLOCKED
UNTIL FEDERATION TESTS PASS; la documentación no afirma tenant, licencias, app
registration, Conditional Access, PIM o federación configurados.

Se contrastaron Authorization Code/PKCE, PIM y criterios de sesión/autenticadores
con Microsoft Learn y NIST SP 800-63B. Se comprobaron enlaces, fences, diecisiete
ADRs y coherencia con seguridad, RBAC, API, auditoría, amenazas, riesgos, testing,
deployment, roadmap e integraciones.

## Límites

No se ejecutaron tests de aplicación, SAST, pruebas de proveedores, carga, restore
real ni validación de credenciales/licencias. No hay implementación de negocio que
verificar en esta tarea. Tampoco hay evidencia para publicar EPS, sizing productivo
o compatibilidad de la matriz completa.

Renderizar Mermaid no demuestra corrección operacional. Faltan schemas ejecutables,
pruebas de conformidad y decisiones sobre retención, transporte y continuidad.
La identidad tiene decisión aceptada, pero carece de pruebas de federación. Las
capacidades de Sophos/Cato permanecen pendientes porque sus páginas
no pudieron leerse íntegramente; consultar [references.md](references.md).

Los cambios concurrentes de CI y `.github/ci/discover.py` quedan fuera del alcance
y de los commits documentales de esta actualización.
