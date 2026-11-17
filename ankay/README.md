# ankay/ — overlay de frontend Shuffle (Ankay heredado)

> **Nota (heredado):** Shuffle y su webhook son el estado heredado de Ankay. El diseño vigente es
> Step Functions ([13](../docs/13-ankay-qapaq.md), [14](../docs/14-ankay-conexion-qapaq.md)); este material se reemplaza (fase M5).

El frontend se construye para alojarse en la ruta `/ankay/` detrás de la sesión QAPAQ. Se entra con la sesión de QAPAQ SecOps, sin segundo login: el puente `sso/` abre la sesión de Shuffle con el rol mapeado desde QAPAQ (decisión B11, [14 §8.1](../docs/14-ankay-conexion-qapaq.md)). `frontend/i18n/qapaq-i18n.js` pone la interfaz en español y `frontend/sso-overlay.mjs` añade «Volver al SIEM».

Overlay versionado sobre **Shuffle v2.3.0** ([`upstream.lock`](upstream.lock)). Diseño vigente (Step Functions) y plan de migración en [`docs/13-ankay-qapaq.md`](../docs/13-ankay-qapaq.md).

| Ruta                                                               | Qué cambia de Shuffle                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/patches/0001-ankay-tema-y-marca-por-defecto.patch` | Superficies oscuras neutras (`#080808`) y nombre de marca por defecto «Ankay» (white-label nativo de Shuffle)                                                                                                                                                                                                     |
| `frontend/patches/0002-ankay-html-y-manifest.patch`          | Título, `theme-color` y manifest PWA (`lang` sigue en `en` hasta traducir la UI de Ankay)                                                                                                                                                                                                                         |
| `frontend/patches/0003-ankay-csp-mismo-origen.patch`         | CSP de mismo origen: el frontend no puede llamar a la nube de Shuffle, Algolia ni otros terceros (N1)                                                                                                                                                                                                                   |
| `frontend/assets/`                                                 | Arte Ankay: la Q de QAPAQ con el «ejecutar» ámbar (ver [identidad visual](../docs/brand/qapaq-visual-identity.md)). Reemplaza los logos con los mismos nombres de archivo (`targets.tsv`). Se regenera con `node assets/tools/build-brand.mjs --raster` (después del de `wazuh/dashboard/assets`)       |
| `frontend/rebrand.mjs`                                             | Codemod con AST de TypeScript: colores naranja de Shuffle → ámbar QAPAQ `#c49a5a` y sus tonos en todo el código, y «Shuffle» → «Ankay» **solo en texto visible**. No toca la lógica, los datos, los nombres de apps del backend (Shuffle Tools, DB, AI) ni los textos que el código compara |
| `build.sh`                                                         | Clona el tag, verifica el SHA, aplica parches, arte y codemod, publica el código fuente en `/source/` (AGPL §13) y construye la imagen                                                                                                                                                                                  |

El workflow [`.github/workflows/ankay-azure.yml`](../.github/workflows/ankay-azure.yml)
construye y verifica la imagen en PR sin credenciales cloud. La publicación a ACR
requiere `workflow_dispatch`, `main`, `publish_to_acr=true` y el environment
`azure-demo`; el workflow conserva la imagen del mismo run, valida su SHA-256 y
registra el digest OCI. Publicar la imagen no despliega Shuffle ni habilita una
ruta pública.

## Identidad visual

Sigue [Identidad visual QAPAQ · Frontend](../docs/brand/qapaq-visual-identity.md): fondo `#080808`, tinta
`#f4f4f5`, ámbar `#c49a5a` como único acento y la Q de QAPAQ. El ámbar reemplaza el naranja de Shuffle, pero
**la marca no codifica severidad ni estado**: los colores semánticos de Shuffle (éxito, error, advertencia)
se conservan. La tipografía es la del sistema (pila `'Segoe UI', Inter, …`); Ankay no empaqueta fuentes.

## Uso

```bash
pnpm install                                    # el codemod usa el TypeScript del monorepo
bash ankay/build.sh out/ ankay-qapaq-frontend:dev
node --test ankay/frontend/rebrand.test.mjs ankay/frontend/subpath.test.mjs
```

## Subir de versión de Shuffle

1. Cambiar `SHUFFLE_TAG` y `SHUFFLE_SHA` en `upstream.lock`.
2. Correr `bash ankay/build.sh out/`. Si un parche no aplica, regenerarlo con `git diff` sobre el tag nuevo.
3. Revisar en la salida del codemod las «apariciones restantes» y si apareció algún logo nuevo que
   agregar a `targets.tsv`.

## Licencia

Shuffle es AGPL-3.0. Ankay es una versión modificada: la imagen sirve en `/source/` el código fuente
correspondiente y la licencia. Los avisos de copyright de Shuffle se conservan. Pendiente: dictamen de
Legal (U-022).
