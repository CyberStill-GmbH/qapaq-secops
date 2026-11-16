"""Extracción y análisis ESTÁTICO de URLs. Nunca se visita ningún enlace.

Detecta: enlaces cuyo texto visible no coincide con el destino, URLs con IP,
acortadores, punycode/homógrafos, dominios parecidos a los protegidos,
servicios legítimos abusados para alojar phishing, redirecciones abiertas y
desenvuelve Safe Links de Microsoft 365, redirecciones de Google y similares.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urlsplit

from cintel.lookalike import brand_in_text, check_lookalike
from cintel.util import is_ip, org_domain, to_unicode_domain

URL_RE = re.compile(r"(?:https?|hxxps?)://[^\s<>\"'`\]\[{}|\\^]+", re.I)
BARE_DOMAIN_RE = re.compile(r"\b((?:[a-z0-9-]+\.)+[a-z]{2,24})\b", re.I)

SHORTENERS = {
    "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly",
    "cutt.ly", "shorturl.at", "rb.gy", "t.ly", "tiny.cc", "s.id", "lnkd.in", "trib.al", "shorte.st",
    "adf.ly", "bl.ink", "qrco.de", "qr.io", "short.io", "v.gd", "x.co", "urlz.fr", "tiny.one", "1drv.ms",
    "aka.ms", "forms.gle", "rebrandly.com", "linktr.ee", "surl.li", "u.to", "clck.ru",
}

# TLDs con alta proporción de abuso según reportes públicos de la industria.
SUSPICIOUS_TLDS = {
    "zip", "mov", "xyz", "top", "click", "link", "online", "site", "website", "icu", "buzz", "rest",
    "cfd", "sbs", "quest", "gq", "ml", "cf", "tk", "ga", "work", "support", "live", "shop", "lol",
    "monster", "cyou", "bond", "beauty", "hair", "skin", "autos", "boats", "mom", "loan", "win",
    "bid", "review", "country", "kim", "date", "faith", "racing", "science", "party", "stream",
    "download", "cam", "su", "ru",
}

# Servicios legítimos que los atacantes usan para alojar páginas de phishing.
ABUSED_SERVICES = {
    "docs.google.com": "Google Docs/Forms", "forms.gle": "Google Forms", "sites.google.com": "Google Sites",
    "storage.googleapis.com": "Google Cloud Storage", "drive.google.com": "Google Drive",
    "forms.office.com": "Microsoft Forms", "forms.microsoft.com": "Microsoft Forms",
    "sharepoint.com": "SharePoint/OneDrive", "onedrive.live.com": "OneDrive", "1drv.ms": "OneDrive",
    "blob.core.windows.net": "Azure Blob Storage", "azurewebsites.net": "Azure App Service",
    "web.core.windows.net": "Azure Static Website", "firebaseapp.com": "Firebase", "web.app": "Firebase",
    "pages.dev": "Cloudflare Pages", "workers.dev": "Cloudflare Workers", "trycloudflare.com": "Cloudflare Tunnel",
    "r2.dev": "Cloudflare R2", "netlify.app": "Netlify", "vercel.app": "Vercel", "github.io": "GitHub Pages",
    "glitch.me": "Glitch", "herokuapp.com": "Heroku", "repl.co": "Replit", "replit.app": "Replit",
    "blogspot.com": "Blogger", "weebly.com": "Weebly", "wixsite.com": "Wix", "000webhostapp.com": "000webhost",
    "ngrok.io": "ngrok", "ngrok-free.app": "ngrok", "ipfs.io": "IPFS", "dweb.link": "IPFS",
    "dropbox.com": "Dropbox", "wetransfer.com": "WeTransfer", "we.tl": "WeTransfer",
    "s3.amazonaws.com": "Amazon S3", "notion.site": "Notion",
    "canva.site": "Canva", "my.canva.site": "Canva", "typeform.com": "Typeform", "jotform.com": "Jotform",
    "webflow.io": "Webflow", "framer.app": "Framer", "godaddysites.com": "GoDaddy Sites",
    "box.com": "Box", "mediafire.com": "MediaFire", "telegra.ph": "Telegraph", "t.me": "Telegram",
}

# Palabras en la URL típicas de páginas de robo de credenciales.
PHISH_PATH_WORDS = ("login", "logon", "signin", "sign-in", "verify", "verificar", "verificacion", "secure",
                    "account", "cuenta", "update", "actualizar", "password", "contrasena", "clave", "token",
                    "wallet", "auth", "sso", "office365", "o365", "outlook", "owa", "microsoft", "webmail",
                    "banca", "bancaporinternet", "validar", "desbloquear", "recuperar", "invoice", "factura")

REDIRECT_PARAMS = ("url", "u", "q", "redirect", "redirect_uri", "redirect_url", "next", "target", "dest",
                   "destination", "link", "goto", "out", "continue", "return", "returnurl", "r")


def unwrap(url: str, depth: int = 0) -> tuple[str, list]:
    """Desenvuelve URLs envolventes (Safe Links, Google, Proofpoint v2, redirects). Devuelve (final, capas)."""
    layers = []
    try:
        parts = urlsplit(url)
    except ValueError:
        return url, layers
    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query)
    target = None
    if host.endswith("safelinks.protection.outlook.com") and "url" in query:
        target, name = query["url"][0], "Microsoft Safe Links"
    elif host in ("www.google.com", "google.com") and parts.path == "/url":
        target, name = (query.get("q") or query.get("url") or [None])[0], "Redirección de Google"
    elif host == "urldefense.proofpoint.com" and "u" in query:
        raw = query["u"][0].replace("_", "/")
        target, name = re.sub(r"-([0-9A-F]{2})", lambda m: chr(int(m.group(1), 16)), raw), "Proofpoint URL Defense v2"
    elif host.endswith("protect-us.mimecast.com") or host.endswith("protect.mimecast.com"):
        target, name = None, "Mimecast URL Protect"
        layers.append(name)
    else:
        for key, values in query.items():
            if key.lower() in REDIRECT_PARAMS:
                candidate = unquote(values[0])
                if re.match(r"^(?:https?:)?//", candidate, re.I):
                    target, name = candidate if candidate.startswith("http") else "https:" + candidate, \
                        f"Redirección por parámetro '{key}' en {host}"
                    break
    if target and target != url and depth < 4:
        layers.append(name)
        final, more = unwrap(target, depth + 1)
        return final, layers + more
    return url, layers


class HtmlScanner(HTMLParser):
    """Recorre el HTML del correo/adjunto recolectando enlaces y elementos de riesgo."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.anchors = []        # [{'href', 'texto'}]
        self.forms = []          # [{'action', 'password', 'campos'}]
        self.sources = []        # src de iframes/scripts/imágenes externas
        self.meta_refresh = []
        self.scripts = 0
        self.script_text = []
        self.text_parts = []
        self._current_anchor = None
        self._current_form = None
        self._in_script = False
        self._in_style = False
        self.error = None  # Error de parseo de HTML malformado (si lo hubo)

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "a":
            self._current_anchor = {"href": a.get("href", "").strip(), "texto": ""}
        elif tag == "form":
            self._current_form = {"action": a.get("action", "").strip(), "pide_clave": False, "campos": []}
        elif tag == "input" and self._current_form is not None:
            kind = a.get("type", "text").lower()
            self._current_form["campos"].append(a.get("name") or kind)
            if kind == "password":
                self._current_form["pide_clave"] = True
        elif tag == "input" and a.get("type", "").lower() == "password":
            self.forms.append({"action": "", "pide_clave": True, "campos": [a.get("name") or "password"]})
        elif tag in ("iframe", "script", "img", "embed", "object", "frame"):
            src = a.get("src") or a.get("data") or ""
            if src and not src.lower().startswith("cid:"):
                self.sources.append({"etiqueta": tag, "src": src.strip()})
            if tag == "script":
                self.scripts += 1
                self._in_script = True
        elif tag == "meta" and a.get("http-equiv", "").lower() == "refresh":
            self.meta_refresh.append(a.get("content", ""))
        elif tag == "style":
            self._in_style = True

    def handle_endtag(self, tag):
        if tag == "a" and self._current_anchor is not None:
            self._current_anchor["texto"] = re.sub(r"\s+", " ", self._current_anchor["texto"]).strip()
            self.anchors.append(self._current_anchor)
            self._current_anchor = None
        elif tag == "form" and self._current_form is not None:
            self.forms.append(self._current_form)
            self._current_form = None
        elif tag == "script":
            self._in_script = False
        elif tag == "style":
            self._in_style = False

    def handle_data(self, data):
        if self._in_script:
            self.script_text.append(data[:20000])
            return
        if self._in_style:
            return
        if self._current_anchor is not None:
            self._current_anchor["texto"] += data
        self.text_parts.append(data)

    @property
    def text(self) -> str:
        return re.sub(r"[ \t\r\f\v]+", " ", " ".join(self.text_parts))


def scan_html(html: str) -> HtmlScanner:
    scanner = HtmlScanner()
    try:
        scanner.feed(html)
        scanner.close()
    except Exception as exc:  # noqa: BLE001 - HTML malicioso/malformado no debe detener el análisis
        scanner.error = str(exc)[:200]
    return scanner


def extract_text_urls(text: str) -> list:
    urls = []
    for raw in URL_RE.findall(text or ""):
        url = raw.rstrip(".,;:)]}>'\"")
        url = re.sub(r"^hxxp", "http", url, flags=re.I)
        urls.append(url)
    return urls


def _display_domain(text: str) -> str | None:
    """Dominio que aparenta el texto visible del enlace, solo si el texto ES una URL o dominio."""
    text = (text or "").strip().lower()
    if not text:
        return None
    if text.startswith(("http://", "https://", "www.")):
        candidate = text if text.startswith("http") else "http://" + text
        try:
            return (urlsplit(candidate.split()[0]).hostname or "").lower() or None
        except ValueError:
            return None
    m = BARE_DOMAIN_RE.fullmatch(text.strip("/ "))
    return m.group(1).lower() if m else None


def analyze_url(url: str, display_text: str | None, cfg, source: str) -> dict | None:
    """Indicadores de riesgo de una URL. `source` indica dónde se encontró."""
    final, layers = unwrap(url)
    try:
        parts = urlsplit(final)
        host = (parts.hostname or "").lower().rstrip(".")
        port = parts.port
    except ValueError:
        return {"url": url, "url_final": final, "host": None, "origen": source, "capas": layers,
                "indicadores": [{"nivel": "medio", "texto": "URL malformada (posible ofuscación)"}]}
    if not host:
        return None
    indicators = []

    def add(level, text):
        indicators.append({"nivel": level, "texto": text})

    org = org_domain(host) if not is_ip(host) else host
    if layers:
        add("info", "URL envuelta por: " + " > ".join(layers) + f"; destino real: {host}")
    if is_ip(host):
        add("alto", "El enlace usa una dirección IP en lugar de un dominio")
    if "xn--" in host or to_unicode_domain(host) != host:
        add("alto", f"Dominio internacionalizado (punycode): se muestra como '{to_unicode_domain(host)}'")
    if "@" in (parts.netloc or ""):
        add("alto", "La URL contiene '@' antes del dominio (truco para ocultar el destino real)")
    if port and port not in (80, 443):
        add("medio", f"Puerto no estándar: {port}")
    if parts.scheme.lower() == "http":
        add("bajo", "Enlace sin cifrado (http)")
    if host in SHORTENERS or org in SHORTENERS:
        add("medio", "Acortador de URL: oculta el destino final")
    tld = host.rsplit(".", 1)[-1] if "." in host else ""
    if tld in SUSPICIOUS_TLDS:
        add("medio", f"Extensión .{tld} con alta tasa de abuso para phishing")
    for service_domain, name in ABUSED_SERVICES.items():
        if host == service_domain or host.endswith("." + service_domain):
            add("medio", f"Servicio legítimo frecuentemente abusado para alojar phishing: {name}")
            break
    if host.count(".") >= 4:
        add("bajo", f"Muchos subdominios ({host.count('.') + 1} niveles)")
    if len(final) > 200:
        add("bajo", f"URL muy larga ({len(final)} caracteres)")
    if final.lower().startswith("data:") or "javascript:" in final.lower():
        add("alto", "Esquema data:/javascript: (contenido incrustado/ejecutable)")
    for match in check_lookalike(host, cfg.protected_domains):
        add("alto", f"Dominio parecido a {match['protegido']}: {match['tecnica']}")
    path_lower = (parts.path + "?" + parts.query).lower()
    brand_hits = [b for b in brand_in_text(host.replace(org, "") + " " + path_lower, cfg.brands)]
    if brand_hits and not any(org == org_domain(p) for p in cfg.protected_domains):
        add("alto", f"La marca '{brand_hits[0]}' aparece en el enlace pero el dominio real es {org}")
    words = [w for w in PHISH_PATH_WORDS if w in path_lower or w in host]
    if words:
        add("bajo", "Palabras típicas de páginas de credenciales: " + ", ".join(sorted(set(words))[:6]))
    # Texto visible vs destino real (técnica clásica de phishing).
    shown = _display_domain(display_text or "")
    if shown and not is_ip(host):
        if org_domain(shown) != org and not shown.endswith("." + org):
            add("alto", f"El texto visible muestra '{shown}' pero el enlace lleva a '{host}'")
    return {"url": url, "url_final": final, "host": host, "dominio": org, "texto_visible": (display_text or "")[:200] or None,
            "origen": source, "capas": layers, "indicadores": indicators}


LEVEL_ORDER = {"critico": 0, "alto": 1, "medio": 2, "bajo": 3, "info": 4}


def url_risk(entry: dict) -> str:
    levels = [i["nivel"] for i in entry.get("indicadores", [])]
    return min(levels, key=lambda lv: LEVEL_ORDER.get(lv, 9)) if levels else "info"

