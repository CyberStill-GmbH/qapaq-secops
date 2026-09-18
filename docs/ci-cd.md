# CI de seguridad y preparación de CD

FACT: `.github/workflows/ci.yml` ejecuta GitHub Actions en push, pull request,
merge queue, ejecución manual y semanal. No existen aún aplicaciones, manifiestos
npm ni Dockerfiles. El destino de despliegue sigue UNRESOLVED en U-011.

## Controles implementados

- CodeQL analiza workflows y activa JavaScript/TypeScript o Python al detectar
  fuentes versionadas. Python incluye el script de CI, no implica una aplicación
  Python. Los resultados se publican en Code scanning.
- Dependabot propone actualizaciones semanales de acciones, npm e imágenes base.
  Las entradas npm/Docker están preparadas para futuros manifiestos; GitHub puede
  indicar que no encontró archivos mientras no existan. No hay automerge.
- npm audit revisa cada package-lock.json, incluyendo dependencias de desarrollo.
  Falla con HIGH/CRITICAL o errores del servicio. Node 24 es el runtime actual del
  scanner y U-002 fija Node 24.21.0 para la aplicación; el workflow todavía no fija
  ese patch ni implementa el workspace pnpm aceptado.
- Trivy revisa vulnerabilidades y configuraciones del filesystem y las imágenes
  construidas localmente. HIGH/CRITICAL bloquean, incluso sin fix disponible.
  Los errores de descarga de bases también fallan.
- Gitleaks revisa todo el historial descargado, con redacción completa. Un secreto
  bloquea. No se suben reportes con valores sensibles como artefactos.
- `CI gate` exige éxito de todos los jobs aplicables, incluidas sus matrices.
  El resumen identifica controles NOT_CONFIGURED. Un gate verde sin aplicación
  no acredita pruebas de aplicación ni preparación para desplegar.

Acciones fijadas por SHA; Trivy 0.74.0 y Gitleaks 8.30.1 descargados como binarios
con SHA-256 guardado en `.github/ci/install-scanner.sh`. Dependabot actualiza las
acciones; las versiones/checksums del script requieren actualización manual revisada.
La selección considera el [aviso oficial de Trivy](https://github.com/aquasecurity/trivy/discussions/10425).

## Activación en GitHub

1. Subir los archivos de CI junto con el verificador existente:
   `.codex/skills/implementation-verifier/scripts/verify.ps1` y
   `docs/verification-checks.json`. Actualmente también son archivos locales nuevos.
2. Habilitar Actions y Code scanning con configuración avanzada; evitar ejecutar
   simultáneamente el default setup de CodeQL. Confirmar disponibilidad de GitHub
   Code Security para repositorios privados.
3. Exigir `CI gate` en el ruleset de la rama protegida. Configurar además **code
   scanning merge protection** para CodeQL con el umbral acordado. El éxito del
   job CodeQL acredita ejecución, no ausencia de alertas; no bloquea hallazgos por sí solo.
4. Habilitar dependency graph, Dependabot alerts y security updates. Las propuestas
   de actualización de versiones no sustituyen esos ajustes.
5. Ejecutar el workflow manualmente y en una PR; revisar resultados y cobertura.

No se han modificado ajustes remotos. Se usan runners hospedados efímeros,
`contents: read`, checkout sin persistir credenciales y `security-events: write`
solo en CodeQL. No hay `pull_request_target`, PAT ni secretos productivos.
Revisar los cambios a workflows, scripts y configuración de scanners como código
ejecutable de confianza y protegerlos mediante revisión obligatoria de ramas.

## Activación al incorporar software

Materializar `.nvmrc`, `package.json`, `pnpm-workspace.yaml` y `pnpm-lock.yaml`
según ADR-016. La instalación debe usar pnpm 12.4.2 con lockfile congelado y sin
scripts de instalación no aprobados. El descubrimiento y auditoría actuales solo
entienden `package-lock.json`/npm: deben ampliarse o sustituirse antes de considerar
cubierto el workspace aceptado. Mantener ese hueco visible y agregar generación o
compilación como pasos explícitos revisados cuando sean necesarios.

Configurar comandos reales en `docs/verification-checks.json` para formato, lint,
unit, integración, typecheck y boundaries. `quality` usa el verificador existente;
checks sin configurar fallan con exit 2. No se inventan scripts pnpm ni se usa
`--if-present`. Añadir el build real cuando exista, antes de habilitar releases.

Registrar cada imagen en `.github/ci/containers.json` con `dockerfile` y `context`
relativos al repositorio. El array inicial está vacío porque no hay imágenes.
Un Dockerfile sin entrada hace fallar el descubrimiento; no se adivina su contexto.
Definir `.dockerignore` y referencias base por digest al implementar contenedores.
No se pasan secretos de build. Las imágenes se escanean y descartan sin publicar.

## CD pendiente

U-011 requiere registro, destino, ambientes, identidad, aprobaciones, health checks,
migraciones y rollback. La CI puede continuar; no hay publicación ni despliegue
ficticio. La futura CD debe depender de estos controles, consumir el artefacto
inmutable ya verificado y usar un ambiente protegido con permisos mínimos.

## Referencias y límites

- [CodeQL](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options).
- [Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
- [Gitleaks](https://github.com/gitleaks/gitleaks).
- [Trivy](https://github.com/aquasecurity/trivy).

La validación local de sintaxis y descubrimiento no sustituye la ejecución en
GitHub: quedan por comprobar consultas CodeQL, bases de vulnerabilidades, permisos
de carga y rulesets. Los checks de aplicación siguen NOT_CONFIGURED.

Verificación local: actionlint 1.7.12 y sintaxis Bash aprobados; escenarios de
descubrimiento y siete escenarios del gate aprobados. El verificador del proyecto
devolvió exit 2 (seis checks NOT_CONFIGURED). No se han ejecutado escaneos remotos.
