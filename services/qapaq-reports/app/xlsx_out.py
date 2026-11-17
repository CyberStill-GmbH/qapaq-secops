"""XLSX con xlsxwriter: Resumen, una hoja por tabla/grafico, Cronologia, propiedades.

Todo texto no confiable se escribe con write_string (nunca como formula) y el libro
se crea con strings_to_formulas/urls/numbers desactivados.
"""
from __future__ import annotations

import io
import math
import re
from datetime import datetime

import xlsxwriter

from .common import (AMBER, ASSETS_DIR, INK, LINE, SERIES_COLORS,
                     KIND_LABELS, fmt_period, markdown_to_blocks, to_tz)
from .spec import ChartSection, MarkdownSection, Spec, TableSection, TimelineSection

_BAD_SHEET = re.compile(r"[\[\]:*?/\\]")
DT_FORMAT = "yyyy-mm-dd hh:mm"
MAX_EXCEL_URL = 2079
RESERVED = {"resumen", "cronología", "cronologia"}


def _naive(dt: datetime, spec: Spec) -> datetime:
    """Excel no tiene zonas horarias: se escribe la hora local de la zona del informe."""
    return to_tz(dt, spec.tz).replace(tzinfo=None)


def _sheet_name(base: str, used: set[str], fallback: str) -> str:
    name = _BAD_SHEET.sub(" ", base or "").strip().strip("'") or fallback
    name = name[:31].strip()
    cand, n = name, 2
    while cand.lower() in used or cand.lower() in RESERVED:
        suffix = f" ({n})"
        cand = name[: 31 - len(suffix)] + suffix
        n += 1
    used.add(cand.lower())
    return cand


def render_xlsx(spec: Spec) -> bytes:
    out = io.BytesIO()
    wb = xlsxwriter.Workbook(out, {
        "in_memory": True,
        "strings_to_formulas": False,
        "strings_to_urls": False,
        "strings_to_numbers": False,
        "default_date_format": DT_FORMAT,
        "remove_timezone": True,
    })
    wb.set_properties({
        "title": spec.title,
        "subject": KIND_LABELS.get(spec.kind, "Informe"),
        "author": "QAPAQ SecOps",
        "company": "QAPAQ",
        "category": spec.classification,
        "comments": "Generado por QAPAQ SecOps. " + spec.classification,
        "created": spec.generated_at.replace(tzinfo=None),
    })
    base = {"font_name": "Calibri", "font_size": 10, "font_color": INK, "valign": "top"}
    F = {
        "title": wb.add_format({**base, "font_size": 20, "bold": True, "valign": "vcenter"}),
        "subtitle": wb.add_format({**base, "font_size": 11, "font_color": "#52525B", "text_wrap": True}),
        "label": wb.add_format({**base, "bold": True, "font_color": "#52525B"}),
        "val": wb.add_format({**base, "text_wrap": True}),
        "h2": wb.add_format({**base, "font_size": 13, "bold": True, "bottom": 2, "bottom_color": AMBER}),
        "kpi_label": wb.add_format({**base, "bg_color": "#F4F4F5", "bold": True, "border": 1, "border_color": LINE}),
        "kpi_val": wb.add_format({**base, "bg_color": "#F4F4F5", "font_size": 14, "bold": True,
                                   "border": 1, "border_color": LINE, "align": "left"}),
        "kpi_hint": wb.add_format({**base, "bg_color": "#F4F4F5", "font_color": "#52525B",
                                    "border": 1, "border_color": LINE, "text_wrap": True}),
        "p": wb.add_format({**base, "text_wrap": True}),
        "pb": wb.add_format({**base, "text_wrap": True, "bold": True}),
        "bullet": wb.add_format({**base, "text_wrap": True, "indent": 1}),
        "code": wb.add_format({**base, "font_name": "Consolas", "text_wrap": True, "bg_color": "#F4F4F5"}),
        "head": wb.add_format({**base, "bold": True, "font_color": "#FFFFFF", "bg_color": "#080808",
                               "border": 1, "border_color": "#FFFFFF", "text_wrap": True, "valign": "vcenter"}),
        "text": wb.add_format({**base, "text_wrap": True, "bottom": 1, "bottom_color": "#E4E4E7"}),
        "dt": wb.add_format({**base, "num_format": DT_FORMAT, "align": "left",
                             "bottom": 1, "bottom_color": "#E4E4E7"}),
        "num": wb.add_format({**base, "num_format": "#,##0.##", "bottom": 1, "bottom_color": "#E4E4E7"}),
        "prio": wb.add_format({**base, "bold": True, "align": "center", "bottom": 1, "bottom_color": "#E4E4E7"}),
        "link": wb.add_format({**base, "font_color": "#0A6FD0", "underline": 1,
                               "bottom": 1, "bottom_color": "#E4E4E7"}),
        "note": wb.add_format({**base, "italic": True, "font_color": "#52525B", "text_wrap": True}),
        "foot": wb.add_format({**base, "font_color": "#777790", "font_size": 9, "text_wrap": True}),
    }

    used: set[str] = set()
    ws = wb.add_worksheet("Resumen")
    used.add("resumen")
    _summary(wb, ws, spec, F)

    for n, sec in enumerate(spec.sections, 1):
        if isinstance(sec, TableSection):
            name = _sheet_name(sec.heading, used, f"Tabla {n}")
            _table_sheet(wb, wb.add_worksheet(name), sec, spec, F)
        elif isinstance(sec, ChartSection):
            name = _sheet_name(sec.heading, used, f"Gráfico {n}")
            _chart_sheet(wb, wb.add_worksheet(name), sec, F)

    timelines = [s for s in spec.sections if isinstance(s, TimelineSection)]
    if timelines:
        _timeline_sheet(wb.add_worksheet("Cronología"), timelines, spec, F)

    wb.close()
    return out.getvalue()


def _lines(text: str, width_chars: int) -> int:
    return sum(max(1, math.ceil(len(p) / width_chars)) for p in text.split("\n"))


def _summary(wb, ws, spec: Spec, F) -> None:
    ws.hide_gridlines(2)
    ws.set_column("A:A", 3)
    ws.set_column("B:B", 24)
    ws.set_column("C:C", 22)
    ws.set_column("D:H", 18)
    ws.set_default_row(15)
    logo = ASSETS_DIR / "qapaq-mark-gradient.png"
    ws.set_row(0, 8)
    ws.set_row(1, 40)
    ws.insert_image("B2", str(logo), {"x_scale": 0.105, "y_scale": 0.105, "object_position": 2,
                                      "x_offset": 2, "y_offset": 2, "description": "QAPAQ"})
    ws.merge_range("C2:H2", "", F["title"])
    ws.write_string("C2", spec.title, F["title"])
    r = 2
    if spec.subtitle:
        ws.merge_range(r, 1, r, 7, "", F["subtitle"])
        ws.write_string(r, 1, spec.subtitle, F["subtitle"])
        ws.set_row(r, 15 * _lines(spec.subtitle, 110))
        r += 1
    r += 1
    meta = [("Tipo", KIND_LABELS.get(spec.kind, "Informe"))]
    if spec.period:
        meta.append(("Periodo", fmt_period(spec.period, spec.tz)))
    meta += [
        ("Generado", to_tz(spec.generated_at, spec.tz).strftime("%Y-%m-%d %H:%M")),
        ("Generado por", spec.generated_by or "—"),
        ("Zona horaria", spec.time_zone),
        ("Clasificación", spec.classification),
    ]
    for k, v in meta:
        ws.write_string(r, 1, k, F["label"])
        ws.merge_range(r, 2, r, 7, "", F["val"])
        ws.write_string(r, 2, v, F["val"])
        r += 1

    if spec.kpis:
        r += 1
        ws.merge_range(r, 1, r, 7, "", F["h2"])
        ws.write_string(r, 1, "Indicadores", F["h2"])
        r += 1
        for k in spec.kpis:
            ws.write_string(r, 1, k.label, F["kpi_label"])
            ws.write_string(r, 2, k.value, F["kpi_val"])
            ws.merge_range(r, 3, r, 7, "", F["kpi_hint"])
            ws.write_string(r, 3, k.hint, F["kpi_hint"])
            ws.set_row(r, 22)
            r += 1

    for sec in spec.sections:
        if not isinstance(sec, MarkdownSection):
            continue
        r += 1
        if sec.heading:
            ws.merge_range(r, 1, r, 7, "", F["h2"])
            ws.write_string(r, 1, sec.heading, F["h2"])
            ws.set_row(r, 22)
            r += 1
        for kind, text in markdown_to_blocks(sec.body):
            if not text:
                continue
            fmt = {"heading": F["pb"], "bullet": F["bullet"], "code": F["code"]}.get(kind, F["p"])
            shown = ("• " + text) if kind == "bullet" else text
            ws.merge_range(r, 1, r, 7, "", fmt)
            ws.write_string(r, 1, shown, fmt)
            ws.set_row(r, min(409, 14 * _lines(shown, 120) + 3))
            r += 1

    sec_names = [s.heading for s in spec.sections if s.type != "markdown" and s.heading]
    if sec_names:
        r += 1
        ws.write_string(r, 1, "Contenido del libro: " + ", ".join(sec_names), F["foot"])
        r += 1
    if spec.sources:
        r += 1
        ws.merge_range(r, 1, r, 7, "", F["h2"])
        ws.write_string(r, 1, "Fuentes", F["h2"])
        r += 1
        for s in spec.sources:
            ws.merge_range(r, 1, r, 7, "", F["foot"])
            ws.write_string(r, 1, "• " + s, F["foot"])
            ws.set_row(r, 13 * _lines(s, 130) + 2)
            r += 1
    ws.set_landscape()
    ws.fit_to_pages(1, 0)
    ws.set_paper(9)
    ws.set_footer("&L&8" + spec.classification.replace("&", "&&") + "&R&8Página &P de &N")


def _write_url(ws, r: int, c: int, url: str, label: str, F) -> None:
    if len(url) > MAX_EXCEL_URL:
        ws.write_string(r, c, url, F["text"])
    else:
        ws.write_url(r, c, url, F["link"], string=label)


def _table_sheet(wb, ws, sec: TableSection, spec: Spec, F) -> None:
    ws.set_row(0, 24)
    for j, col in enumerate(sec.columns):
        ws.write_string(0, j, col.label, F["head"])
    for i, row in enumerate(sec.rows, 1):
        for j, col in enumerate(sec.columns):
            v = row[col.key]
            if v is None:
                ws.write_blank(i, j, None, F["text"])
            elif col.kind == "datetime":
                ws.write_datetime(i, j, _naive(v, spec), F["dt"])
            elif col.kind == "number":
                ws.write_number(i, j, v, F["num"])
            elif col.kind == "priority":
                ws.write_string(i, j, v, F["prio"])
            elif col.kind == "link":
                _write_url(ws, i, j, v, col.label, F)
            else:
                ws.write_string(i, j, v, F["text"])
    # anchos
    for j, col in enumerate(sec.columns):
        sample = [len(col.label) + 3]
        for row in sec.rows[:300]:
            v = row[col.key]
            if v is None:
                continue
            if col.kind == "datetime":
                sample.append(16)
            elif col.kind == "number":
                sample.append(len(f"{v:,}"))
            elif col.kind == "link":
                sample.append(len(col.label) + 2)
            else:
                sample.append(min(len(v), 80))
        width = {"datetime": 17, "priority": 11}.get(col.kind) or max(10, min(60, max(sample) + 2))
        ws.set_column(j, j, width)
    last = max(len(sec.rows), 1)
    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, last, len(sec.columns) - 1)
    if sec.note:
        ws.write_string(last + 2, 0, sec.note, F["note"])
    ws.set_landscape()
    ws.fit_to_pages(1, 0)
    ws.repeat_rows(0)
    ws.set_footer("&L&8" + spec.classification.replace("&", "&&") + "&R&8Página &P de &N")


def _chart_sheet(wb, ws, sec: ChartSection, F) -> None:
    xs: list[str] = []
    for s in sec.series:
        for x, _ in s.points:
            if x not in xs:
                xs.append(x)
    ws.set_row(0, 24)
    ws.write_string(0, 0, sec.heading or "Categoría", F["head"])
    for j, s in enumerate(sec.series, 1):
        ws.write_string(0, j, s.label or f"Serie {j}", F["head"])
    lookup = [dict(s.points) for s in sec.series]
    for i, x in enumerate(xs, 1):
        ws.write_string(i, 0, x, F["text"])
        for j, lk in enumerate(lookup, 1):
            if x in lk:
                ws.write_number(i, j, lk[x], F["num"])
            else:
                ws.write_blank(i, j, None, F["text"])
    ws.set_column(0, 0, 24)
    ws.set_column(1, len(sec.series), 14)
    ws.freeze_panes(1, 0)

    sheet = ws.get_name()
    q = "'" + sheet.replace("'", "''") + "'"
    n = len(xs)
    ctype = {"bar": "column", "line": "line", "donut": "doughnut"}[sec.chart]
    chart = wb.add_chart({"type": ctype})
    if sec.chart == "donut":
        if len(sec.series) == 1:
            chart.add_series({
                "name": sec.series[0].label or sec.heading,
                "categories": f"={q}!$A$2:$A${n + 1}",
                "values": f"={q}!$B$2:$B${n + 1}",
                "points": [{"fill": {"color": SERIES_COLORS[i % len(SERIES_COLORS)]}} for i in range(n)],
            })
        else:
            # varias series: cada porcion es el total de una serie
            tr = n + 3
            ws.write_string(tr - 1, 0, "Total por serie", F["label"])
            for j, s in enumerate(sec.series):
                ws.write_string(tr + j, 0, s.label or f"Serie {j + 1}", F["text"])
                ws.write_number(tr + j, 1, sum(y for _, y in s.points), F["num"])
            chart.add_series({
                "name": sec.heading,
                "categories": f"={q}!$A${tr + 1}:$A${tr + len(sec.series)}",
                "values": f"={q}!$B${tr + 1}:$B${tr + len(sec.series)}",
                "points": [{"fill": {"color": SERIES_COLORS[i % len(SERIES_COLORS)]}}
                           for i in range(len(sec.series))],
            })
        chart.set_hole_size(55)
    else:
        for j, s in enumerate(sec.series, 1):
            color = SERIES_COLORS[(j - 1) % len(SERIES_COLORS)]
            col = xlsxwriter.utility.xl_col_to_name(j)
            spec_s = {
                "name": f"={q}!${col}$1",
                "categories": f"={q}!$A$2:$A${n + 1}",
                "values": f"={q}!${col}$2:${col}${n + 1}",
            }
            if sec.chart == "bar":
                spec_s["fill"] = {"color": color}
                spec_s["gap"] = 80
            else:
                spec_s["line"] = {"color": color, "width": 2.25}
                spec_s["marker"] = {"type": "circle", "size": 5, "fill": {"color": color},
                                    "border": {"color": color}}
            chart.add_series(spec_s)
        chart.set_y_axis({"major_gridlines": {"visible": True, "line": {"color": "#E4E4E7"}},
                          "line": {"none": True}})
        chart.set_x_axis({"line": {"color": "#BBBBD0"}, "num_font": {"rotation": -45 if n > 8 else 0}})
    chart.set_title({"name": sec.heading, "name_font": {"size": 13, "color": INK, "bold": True}})
    chart.set_legend({"position": "bottom"} if (len(sec.series) > 1 or sec.chart == "donut") else {"none": True})
    chart.set_size({"width": 760, "height": 380})
    chart.set_chartarea({"border": {"none": True}})
    ws.insert_chart(1, len(sec.series) + 2, chart)


def _timeline_sheet(ws, sections: list[TimelineSection], spec: Spec, F) -> None:
    heads = ["Fecha y hora", "Prioridad", "Evento", "Detalle", "Sección"]
    ws.set_row(0, 24)
    for j, h in enumerate(heads):
        ws.write_string(0, j, h, F["head"])
    r = 1
    for sec in sections:
        for it in sorted(sec.items, key=lambda x: x.at):
            ws.write_datetime(r, 0, _naive(it.at, spec), F["dt"])
            ws.write_string(r, 1, it.priority, F["prio"])
            ws.write_string(r, 2, it.title, F["text"])
            ws.write_string(r, 3, it.detail, F["text"])
            ws.write_string(r, 4, sec.heading, F["text"])
            r += 1
    ws.set_column(0, 0, 17)
    ws.set_column(1, 1, 11)
    ws.set_column(2, 2, 40)
    ws.set_column(3, 3, 60)
    ws.set_column(4, 4, 22)
    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, max(r - 1, 1), len(heads) - 1)
    ws.set_landscape()
    ws.fit_to_pages(1, 0)
    ws.repeat_rows(0)
