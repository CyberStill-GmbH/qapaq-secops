import io

import pytest
from pypdf import PdfReader

from app import pdf_out
from app.spec import validate


def render(raw):
    data, pages = pdf_out.render_pdf(validate(dict(raw, format="pdf")))
    return data, pages


def test_sample_renders_multi_page(sample):
    data, pages = render(sample)
    assert data.startswith(b"%PDF")
    reader = PdfReader(io.BytesIO(data))
    assert len(reader.pages) == pages and pages > 3
    assert reader.metadata.title == "Informe semanal de alertas"
    assert reader.metadata.author == "QAPAQ SOC"
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert "Resumen ejecutivo" in text
    assert "Fuentes" in text
    assert f"de {pages}" in text  # pie "Página X de Y"
    assert "Confidencial" in text


def test_long_table_spans_pages_and_repeats_header(minimal):
    raw = minimal()
    sec = raw["sections"][0]
    sec["columns"] = [{"key": "a", "label": "ColumnaUnica", "kind": "text"}]
    sec["rows"] = [{"a": f"fila {i}"} for i in range(400)]
    data, pages = render(raw)
    assert pages > 2
    reader = PdfReader(io.BytesIO(data))
    pages_with_header = sum("ColumnaUnica" in p.extract_text() for p in reader.pages[1:])
    assert pages_with_header >= pages - 2  # cabecera repetida en (casi) todas las paginas de la tabla


def test_markdown_html_is_escaped_not_executed():
    html = pdf_out._markdown_html("<script>alert(1)</script> <img src=http://evil.test/x.png onerror=1>\n\n"
                                  "[x](javascript:alert(1)) [ok](https://example.test) ![i](http://evil.test/i.png)")
    assert "<script" not in html and "<img" not in html
    assert "&lt;script&gt;" in html
    assert "href=\"javascript" not in html
    assert 'href="https://example.test"' in html


def test_text_is_html_escaped(minimal):
    raw = minimal(title="<b>Titulo</b> & co")
    raw["sections"][0]["rows"] = [{"a": "<img src=x onerror=alert(1)>", "n": 1, "t": None}]
    html = pdf_out.build_html(validate(raw))
    assert "<img src=x" not in html
    assert "&lt;b&gt;Titulo&lt;/b&gt;" in html


def test_fetcher_blocks_remote_and_local_files():
    for url in ("http://example.test/x.png", "https://example.test/x.css", "file:///etc/passwd",
                "data:text/plain;base64,AAAA", "asset:../app/spec.py", "asset:nope.png"):
        with pytest.raises(pdf_out.BlockedFetch):
            pdf_out.asset_fetcher(url)
    assert pdf_out.asset_fetcher("asset:remi.png")["mime_type"] == "image/png"


def test_row_budget_truncates_pdf(minimal, monkeypatch):
    monkeypatch.setattr(pdf_out, "PDF_MAX_ROWS", 5)
    raw = minimal()
    raw["sections"][0]["rows"] = [{"a": f"f{i}"} for i in range(20)]
    html = pdf_out.build_html(validate(raw))
    assert "primeros 5 de 20" in html
