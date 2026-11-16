"""PDF: HTML + CSS -> WeasyPrint. Sin acceso a red: url_fetcher solo sirve assets incluidos."""
from __future__ import annotations

import html
import io
from pathlib import Path

from weasyprint import HTML

from .charts import chart_svg
from .common import (ASSETS_DIR, KIND_LABELS, MD, fmt_dt, fmt_dt_long, fmt_number, fmt_period)
from .spec import (ChartSection, MarkdownSection, Spec, TableSection, TimelineSection)

ALLOWED_ASSETS = {
    "qapaq-mark-gradient.png", "qapaqzito.png",
}
PDF_MAX_ROWS = 3000  # presupuesto total de filas en el PDF; el detalle completo va en XLSX/CSV
STYLE_PATH = Path(__file__).with_name("pdf.css")
_SAFE_HREF = ("http://", "https://", "mailto:")


class BlockedFetch(ValueError):
    pass


def asset_fetcher(url: str) -> dict:
    """Solo `asset:<nombre>` de la lista blanca. Cualquier otra URL (http, file, data...) se rechaza."""
    if url.startswith("asset:"):
        name = url[len("asset:"):]
        if name in ALLOWED_ASSETS:
            return {"file_obj": io.BytesIO((ASSETS_DIR / name).read_bytes()), "mime_type": "image/png"}
    raise BlockedFetch("recurso externo bloqueado")


def e(text: str) -> str:
    return html.escape(text, quote=True)


def _markdown_html(body: str) -> str:
    tokens = MD.parse(body or "")
    for t in tokens:
        if t.type != "inline" or not t.children:
            continue
        neutralized = False  # los enlaces no http(s)/mailto se degradan a <span>
        for c in t.children:
            if c.type == "link_open":
                neutralized = not (c.attrGet("href") or "").lower().startswith(_SAFE_HREF)
                if neutralized:
                    c.tag, c.attrs = "span", {}
            elif c.type == "link_close" and neutralized:
                c.tag, neutralized = "span", False
    return MD.renderer.render(tokens, MD.options, {})


def _prio(p: str) -> str:
    return f'<span class="tag tag-{p.lower()}">{e(p)}</span>' if p else ""


def _cell_html(v, col) -> str:
    if v is None:
        return '<span class="empty">—</span>'
    if col.kind == "priority":
        return _prio(v)
    if col.kind == "link":
        return f'<a href="{e(v)}">{e(col.label)}</a>'
    return ""


def _table_html(sec: TableSection, spec: Spec, budget: list[int]) -> str:
    tz = spec.tz
    cols = sec.columns
    total = len(sec.rows)
    take = max(0, min(total, budget[0]))
    budget[0] -= take
    rows = sec.rows[:take]
    cls = "data" + (" dense" if len(cols) > 7 else "")
    colgroup = "".join(
        {"datetime": '<col style="width:23mm">', "priority": '<col style="width:13mm">',
         "number": '<col style="width:17mm">', "link": '<col style="width:14mm">'}.get(c.kind, "<col>")
        for c in cols
    )
    head = "".join(f'<th class="k-{c.kind}">{e(c.label)}</th>' for c in cols)
    short = {c.key for c in cols if c.kind == "text" and max((len(r[c.key] or "") for r in rows), default=0) <= 22}
    body = []
    for r in rows:
        tds = []
        for c in cols:
            v = r[c.key]
            if c.kind == "datetime":
                inner = e(fmt_dt(v, tz)) if v is not None else '<span class="empty">—</span>'
            elif c.kind == "number":
                inner = e(fmt_number(v)) if v is not None else '<span class="empty">—</span>'
            elif c.kind in ("priority", "link") or v is None:
                inner = _cell_html(v, c)
            else:
                inner = e(v)
            nw = " nw" if c.key in short else ""
            tds.append(f'<td class="k-{c.kind}{nw}">{inner}</td>')
        body.append("<tr>" + "".join(tds) + "</tr>")
    if not body:
        body.append(f'<tr><td colspan="{len(cols)}" class="none">Sin registros para este periodo.</td></tr>')
    meta = f"{fmt_number(total)} registro{'s' if total != 1 else ''}"
    out = [f'<div class="count">{meta}</div>',
           f'<table class="{cls}"><colgroup>{colgroup}</colgroup><thead><tr>{head}</tr></thead>'
           f'<tbody>{"".join(body)}</tbody></table>']
    if take < total:
        out.append(f'<p class="note warn">Se muestran los primeros {fmt_number(take)} de {fmt_number(total)} registros. '
                   'El detalle completo está disponible en los formatos XLSX y CSV.</p>')
    if sec.note:
        out.append(f'<p class="note">{e(sec.note)}</p>')
    return "".join(out)


def _timeline_html(sec: TimelineSection, spec: Spec) -> str:
    items = []
    for it in sorted(sec.items, key=lambda x: x.at):
        detail = f'<div class="tl-detail">{e(it.detail)}</div>' if it.detail else ""
        items.append(
            f'<li><div class="tl-time">{e(fmt_dt(it.at, spec.tz))}</div>'
            f'<div class="tl-title">{_prio(it.priority)} {e(it.title)}</div>{detail}</li>')
    if not items:
        return '<p class="note">Sin eventos en la cronología.</p>'
    return f'<ol class="tl">{"".join(items)}</ol>'


def build_html(spec: Spec) -> str:
    tz = spec.tz
    kind_label = KIND_LABELS.get(spec.kind, "Informe")
    gen_txt = f"{fmt_dt_long(spec.generated_at, tz)} ({spec.time_zone})"
    css = (STYLE_PATH.read_text(encoding="utf-8")
           .replace("@@CLS@@", css_string(spec.classification))
           .replace("@@GEN@@", css_string("Generado " + gen_txt)))

    meta = []
    if spec.period:
        meta.append(("Periodo", fmt_period(spec.period, tz)))
    meta.append(("Generado", f'<span class="gen">{e(gen_txt)}</span>'))
    if spec.generated_by:
        meta.append(("Generado por", e(spec.generated_by)))
    meta.append(("Zona horaria", e(spec.time_zone)))
    # el periodo ya viene saneado de fechas; se escapa igualmente
    meta_html = "".join(
        f'<div class="m"><div class="ml">{k}</div><div class="mv">{v if k in ("Generado", "Generado por", "Zona horaria") else e(v)}</div></div>'
        for k, v in meta)

    cover = f"""
<section class="cover">
  <div class="bar"></div>
  <div class="brand"><img class="logo" src="asset:qapaq-mark-gradient.png" alt="QAPAQ"><div class="wordmark">QAPAQ <span>SOC</span></div></div>
  <div class="orb"></div>
  <img class="mascot" src="asset:qapaqzito.png" alt="">
  <div class="cover-main">
    <div class="eyebrow">{e(kind_label)}</div>
    <h1>{e(spec.title)}</h1>
    {f'<p class="sub">{e(spec.subtitle)}</p>' if spec.subtitle else ''}
    <div class="cls">{e(spec.classification)}</div>
  </div>
  <div class="meta">{meta_html}</div>
</section>"""

    kpis = ""
    if spec.kpis:
        cells = []
        for k in spec.kpis:
            hint = f'<div class="kh">{e(k.hint)}</div>' if k.hint else ""
            cells.append(f'<td><div class="kv">{e(k.value)}</div><div class="kl">{e(k.label)}</div>{hint}</td>')
        per = 4 if len(cells) >= 4 else len(cells)
        rows = []
        for i in range(0, len(cells), per):
            chunk = cells[i:i + per] + ["<td class='pad'></td>"] * (per - len(cells[i:i + per]))
            rows.append("<tr>" + "".join(chunk) + "</tr>")
        kpis = f'<table class="kpis">{"".join(rows)}</table>'

    budget = [PDF_MAX_ROWS]
    parts = []
    for sec in spec.sections:
        h = f'<h2>{e(sec.heading)}</h2>' if sec.heading else ""
        if isinstance(sec, MarkdownSection):
            inner = f'<div class="md">{_markdown_html(sec.body)}</div>'
        elif isinstance(sec, TableSection):
            inner = _table_html(sec, spec, budget)
        elif isinstance(sec, ChartSection):
            inner = f'<figure class="chart">{chart_svg(sec)}</figure>'
        elif isinstance(sec, TimelineSection):
            inner = _timeline_html(sec, spec)
        else:  # pragma: no cover
            continue
        parts.append(f'<section class="sec sec-{sec.type}">{h}{inner}</section>')

    sources = ""
    if spec.sources:
        li = "".join(f"<li>{e(s)}</li>" for s in spec.sources)
        sources = f'<section class="sec sources"><h2>Fuentes</h2><ul>{li}</ul></section>'

    header = (f'<div class="run-header"><img src="asset:qapaq-mark-gradient.png" alt="">'
              f'<span class="rt">{e(spec.title)}</span></div>')

    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>{e(spec.title)}</title>
<meta name="author" content="QAPAQ SecOps">
<meta name="description" content="{e(kind_label)} · {e(spec.classification)}">
<meta name="generator" content="QAPAQ SecOps reports">
<style>{css}</style></head>
<body>{header}{cover}
<main>{kpis}{"".join(parts)}{sources}</main>
</body></html>"""


def render_pdf(spec: Spec) -> tuple[bytes, int]:
    doc = HTML(string=build_html(spec), url_fetcher=asset_fetcher).render()
    pages = len(doc.pages)
    return doc.write_pdf(), pages


_BS = chr(92)
_CSS_UNSAFE = {chr(34), chr(39), _BS, "<", ">", "&"}


def css_string(text: str) -> str:
    """Escapa texto para el interior de un literal CSS entre comillas dobles."""
    return "".join(f"{_BS}{ord(c):x} " if c in _CSS_UNSAFE or ord(c) < 32 else c for c in text)
