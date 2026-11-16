"""Orquestación de un caso: detecta el tipo de objetivo, ejecuta los análisis y arma el resultado."""
from __future__ import annotations

import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path

from cintel import __author__, __author_role__, __organization__, __product__, __version__, assessment, mitigations, urls
from cintel import domain as dom
from cintel.evasion import analyze_evasion
from cintel.message import analyze_message
from cintel.parsers import EvidenceError, load_evidence, parse_bytes
from cintel.util import DOMAIN_RE, EMAIL_RE, is_ip, org_domain, to_ascii_domain, to_unicode_domain

EVIDENCE_EXT = {".eml", ".msg", ".txt", ".mht", ".mhtml", ".headers", ".hdr"}


def detect_target(target: str) -> str:
    """Clasifica el objetivo: archivo, stdin, direccion, url o dominio."""
    if target == "-":
        return "stdin"
    path = Path(target).expanduser()
    if path.exists():
        return "carpeta" if path.is_dir() else "archivo"
    if re.match(r"^(?:https?|hxxps?)://", target, re.I):
        return "url"
    clean = target.strip().strip("<>").strip()
    if "@" in clean and EMAIL_RE.match(clean):
        return "direccion"
    if DOMAIN_RE.match(to_ascii_domain(clean.lower().rstrip("."))):
        return "dominio"
    return "desconocido"


def _sender_domains(m: dict) -> dict:
    """Dominios relevantes del mensaje (y de mensajes adjuntos) con sus selectores DKIM."""
    found = {}
    for party in (m["remitente"], m.get("reply_to"), m.get("return_path")):
        if party and party.get("dominio"):
            found.setdefault(party["dominio"], [])
    for sig in m.get("dkim_firmas", []):
        if sig.get("d") and sig["d"] in found and sig.get("s"):
            found[sig["d"]].append(sig["s"])
    for nested in m.get("mensajes_adjuntos", []):
        for k, v in _sender_domains(nested).items():
            found.setdefault(k, []).extend(v)
    return found


def _origin_ip(m: dict, online: bool) -> dict | None:
    """IP de origen del correo atacante y la IP que se conectó a Microsoft 365 (CIP).

    Con un gateway de terceros delante de M365, la CIP es la del gateway; por eso se reportan
    ambas: la primera IP pública de la cadena Received y la CIP.
    """
    target = m["mensajes_adjuntos"][0] if m.get("mensajes_adjuntos") else m
    origin = target["ruta"]["ip_origen"]
    cip = next((ff.get("CIP") for ff in target["microsoft"]["forefront"] if ff.get("CIP")), None)
    ip = origin or cip
    if not ip:
        return None
    return {"ip": ip, "ptr": dom.reverse_dns(ip) if online else None,
            "ip_conectante_m365": cip if cip and cip != ip else None}


_PROGRESS_HOOK = None  # Callback opcional de la interfaz (spinner) para mostrar el paso actual


def _progress(text: str, quiet: bool) -> None:
    if _PROGRESS_HOOK:
        _PROGRESS_HOOK(text)
    elif not quiet:
        print(f"  · {text}", file=sys.stderr, flush=True)


def analyze_target(target: str, cfg, online: bool = True, quiet: bool = False, stdin_data: bytes | None = None,
                   on_progress=None) -> dict:
    global _PROGRESS_HOOK
    _PROGRESS_HOOK = on_progress
    try:
        return _analyze_target(target, cfg, online, quiet, stdin_data)
    finally:
        _PROGRESS_HOOK = None


def _analyze_target(target: str, cfg, online: bool, quiet: bool, stdin_data: bytes | None) -> dict:
    kind = detect_target(target)
    now = datetime.now().astimezone()
    case = {
        "id": "CINTEL-" + now.strftime("%Y%m%d-%H%M%S") + "-" + hashlib.sha256(f"{target}{now.timestamp()}".encode()).hexdigest()[:4].upper(),
        "generado_en": now.isoformat(timespec="seconds"),
        "objetivo": target, "tipo_objetivo": kind, "en_linea": online,
        "herramienta": {"nombre": __product__, "version": __version__, "autor": __author__,
                        "rol_autor": __author_role__, "organizacion": __organization__},
        "dominios_protegidos": cfg.protected_domains,
        "mensaje": None, "direccion": None, "url": None, "dominios": {}, "ip_origen": None,
        "postura_propia": None, "evasion": None,
        "hallazgos": [],
    }
    findings = []
    if kind in ("archivo", "stdin"):
        if kind == "archivo":
            _progress(f"Leyendo evidencia {target}", quiet)
            ev = load_evidence(Path(target).expanduser())
            source = str(Path(target).expanduser().resolve())
        else:
            if not stdin_data or not stdin_data.strip():
                raise EvidenceError("No se recibió contenido por la entrada estándar")
            msg, headers_only = parse_bytes(stdin_data)
            ev = {"mensaje": msg, "datos": stdin_data, "tipo": "cabeceras pegadas" if headers_only else "eml (entrada estándar)",
                  "solo_cabeceras": headers_only}
            source = "entrada estándar"
            case["objetivo"] = "cabeceras pegadas (entrada estándar)"
        if not ev["mensaje"].keys():
            raise EvidenceError("El archivo no contiene cabeceras de correo reconocibles")
        _progress("Analizando cabeceras, autenticación, enlaces y adjuntos", quiet)
        m = analyze_message(ev["mensaje"], cfg, ev["datos"], source, ev["tipo"], ev["solo_cabeceras"])
        case["mensaje"] = m
        case["tipo_objetivo"] = "mensaje"
        if online:
            for name, selectors in list(_sender_domains(m).items())[:6]:
                # Los proveedores gratuitos (gmail.com, outlook.com...) no aportan inteligencia DNS al caso.
                free = name in dom.FREE_MAIL
                if not free:
                    _progress(f"Consultando DNS/RDAP de {name}", quiet)
                case["dominios"][name] = dom.check_domain(name, selectors, online=not free)
            case["ip_origen"] = _origin_ip(m, online=True)
            # Postura del dominio propio: explica si el atacante pudo aprovechar una política débil.
            own = cfg.protected_domains[0] if cfg.protected_domains else None
            if own:
                if own in case["dominios"]:
                    case["postura_propia"] = case["dominios"][own]
                else:
                    _progress(f"Revisando postura de correo de {own}", quiet)
                    case["postura_propia"] = dom.check_domain(own, online=True)
        else:
            for name in _sender_domains(m):
                case["dominios"][name] = dom.check_domain(name, online=False)
            case["ip_origen"] = _origin_ip(m, online=False)
        findings += assessment.assess_message(m, cfg, case["dominios"])
    elif kind == "direccion":
        address = target.strip().strip("<>").lower()
        local, _, domain_name = address.rpartition("@")
        domain_name = to_ascii_domain(domain_name.rstrip("."))
        case["direccion"] = {"direccion": address, "local": local, "dominio": domain_name,
                             "dominio_unicode": to_unicode_domain(domain_name),
                             "nota": "No se verifica la existencia del buzón (evita enumeración y alertar al atacante)."}
        _progress(f"Consultando DNS/RDAP de {domain_name}", quiet)
        case["dominios"][domain_name] = dom.check_domain(domain_name, online=online)
        findings += assessment.assess_address(case["direccion"], cfg)
        findings += assessment.assess_domain(case["dominios"][domain_name], cfg, "Dominio", "Dominio")
    elif kind == "url":
        entry = urls.analyze_url(re.sub(r"^hxxp", "http", target, flags=re.I), None, cfg, "objetivo")
        if not entry:
            raise EvidenceError("URL sin dominio válido")
        entry["riesgo"] = urls.url_risk(entry)
        case["url"] = entry
        for ind in entry["indicadores"]:
            if ind["nivel"] != "info" or ind["texto"].startswith("URL envuelta"):
                findings.append({"codigo": "URL_INDICADOR", "severidad": ind["nivel"], "titulo": ind["texto"],
                                 "detalle": entry["url_final"], "ambito": "URL"})
        if entry.get("host") and not is_ip(entry["host"]):
            name = org_domain(entry["host"])
            _progress(f"Consultando DNS/RDAP de {name}", quiet)
            case["dominios"][name] = dom.check_domain(name, online=online)
            findings += assessment.assess_domain(case["dominios"][name], cfg, "Dominio", "Dominio")
    elif kind == "dominio":
        name = to_ascii_domain(target.strip().lower().rstrip("."))
        _progress(f"Consultando DNS/RDAP de {name}", quiet)
        case["dominios"][name] = dom.check_domain(name, online=online)
        findings += assessment.assess_domain(case["dominios"][name], cfg, "Dominio", "Dominio")
    else:
        raise EvidenceError(f"No se reconoce '{target}' como archivo, dirección de correo, dominio ni URL")

    case["hallazgos"] = findings
    return finalize_case(case)


def finalize_case(case: dict) -> dict:
    """Calcula veredicto, evasión, MITRE/mitigaciones, recomendaciones e IOCs a partir de los hallazgos.

    Se vuelve a llamar después de la correlación con casos anteriores, que puede agregar hallazgos.
    """
    case["hallazgos"] = assessment.sort_findings(case["hallazgos"])
    case["veredicto"] = assessment.verdict(case["hallazgos"], case["tipo_objetivo"])
    case["evasion"] = analyze_evasion(case, case["dominios_protegidos"], case.get("postura_propia"))
    mitigations.apply(case)
    case["recomendaciones"] = assessment.recommendations(case)
    case["iocs"] = build_iocs(case)
    return case


def build_iocs(case: dict) -> list:
    """Indicadores de compromiso para bloqueo/búsqueda (tipo, valor, contexto, riesgo)."""
    iocs, seen = [], set()

    def add(kind, value, context, risk="info"):
        if not value or (kind, value) in seen:
            return
        seen.add((kind, value))
        iocs.append({"tipo": kind, "valor": value, "contexto": context, "riesgo": risk})

    level = case["veredicto"]["nivel"]
    protected = case.get("dominios_protegidos", [])

    def is_own(domain_name):
        return any(org_domain(domain_name or "") == org_domain(p) for p in protected)

    def from_message(m, prefix=""):
        # En un reporte reenviado como adjunto, el correo exterior es del colaborador que reporta:
        # su remitente, IPs y asunto no son indicadores del ataque.
        reporter = not prefix and bool(m.get("mensajes_adjuntos"))
        parties = () if reporter else (("From", m["remitente"]), ("Reply-To", m.get("reply_to")),
                                       ("Return-Path", m.get("return_path")))
        for role, party in parties:
            if party and party.get("direccion"):
                add("correo", party["direccion"], f"{prefix}{role}", level)
                if party.get("dominio") and not is_own(party["dominio"]):
                    add("dominio", party["dominio"], f"{prefix}{role}", level)
        if m["ruta"].get("ip_origen") and not reporter:
            add("ip", m["ruta"]["ip_origen"], f"{prefix}IP de origen (Received)", level)
        for ff in [] if reporter else m["microsoft"]["forefront"]:
            if ff.get("CIP"):
                add("ip", ff["CIP"], f"{prefix}IP conectante a M365 (CIP)", level)
        for u in m["urls"]:
            add("url", u["url_final"], f"{prefix}{u['origen']}", u.get("riesgo", "info"))
            if u.get("dominio") and u.get("riesgo") in ("critico", "alto", "medio") and not is_own(u["dominio"]):
                add("dominio", u["dominio"], f"{prefix}dominio de enlace", u["riesgo"])
        for a in m["adjuntos"]:
            top = min([i["nivel"] for i in a["indicadores"]] or ["info"], key=assessment.SEVERITY_ORDER.index)
            add("sha256", a["sha256"], f"{prefix}adjunto {a['nombre']}", top)
        if m["cabeceras"].get("subject") and not reporter:
            add("asunto", m["cabeceras"]["subject"], f"{prefix}Subject", level)
        for i, nested in enumerate(m.get("mensajes_adjuntos", []), 1):
            from_message(nested, f"Adjunto {i} · ")

    if case.get("mensaje"):
        from_message(case["mensaje"])
    if case.get("direccion"):
        add("correo", case["direccion"]["direccion"], "objetivo", level)
        if not is_own(case["direccion"]["dominio"]):
            add("dominio", case["direccion"]["dominio"], "objetivo", level)
    if case.get("url"):
        add("url", case["url"]["url_final"], "objetivo", case["url"].get("riesgo", level))
        if case["url"].get("host"):
            add("dominio", case["url"]["host"], "objetivo", level)
    if case["tipo_objetivo"] == "dominio":
        add("dominio", next(iter(case["dominios"]), case["objetivo"]), "objetivo", level)
    return iocs

