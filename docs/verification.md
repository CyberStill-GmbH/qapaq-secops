# Verificación

No hay tooling de aplicación configurado en el estado inicial. El verificador
no instala dependencias, no inventa comandos y no escribe archivos del proyecto
por sí mismo; los comandos configurados sí pueden tener efectos y deben revisarse.

Desde la raíz:

```powershell
pwsh -NoProfile -File .codex/skills/implementation-verifier/scripts/verify.ps1
```

Usa docs/verification-checks.json. Códigos de salida: 0 = todos los checks
configurados aprobaron o tienen N/A explícito; 1 = fallo de check/configuración;
2 = verificación incompleta por checks sin configurar. Un fallo prevalece sobre
checks pendientes. La revisión manual de aceptación, diff, límites y seguridad
es obligatoria fuera del script; exit 0 no certifica una feature completa.

U-002 acepta como interfaz de repositorio `format`, `format:check`, `lint`,
`typecheck`, `test`, `test:unit`, `test:integration`, `test:e2e`, `build` y
`bench`. En el estado documental siguen sin estar materializados. Aceptar sus
nombres no permite reemplazar los `null` ni reportar PASS.

Al existir comandos reales, reemplazar cada null por un objeto con executable y
arguments (array de strings). Ejemplo de formato, NO configuración aprobada:

```json
{"executable": "pnpm", "arguments": ["run", "lint"]}
```

Se ejecutan desde la raíz, secuencialmente: format, lint, unit, integration,
typecheck, boundaries. Usar un comando de formato en modo check; ejecutar antes
el formatter de escritura únicamente sobre el alcance solicitado. En monorepos,
configurar scripts de raíz que cubran todos los paquetes afectados; no asumir
que un comando Node cubre Python. No usar argumentos con credenciales.

Un check inaplicable puede expresarse como `{"notApplicable": "motivo concreto"}`.
La falta de herramienta, tests, proveedor o credenciales NO es N/A: mantener null
y reportar lo pendiente. Reevaluar integración en cada tarea; no conservar N/A
de una tarea previa cuando cambie el alcance. Revisar los comandos antes de
ejecutar un config recibido de una fuente no confiable: este archivo ejecuta código.

El script admite -RepoRoot y -ConfigPath para repositorios/fixtures explícitos.
ConfigPath relativo se resuelve contra RepoRoot. Los comandos se invocan mediante
argumentos, sin Invoke-Expression; no se interpretan pipelines ni strings de shell.

Antes de entregar, inspeccionar cambios staged/unstaged y nuevos; registrar criterios
de aceptación, controles manuales, evidencia y verificaciones pendientes. No subir
logs de eventos reales ni secretos como artefactos de pruebas.
