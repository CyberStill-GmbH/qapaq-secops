"""Vigilancia de dominios parecidos a los propios (inspirado en dnstwist).

Genera variantes de un dominio (errores de tipeo, homoglifos, guiones, otras
extensiones, palabras añadidas…), consulta cuáles están registradas en DNS y
prioriza las que pueden enviar o recibir correo y las registradas hace poco.

Si el paquete open source `dnstwist` está instalado, se usan además sus
generadores de permutaciones (https://github.com/elceef/dnstwist).
"""
from __future__ import annotations

import csv
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from cintel import domain as dom
from cintel.util import DOMAIN_RE, org_domain

KEYBOARD = {  # Teclas vecinas en teclado QWERTY/latinoamericano
    "q": "wa", "w": "qes", "e": "wrd", "r": "etf", "t": "ryg", "y": "tuh", "u": "yij", "i": "uok", "o": "ipl", "p": "ol",
    "a": "qsz", "s": "awdz", "d": "sefx", "f": "drgc", "g": "fthv", "h": "gyjb", "j": "hukn", "k": "jilm", "l": "kop",
    "z": "asx", "x": "zsdc", "c": "xdfv", "v": "cfgb", "b": "vghn", "n": "bhjm", "m": "njk",
}
GLYPHS = {"o": ["0"], "l": ["1", "i"], "i": ["1", "l"], "a": ["4"], "e": ["3"], "s": ["5"], "m": ["rn", "nn"],
          "w": ["vv"], "d": ["cl"], "q": ["g"], "g": ["q"], "u": ["v"], "b": ["d"]}
TLDS = ("com", "net", "org", "pe", "com.pe", "net.pe", "org.pe", "info", "co", "io", "la", "lat", "online", "site",
        "xyz", "top", "app", "cloud", "biz", "us", "mx", "cl", "co.uk", "email", "support", "live", "store", "tech")
WORDS = ("login", "secure", "seguro", "soporte", "support", "pagos", "pago", "peru", "pe", "online", "app", "web", "mail",
         "correo", "banca", "clientes", "cliente", "cuenta", "verificacion", "verify", "portal", "office", "microsoft",
         "sharepoint", "docs", "rrhh", "it", "ti", "servicios", "tesoreria", "financiera", "credito", "account")


def permutations(domain: str) -> dict:
    """Variantes del dominio -> técnica de generación."""
    domain = domain.lower().strip(".")
    org = org_domain(domain)
    label, _, suffix = org.partition(".")
    out = {}

    def add(candidate_label, technique, tld=None):
        candidate = f"{candidate_label}.{tld or suffix}"
        if candidate != org and DOMAIN_RE.match(candidate) and candidate not in out:
            out[candidate] = technique

    for i in range(len(label)):
        add(label[:i] + label[i + 1:], "omisión")
        add(label[:i] + label[i] + label[i:], "repetición")
        for ch in KEYBOARD.get(label[i], ""):
            add(label[:i] + ch + label[i + 1:], "tecla vecina")
            add(label[:i] + ch + label[i:], "inserción")
        for glyph in GLYPHS.get(label[i], []):
            add(label[:i] + glyph + label[i + 1:], "homoglifo")
        if i < len(label) - 1:
            add(label[:i] + label[i + 1] + label[i] + label[i + 2:], "transposición")
        if 0 < i < len(label):
            add(label[:i] + "-" + label[i:], "guion")
        if label[i] in "aeiou":
            for vowel in "aeiou":
                if vowel != label[i]:
                    add(label[:i] + vowel + label[i + 1:], "cambio de vocal")
    for tld in TLDS:
        if tld != suffix:
            add(label, "otra extensión", tld)
    for word in WORDS:
        add(f"{label}-{word}", "palabra añadida")
        add(f"{word}-{label}", "palabra añadida")
        add(f"{label}{word}", "palabra añadida")
        for tld in ("com", "net"):
            add(f"{label}-{word}", "palabra añadida + extensión", tld)
    add(f"{label}{suffix.replace('.', '')}", "sufijo pegado", "com")
    add(f"{label}-{suffix.replace('.', '-')}", "sufijo con guion", "com")
    for name, fuzz in _dnstwist_variants(org).items():
        if name != org and name not in out and DOMAIN_RE.match(name):
            out[name] = f"dnstwist:{fuzz}"
    return out


def _dnstwist_variants(org: str) -> dict:
    """Permutaciones del paquete open source dnstwist, si está instalado (opcional)."""
    try:
        import dnstwist  # type: ignore
    except ImportError:
        return {}
    try:
        fuzzer = dnstwist.Fuzzer(org)
        fuzzer.generate()
        result = {}
        for item in fuzzer.domains:
            name = (item.get("domain") if isinstance(item, dict) else getattr(item, "domain", "")) or ""
            fuzz = (item.get("fuzzer") if isinstance(item, dict) else getattr(item, "fuzzer", "")) or "dnstwist"
            if name:
                result[name.lower()] = fuzz
        return result
    except Exception:  # noqa: BLE001 - la API de dnstwist puede variar entre versiones
        return {}


def _probe(candidate: str) -> dict | None:
    ns = dom.lookup(candidate, "NS", lifetime=3.0)
    a = dom.lookup(candidate, "A", lifetime=3.0)
    if ns["estado"] != "ok" and a["estado"] != "ok":
        return None
    mx = dom.lookup(candidate, "MX", lifetime=3.0)
    mx_hosts = [r.split()[-1].rstrip(".") for r in mx.get("registros", []) if r.split()[-1] != "."]
    return {"dominio": candidate, "a": a.get("registros", [])[:3], "ns": ns.get("registros", [])[:2], "mx": mx_hosts[:3]}


def watch(domain: str, root: Path, rdap_limit: int = 40, workers: int = 24, progress=None) -> dict:
    """Busca variantes registradas del dominio y guarda CSV/JSON en <root>/vigilancia/."""
    variants = permutations(domain)
    if progress:
        progress(f"{len(variants)} variantes generadas para {domain}; consultando DNS…")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        probes = list(pool.map(_probe, variants))
    found = [dict(p, tecnica=variants[p["dominio"]]) for p in probes if p]
    for item in found[:rdap_limit]:
        info = dom.rdap(org_domain(item["dominio"]))
        item["creado"] = info.get("creado")
        item["antiguedad_dias"] = info.get("antiguedad_dias")
        item["registrador"] = info.get("registrador")
    for item in found:
        age = item.get("antiguedad_dias")
        if age is not None and age < 90:
            item["riesgo"] = "critico"
        elif item["mx"]:
            item["riesgo"] = "alto"
        else:
            item["riesgo"] = "medio"
    order = {"critico": 0, "alto": 1, "medio": 2}
    found.sort(key=lambda x: (order[x["riesgo"]], x["dominio"]))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    folder = Path(root) / "vigilancia"
    folder.mkdir(parents=True, exist_ok=True)
    base = folder / f"{stamp}_{domain.replace('.', '_')}"
    with open(f"{base}.csv", "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh, delimiter=";")
        writer.writerow(["riesgo", "dominio", "tecnica", "creado", "antiguedad_dias", "registrador", "mx", "a", "ns"])
        for x in found:
            writer.writerow([x["riesgo"], x["dominio"], x["tecnica"], x.get("creado") or "", x.get("antiguedad_dias") or "",
                             x.get("registrador") or "", " ".join(x["mx"]), " ".join(x["a"]), " ".join(x["ns"])])
    result = {"dominio": domain, "fecha": stamp, "variantes": len(variants), "registrados": found,
              "csv": f"{base}.csv", "json": f"{base}.json"}
    Path(f"{base}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result

