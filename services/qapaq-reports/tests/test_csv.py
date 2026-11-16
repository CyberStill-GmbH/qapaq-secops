import csv
import io

import pytest

from app.csv_out import neutralize, render_csv
from app.spec import validate


@pytest.mark.parametrize("raw", ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tTAB", "\rCR", "=HYPERLINK(\"http://x\")"])
def test_neutralize_dangerous(raw):
    assert neutralize(raw) == "'" + raw


@pytest.mark.parametrize("raw", ["normal", "", "a=b", "1+1", "Ñandú"])
def test_neutralize_leaves_safe(raw):
    assert neutralize(raw) == raw


def decode(data: bytes):
    assert data.startswith(b"\xef\xbb\xbf")
    return list(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline="")))


def test_csv_structure_quoting_and_injection(minimal):
    raw = minimal()
    raw["sections"][0]["columns"].append({"key": "e", "label": "=Etiqueta", "kind": "text"})
    raw["sections"][0]["rows"] = [
        {"a": '=cmd|" /C calc"!A0', "n": 3.5, "t": "2026-11-13T17:00:00Z", "e": 'con "comillas", coma\ny salto'},
        {"a": "@x", "n": -4, "t": None, "e": None},
    ]
    rows = decode(render_csv(validate(raw)))
    assert rows[0] == ["A", "N", "T", "'=Etiqueta"]
    assert rows[1] == ['\'=cmd|" /C calc"!A0', "3.5", "2026-11-13T12:00:00-05:00", 'con "comillas", coma\ny salto']
    assert rows[2] == ["'@x", "-4", "", ""]


def test_csv_uses_primary_table_and_crlf(minimal):
    raw = minimal()
    first = raw["sections"][0]
    first["primary"] = False
    second = {"type": "table", "heading": "Otra", "primary": True,
              "columns": [{"key": "z", "label": "Z", "kind": "text"}], "rows": [{"z": "uno"}]}
    raw["sections"] = [first, second]
    data = render_csv(validate(raw))
    assert data == b"\xef\xbb\xbfZ\r\nuno\r\n"


def test_csv_falls_back_to_first_table(minimal):
    rows = decode(render_csv(validate(minimal())))
    assert rows[0] == ["A", "N", "T"]
