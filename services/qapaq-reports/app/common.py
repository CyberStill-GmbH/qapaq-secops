"""Utilidades compartidas: formato de fechas/numeros, paleta QAPAQ, markdown a bloques."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from markdown_it import MarkdownIt

ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"

# Paleta oficial (docs/brand/qapaq-visual-identity.md)
CORAL, FUCSIA, AMARILLO, LIMA = "#FF5841", "#FF5899", "#FFC136", "#D0E870"
TURQUESA, AZUL, LAVANDA, INK = "#00DFC2", "#119CFF", "#CDCCED", "#1B1B2F"
# Orden de series en graficos: contraste razonable sobre blanco primero.
SERIES_COLORS = [AZUL, FUCSIA, TURQUESA, AMARILLO, CORAL, "#8E8CD8", "#A9C94A"]

MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
KIND_LABELS = {
    "alerts": "Informe de alertas",
    "investigation": "Informe de investigación",
    "incident": "Informe de incidente",
    "custom": "Informe",
}


def to_tz(dt: datetime, tz: ZoneInfo) -> datetime:
    return dt.astimezone(tz)


def fmt_dt(dt: datetime, tz: ZoneInfo) -> str:
    """2026-11-12 10:15 en la zona del informe (compacto y ordenable)."""
    return to_tz(dt, tz).strftime("%Y-%m-%d %H:%M")


def fmt_dt_long(dt: datetime, tz: ZoneInfo) -> str:
    d = to_tz(dt, tz)
    return f"{d.day} {MESES[d.month - 1]} {d.year}, {d:%H:%M}"


def fmt_number(v: float | int) -> str:
    if isinstance(v, float) and not v.is_integer():
        s = f"{v:,.2f}".rstrip("0").rstrip(".")
    else:
        s = f"{int(v):,}"
    return s.replace(",", " ")  # espacio fino: sin ambiguedad coma/punto


def fmt_period(period, tz: ZoneInfo) -> str:
    if not period:
        return ""
    return f"{fmt_dt_long(period[0], tz)} – {fmt_dt_long(period[1], tz)}"


def iso_in_tz(dt: datetime, tz: ZoneInfo) -> str:
    return to_tz(dt, tz).isoformat(timespec="seconds")


def _md() -> MarkdownIt:
    # "commonmark" + html=False: el HTML crudo se escapa como texto.
    return MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table").disable("image")


MD = _md()


def markdown_to_blocks(text: str) -> list[tuple[str, str]]:
    """Markdown -> [(kind, texto plano)] con kind en heading|para|bullet|code|row.

    Se usa para XLSX (sin formato de texto enriquecido). No genera HTML.
    """
    blocks: list[tuple[str, str]] = []
    tokens = MD.parse(text or "")
    in_item = 0
    heading = False
    row: list[str] = []
    for i, t in enumerate(tokens):
        if t.type == "heading_open":
            heading = True
        elif t.type == "heading_close":
            heading = False
        elif t.type == "list_item_open":
            in_item += 1
        elif t.type == "list_item_close":
            in_item -= 1
        elif t.type == "tr_open":
            row = []
        elif t.type == "tr_close":
            blocks.append(("row", " | ".join(row)))
        elif t.type == "inline":
            txt = _inline_text(t)
            prev = tokens[i - 1].type if i else ""
            if prev in ("th_open", "td_open"):
                row.append(txt)
            elif heading:
                blocks.append(("heading", txt))
            elif in_item:
                blocks.append(("bullet", txt))
            elif txt:
                blocks.append(("para", txt))
        elif t.type == "fence" or t.type == "code_block":
            blocks.append(("code", t.content.rstrip()))
    return blocks


def _inline_text(tok) -> str:
    out = []
    for c in tok.children or []:
        if c.type in ("text", "code_inline"):
            out.append(c.content)
        elif c.type in ("softbreak", "hardbreak"):
            out.append("\n")
    return "".join(out).strip()
