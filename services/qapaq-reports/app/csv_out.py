"""CSV: tabla primary (o la primera), UTF-8 con BOM, RFC 4180, anti formula injection."""
from __future__ import annotations

import csv
import io

from .common import iso_in_tz
from .spec import Spec

DANGEROUS_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def neutralize(value: str) -> str:
    """Prefija ' a celdas que Excel/Sheets interpretarian como formula."""
    if value and value[0] in DANGEROUS_PREFIXES:
        return "'" + value
    return value


def _cell(value, kind: str, spec: Spec) -> str:
    if value is None:
        return ""
    if kind == "datetime":
        return iso_in_tz(value, spec.tz)
    if kind == "number":
        # Numeros sin agrupacion de miles (aptos para importar).
        return repr(value) if isinstance(value, float) else str(value)
    return neutralize(str(value))


def render_csv(spec: Spec) -> bytes:
    table = spec.primary_table()
    assert table is not None  # garantizado por validate()
    buf = io.StringIO(newline="")
    w = csv.writer(buf, dialect="excel", delimiter=",", quotechar='"',
                   quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    w.writerow([neutralize(c.label) for c in table.columns])
    for row in table.rows:
        w.writerow([_cell(row[c.key], c.kind, spec) for c in table.columns])
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")


