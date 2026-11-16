"""Validacion estricta de ReportSpec v1 (contrato qapaqzito-reports, seccion 1).

Escrita a mano (sin pydantic) para mantener la imagen pequena. Cualquier
incumplimiento lanza SpecError(path=...), p. ej. "sections[2].rows[5].score".
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

MAX_ROWS_TOTAL = 50_000
MAX_CELL = 4_000
MAX_MARKDOWN = 100_000
MAX_KPIS = 8
MAX_SECTIONS = 40
MAX_COLUMNS = 40
MAX_SERIES = 20
MAX_POINTS = 2_000
MAX_TIMELINE = 2_000
MAX_SOURCES = 50

FORMATS = ("pdf", "xlsx", "csv")
KINDS = ("alerts", "investigation", "incident", "custom")
COLUMN_KINDS = ("text", "datetime", "priority", "number", "link")
CHARTS = ("bar", "line", "donut")
PRIORITIES = ("P1", "P2", "P3", "P4")
DEFAULT_TZ = "America/Lima"
DEFAULT_CLASSIFICATION = "Confidencial · uso interno QAPAQ"


class SpecError(ValueError):
    code = "SPEC_INVALID"

    def __init__(self, path: str, message: str = "") -> None:
        super().__init__(f"{path}: {message}" if message else path)
        self.path = path
        self.message = message


@dataclass
class Kpi:
    label: str
    value: str
    hint: str = ""


@dataclass
class Column:
    key: str
    label: str
    kind: str


@dataclass
class MarkdownSection:
    heading: str
    body: str
    type: str = "markdown"


@dataclass
class TableSection:
    heading: str
    columns: list[Column]
    rows: list[dict[str, Any]]  # valores normalizados por kind
    note: str = ""
    primary: bool = False
    type: str = "table"


@dataclass
class Series:
    label: str
    points: list[tuple[str, float]]


@dataclass
class ChartSection:
    heading: str
    chart: str
    series: list[Series]
    type: str = "chart"


@dataclass
class TimelineItem:
    at: datetime
    title: str
    detail: str = ""
    priority: str = ""


@dataclass
class TimelineSection:
    heading: str
    items: list[TimelineItem]
    type: str = "timeline"


@dataclass
class Spec:
    format: str
    kind: str
    title: str
    subtitle: str
    generated_at: datetime
    generated_by: str
    time_zone: str
    classification: str
    period: tuple[datetime, datetime] | None
    kpis: list[Kpi]
    sections: list[Any] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.time_zone)

    def primary_table(self) -> TableSection | None:
        tables = [s for s in self.sections if s.type == "table"]
        for t in tables:
            if t.primary:
                return t
        return tables[0] if tables else None


# --- helpers ---------------------------------------------------------------

def _obj(v: Any, path: str) -> dict:
    if not isinstance(v, dict):
        raise SpecError(path, "se esperaba un objeto")
    return v


def _list(v: Any, path: str, maximum: int) -> list:
    if not isinstance(v, list):
        raise SpecError(path, "se esperaba una lista")
    if len(v) > maximum:
        raise SpecError(path, f"maximo {maximum} elementos")
    return v


def _str(v: Any, path: str, *, maximum: int, required: bool = True, default: str = "") -> str:
    if v is None:
        if required:
            raise SpecError(path, "obligatorio")
        return default
    if not isinstance(v, str):
        raise SpecError(path, "se esperaba texto")
    if "\x00" in v:
        raise SpecError(path, "caracter nulo no permitido")
    if len(v) > maximum:
        raise SpecError(path, f"maximo {maximum} caracteres")
    if required and not v.strip():
        raise SpecError(path, "no puede estar vacio")
    return v


def parse_iso(v: Any, path: str) -> datetime:
    if not isinstance(v, str) or len(v) > 64:
        raise SpecError(path, "fecha ISO-8601 invalida")
    try:
        dt = datetime.fromisoformat(v.strip())
    except ValueError as exc:
        raise SpecError(path, "fecha ISO-8601 invalida") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _number(v: Any, path: str) -> float | int:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise SpecError(path, "se esperaba un numero")
    if isinstance(v, float) and not math.isfinite(v):
        raise SpecError(path, "numero no finito")
    return v


def _link(v: str, path: str) -> str:
    parts = urlsplit(v)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise SpecError(path, "solo se admiten enlaces http(s)")
    if len(v) > 2000:
        raise SpecError(path, "enlace demasiado largo")
    return v


# --- cuerpo ----------------------------------------------------------------

def validate(raw: Any) -> Spec:
    d = _obj(raw, "$")
    if d.get("version") != 1 or isinstance(d.get("version"), bool):
        raise SpecError("version", "debe ser 1")
    fmt = d.get("format")
    if fmt not in FORMATS:
        raise SpecError("format", "pdf | xlsx | csv")
    kind = d.get("kind")
    if kind not in KINDS:
        raise SpecError("kind", "alerts | investigation | incident | custom")
    title = _str(d.get("title"), "title", maximum=160)
    subtitle = _str(d.get("subtitle"), "subtitle", maximum=240, required=False)
    generated_at = parse_iso(d.get("generatedAt"), "generatedAt")
    generated_by = _str(d.get("generatedBy"), "generatedBy", maximum=120, required=False)
    tz = _str(d.get("timeZone"), "timeZone", maximum=64, required=False, default=DEFAULT_TZ) or DEFAULT_TZ
    try:
        ZoneInfo(tz)
    except Exception as exc:  # ZoneInfoNotFoundError, ValueError
        raise SpecError("timeZone", "zona horaria desconocida") from exc
    classification = _str(
        d.get("classification"), "classification", maximum=120, required=False,
        default=DEFAULT_CLASSIFICATION,
    ) or DEFAULT_CLASSIFICATION

    period = None
    if d.get("period") is not None:
        p = _obj(d["period"], "period")
        pf, pt = parse_iso(p.get("from"), "period.from"), parse_iso(p.get("to"), "period.to")
        if pt < pf:
            raise SpecError("period.to", "anterior a period.from")
        period = (pf, pt)

    kpis = []
    for i, k in enumerate(_list(d.get("kpis", []), "kpis", MAX_KPIS)):
        ko = _obj(k, f"kpis[{i}]")
        value = ko.get("value")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        kpis.append(Kpi(
            _str(ko.get("label"), f"kpis[{i}].label", maximum=80),
            _str(value, f"kpis[{i}].value", maximum=40),
            _str(ko.get("hint"), f"kpis[{i}].hint", maximum=160, required=False),
        ))

    sections: list[Any] = []
    total_rows = 0
    for i, s in enumerate(_list(d.get("sections", []), "sections", MAX_SECTIONS)):
        sp = f"sections[{i}]"
        so = _obj(s, sp)
        stype = so.get("type")
        heading = _str(so.get("heading"), f"{sp}.heading", maximum=160, required=False)
        if stype == "markdown":
            sections.append(MarkdownSection(
                heading, _str(so.get("body"), f"{sp}.body", maximum=MAX_MARKDOWN, required=False)))
        elif stype == "table":
            cols_raw = _list(so.get("columns"), f"{sp}.columns", MAX_COLUMNS)
            if not cols_raw:
                raise SpecError(f"{sp}.columns", "al menos una columna")
            cols, seen = [], set()
            for j, c in enumerate(cols_raw):
                co = _obj(c, f"{sp}.columns[{j}]")
                key = _str(co.get("key"), f"{sp}.columns[{j}].key", maximum=80)
                if key in seen:
                    raise SpecError(f"{sp}.columns[{j}].key", "clave duplicada")
                seen.add(key)
                ck = co.get("kind", "text")
                if ck not in COLUMN_KINDS:
                    raise SpecError(f"{sp}.columns[{j}].kind", "text | datetime | priority | number | link")
                cols.append(Column(key, _str(co.get("label"), f"{sp}.columns[{j}].label", maximum=80), ck))
            rows_raw = _list(so.get("rows", []), f"{sp}.rows", MAX_ROWS_TOTAL)
            total_rows += len(rows_raw)
            if total_rows > MAX_ROWS_TOTAL:
                raise SpecError(f"{sp}.rows", f"maximo {MAX_ROWS_TOTAL} filas en total")
            rows = []
            for r, row in enumerate(rows_raw):
                ro = _obj(row, f"{sp}.rows[{r}]")
                rows.append({c.key: _cell(ro.get(c.key), c.kind, f"{sp}.rows[{r}].{c.key}") for c in cols})
            prim = so.get("primary", False)
            if not isinstance(prim, bool):
                raise SpecError(f"{sp}.primary", "se esperaba booleano")
            sections.append(TableSection(
                heading, cols, rows,
                _str(so.get("note"), f"{sp}.note", maximum=MAX_CELL, required=False), prim))
        elif stype == "chart":
            chart = so.get("chart")
            if chart not in CHARTS:
                raise SpecError(f"{sp}.chart", "bar | line | donut")
            series = []
            for j, se in enumerate(_list(so.get("series"), f"{sp}.series", MAX_SERIES)):
                seo = _obj(se, f"{sp}.series[{j}]")
                pts = []
                for k, pt in enumerate(_list(seo.get("points"), f"{sp}.series[{j}].points", MAX_POINTS)):
                    pp = f"{sp}.series[{j}].points[{k}]"
                    po = _obj(pt, pp)
                    x = po.get("x")
                    if isinstance(x, (int, float)) and not isinstance(x, bool):
                        x = str(x)
                    pts.append((_str(x, f"{pp}.x", maximum=120, required=False),
                                float(_number(po.get("y"), f"{pp}.y"))))
                series.append(Series(
                    _str(seo.get("label"), f"{sp}.series[{j}].label", maximum=80, required=False), pts))
            if not series:
                raise SpecError(f"{sp}.series", "al menos una serie")
            sections.append(ChartSection(heading, chart, series))
        elif stype == "timeline":
            items = []
            for j, it in enumerate(_list(so.get("items", []), f"{sp}.items", MAX_TIMELINE)):
                ip = f"{sp}.items[{j}]"
                io = _obj(it, ip)
                pr = io.get("priority")
                if pr not in (None, "") and pr not in PRIORITIES:
                    raise SpecError(f"{ip}.priority", "P1 | P2 | P3 | P4")
                items.append(TimelineItem(
                    parse_iso(io.get("at"), f"{ip}.at"),
                    _str(io.get("title"), f"{ip}.title", maximum=MAX_CELL),
                    _str(io.get("detail"), f"{ip}.detail", maximum=MAX_CELL, required=False),
                    pr or "",
                ))
            sections.append(TimelineSection(heading, items))
        else:
            raise SpecError(f"{sp}.type", "markdown | table | chart | timeline")

    sources = [
        _str(s, f"sources[{i}]", maximum=500)
        for i, s in enumerate(_list(d.get("sources", []), "sources", MAX_SOURCES))
    ]

    spec = Spec(fmt, kind, title, subtitle, generated_at, generated_by, tz, classification,
                period, kpis, sections, sources)
    if fmt == "csv" and spec.primary_table() is None:
        raise SpecError("sections", "el formato csv requiere al menos una tabla")
    return spec


def _cell(v: Any, kind: str, path: str) -> Any:
    """Normaliza una celda segun la columna. None/"" se conservan como None."""
    if v is None or v == "":
        return None
    if kind == "number":
        return _number(v, path)
    if kind == "datetime":
        return parse_iso(v, path)
    if kind == "priority":
        if v not in PRIORITIES:
            raise SpecError(path, "P1 | P2 | P3 | P4")
        return v
    if kind == "link":
        return _link(_str(v, path, maximum=MAX_CELL), path)
    if isinstance(v, bool):
        return "Sí" if v else "No"
    if isinstance(v, (int, float)):
        _number(v, path)
        return str(v)
    return _str(v, path, maximum=MAX_CELL, required=False)
