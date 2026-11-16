#!/usr/bin/env python3
"""QAPAQ SOC · detección como código (docs/17-ingenieria-de-deteccion.md).

Subcomandos:
  lint                         Valida catálogo, metadatos, rangos de IDs, prefijos y MITRE.
  coverage [--official DIR]    Matriz MITRE ATT&CK desde el XML de las reglas QAPAQ y brechas priorizadas.
           [--json F] [--md F] Escribe detections/reports/mitre-coverage.{json,md} por defecto.
  check-logtest OUT EXPECTED   Compara la salida de wazuh-logtest con el resultado esperado.
           [--suite NOMBRE]    Aplica los refinamientos declarados en catalog.yaml para esa suite.
  bundle DIR [--example-lists] Prepara reglas del programa (qapaq_soc_*.xml) y listas para instalar o probar.
  cases                        Lista los casos de uso con fixtures (para los runners de shell).

Requiere Python 3.8+ y PyYAML (CI: `pip install pyyaml`; el host AWS ya lo trae).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("Se requiere PyYAML (pip install pyyaml)")

ROOT = Path(__file__).resolve().parents[2]
DET = ROOT / "detections"
REQUIRED_META = ["id", "title", "source", "use_case", "status", "version", "owner", "data_sources",
                 "rules", "mitre", "severity", "false_positives", "tests", "runbook"]
STATUSES = {"experimental", "testing", "production", "pending-provider-evidence", "deprecated", "retired"}


# ----------------------------------------------------------------------------- carga
def load_yaml(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def catalog() -> dict:
    return load_yaml(DET / "catalog.yaml")


def attack() -> dict:
    return json.loads((DET / "mitre" / "attack-qapaq.json").read_text(encoding="utf-8"))


def parse_rules(path: Path, origin: str) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"<\?xml[^>]*\?>", "", text)
    root = ET.fromstring(f"<root>{text}</root>")
    out = []
    for group in root.iter("group"):
        base = [g for g in (group.attrib.get("name") or "").split(",") if g]
        for rule in group.findall("rule"):
            descr = " ".join((d.text or "").strip() for d in rule.findall("description")).strip()
            mitre = [i.text.strip() for m in rule.findall("mitre") for i in m.findall("id") if i.text]
            groups = list(base)
            for g in rule.findall("group"):
                groups += [x for x in (g.text or "").split(",") if x.strip()]
            out.append({
                "id": int(rule.attrib["id"]), "level": int(rule.attrib.get("level", 0)),
                "description": descr, "mitre": mitre, "groups": groups,
                "file": path.relative_to(ROOT).as_posix(), "origin": origin,
                "overwrite": rule.attrib.get("overwrite") == "yes",
            })
    return out


def _tracked(paths):
    """Con QAPAQ_DETECTIONS_TRACKED_ONLY=1 ignora lo que no está en git (trabajo en curso de otros agentes)."""
    import os
    import subprocess
    if os.environ.get("QAPAQ_DETECTIONS_TRACKED_ONLY") != "1":
        return sorted(paths)
    listed = subprocess.run(["git", "-C", str(ROOT), "ls-files", "detections"], capture_output=True, text=True,
                            check=True).stdout.split()
    tracked = {ROOT / Path(x) for x in listed}
    return sorted(p for p in paths if p in tracked)


def use_case_dirs() -> list[Path]:
    return [p.parent for p in _tracked(DET.glob("*/*/metadata.yaml"))]


def program_rule_files() -> list[Path]:
    """QAPAQ_DETECTIONS_INCLUDE="aws/trusted-principals linux/noise-tuning" limita el bundle a esos casos de uso
    (despliegue coordinado: cada owner instala lo suyo; lo ya instalado de otros no se toca)."""
    import os
    files = _tracked(DET.glob("*/*/rule.xml"))
    include = os.environ.get("QAPAQ_DETECTIONS_INCLUDE", "").split()
    if include:
        files = [f for f in files if f.parent.relative_to(DET).as_posix() in include]
    return files


def bundle_name(rule_xml: Path) -> str:
    rel = rule_xml.parent.relative_to(DET)
    return "qapaq_soc_" + "_".join(part.replace("-", "_") for part in rel.parts) + ".xml"


def all_rules(include_program: bool = True) -> list[dict]:
    rules = []
    for entry in catalog()["rule_files"]:
        p = ROOT / entry["path"]
        if not p.exists():
            if not entry.get("optional"):
                raise SystemExit(f"falta el archivo de reglas del catálogo: {entry['path']}")
            continue
        rules += parse_rules(p, "existing" if entry.get("owner") == "soc-detection-engineering" else f"owner:{entry.get('owner')}")
    if include_program:
        for rule_xml in program_rule_files():
            try:
                rules += parse_rules(rule_xml, "program")
            except ET.ParseError as error:
                raise SystemExit(f"{rule_xml.relative_to(ROOT).as_posix()}: XML inválido ({error})")
    return rules


# ----------------------------------------------------------------------------- lint
def cmd_lint(_args) -> int:
    cat, att = catalog(), attack()
    techniques = att["techniques"]
    errors, warnings = [], []
    rules = all_rules()
    by_id: dict[int, dict] = {}
    lo, hi = cat["user_range"]
    for r in rules:
        own = r["origin"] in ("existing", "program")
        sink = errors if own else warnings
        if r["id"] in by_id and not r["overwrite"]:
            errors.append(f"ID {r['id']} duplicado: {r['file']} y {by_id[r['id']]['file']}")
        by_id.setdefault(r["id"], r)
        if not lo <= r["id"] <= hi:
            errors.append(f"{r['file']}: ID {r['id']} fuera del rango de usuario")
        if not any(rg["from"] <= r["id"] <= rg["to"] for rg in cat["id_ranges"]):
            sink.append(f"{r['file']}: ID {r['id']} fuera de los rangos reservados del catálogo")
        if r["level"] > 0 and not re.match(r"^QAPAQ [A-Za-zÁ-ú0-9 ]+: ", r["description"]):
            sink.append(f"{r['file']}: regla {r['id']} sin prefijo «QAPAQ <Fuente>:» → {r['description'][:60]!r}")
        for t in r["mitre"]:
            if t not in techniques:
                sink.append(f"{r['file']}: regla {r['id']} usa {t}, que no está en detections/mitre/attack-qapaq.json")

    referenced: set[int] = set()
    for uc in use_case_dirs():
        rel = uc.relative_to(DET).as_posix()
        meta = load_yaml(uc / "metadata.yaml")
        missing = [k for k in REQUIRED_META if k not in meta]
        if missing:
            errors.append(f"{rel}: faltan campos {missing}")
            continue
        if meta["status"] not in STATUSES:
            errors.append(f"{rel}: status {meta['status']!r} no válido")
        if meta["source"] not in cat["sources"]:
            errors.append(f"{rel}: fuente {meta['source']!r} no está en catalog.yaml")
        rule_file = ROOT / meta["rules"]["file"]
        if not rule_file.exists():
            (warnings if meta["rules"].get("optional") else errors).append(f"{rel}: no existe {meta['rules']['file']}")
            continue
        file_rules = {r["id"]: r for r in parse_rules(rule_file, "x")}
        referenced.update((meta["rules"].get("related") or {}).get("ids", []))
        xml_mitre: set[str] = set()
        for rid in meta["rules"]["ids"]:
            referenced.add(rid)
            if rid not in file_rules:
                errors.append(f"{rel}: la regla {rid} no está en {meta['rules']['file']}")
            else:
                xml_mitre |= set(file_rules[rid]["mitre"])
        for m in meta["mitre"]:
            if m["technique"] not in xml_mitre:
                errors.append(f"{rel}: MITRE {m['technique']} declarado en metadata pero no en el XML de sus reglas")
        for t in xml_mitre - {m["technique"] for m in meta["mitre"]}:
            warnings.append(f"{rel}: {t} está en el XML pero no en metadata.mitre")
        if (uc / "rule.xml").exists():
            ids_here = set(parse_rules_ids(uc / "rule.xml"))
            if ids_here != set(meta["rules"]["ids"]):
                errors.append(f"{rel}: rules.ids {sorted(meta['rules']['ids'])} ≠ reglas de rule.xml {sorted(ids_here)}")
        tests = meta["tests"]
        for key in ("fixtures", "expected"):
            if key in tests and not (ROOT / tests[key]).exists():
                errors.append(f"{rel}: no existe {tests[key]}")
        if "fixtures" in tests and "expected" in tests and (ROOT / tests["fixtures"]).exists():
            n_f = sum(1 for line in (ROOT / tests["fixtures"]).read_text(encoding="utf-8").splitlines() if line.strip())
            n_e = sum(1 for line in (ROOT / tests["expected"]).read_text(encoding="utf-8").splitlines() if line.strip())
            if n_f != n_e:
                errors.append(f"{rel}: {n_f} fixtures y {n_e} resultados esperados")
        if not (ROOT / meta["runbook"].split("#")[0]).exists():
            errors.append(f"{rel}: runbook inexistente {meta['runbook']}")
        pb = meta.get("respond_playbook")
        if pb and not (ROOT / pb).exists():
            errors.append(f"{rel}: playbook inexistente {pb}")

    for r in rules:
        if r["origin"] in ("existing", "program") and r["id"] not in referenced and r["level"] > 0:
            (errors if r["origin"] == "program" else warnings).append(
                f"{r['file']}: regla {r['id']} sin caso de uso (metadata.yaml) que la referencie")

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"FAIL  {e}")
    own = sum(1 for r in rules if r["origin"] in ("existing", "program"))
    print(f"{len(use_case_dirs())} casos de uso, {len(rules)} reglas QAPAQ ({own} del programa/SOC), "
          f"{len(errors)} errores, {len(warnings)} avisos")
    return 1 if errors else 0


def parse_rules_ids(path: Path) -> list[int]:
    return [r["id"] for r in parse_rules(path, "x")]


# ----------------------------------------------------------------------------- coverage
def technique_index(rules: list[dict]) -> dict[str, list[dict]]:
    index: dict[str, list[dict]] = defaultdict(list)
    for r in rules:
        for t in sorted(set(r["mitre"])):
            index[t].append(r)
    return index


def coverage_view(rules: list[dict], att: dict) -> dict:
    index = technique_index(rules)
    tactics = {t["key"]: t for t in att["tactics"]}
    per_tactic: dict[str, list[str]] = {k: [] for k in tactics}
    for t in index:
        for tac in att["techniques"].get(t, {}).get("tactics", []):
            per_tactic[tac].append(t)
    return {
        "rules": len(rules),
        "rules_with_mitre": sum(1 for r in rules if r["mitre"]),
        "techniques": sorted(index),
        "parents": sorted({t.split(".")[0] for t in index}),
        "tactics_covered": sorted(k for k, v in per_tactic.items() if v),
        "per_tactic": {k: sorted(v) for k, v in per_tactic.items()},
        "index": {t: sorted(r["id"] for r in rs) for t, rs in index.items()},
    }


def official_techniques(directory: Path) -> dict[str, list[int]]:
    found: dict[str, list[int]] = defaultdict(list)
    for f in sorted(directory.glob("*.xml")):
        try:
            for r in parse_rules_loose(f):
                for t in r[1]:
                    found[t].append(r[0])
        except ET.ParseError:
            continue
    return found


def parse_rules_loose(path: Path):
    text = re.sub(r"<\?xml[^>]*\?>", "", path.read_text(encoding="utf-8", errors="replace"))
    root = ET.fromstring(f"<root>{text}</root>")
    for rule in root.iter("rule"):
        yield int(rule.attrib["id"]), [i.text.strip() for m in rule.findall("mitre") for i in m.findall("id") if i.text]


def cmd_coverage(args) -> int:
    att = attack()
    before = coverage_view([r for r in all_rules(False)], att)
    after_rules = all_rules(True)
    after = coverage_view(after_rules, att)
    official = official_techniques(Path(args.official)) if args.official else {}
    names = {k: v["name"] for k, v in att["techniques"].items()}
    tactic_es = {t["key"]: t["es"] for t in att["tactics"]}
    rule_by_id = {r["id"]: r for r in after_rules}

    gaps = []
    for p in sorted(att["priorities"], key=lambda x: (x["priority"], x["technique"])):
        t = p["technique"]
        if t in after["index"]:
            state = "cubierta"
        elif t.split(".")[0] in after["index"] or any(k.startswith(t + ".") for k in after["index"]):
            state = "parcial"
        else:
            state = "brecha"
        gaps.append({**p, "name": names.get(t, "?"), "state": state,
                     "qapaq_rules": after["index"].get(t, []),
                     "official_rules": len(official.get(t, [])) if official else None})

    report = {
        "generated_by": "detections/tools/qapaq_detections.py coverage",
        "attack_version": att["attack_version"],
        "official_ruleset": bool(official),
        "before_program": {k: before[k] for k in ("rules", "rules_with_mitre", "techniques", "parents", "tactics_covered")},
        "after_program": {k: after[k] for k in ("rules", "rules_with_mitre", "techniques", "parents", "tactics_covered")},
        "new_techniques": sorted(set(after["techniques"]) - set(before["techniques"])),
        "per_tactic": after["per_tactic"],
        "technique_rules": after["index"],
        "priorities": gaps,
    }
    json_path = Path(args.json or DET / "reports" / "mitre-coverage.json")
    md_path = Path(args.md or DET / "reports" / "mitre-coverage.md")
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    pr = {1: "Alta", 2: "Media", 3: "Baja"}
    blk = {"none": "Hay datos hoy", "entra-permission": "Permiso de Entra", "endpoint-agent": "Agentes en endpoints",
           "budget": "Presupuesto/licencia", "config": "Configuración"}
    lines = [
        "# QAPAQ SOC · Cobertura MITRE ATT&CK",
        "",
        "> Generado por `python3 detections/tools/qapaq_detections.py coverage`"
        + (" con el ruleset oficial de Wazuh 4.14.8 (`--official`)." if official else ".")
        + " No editar a mano. Fuente: el XML de las reglas QAPAQ (`<mitre><id>`), no las intenciones.",
        "",
        "## Resumen",
        "",
        "| Métrica | Antes del programa | Con el programa |",
        "| --- | ---: | ---: |",
        f"| Reglas QAPAQ | {before['rules']} | {after['rules']} |",
        f"| Reglas con técnica MITRE | {before['rules_with_mitre']} | {after['rules_with_mitre']} |",
        f"| Técnicas y subtécnicas cubiertas | {len(before['techniques'])} | {len(after['techniques'])} |",
        f"| Técnicas padre cubiertas | {len(before['parents'])} | {len(after['parents'])} |",
        f"| Tácticas con al menos una técnica | {len(before['tactics_covered'])}/14 | {len(after['tactics_covered'])}/14 |",
        "",
        "Técnicas nuevas con el programa: " + (", ".join(f"`{t}`" for t in report["new_techniques"]) or "ninguna") + ".",
        "",
        "## Matriz por táctica",
        "",
        "| Táctica | Técnicas | Detalle (técnica → reglas QAPAQ) |",
        "| --- | ---: | --- |",
    ]
    for t in att["tactics"]:
        techs = after["per_tactic"][t["key"]]
        detail = "<br>".join(
            f"`{x}` {names.get(x, '?')} → {', '.join(str(i) for i in after['index'][x][:8])}"
            + (" …" if len(after["index"][x]) > 8 else "") for x in techs) or "—"
        lines.append(f"| {t['es']} ({t['id']}) | {len(techs)} | {detail} |")
    counts = defaultdict(lambda: defaultdict(int))
    for g in gaps:
        counts[g["priority"]][g["state"]] += 1
    lines += [
        "",
        "## Brechas priorizadas para el entorno QAPAQ",
        "",
        "Prioridad según el entorno (M365/Entra, AWS, Linux, Windows/AD, SaaS). «Parcial» = solo la técnica padre o",
        "una subtécnica hermana. «Bloqueo» dice qué hace falta para cerrarla (ver backlog en docs/17).",
        "",
        "| Prioridad | Cubiertas | Parciales | Brechas |",
        "| --- | ---: | ---: | ---: |",
    ]
    for p in (1, 2, 3):
        c = counts[p]
        lines.append(f"| {pr[p]} | {c['cubierta']} | {c['parcial']} | {c['brecha']} |")
    lines += ["", "| Prio. | Técnica | Estado | Entorno | Reglas QAPAQ | " + ("Reglas oficiales | " if official else "")
              + "Bloqueo | Datos necesarios |",
              "| --- | --- | --- | --- | --- | " + ("---: | " if official else "") + "--- | --- |"]
    for g in gaps:
        lines.append(
            f"| {pr[g['priority']]} | `{g['technique']}` {g['name']} | {g['state']} | {', '.join(g['env'])} | "
            + (", ".join(str(i) for i in g["qapaq_rules"][:6]) or "—") + " | "
            + (f"{g['official_rules']} | " if official else "")
            + f"{blk[g['blocker']]} | {g['data']} |")
    lines += ["", "## Reglas por técnica", "", "| Técnica | Reglas QAPAQ (nivel) |", "| --- | --- |"]
    for t in after["techniques"]:
        lines.append(f"| `{t}` {names.get(t, '?')} | "
                     + ", ".join(f"{i} ({rule_by_id[i]['level']})" for i in after["index"][t]) + " |")
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"antes: {len(before['techniques'])} técnicas / {len(before['tactics_covered'])} tácticas; "
          f"con el programa: {len(after['techniques'])} técnicas / {len(after['tactics_covered'])} tácticas; "
          f"nuevas: {', '.join(report['new_techniques'])}")
    print(f"escrito {json_path.relative_to(ROOT) if json_path.is_relative_to(ROOT) else json_path} y "
          f"{md_path.relative_to(ROOT) if md_path.is_relative_to(ROOT) else md_path}")
    return 0


# ----------------------------------------------------------------------------- logtest
def cmd_check_logtest(args) -> int:
    text = Path(args.output).read_text(encoding="utf-8", errors="replace")
    blocks = text.split("**Phase 1: Completed pre-decoding.")[1:]
    expected = [line.strip() for line in Path(args.expected).read_text(encoding="utf-8").splitlines() if line.strip()]
    refinements = {}
    if args.suite:
        for ref in catalog().get("refinements", []):
            if ref["suite"] == args.suite:
                refinements[int(ref["case"])] = (str(ref["from"]), str(ref["to"]))
    if len(blocks) != len(expected):
        print(text[-3000:])
        print(f"FAIL  logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}")
        return 1
    failures, refined = [], 0
    for i, (block, want) in enumerate(zip(blocks, expected), start=1):
        m = re.search(r"id: '(\d+)'\s+level: '(\d+)'", block)
        got = m.group(1) if m else "none"
        if i in refinements and want == refinements[i][0] and got == refinements[i][1]:
            refined += 1
            continue
        if want in ("none", "0"):  # "0": sin alerta o regla de nivel 0 (convención de los runners existentes)
            ok = m is None or m.group(2) == "0"
        elif want.startswith("!"):
            ok = got != want[1:]
        elif "|" in want:  # alternativas, p. ej. reglas que dependen de la hora del manager (<time>, <weekday>)
            ok = got in want.split("|")
        else:
            ok = got == want
        if not ok:
            failures.append(f"caso {i:02d}: esperado {want}, obtenido {got}")
    label = args.suite or Path(args.expected).parent.name
    for f in failures:
        print(f"FAIL  [{label}] {f}")
    print(f"{'OK  ' if not failures else 'FAIL'}  [{label}] {len(expected) - len(failures)}/{len(expected)} casos"
          + (f" ({refined} refinados por reglas del programa)" if refined else ""))
    return 1 if failures else 0


# ----------------------------------------------------------------------------- bundle / cases
def cmd_bundle(args) -> int:
    out = Path(args.dir)
    (out / "rules").mkdir(parents=True, exist_ok=True)
    for rule_xml in program_rule_files():
        target = out / "rules" / bundle_name(rule_xml)
        target.write_bytes(rule_xml.read_bytes().replace(b"\r\n", b"\n"))
        print(f"rules/{target.name}")
    if args.example_lists:
        (out / "lists").mkdir(exist_ok=True)
        for lst in catalog()["lists"]:
            src = ROOT / (lst.get("source") or lst["example"])
            (out / "lists" / lst["name"]).write_bytes(src.read_bytes().replace(b"\r\n", b"\n"))
            print(f"lists/{lst['name']}")
    if args.managed_lists:
        (out / "managed-lists").mkdir(exist_ok=True)
        for lst in catalog()["lists"]:
            if lst.get("source"):
                src = ROOT / lst["source"]
                (out / "managed-lists" / lst["name"]).write_bytes(src.read_bytes().replace(b"\r\n", b"\n"))
                print(f"managed-lists/{lst['name']}")
    if args.existing:
        (out / "existing").mkdir(exist_ok=True)
        for entry in catalog()["rule_files"]:
            p = ROOT / entry["path"]
            if p.exists() and (args.existing == "all" or entry.get("owner") == "soc-detection-engineering"):
                (out / "existing" / p.name).write_bytes(p.read_bytes().replace(b"\r\n", b"\n"))
                print(f"existing/{p.name}")
    return 0


def cmd_cases(_args) -> int:
    import os
    include = os.environ.get("QAPAQ_DETECTIONS_INCLUDE", "").split()
    for uc in use_case_dirs():
        if include and (uc / "rule.xml").exists() and uc.relative_to(DET).as_posix() not in include:
            continue
        meta = load_yaml(uc / "metadata.yaml")
        t = meta.get("tests", {})
        if "fixtures" in t and "expected" in t and t.get("runner", "logtest") == "logtest":
            print(f"{uc.relative_to(DET).as_posix()}\t{t['fixtures']}\t{t['expected']}\t{t.get('suite', '')}")
    return 0


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap =argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("lint")
    c = sub.add_parser("coverage")
    c.add_argument("--official", help="directorio ruleset/rules del manager (opcional)")
    c.add_argument("--json")
    c.add_argument("--md")
    k = sub.add_parser("check-logtest")
    k.add_argument("output")
    k.add_argument("expected")
    k.add_argument("--suite")
    b = sub.add_parser("bundle")
    b.add_argument("dir")
    b.add_argument("--example-lists", action="store_true")
    b.add_argument("--existing", choices=["soc", "all"])
    b.add_argument("--managed-lists", action="store_true", help="copia las listas versionadas (source) a DIR/managed-lists")
    sub.add_parser("cases")
    args = ap.parse_args(argv)
    return {"lint": cmd_lint, "coverage": cmd_coverage, "check-logtest": cmd_check_logtest,
            "bundle": cmd_bundle, "cases": cmd_cases}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
