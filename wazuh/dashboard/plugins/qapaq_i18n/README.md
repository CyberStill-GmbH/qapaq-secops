# qapaq_i18n — interfaz en español para QAPAQ SecOps

Plugin independiente de OpenSearch Dashboards 2.19.6 (id `qapaqI18n`, config `qapaq_i18n.*`) que
muestra en español (latinoamericano neutro) la UI de Wazuh 4.14.8 + OSD. No modifica Wazuh ni
`qapaq_ops`: vive aparte para que un upgrade de Wazuh nunca genere conflictos.

## Enfoque

Traduce la UI **ya renderizada** en el navegador, con dos capas:

1. **Glosario curado** (`public/glossary.es.json`, ~1250 entradas + ~40 patrones). Determinista,
   funciona en todos los navegadores. Coincidencia sobre el texto completo recortado de cada nodo de
   texto y de los atributos `placeholder`, `title` y `aria-label`: exacta → sin distinguir
   mayúsculas → sin `:` / `.` / `...` final (que se conserva) → patrones (`"{n} hits"` →
   `"{n} resultados"`; `{n}`/`{m}` = número, `{s}` = texto corto). Luego aplica la marca:
   `Wazuh` y `OpenSearch Dashboards` → `QAPAQ SecOps`.
2. **Respaldo on-device**: si el navegador expone la Translator API integrada (Chrome 138+,
   `self.Translator`), traduce el texto de interfaz en inglés que quede, con caché en memoria y en
   `sessionStorage`. Si la API no existe o no está disponible, no se hace nada más.

También fija `<html lang="es">` y traduce `document.title` (por partes separadas por `-`).

### Por qué no traducción manual completa ni MT externa

- **Manual completa**: Wazuh + OSD tienen más de 10 000 cadenas y no existe un locale `es` oficial.
  Mantener un fork de traducción se rompe en cada upgrade. El glosario cubre lo que el analista ve
  todo el tiempo (navegación, barras superiores, botones, pestañas, módulos, Discover/Paneles,
  selector de tiempo, filtros, configuración); el respaldo cubre la cola larga.
- **MT externa (Google/DeepL/etc.)**: descartada por decisión regulatoria. Enviar texto de la consola
  SOC a terceros sería tratamiento de datos por terceros (Res. SBS 504-2021; Ley 29733). El plugin
  **no hace ninguna llamada de red**.

## Garantías de privacidad y seguridad

- Cero llamadas de red para traducir. La Translator API corre en el dispositivo; Chrome solo
  descarga el modelo de idioma (sin enviar texto) y esa descarga se dispara tras un gesto del usuario.
- Solo se traduce el "cromo" de la UI, nunca datos de seguridad. Subárboles excluidos: `.euiDataGrid*`,
  `.osdDocTable*`, `.osdDocViewer`, `[data-test-subj*=docTable|discoverTable|dscDocsGrid|osdDocViewer|dataGrid|codeEditor|documentDetail]`,
  `role="grid"`, celdas `.euiTableRowCell` (las cabeceras sí), `.euiCodeBlock`, `code`, `pre`,
  `textarea`, valores de `input`/`select`, `[contenteditable]`, editores Monaco/Ace/CodeMirror,
  gráficos y leyendas (`.echChart`, `.visChart`, `.visLegend`, Vega/TSVB), píldoras de filtros,
  Markdown de usuario, y todo lo marcado con `data-qapaq-no-translate`, `translate="no"` o
  `class="notranslate"`.
- Además, no se toca texto que parezca dato: IPs, hashes, UUIDs, rutas, emails, URLs, nombres de
  campo (`agent.name`), JSON/código, números/fechas, CVE/IDs, `snake_case`. El respaldo on-device
  solo acepta texto de 2–120 caracteres, mayormente alfabético, de al menos dos palabras en inglés.
- Nombres propios que nunca se traducen: lista `keep` del glosario (MITRE ATT&CK, PCI DSS, GDPR,
  HIPAA, NIST, TSC, Sigma, VirusTotal, Office 365, GitHub, AWS, Azure, Google Cloud, Docker, …).

## Rendimiento

`MutationObserver` (subtree, childList, characterData, atributos filtrados) con lotes en
`requestIdleCallback` (o `requestAnimationFrame` con presupuesto de 8 ms) y máximo 400 nodos por
lote. No trabaja con la pestaña oculta. Recuerda el último valor escrito por nodo/atributo, así no
entra en bucle con sus propias escrituras ni traduce dos veces el mismo contenido; si React
reutiliza un nodo con texto nuevo, ese texto nuevo sí se traduce. No restaura nada (vida de la página).

## Activar / desactivar

- Servidor: `qapaq_i18n.enabled` (por defecto `true`). Con `false`, OSD no carga el plugin.
- Por navegador: `localStorage.setItem('qapaq.i18n.off', '1')` y recargar (borrar la clave para
  reactivar).

## Compatibilidad de navegadores

| Navegador                                | Glosario | Respaldo on-device                                              |
| ---------------------------------------- | -------- | --------------------------------------------------------------- |
| Chrome / Edge Chromium 138+ (escritorio) | Sí       | Sí (Translator API; en Edge depende de su despliegue de la API) |
| Chrome < 138, Chromium sin la API        | Sí       | No (queda en inglés lo que no esté en el glosario)              |
| Firefox, Safari                          | Sí       | No                                                              |
| Navegadores móviles                      | Sí       | No                                                              |

## Agregar entradas al glosario

1. Editar `public/glossary.es.json` → `entries` (`"English exacto": "Español"`). La clave es el texto
   visible completo, sin espacios al inicio/fin. Para cadenas con números use `patterns`.
2. Terminología fija: Alert→Alerta, Agent→Agente, Dashboard→Panel, Discover→Explorar,
   Visualize→Visualizar, Index pattern→Patrón de índice, Saved objects→Objetos guardados,
   Refresh→Actualizar, Threat Hunting→Búsqueda de amenazas, File Integrity Monitoring→Monitoreo de
   integridad de archivos, Compliance→Cumplimiento, Rules→Reglas, Decoders→Decodificadores.
   Usted como tratamiento; sin voseo ni regionalismos.
3. `node --test test/translate.test.mts` (valida JSON, duplicados, terminología y exclusiones).

### Tras un upgrade de Wazuh

```sh
git clone --depth 1 --branch vX.Y.Z --filter=blob:none https://github.com/wazuh/wazuh-dashboard
git clone --depth 1 --branch vX.Y.Z --filter=blob:none https://github.com/wazuh/wazuh-dashboard-plugins
node tools/extract-strings.mjs --osd wazuh-dashboard --wazuh wazuh-dashboard-plugins \
  --glossary public/glossary.es.json --min-score 3
```

Lista las cadenas nuevas sin traducir, ordenadas por visibilidad (`--json out.json` para guardarlas,
`--all` para ver todas).

## Build y despliegue

Sin dependencias npm propias. Dos opciones:

- **Dentro del fork** (como `qapaq_ops`): copiar la carpeta a `src/plugins/qapaq_i18n` del árbol
  wazuh-dashboard 2.19.6 y compilar la distribución normalmente.
- **Plugin externo**: copiar a `plugins/qapaq_i18n` de un checkout OSD 2.19.6, `yarn build`
  (plugin-helpers) e instalar el zip con
  `bin/opensearch-dashboards-plugin install file:///ruta/qapaqI18n-2.19.6.zip`.

No requiere cambios en `opensearch_dashboards.yml` (habilitado por defecto). Para dejarlo explícito:
`qapaq_i18n.enabled: true`. No cambie `i18n.locale` (OSD no trae locale `es`).

## Archivos

- `opensearch_dashboards.json` — manifiesto (id `qapaqI18n`, 2.19.6, `configPath: qapaq_i18n`).
- `common/translate.ts` — núcleo puro: glosario, patrones, marca, detección de datos, exclusión.
- `public/dom_translator.ts` — observer, lotes, atributos, título y Translator API.
- `public/plugin.ts`, `public/index.ts` — arranque en `start()`.
- `server/index.ts` — esquema `enabled` expuesto al navegador.
- `tools/extract-strings.mjs` — extractor/diferencia de cadenas; `tools/tsconfig.check.json` typecheck.
- `test/translate.test.mts` — pruebas `node:test`.

Verificación local: `node --test test/translate.test.mts` y
`npx -y -p typescript@5 tsc -p tools/tsconfig.check.json`.
