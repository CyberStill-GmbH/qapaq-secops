"""Renderiza la salida real de la sonda C-12 como una página autocontenida.

No calcula nada: lee `output/demo/c12-normalization-run.json`, producido por la ejecución
real del normalizador, y lo presenta. Si el JSON no existe, falla en vez de inventar datos.

Uso:  python scripts/demo/render-c12-demo.py
Salida: output/demo/c12-demo.html  (se abre con doble clic, no necesita servidor)
"""

import datetime
import html
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "output" / "demo" / "c12-normalization-run.json"
TARGET = ROOT / "output" / "demo" / "c12-demo.html"

# Traducción de los códigos internos a lenguaje entendible por cualquiera.
REASON_TEXT = {
    "RAW_TOO_LARGE": "El documento excede el tamaño permitido",
    "RAW_NOT_OBJECT": "El documento no tiene la forma esperada",
    "MISSING_TIMESTAMP": "El evento no declara cuándo ocurrió",
    "INVALID_TIMESTAMP": "La fecha del evento no existe en el calendario",
    "MISSING_RULE": "El evento no declara qué regla lo originó",
    "INVALID_RULE_LEVEL": "La gravedad está fuera de la escala del proveedor",
    "INVALID_RULE_IDENTITY": "La regla no se puede identificar",
    "CONTRACT_VALIDATION_FAILED": "El resultado no cumple el contrato interno",
}

SEVERITY_TEXT = {
    "critical": ("Crítica", "#8C2F1E", "#FBE6E1"),
    "high": ("Alta", "#8A5A14", "#F7EAD4"),
    "medium": ("Media", "#1F5E57", "#E3F0ED"),
    "low": ("Baja", "#44536B", "#E8EBEF"),
    "informational": ("Informativa", "#55606E", "#E8EBEF"),
    "unknown": ("Sin determinar", "#55606E", "#E8EBEF"),
}

CATEGORY_TEXT = {
    "authentication": "Acceso",
    "iam": "Identidades",
    "network": "Red",
    "intrusion_detection": "Intrusión",
    "malware": "Código malicioso",
    "host": "Equipo",
    "file": "Archivos",
    "process": "Procesos",
    "configuration": "Configuración",
    "email": "Correo",
    "web": "Web",
    "vulnerability": "Vulnerabilidad",
    "threat": "Amenaza",
    "api": "API",
    "database": "Base de datos",
    "unclassified": "Sin clasificar",
}

CSS = """
*{box-sizing:border-box}
body{margin:0;background:#EEF2F7;color:#0F2D4D;
 font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;font-size:17px;line-height:1.5}
.wrap{max-width:1500px;margin:0 auto;padding:40px 32px 64px}
header{border-bottom:3px solid #0F2D4D;padding-bottom:20px;margin-bottom:28px}
.eyebrow{font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#9A6516;margin:0 0 8px}
h1{font-size:34px;margin:0 0 6px;line-height:1.2}
.sub{margin:0;color:#44536B;font-size:17px}
.flow{display:flex;gap:16px;align-items:stretch;margin:0 0 28px;flex-wrap:wrap}
.stat{flex:1;min-width:210px;background:#fff;border:1px solid #DCE3EB;border-radius:14px;padding:22px 24px}
.stat .n{font-size:46px;font-weight:700;line-height:1;margin:0 0 6px}
.stat .l{margin:0;font-size:15px;color:#44536B}
.stat.ok{border-left:6px solid #2E7D74}.stat.ok .n{color:#1F5E57}
.stat.hold{border-left:6px solid #C9872E}.stat.hold .n{color:#8A5A14}
.stat.lost{border-left:6px solid #0F2D4D}.stat.lost .n{color:#0F2D4D}
h2{font-size:22px;margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid #CDD8E4}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;
 border:1px solid #DCE3EB}
th{background:#0F2D4D;color:#fff;text-align:left;font-size:13px;letter-spacing:.6px;
 text-transform:uppercase;padding:12px 14px}
td{padding:12px 14px;border-top:1px solid #E6EBF1;font-size:15px;vertical-align:top}
tbody tr:nth-child(even){background:#F7F9FB}
.pill{display:inline-block;padding:4px 12px;border-radius:40px;font-size:13px;font-weight:700}
.mono{font-family:"Cascadia Mono",Consolas,monospace;font-size:13px;color:#55606E}
.q{background:#fff;border:1px solid #DCE3EB;border-left:6px solid #C9872E;border-radius:12px;
 padding:18px 22px;margin-bottom:12px}
.q .why{font-weight:700;font-size:17px;margin:0 0 6px}
.q .lin{margin:0;font-size:14px;color:#55606E}
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.card{background:#fff;border:1px solid #DCE3EB;border-radius:12px;padding:20px 22px}
.card h3{margin:0 0 12px;font-size:16px;text-transform:uppercase;letter-spacing:1px;color:#55606E}
.card.after{border-left:6px solid #2E7D74}
pre{margin:0;font-family:"Cascadia Mono",Consolas,monospace;font-size:13px;color:#6B7684;
 white-space:pre-wrap;word-break:break-word}
dl{margin:0;display:grid;grid-template-columns:150px 1fr;gap:8px 14px}
dt{font-size:13px;font-weight:700;color:#8894A5;text-transform:uppercase;letter-spacing:.5px}
dd{margin:0;font-size:16px}
footer{margin-top:40px;padding-top:18px;border-top:1px solid #CDD8E4;font-size:14px;color:#687788}
.note{background:#FDF6E6;border:1px solid #E8D4A2;border-radius:10px;padding:14px 18px;
 font-size:14px;color:#4A3A12;margin:22px 0 0}
@media (max-width:900px){.cmp{grid-template-columns:1fr}dl{grid-template-columns:1fr}}
"""


def esc(value):
    return html.escape(str(value), quote=True)


def severity_pill(key):
    label, fg, bg = SEVERITY_TEXT.get(key, SEVERITY_TEXT["unknown"])
    return f'<span class="pill" style="background:{bg};color:{fg}">{esc(label)}</span>'


def when_local(iso):
    """La marca viene en UTC; se muestra en la hora del equipo que presenta."""
    parsed = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    local = parsed.astimezone()
    return local.strftime("%d/%m/%Y %H:%M")


def when(iso):
    # 2026-09-30T16:41:02.000Z -> 30/09/2026 16:41
    date, _, rest = iso.partition("T")
    y, m, d = date.split("-")
    return f"{d}/{m}/{y} {rest[:5]}"


def main():
    if not SOURCE.exists():
        sys.exit(
            f"No existe {SOURCE}.\n"
            "Ejecuta primero: npx tsx scripts/demo/c12-normalization-demo.ts"
        )

    report = json.loads(SOURCE.read_text(encoding="utf-8"))
    counts = report["counts"]
    lost = counts["received"] - counts["normalized"] - counts["quarantined"]

    rows = []
    for event in report["normalized"]:
        categories = ", ".join(CATEGORY_TEXT.get(c, c) for c in event["category"])
        rows.append(
            "<tr>"
            f"<td class='mono'>{esc(when(event['occurredAt']))}</td>"
            f"<td>{esc(event['rule'] or '—')}</td>"
            f"<td>{severity_pill(event['severity'])}</td>"
            f"<td>{esc(categories)}</td>"
            f"<td>{esc(event['host'] or '—')}</td>"
            f"<td>{esc(event['principal'] or '—')}</td>"
            "</tr>"
        )

    quarantine = []
    for item in report["quarantined"]:
        why = REASON_TEXT.get(item["code"], item["code"])
        quarantine.append(
            "<div class='q'>"
            f"<p class='why'>{esc(why)}</p>"
            f"<p class='lin'>Evento <strong>{esc(item['sourceRecordId'])}</strong> · "
            f"original conservado en <span class='mono'>{esc(item['rawRef'])}</span> · "
            f"huella <span class='mono'>{esc(item['rawSha256'][:16])}…</span></p>"
            "</div>"
        )

    sample_id = report["normalized"][0]["eventUid"].rsplit(":", 1)[-1]
    sample_raw = json.dumps(
        report["rawSamples"][sample_id], indent=1, ensure_ascii=False
    )
    sample = report["normalized"][0]
    sample_cats = ", ".join(CATEGORY_TEXT.get(c, c) for c in sample["category"])

    page = f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QAPAQ SecOps — Demostración C-12</title><style>{CSS}</style></head>
<body><div class="wrap">
<header>
<p class="eyebrow">QAPAQ SecOps · Demostración</p>
<h1>Qué le pasa a un evento de seguridad cuando entra</h1>
<p class="sub">Resultado de una ejecución real del normalizador, el
{esc(when_local(report['generatedAt']))}. Procesó {counts['received']} eventos en
{report['elapsedMs']} milisegundos.</p>
</header>

<div class="flow">
<div class="stat"><p class="n">{counts['received']}</p><p class="l">eventos recibidos</p></div>
<div class="stat ok"><p class="n">{counts['normalized']}</p><p class="l">convertidos en registros legibles</p></div>
<div class="stat hold"><p class="n">{counts['quarantined']}</p><p class="l">aislados por venir defectuosos</p></div>
<div class="stat lost"><p class="n">{lost}</p><p class="l">perdidos</p></div>
</div>

<h2>Lo que quedó consultable</h2>
<table><thead><tr>
<th>Cuándo</th><th>Qué pasó</th><th>Gravedad</th><th>Tipo</th><th>Equipo</th><th>Usuario</th>
</tr></thead><tbody>{''.join(rows)}</tbody></table>

<h2>Lo que se aisló, y por qué</h2>
{''.join(quarantine)}
<p class="sub">Ninguno de estos detuvo el procesamiento del resto, y de ninguno se perdió
el original: ambos quedan referenciados para revisarse o reprocesarse después.</p>

<h2>El mismo evento, antes y después</h2>
<div class="cmp">
<div class="card"><h3>Como llega del sistema</h3><pre>{esc(sample_raw)}</pre></div>
<div class="card after"><h3>Como queda en la plataforma</h3><dl>
<dt>Qué pasó</dt><dd>{esc(sample['rule'])}</dd>
<dt>Cuándo</dt><dd>{esc(when(sample['occurredAt']))}</dd>
<dt>Gravedad</dt><dd>{severity_pill(sample['severity'])} &nbsp;{esc(sample['score'])} de 100</dd>
<dt>Tipo</dt><dd>{esc(sample_cats)}</dd>
<dt>Equipo</dt><dd>{esc(sample['host'] or '—')}</dd>
<dt>Usuario</dt><dd>{esc(sample['principal'] or '—')}</dd>
<dt>Original</dt><dd class="mono">{esc(sample['rawRef'])}</dd>
</dl></div>
</div>

<p class="note"><strong>Sobre esta pantalla.</strong> Es un visualizador de la ejecución,
no la interfaz del producto. La interfaz de consulta es una etapa posterior del plan; lo
que aquí se demuestra es el procesamiento, que es lo que ya está construido.</p>

<footer>Generado desde <span class="mono">output/demo/c12-normalization-run.json</span>,
producido por <span class="mono">scripts/demo/c12-normalization-demo.ts</span> ejecutando el
mismo código que cubren las pruebas automáticas. Mapping
<span class="mono">{esc(report['mappingId'])} v{esc(report['mappingVersion'])}</span>.
Los eventos del lote son de prueba; el procesamiento es real.</footer>
</div></body></html>
"""

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(page, encoding="utf-8")
    print(f"OK {TARGET} ({TARGET.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
