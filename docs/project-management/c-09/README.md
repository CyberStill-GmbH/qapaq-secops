# C-09 — CI seguro y evidencia

Estado al 2026-09-25: **IMPLEMENTED / BLOCKED_BY_REPOSITORY_ADMINISTRATION**.
El código C-09 está integrado en `main`, la CI posterior al merge pasó y se
generó el artifact oficial redactado. No declarar `DONE`: el plan actual no
aplica rulesets ni protección de rama al repositorio privado, por lo que no hay
required checks activos; tampoco hay CODEOWNERS/revisión requerida ni una prueba
controlada de fork con canario sintético. El propietario confirmó que es el único
mantenedor humano y eximió CODEOWNERS/revisión independiente mientras siga así;
esa decisión queda registrada, pero no satisface literalmente el DoD original.

## PR #2

El PR #2 del repositorio `CyberStill-GmbH/qapaq-secops`, con base `main`, fue
fusionado a `main` el 2026-09-21. Su head inspeccionado es
`9563ea13e6781923cdaf27275bd04f7b8c80d48a`, autor registrado
`CyberStill-GmbH <cesar.guevara.s@uni.pe>`. El commit es ancestro de `origin/main`
y se integra en la historia mediante `e3a001dc4bb78b9089129320941a774059ea51c4`.
El diff añade seis archivos de CI/Dependabot; no se observó exfiltración, secretos,
acciones sin fijar ni `pull_request_target`. Sí se detectaron deficiencias que se
corrigieron después en `main`: el check `CI gate` falló por CodeQL no disponible,
el job de calidad se omitió por falta de workspace pnpm en ese commit y se usaba
un script `.codex/skills/...` no versionado.

El objeto PR mostraba 12/18 checks pasados, CodeQL y el agregador fallidos, y no
mostraba reviews ni comentarios. La evidencia histórica de checks puede
consultarse en [PR #2](https://github.com/CyberStill-GmbH/qapaq-secops/pull/2).
No se volvió a fusionar ni se alteró ese PR.

## PR #16 y evidencia en `main`

El PR #16, [ci: add C-09 security evidence](https://github.com/CyberStill-GmbH/qapaq-secops/pull/16),
se fusionó el 2026-09-25. El merge commit es
`c6d235b82a88904b3e129103e861f17bd1534f40`. Sus 22 checks pasaron y dos se
omitieron según configuración; el check `CI / required` pasó. La ejecución de CI
en `main` [36179027763](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36179027763)
terminó correctamente. El workflow oficial de evidencia
[36179387219](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36179387219)
terminó correctamente sobre ese merge commit.

Artifact: `c09-ci-evidence-c6d235b82a88904b3e129103e861f17bd1534f40` (ID
`10883736022`, tamaño 2.55 KB, retención 14 días), SHA-256
`e0f8078065e72a1c9973290a322288d57b301adf1390b89ed5bf0315498fc213`. El log del
workflow confirma que Gitleaks no encontró fugas en el bundle, los seis archivos
pasaron `sha256sum --check` y la carga registró ese digest. El ZIP descargado se
inspeccionó: incluye únicamente los seis archivos allowlisted, los seis SHA-256
internos coinciden y el SHA-256 del ZIP coincide con el digest que muestra
GitHub. No se observaron secretos, tokens, cookies, claves ni contenido de código.
GitHub Code Scanning no está habilitado en el plan actual; CodeQL produjo SARIF
como artifact y no intentó subirlo. El artifact contiene resumen y checksums, no
logs crudos.

## Baseline y cambios locales

- Rama predeterminada: `main`; repositorio privado.
- Node fijado: `24.21.0`; pnpm fijado en `packageManager`, `engines` y lockfile:
  `12.4.2`.
- CI: `ubuntu-24.04`, permisos globales `contents: read`, checkout con
  `persist-credentials: false`, timeouts, concurrencia con cancelación,
  Actions externas fijadas por SHA, instalación congelada, CodeQL JS/TS y Python,
  Gitleaks redactado, Trivy, `pnpm audit`, checks C-07, C-04/C-06 y agregador.
  No publica ni despliega.
- El agregador CI se llama `CI / required`; los controles estáticos nuevos
  verifican permisos de solo lectura, SHA pinning, timeouts, concurrencia,
  instalación congelada, ausencia de `pull_request_target` y de
  `continue-on-error`.
- `.github/workflows/evidence.yml` solo reacciona a CI exitoso de un
  push a `main`, obtiene nombres/resultados de jobs por API, exige `CI / required`,
  usa permisos de lectura, crea un bundle allowlisted, escanea antes de cargar y
  fija retención de 14 días. El generador impone límite de tamaño/cantidad,
  detector de patrones y SHA-256. El artifact oficial de `main` está listado
  arriba.
- Dependabot semanal cubre GitHub Actions, npm/pnpm y Docker, con límite de cinco
  PR por ecosistema.
- Los cambios ajenos de C-08 presentes en el worktree fueron preservados.

## Comprobaciones realizadas

- `.github/ci`: `python -m unittest --verbose` — 19/19 pruebas pasan, incluidas
  pruebas del generador y políticas de ambos workflows.
- Prettier en los archivos C-09 cambiados: pasa; `git diff --check`: pasa.
- Instalación reproducible en worktree limpio de `origin/main`, con Node 24.21.0
  y pnpm 12.4.2: `pnpm install --frozen-lockfile --ignore-scripts` pasa.
- Se añadió temporalmente una dependencia solo al manifest en ese worktree; la
  instalación congelada rechazó el manifest/lockfile inconsistente con
  `ERR_PNPM_OUTDATED_LOCKFILE`. El fixture fue retirado después.
- `pnpm audit --audit-level high`: pasa, sin vulnerabilidades conocidas.
- `scripts/verify.ps1`: lint, typecheck, unit (205 pruebas), arquitectura, build y
  smoke pasan. Format falla porque 181 archivos existentes no siguen Prettier;
  no se reformatearon archivos ajenos. C-06 queda `BLOCKED` por Docker no
  disponible en el host.
- Playwright: el test de UI falló una vez con `frame detached` en ejecución
  completa, pasó al repetirlo aislado; el test de recuperación pasó.
- PR confiable existente #10: checks de CI exitosos en run
  [35659935393](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/35659935393),
  incluidos CodeQL, auditoría, calidad, C-04 y el agregador anterior `CI gate`.
- Dependabot PR #13: el contexto automatizado ejecutó checks de lectura y
  Gitleaks/Trivy/CodeQL/auditoría; unit pasó (205 pruebas), pero calidad y C-04/
  C-06 fallaron. Run
  [36151324474](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36151324474).
  Por tanto, se prueba ejecución sin secrets ordinarios, no una aceptación verde.
- PR #2 falló CodeQL porque Code Security no está habilitado. En el workflow
  actual CodeQL produce SARIF como artifact sin intentar subirlo a GitHub.

## Configuración externa observada y cambios autorizados

Lectura autenticada de Settings de GitHub el 2026-09-25:

- No hay rulesets y la interfaz advierte que no serán aplicados al repositorio
  privado hasta mover la organización a GitHub Team. Tampoco existe branch
  protection clásica configurada.
- No existe `.github/CODEOWNERS`. Decisión del propietario (César Adrián,
  2026-09-25): CODEOWNERS y aprobación independiente quedan eximidos mientras
  exista un único mantenedor humano; reevaluar al incorporar otro mantenedor.
- Dependency graph, Dependabot alerts, Dependabot security updates y Code
  Security están deshabilitados en Settings. La actualización de versiones
  Dependabot sí está configurada y tiene PR activo.
- Actions permite todas las acciones de terceros. La retención global observada
  es 90 días. No hay runner self-hosted configurado.
- Permisos por defecto de Actions: lectura. Creación/aprobación de PR por Actions
  desactivada. Tokens de fork de escritura desactivados; secretos/variables del
  repositorio no se envían a forks.
- Con confirmación explícita del usuario se activaron “Require actions to be
  pinned to a full-length commit SHA” y “Run workflows from fork pull requests”.
  Ambos cambios se volvieron a leer en Settings. La segunda política mantiene
  tokens de solo lectura y no envía secrets a forks; GitHub advierte que el
  mantenedor del fork recibirá un `GITHUB_TOKEN` de solo lectura del repositorio
  origen.

## Matriz de cierre

| Criterio | Estado/evidencia |
| --- | --- |
| Inspección e integración de PR #2 | Revisado y ya integrado en `main`; checks históricos fallaron parcialmente |
| Node/pnpm/lockfile | Pins exactos; instalación congelada y fixture de desajuste comprobados |
| Acciones fijadas y permiso mínimo | Workflow validado; SHA enforcement habilitado en Settings |
| CI de PR confiable | PR #10 histórico verde con el nombre previo del agregador |
| PR real de fork | Workflow habilitado; falta una ejecución controlada verificable con canario sintético |
| Dependabot | Ejecución real observada, pero algunos jobs fallaron |
| Secretos/tokens de fork | Settings y YAML indican solo lectura y sin secrets; falta canario controlado |
| C-07 y controles locales | Arquitectura pasa; lint, typecheck, unit, build y smoke pasan |
| C-04/C-06 | C-04 pasa en evidencia CI existente; local C-06 bloqueado por Docker |
| Formato | Falla en 181 archivos existentes de baseline; no se alteraron |
| CODEOWNERS/revisión independiente | Eximido por decisión del propietario mientras haya un único mantenedor humano; el requisito literal sigue sin cumplirse |
| Required checks/ruleset | Bloqueado por plan/settings; no están configurados ni aplicados |
| Workflow/generador de artifacts C-09 redactados, scan, hash y retención 14 días | Ejecutado correctamente sobre `main`; logs confirman Gitleaks limpio y checksums válidos; digest registrado arriba |

## Acciones para cerrar el bloqueo

1. Cambiar el plan de la organización o habilitar una opción que permita aplicar
   rulesets/protección al repositorio privado; el administrador debe exigir PR,
   conversaciones resueltas, protección contra force-push/borrado, bypass
   restringido y `CI / required` después de que ese nombre aparezca en CI. La
   aprobación independiente y CODEOWNERS quedan eximidos por decisión del
   propietario mientras exista un solo mantenedor humano.
2. Ejecutar una PR de fork controlada con canario sintético de prueba y verificar
   que no es accesible, sin guardar su valor. Confirmar explícitamente que no hay
   token de escritura.
3. Resolver en baseline los fallos reproducibles de format/C-06 y ejecutar CI
   actualizado en PR confiable, fork y Dependabot.
4. Artifact oficial generado e inspeccionado según la evidencia arriba. La
   retención de 14 días sigue siendo provisional y operativa, no un archivo
   inmutable.

No se imprimieron ni almacenaron credenciales, tokens, cookies, valores de
secretos ni el valor de ningún canario. Se cambiaron únicamente las políticas de
Actions autorizadas por el propietario descritas arriba; no se cambiaron reglas
organizacionales.
