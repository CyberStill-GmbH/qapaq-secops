"""Renderiza el sample a PDF/XLSX/CSV en el directorio dado (uso manual)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.renderers import render
from app.spec import validate
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
raw = json.loads((Path(__file__).parent / "fixtures" / "sample-alerts.json").read_text(encoding="utf-8"))
for fmt in ("pdf", "xlsx", "csv"):
    ct, data, pages = render(validate(dict(raw, format=fmt)))
    (out / f"sample.{fmt}").write_bytes(data)
    print(fmt, len(data), pages)
