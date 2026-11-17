"""Correlación de casos: detecta campañas a partir de IOCs compartidos entre análisis.

Cada caso guardado se agrega a un índice local (JSON Lines) dentro de la carpeta
de reportes:

    Qapaq Phishing Contra-inteligencia/correlacion/indice.jsonl

Al analizar un correo nuevo se compara contra el índice por:
  - IOCs fuertes: hash de adjunto, URL, IP de origen, dirección del atacante y dominio
  - IOCs débiles: asunto normalizado (sin RE:/RV: ni números)

Los casos relacionados reciben un identificador de campaña común (CAMP-…), lo que
permite ver cuántos colaboradores recibieron la misma ofensiva aunque se haya
enviado desde direcciones distintas.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from cintel.domain import FREE_MAIL
from cintel.urls import SHORTENERS
from cintel.util import norm_text, org_domain

INDEX_DIR = "correlacion"
INDEX_FILE = "indice.jsonl"
STRONG_TYPES = {"sha256", "url", "ip", "correo", "dominio"}
REPLY_PREFIX = re.compile(r"^\s*((re|rv|fw|fwd|res|enc|tr|aw|wg)\s*(\[\d+\])?\s*:\s*)+", re.I)
LEVELS = ("critico", "alto", "medio", "bajo", "info")


def normalize_subject(subject: str) -> str:
    text = REPLY_PREFIX.sub("", subject or "")
    text = re.sub(r"\d+", "#", norm_text(text))
    return re.sub(r"\s+", " ", text).strip()


def _keys(case: dict) -> set:
    """IOCs correlacionables del caso, excluyendo dominios propios, gratuitos y acortadores."""
    protected = {org_domain(p) for p in case.get("dominios_protegidos", [])}
    keys = set()
    for ioc in case.get("iocs", []):
        kind, value = ioc["tipo"], (ioc["valor"] or "").strip()
        if not value:
            continue
        if kind == "dominio":
            org = org_domain(value.lower())
            if org in protected or org in FREE_MAIL or org in SHORTENERS:
                continue
            keys.add(("dominio", org))
        elif kind == "correo":
            if org_domain(value.rsplit("@", 1)[-1].lower()) in protected:
                continue
            keys.add(("correo", value.lower()))
        elif kind in ("sha256", "ip"):
            keys.add((kind, value.lower()))
        elif kind == "url":
            if org_domain((re.sub(r"^https?://", "", value.lower()).split("/")[0]).split(":")[0]) in protected:
                continue
            keys.add(("url", value))
        elif kind == "asunto":
            subject = normalize_subject(value)
            if len(subject) >= 12:
                keys.add(("asunto", subject))
    return keys


def _evidence_hash(case: dict) -> str | None:
    m = case.get("mensaje") or {}
    target = m["mensajes_adjuntos"][0] if m.get("mensajes_adjuntos") else m
    return (target.get("hashes") or {}).get("sha256")


def load_index(root: Path) -> list:
    path = Path(root) / INDEX_DIR / INDEX_FILE
    entries = []
    if not path.is_file():
        return entries
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue  # Línea dañada: se ignora sin perder el resto del índice.
    return entries


def correlate(case: dict, root: Path, write: bool = True) -> dict:
    """Compara el caso con el índice, agrega hallazgos de campaña y (opcionalmente) lo indexa."""
    entries = load_index(root)
    keys = _keys(case)
    evidence = _evidence_hash(case)
    related, same_evidence = [], []
    for entry in entries:
        if entry.get("id") == case["id"]:
            continue
        if evidence and entry.get("evidencia_sha256") == evidence:
            same_evidence.append(entry)
            continue
        common = keys & {tuple(k) for k in entry.get("claves", [])}
        if common:
            strong = [k for k in common if k[0] in STRONG_TYPES]
            related.append({"id": entry["id"], "fecha": entry.get("fecha"), "veredicto": entry.get("veredicto"),
                            "nivel": entry.get("nivel"), "campana": entry.get("campana"),
                            "coincidencias": [{"tipo": t, "valor": v} for t, v in sorted(common)],
                            "fuerte": bool(strong)})
    related.sort(key=lambda r: (not r["fuerte"], -len(r["coincidencias"]), r.get("fecha") or ""))
    strong_related = [r for r in related if r["fuerte"]]
    campaign = None
    if strong_related:
        campaign = next((r["campana"] for r in strong_related if r.get("campana")), None) or \
            "CAMP-" + min((r["id"] for r in strong_related), key=lambda x: x)[7:]
    result = {"casos_relacionados": related[:25], "total_relacionados": len(related), "campana": campaign,
              "mismo_correo": [{"id": e["id"], "fecha": e.get("fecha")} for e in same_evidence[:10]],
              "indice": str(Path(root) / INDEX_DIR / INDEX_FILE)}
    case["correlacion"] = result

    scope = "Correlación"
    if strong_related:
        worst = min((r.get("nivel") or "info" for r in strong_related), key=LEVELS.index)
        severity = "alto" if worst in ("critico", "alto") else "medio"
        sample = "; ".join(f"{r['id']} ({', '.join(c['tipo'] + '=' + c['valor'][:60] for c in r['coincidencias'][:2])})"
                           for r in strong_related[:3])
        case["hallazgos"].append({
            "codigo": "CAMPANA_RELACIONADA", "severidad": severity, "ambito": scope,
            "titulo": f"Forma parte de una campaña ya vista ({campaign}: {len(strong_related) + 1} casos)",
            "detalle": f"Comparte IOCs con {len(strong_related)} caso(s) anteriores: {sample}."})
    elif related:
        case["hallazgos"].append({
            "codigo": "ASUNTO_REPETIDO", "severidad": "bajo", "ambito": scope,
            "titulo": f"Mismo asunto que {len(related)} caso(s) anteriores",
            "detalle": "; ".join(r["id"] for r in related[:5]) + ". Coincidencia débil (solo asunto)."})
    if same_evidence:
        case["hallazgos"].append({
            "codigo": "MISMO_CORREO", "severidad": "info", "ambito": scope,
            "titulo": "Este mismo correo ya fue analizado", "detalle": ", ".join(e["id"] for e in same_evidence[:5])})

    if write:
        path = Path(root) / INDEX_DIR / INDEX_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        m = case.get("mensaje") or {}
        target = m["mensajes_adjuntos"][0] if m.get("mensajes_adjuntos") else m
        entry = {"id": case["id"], "fecha": case["generado_en"], "objetivo": case["objetivo"],
                 "tipo": case["tipo_objetivo"], "veredicto": case["veredicto"]["etiqueta"], "nivel": case["veredicto"]["nivel"],
                 "campana": campaign, "evidencia_sha256": evidence,
                 "remitente": (target.get("remitente") or {}).get("direccion") if target else None,
                 "asunto": (target.get("cabeceras") or {}).get("subject") if target else None,
                 "claves": sorted([list(k) for k in keys])}
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return result


def campaigns(root: Path) -> list:
    """Agrupa el índice en campañas: casos unidos por IOCs fuertes compartidos (componentes conexos)."""
    entries = load_index(root)
    parent = {e["id"]: e["id"] for e in entries}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    owner = {}
    for e in entries:
        for kind, value in e.get("claves", []):
            if kind not in STRONG_TYPES:
                continue
            key = (kind, value)
            if key in owner:
                parent[find(e["id"])] = find(owner[key])
            else:
                owner[key] = e["id"]
    groups = {}
    for e in entries:
        groups.setdefault(find(e["id"]), []).append(e)
    result = []
    for members in groups.values():
        if len(members) < 2:
            continue
        counts = {}
        for e in members:
            for kind, value in e.get("claves", []):
                if kind in STRONG_TYPES:
                    counts[(kind, value)] = counts.get((kind, value), 0) + 1
        shared = sorted(((k, c) for k, c in counts.items() if c > 1), key=lambda x: -x[1])
        dates = sorted(e.get("fecha") or "" for e in members)
        result.append({"campana": next((e["campana"] for e in members if e.get("campana")), "CAMP-" + min(e["id"] for e in members)[7:]),
                       "casos": len(members), "primero": dates[0], "ultimo": dates[-1],
                       "remitentes": sorted({e["remitente"] for e in members if e.get("remitente")})[:10],
                       "asuntos": sorted({e["asunto"] for e in members if e.get("asunto")})[:5],
                       "iocs_compartidos": [{"tipo": k[0], "valor": k[1], "casos": c} for k, c in shared[:15]],
                       "ids": [e["id"] for e in members]})
    result.sort(key=lambda c: -c["casos"])
    return result

