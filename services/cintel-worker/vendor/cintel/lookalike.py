"""Detección de dominios parecidos (typosquatting, homógrafos, combosquatting).

Compara un dominio contra los dominios protegidos de la organización
(por defecto qapaq.pe) para detectar suplantaciones como:
  qapaq-pe.com, qapaqperu.com, qapaq.com, qapag.pe, qаpaq.pe (cirílico),
  qapaq.pe.verificacion-cuenta.com, etc.
"""
from __future__ import annotations

from cintel.util import levenshtein, org_domain, to_unicode_domain

# Caracteres confundibles visualmente -> equivalente ASCII.
HOMOGLYPHS = {
    # Cirílico
    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p",
    "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ј": "j", "ԛ": "q", "ѕ": "s",
    "ԁ": "d", "ɡ": "g", "һ": "h", "ӏ": "l", "ԝ": "w",
    # Griego
    "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
    "τ": "t", "υ": "u", "χ": "x", "ω": "w",
    # Latinos extendidos / IPA
    "ɑ": "a", "ı": "i", "ł": "l", "ø": "o", "ß": "b", "ɩ": "i", "ɵ": "o",
    # Dígitos y símbolos usados como letras
    "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "|": "l",
}
MULTI_CHAR = (("rn", "m"), ("vv", "w"), ("cl", "d"), ("nn", "m"), ("ii", "u"))


def skeleton(text: str) -> str:
    """Forma canónica visual: elimina tildes, homoglifos y combinaciones engañosas."""
    import unicodedata

    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = "".join(HOMOGLYPHS.get(c, c) for c in text)
    for src, dst in MULTI_CHAR:
        text = text.replace(src, dst)
    # i / l / 1 se ven casi iguales en muchas tipografías.
    return text.replace("l", "i")


def _label(domain: str) -> tuple[str, str]:
    """Separa un dominio registrable en (etiqueta, sufijo): qapaq.com.pe -> (qapaq, com.pe)."""
    org = org_domain(domain)
    label, _, suffix = org.partition(".")
    return label, suffix


def check_lookalike(domain: str, protected_domains: list) -> list:
    """Devuelve coincidencias sospechosas del dominio contra los dominios protegidos."""
    matches = []
    if not domain:
        return matches
    domain = domain.lower().strip(".")
    unicode_domain = to_unicode_domain(domain)
    for protected in protected_domains:
        protected = protected.lower().strip(".")
        if org_domain(domain) == org_domain(protected):
            continue  # Es el dominio legítimo o un subdominio propio.
        p_label, p_suffix = _label(protected)
        label, suffix = _label(unicode_domain)
        technique = None
        if domain.startswith("xn--") or ".xn--" in domain or unicode_domain != domain:
            if skeleton(label) == skeleton(p_label):
                technique = "Homógrafo IDN (caracteres Unicode que imitan al dominio legítimo)"
        if technique is None and label == p_label and suffix != p_suffix:
            technique = f"Mismo nombre con otra extensión (.{suffix} en lugar de .{p_suffix})"
        if technique is None and skeleton(label) == skeleton(p_label) and label != p_label:
            technique = "Sustitución de caracteres parecidos (0/o, 1/l, rn/m, etc.)"
        if technique is None and len(p_label) >= 4:
            distance = levenshtein(label, p_label)
            if 0 < distance <= (1 if len(p_label) <= 5 else 2):
                technique = f"Typosquatting (diferencia de {distance} carácter(es) con '{p_label}')"
        if technique is None and len(p_label) >= 4 and p_label in label.replace("-", ""):
            technique = f"Combosquatting (contiene '{p_label}' con palabras añadidas)"
        if technique is None and (unicode_domain.startswith(protected + ".") or
                                  f".{protected}." in unicode_domain or
                                  f"{p_label}." in unicode_domain.replace(org_domain(unicode_domain), "")):
            technique = f"Subdominio engañoso (incluye '{protected}' antes del dominio real {org_domain(domain)})"
        if technique:
            matches.append({"dominio": domain, "dominio_unicode": unicode_domain,
                            "protegido": protected, "tecnica": technique})
    return matches


def brand_in_text(text: str, brands: list) -> list:
    """Marcas protegidas que aparecen (normalizadas) dentro de un texto."""
    sk = skeleton(text or "")
    return [b for b in brands if b and skeleton(b) in sk]

