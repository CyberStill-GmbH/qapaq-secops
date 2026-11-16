"""Guardado automático de cada caso en la carpeta "Qapaq Phishing Contra-inteligencia".

Estructura generada:
  Qapaq Phishing Contra-inteligencia/
    CINTEL-20261019-153012-AB12_dominio_ejemplo.pdf     <- reporte principal
    registro_casos.csv                                  <- bitácora de todos los análisis
    evidencias/CINTEL-20261019-153012-AB12/
      reporte.json  reporte.md  iocs.csv  original.eml  (copia íntegra de la evidencia)
"""
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

from cintel.report.markdown import render_markdown
from cintel.util import defang, safe_filename

LOG_FIELDS = ("id", "fecha", "objetivo", "tipo", "veredicto", "indice_riesgo", "criticos", "altos", "medios",
              "remitente", "asunto", "pdf")


def case_label(case: dict) -> str:
    m = case.get("mensaje")
    if m:
        # En reportes reenviados como adjunto, el protagonista es el correo original.
        target = m["mensajes_adjuntos"][0] if m.get("mensajes_adjuntos") else m
        return target["remitente"].get("dominio") or target["cabeceras"].get("subject") or "mensaje"
    return case["objetivo"]


def save_case(case: dict, root: Path, make_pdf: bool = True, copy_original: bool = True) -> dict:
    root = Path(root)
    evidence_dir = root / "evidencias" / case["id"]
    evidence_dir.mkdir(parents=True, exist_ok=True)
    paths = {"carpeta": str(root), "evidencias": str(evidence_dir)}

    json_path = evidence_dir / "reporte.json"
    json_path.write_text(json.dumps(case, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    paths["json"] = str(json_path)

    md_path = evidence_dir / "reporte.md"
    md_path.write_text(render_markdown(case), encoding="utf-8")
    paths["markdown"] = str(md_path)

    ioc_path = evidence_dir / "iocs.csv"
    with ioc_path.open("w", newline="", encoding="utf-8-sig") as fh:  # BOM: Excel abre bien las tildes
        writer = csv.writer(fh, delimiter=";")
        writer.writerow(["tipo", "valor", "valor_neutralizado", "contexto", "riesgo"])
        for ioc in case["iocs"]:
            writer.writerow([ioc["tipo"], ioc["valor"], defang(ioc["valor"]) if ioc["tipo"] in ("url", "dominio", "correo", "ip") else ioc["valor"],
                             ioc["contexto"], ioc["riesgo"]])
    paths["iocs"] = str(ioc_path)

    # Formatos abiertos para correlacionar en MISP / OpenCTI / SIEM.
    from cintel.report.intel import write_exports

    paths.update(write_exports(case, evidence_dir))

    m = case.get("mensaje")
    if copy_original and m and m.get("fuente") and Path(m["fuente"]).is_file():
        src = Path(m["fuente"])
        dest = evidence_dir / ("original" + (src.suffix.lower() or ".eml"))
        shutil.copy2(src, dest)
        paths["original"] = str(dest)

    if make_pdf:
        from cintel.report.pdf import render_pdf

        pdf_path = root / f"{case['id']}_{safe_filename(case_label(case))}.pdf"
        render_pdf(case, pdf_path)
        paths["pdf"] = str(pdf_path)

    _append_log(root, case, paths.get("pdf", ""))
    return paths


def _append_log(root: Path, case: dict, pdf: str) -> None:
    log = root / "registro_casos.csv"
    new = not log.exists()
    m = case.get("mensaje") or {}
    v = case["veredicto"]
    row = {
        "id": case["id"], "fecha": case["generado_en"], "objetivo": case["objetivo"], "tipo": case["tipo_objetivo"],
        "veredicto": v["etiqueta"], "indice_riesgo": v["indice_riesgo"], "criticos": v["conteo"]["critico"],
        "altos": v["conteo"]["alto"], "medios": v["conteo"]["medio"],
        "remitente": (m.get("remitente") or {}).get("direccion", "") if m else "",
        "asunto": (m.get("cabeceras") or {}).get("subject", "") if m else "", "pdf": Path(pdf).name if pdf else "",
    }
    try:
        with log.open("a", newline="", encoding="utf-8-sig" if new else "utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=LOG_FIELDS, delimiter=";")
            if new:
                writer.writeheader()
            writer.writerow(row)
    except PermissionError:
        pass  # El CSV puede estar abierto en Excel; el caso igual queda guardado.

