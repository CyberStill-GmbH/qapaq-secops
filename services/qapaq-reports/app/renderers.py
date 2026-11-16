"""Despacho de render por formato. Se ejecuta en un proceso hijo (ver server.py)."""
from __future__ import annotations

from .csv_out import render_csv
from .pdf_out import render_pdf
from .spec import Spec
from .xlsx_out import render_xlsx

CONTENT_TYPES = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv; charset=utf-8",
}


def render(spec: Spec) -> tuple[str, bytes, int | None]:
    """Devuelve (content_type, bytes, paginas|None)."""
    if spec.format == "pdf":
        data, pages = render_pdf(spec)
        return CONTENT_TYPES["pdf"], data, pages
    if spec.format == "xlsx":
        return CONTENT_TYPES["xlsx"], render_xlsx(spec), None
    return CONTENT_TYPES["csv"], render_csv(spec), None
