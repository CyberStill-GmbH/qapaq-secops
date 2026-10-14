# ankay/ — Ankay Qapaq (Shuffle con identidad QAPAQ)

Overlay versionado sobre **Shuffle v2.3.0** ([`upstream.lock`](upstream.lock)). Plan completo, tradeoffs
y fases en [`docs/13-ankay-qapaq.md`](../docs/13-ankay-qapaq.md).

| Ruta                                                         | Qué cambia de Shuffle                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/patches/0001-ankay-tema-y-marca-por-defecto.patch` | Fondos QAPAQ (`#080808`) y nombre de marca por defecto «Ankay Qapaq» (white-label nativo de Shuffle)                                                                                                                                                      |
| `frontend/patches/0002-ankay-html-y-manifest.patch`          | `lang="es"`, título, `theme-color` y manifest PWA                                                                                                                                                                                                         |
| `frontend/patches/0003-ankay-csp-mismo-origen.patch`         | CSP de mismo origen: el frontend no puede llamar a la nube de Shuffle, Algolia ni otros terceros (N1)                                                                                                                                                     |
| `frontend/assets/`                                           | Arte Ankay (la Q de QAPAQ con el «ejecutar» ámbar). Reemplaza los logos con los mismos nombres de archivo (`targets.tsv`). Se regenera con `assets/tools/build-brand.mjs --raster`                                                                        |
| `frontend/rebrand.mjs`                                       | Codemod con AST de TypeScript: colores naranja → ámbar en todo el código y «Shuffle» → «Ankay Qapaq» **solo en texto visible**. No toca la lógica, los datos, los nombres de apps del backend (Shuffle Tools, DB, AI) ni los textos que el código compara |
| `build.sh`                                                   | Clona el tag, verifica el SHA, aplica parches, arte y codemod, publica el código fuente en `/source/` (AGPL §13) y construye la imagen                                                                                                                    |

## Uso

```bash
pnpm install                                    # el codemod usa el TypeScript del monorepo
bash ankay/build.sh out/ ankay-qapaq-frontend:dev
node --test ankay/frontend/rebrand.test.mjs     # 8 pruebas del codemod
```

## Subir de versión de Shuffle

1. Cambiar `SHUFFLE_TAG` y `SHUFFLE_SHA` en `upstream.lock`.
2. Correr `bash ankay/build.sh out/`. Si un parche no aplica, regenerarlo con `git diff` sobre el tag nuevo.
3. Revisar en la salida del codemod las «apariciones restantes» y si apareció algún logo nuevo que
   agregar a `targets.tsv`.

## Licencia

Shuffle es AGPL-3.0. Ankay Qapaq es una versión modificada: la imagen sirve en `/source/` el código fuente
correspondiente y la licencia. Los avisos de copyright de Shuffle se conservan. Pendiente: dictamen de
Legal (U-022).
