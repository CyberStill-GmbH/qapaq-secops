"""Utilidades compartidas: dominios, IPs, normalización de texto y "defang"."""
from __future__ import annotations

import hashlib
import ipaddress
import re
import unicodedata
from email.utils import parseaddr

# Regex de dominio (etiquetas LDH, TLD alfabético o punycode).
DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$",
    re.I,
)
EMAIL_RE = re.compile(r"^[^@\s<>\"]{1,64}@[^@\s<>\"]{1,253}$")

# Sufijos públicos de segundo nivel más comunes (aproximación ligera a la
# Public Suffix List). Suficiente para alinear dominios y detectar similares.
MULTI_LEVEL_SUFFIXES = {
    "com.pe", "org.pe", "gob.pe", "edu.pe", "net.pe", "nom.pe", "mil.pe", "sld.pe",
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
    "com.br", "net.br", "org.br", "gov.br", "com.ar", "gob.ar", "org.ar", "net.ar",
    "com.mx", "gob.mx", "org.mx", "net.mx", "com.co", "gov.co", "org.co", "net.co",
    "com.ec", "gob.ec", "com.bo", "gob.bo", "com.ve", "gob.ve", "com.uy", "gub.uy",
    "com.py", "gov.py", "cl.cl", "gob.cl", "com.es", "org.es", "gob.es",
    "com.au", "net.au", "org.au", "gov.au", "co.nz", "org.nz", "co.za", "org.za",
    "co.jp", "ne.jp", "or.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn",
    "com.tw", "com.hk", "co.in", "net.in", "org.in", "co.id", "com.sg", "com.my",
    "com.tr", "com.ru", "com.ua", "co.il", "com.sa", "com.eg", "com.ng", "co.ke",
    "github.io", "herokuapp.com", "web.app", "firebaseapp.com", "pages.dev",
    "workers.dev", "netlify.app", "vercel.app", "blogspot.com", "azurewebsites.net",
    "cloudfront.net", "s3.amazonaws.com", "appspot.com", "onmicrosoft.com",
    "sharepoint.com", "wixsite.com", "weebly.com", "glitch.me", "ngrok.io",
    "ngrok-free.app", "trycloudflare.com", "000webhostapp.com", "repl.co",
}


def domain_of(value: str | None) -> str:
    """Dominio de una cabecera tipo From/Reply-To o de una dirección suelta."""
    address = parseaddr(value or "")[1]
    if "@" not in address:
        return ""
    return address.rsplit("@", 1)[-1].strip().lower().rstrip(".>")


def address_of(value: str | None) -> str:
    return (parseaddr(value or "")[1] or "").strip().lower()


def display_name_of(value: str | None) -> str:
    return (parseaddr(value or "")[0] or "").strip()


def to_unicode_domain(domain: str) -> str:
    """Convierte punycode (xn--) a Unicode para mostrarlo al analista."""
    try:
        return domain.encode("ascii").decode("idna")
    except (UnicodeError, ValueError):
        return domain


def to_ascii_domain(domain: str) -> str:
    """Convierte un dominio Unicode a punycode (xn--)."""
    try:
        return domain.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        return domain


def org_domain(domain: str) -> str:
    """Dominio organizacional (registrable): mail.qapaq.pe -> qapaq.pe."""
    domain = (domain or "").lower().strip(".")
    parts = domain.split(".")
    if len(parts) <= 2:
        return domain
    # Primero sufijos de tres niveles (p. ej. s3.amazonaws.com), luego de dos.
    if len(parts) >= 4 and ".".join(parts[-3:]) in MULTI_LEVEL_SUFFIXES:
        return ".".join(parts[-4:])
    if ".".join(parts[-2:]) in MULTI_LEVEL_SUFFIXES:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def same_org(a: str, b: str) -> bool:
    return bool(a and b) and org_domain(a) == org_domain(b)


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value.strip("[]"))
        return True
    except ValueError:
        return False


_DOC_NETS = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")]


def is_public_ip(value: str) -> bool:
    """IP enrutable en Internet. Los rangos de documentación (RFC 5737/3849) cuentan como públicos
    porque se usan en ejemplos y pruebas y nunca aparecen en redes internas."""
    try:
        ip = ipaddress.ip_address(value.strip("[]"))
    except ValueError:
        return False
    return ip.is_global or any(ip in net for net in _DOC_NETS if net.version == ip.version)


def strip_accents(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in normalized if not unicodedata.combining(c))


def norm_text(text: str) -> str:
    """Minúsculas sin tildes y con espacios colapsados (para buscar palabras clave)."""
    return re.sub(r"\s+", " ", strip_accents(text).lower())


def defang(value: str) -> str:
    """Neutraliza IOCs para que no sean clicables: hxxps://ejemplo[.]com."""
    value = re.sub(r"^http", "hxxp", value or "", flags=re.I)
    value = value.replace("://", "[://]") if value.lower().startswith("hxxp") else value
    return value.replace(".", "[.]").replace("@", "[@]")


def hashes(data: bytes) -> dict:
    return {
        # MD5 y SHA-1 se calculan solo para buscar la muestra en plataformas de inteligencia;
        # la integridad de la evidencia se respalda con SHA-256.
        "md5": hashlib.md5(data, usedforsecurity=False).hexdigest(),
        "sha1": hashlib.sha1(data, usedforsecurity=False).hexdigest(),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def levenshtein(a: str, b: str) -> int:
    """Distancia de edición clásica (inserción, borrado, sustitución)."""
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def safe_filename(text: str, limit: int = 60) -> str:
    text = strip_accents(text or "")
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._")
    return (text or "objetivo")[:limit]

