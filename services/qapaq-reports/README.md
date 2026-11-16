# qapaq-reports

Microservicio de renderizado de informes del SOC QAPAQ: recibe un `ReportSpec` v1 (JSON) y devuelve un
**PDF**, **XLSX** o **CSV** con la marca QAPAQ. No consulta datos: la API QAPAQ arma el spec con los servicios
de lectura y las capacidades del actor; aquí solo se maqueta.

Contrato: sección 1 (ReportSpec v1) y 4 (Marca) de `qapaqzito-reports-contract.md` (contrato compartido
API/UI/servicio, 2026-11-13).

## Endpoints

- `POST /render` — `Authorization: Bearer <QAPAQ_REPORTS_TOKEN>`, `content-type: application/json`.
  200 bytes del archivo (+ `x-qapaq-report-pages` en PDF); 400 `{code:"SPEC_INVALID",path}`; 401; 411 sin
  `Content-Length`; 413 si el cuerpo > 20 MB; 422 `{code:"RENDER_FAILED"}` (error o plazo de 60 s); 503 si hay
  demasiados renders en curso.
- `GET /healthz` — 200 `{"status":"ok"}` (sin token).

## Formatos

- **PDF** (WeasyPrint): portada con logo, Remi, título/subtítulo/periodo/clasificación; KPIs; secciones en orden;
  cabecera corriente y pie (clasificación · página X de Y · fecha de generación en la zona del informe); fuentes.
  Prioridad como etiqueta de texto P1..P4 en rampa neutra. Tipografía Noto Sans (nunca Satoshi). Para acotar
  tiempo y tamaño, el PDF muestra como máximo 3000 filas en total y avisa; el detalle completo va en XLSX/CSV.
- **XLSX** (xlsxwriter): hoja «Resumen», una hoja por tabla o gráfico (gráficos nativos de Excel), «Cronología».
  Fechas reales en la zona del informe, números reales, enlaces reales. Autor «QAPAQ SOC».
- **CSV**: tabla `primary` (o la primera), UTF-8 con BOM, coma, RFC 4180, fechas ISO con zona.
- Donut: con una serie, cada punto es una porción; con varias, cada serie aporta su total.

## Ejecutar y probar

```bash
# construir y arrancar (desarrollo, sin token)
docker build -t qapaq-reports services/qapaq-reports
docker run --rm -p 8090:8090 -e QAPAQ_REPORTS_INSECURE_DEV=1 qapaq-reports

# pruebas (etapa "test"; en Windows/Git Bash anteponer MSYS_NO_PATHCONV=1)
docker build --target test -t qapaq-reports:test services/qapaq-reports
docker run --rm qapaq-reports:test

# renderizar el ejemplo sintético a un directorio
docker run --rm -v "$PWD/out:/out" qapaq-reports:test python tests/render_sample.py /out
```

Variables: `QAPAQ_REPORTS_TOKEN` (obligatoria, ≥ 16 caracteres), `QAPAQ_REPORTS_INSECURE_DEV=1` (solo desarrollo),
`QAPAQ_REPORTS_PORT` (8090), `QAPAQ_REPORTS_BIND` (0.0.0.0), `QAPAQ_REPORTS_RENDER_TIMEOUT` (60),
`QAPAQ_REPORTS_MAX_CONCURRENT` (2).

## Seguridad

- Sin token válido no arranca (salvo modo desarrollo explícito); comparación en tiempo constante.
- Validación estricta del spec; límites de filas (50 000), celdas (4000), secciones, series y puntos.
- Markdown con HTML crudo desactivado (se muestra como texto), imágenes desactivadas, enlaces solo `http(s)`/`mailto`;
  todo el texto restante se escapa.
- WeasyPrint no hace peticiones de red: `url_fetcher` solo sirve los PNG incluidos en `assets/`.
- XLSX/CSV: texto siempre como cadena (`write_string`); CSV antepone `'` a celdas que empiezan por `= + - @ TAB CR`.
- Cada render corre en un proceso hijo con plazo duro; no se registra contenido de informes (solo método, ruta, estado, ms).
- Pensado para red interna, usuario no root, sistema de archivos de solo lectura con `/tmp` en tmpfs.
