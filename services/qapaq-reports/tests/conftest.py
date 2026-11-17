import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FIXTURE = Path(__file__).parent / "fixtures" / "sample-alerts.json"


@pytest.fixture
def sample() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture
def minimal():
    def make(**over):
        spec = {
            "version": 1, "format": "csv", "kind": "custom", "title": "Prueba",
            "generatedAt": "2026-11-13T17:00:00Z", "generatedBy": "Tester",
            "timeZone": "America/Lima", "classification": "Confidencial · uso interno QAPAQ",
            "sections": [{
                "type": "table", "heading": "Datos", "primary": True,
                "columns": [{"key": "a", "label": "A", "kind": "text"},
                            {"key": "n", "label": "N", "kind": "number"},
                            {"key": "t", "label": "T", "kind": "datetime"}],
                "rows": [{"a": "x", "n": 1, "t": "2026-11-13T17:00:00Z"}],
            }],
        }
        spec.update(copy.deepcopy(over))
        return spec
    return make
