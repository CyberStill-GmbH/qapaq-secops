import pytest

from app.spec import SpecError, validate


def err(raw) -> str:
    with pytest.raises(SpecError) as ei:
        validate(raw)
    return ei.value.path


def test_sample_is_valid(sample):
    spec = validate(sample)
    assert spec.primary_table().heading == "Alertas del periodo"
    assert len(spec.primary_table().rows) == 64


@pytest.mark.parametrize("field,value,path", [
    ("version", 2, "version"),
    ("format", "docx", "format"),
    ("kind", "otro", "kind"),
    ("title", "", "title"),
    ("title", "x" * 161, "title"),
    ("generatedAt", "ayer", "generatedAt"),
    ("timeZone", "Mars/Olympus", "timeZone"),
    ("kpis", [{"label": "a", "value": "1"}] * 9, "kpis"),
    ("sections", [{"type": "markdown", "heading": "h", "body": ""}] * 41, "sections"),
    ("sections", [{"type": "nope"}], "sections[0].type"),
    ("period", {"from": "2026-11-13T00:00:00Z", "to": "2026-11-12T00:00:00Z"}, "period.to"),
])
def test_top_level_errors(minimal, field, value, path):
    assert err(minimal(**{field: value})) == path


def test_cell_errors_have_precise_path(minimal):
    spec = minimal()
    spec["sections"][0]["rows"][0]["n"] = "no-numero"
    assert err(spec) == "sections[0].rows[0].n"
    spec = minimal()
    spec["sections"][0]["rows"][0]["a"] = "x" * 4001
    assert err(spec) == "sections[0].rows[0].a"
    spec = minimal()
    spec["sections"][0]["rows"][0]["t"] = "13/11/2026"
    assert err(spec) == "sections[0].rows[0].t"


def test_priority_and_link_kinds(minimal):
    spec = minimal()
    spec["sections"][0]["columns"] = [{"key": "p", "label": "P", "kind": "priority"},
                                       {"key": "l", "label": "L", "kind": "link"}]
    spec["sections"][0]["rows"] = [{"p": "P5", "l": None}]
    assert err(spec) == "sections[0].rows[0].p"
    spec["sections"][0]["rows"] = [{"p": "P1", "l": "javascript:alert(1)"}]
    assert err(spec) == "sections[0].rows[0].l"


def test_row_limit(minimal):
    spec = minimal()
    spec["sections"][0]["rows"] = [{"a": "x"}] * 50_001
    assert err(spec) == "sections[0].rows"


def test_rows_limit_is_global(minimal):
    spec = minimal()
    sec = spec["sections"][0]
    sec["rows"] = [{"a": "x"}] * 30_000
    spec["sections"] = [sec, dict(sec, primary=False)]
    assert err(spec) == "sections[1].rows"


def test_csv_requires_table(minimal):
    assert err(minimal(sections=[{"type": "markdown", "heading": "h", "body": "x"}])) == "sections"


def test_non_object_and_bool_numbers(minimal):
    assert err([]) == "$"
    spec = minimal()
    spec["sections"][0]["rows"][0]["n"] = True
    assert err(spec) == "sections[0].rows[0].n"


def test_naive_dates_are_utc(minimal):
    spec = minimal()
    spec["generatedAt"] = "2026-11-13T17:00:00"
    assert validate(spec).generated_at.utcoffset().total_seconds() == 0
