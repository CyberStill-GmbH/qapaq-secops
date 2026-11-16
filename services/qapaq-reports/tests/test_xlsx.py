import datetime as dt
import io

import openpyxl

from app.spec import validate
from app.xlsx_out import render_xlsx


def load(sample):
    sample = dict(sample, format="xlsx")
    return openpyxl.load_workbook(io.BytesIO(render_xlsx(validate(sample))))


def test_sheets_and_properties(sample):
    wb = load(sample)
    assert wb.sheetnames == [
        "Resumen", "Alertas por día y prioridad", "Distribución por prioridad",
        "Tendencia de alertas totales", "Alertas del periodo", "Cronología"]
    assert wb.properties.creator == "QAPAQ SOC"
    assert wb.properties.title == "Informe semanal de alertas"


def test_resumen_content(sample):
    ws = load(sample)["Resumen"]
    texts = [str(c.value) for row in ws.iter_rows() for c in row if c.value]
    assert "Informe semanal de alertas" in texts
    assert "Alertas P1" in texts
    assert any("Wazuh Indexer" in t for t in texts)
    assert any("64 alertas" in t for t in texts)
    assert len(ws._images) == 1


def test_table_sheet_structure(sample):
    ws = load(sample)["Alertas del periodo"]
    assert ws.freeze_panes == "A2"
    assert ws.auto_filter.ref.startswith("A1:G")
    assert [c.value for c in ws[1]] == ["Ocurrió", "Prioridad", "Alerta", "IP origen", "Estado", "Puntuación", "Abrir"]
    first = [c.value for c in ws[2]]
    assert isinstance(first[0], dt.datetime)          # fecha real
    assert isinstance(first[5], (int, float))         # numero real
    assert ws.cell(2, 7).hyperlink is not None        # enlace real
    assert ws.cell(2, 7).hyperlink.target.startswith("https://soc.example.test/")


def test_datetime_in_report_timezone(sample):
    sample = dict(sample, format="xlsx")
    sample["sections"] = [s for s in sample["sections"] if s["type"] == "table"]
    sample["sections"][0]["rows"] = [dict(sample["sections"][0]["rows"][0], occurredAt="2026-11-12T14:00:00Z")]
    ws = openpyxl.load_workbook(io.BytesIO(render_xlsx(validate(sample))))["Alertas del periodo"]
    assert ws["A2"].value == dt.datetime(2026, 11, 12, 9, 0)  # UTC-5


def test_charts_are_native(sample):
    wb = load(sample)
    assert len(wb["Alertas por día y prioridad"]._charts) == 1
    assert len(wb["Distribución por prioridad"]._charts) == 1
    assert len(wb["Tendencia de alertas totales"]._charts) == 1


def test_timeline_sheet(sample):
    ws = load(sample)["Cronología"]
    assert ws.max_row == 7
    assert isinstance(ws["A2"].value, dt.datetime)


def test_formula_injection_stays_text(minimal):
    raw = minimal(format="xlsx", title="=1+1")
    raw["sections"][0]["rows"] = [{"a": '=HYPERLINK("http://evil.test","x")', "n": 1, "t": None}]
    raw["sections"].append({"type": "markdown", "heading": "=SUM(1)", "body": "+cmd\n\n- =2+2"})
    raw["kpis"] = [{"label": "=A1", "value": "@x", "hint": "-1"}]
    wb = openpyxl.load_workbook(io.BytesIO(render_xlsx(validate(raw))))
    for ws in wb:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and c.value[:1] in "=+-@":
                    assert c.data_type == "s", (ws.title, c.coordinate, c.value)
    assert wb["Datos"]["A2"].data_type == "s"
    assert wb["Datos"]["A2"].value.startswith("=HYPERLINK")


def test_sheet_name_sanitised_and_unique(minimal):
    raw = minimal(format="xlsx")
    sec = raw["sections"][0]
    sec["heading"] = "Datos: [prueba]/muy largo " + "x" * 40
    raw["sections"] = [sec, dict(sec), dict(sec, heading="Resumen")]
    names = openpyxl.load_workbook(io.BytesIO(render_xlsx(validate(raw)))).sheetnames
    assert len(set(n.lower() for n in names)) == len(names)
    assert all(len(n) <= 31 and not set("[]:*?/\\") & set(n) for n in names)
