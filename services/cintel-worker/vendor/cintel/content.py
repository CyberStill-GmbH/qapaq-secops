"""Análisis del contenido: ingeniería social, fraude del CEO (BEC) y suplantación.

Las palabras clave están en español y en inglés y se comparan sin tildes ni
mayúsculas. Ninguna palabra por sí sola es concluyente: la combinación de
categorías es lo que eleva el riesgo.
"""
from __future__ import annotations

import re

from cintel.util import norm_text

KEYWORDS = {
    "urgencia": (
        "urgente", "urgencia", "inmediato", "inmediatamente", "de inmediato", "hoy mismo", "a la brevedad",
        "lo antes posible", "24 horas", "48 horas", "ultimo aviso", "plazo vence", "vence hoy", "sin demora",
        "accion requerida", "requiere su atencion", "urgent", "immediately", "asap", "final notice",
        "action required", "within 24 hours", "expires today",
    ),
    "credenciales": (
        "contrasena", "clave de acceso", "verifique su cuenta", "verificar su cuenta", "verifica tu cuenta",
        "actualice sus datos", "actualiza tus datos", "inicie sesion", "iniciar sesion", "inicia sesion",
        "confirme su identidad", "confirma tu identidad", "credenciales", "codigo de verificacion",
        "clave dinamica", "token", "validar su cuenta", "restablecer", "password", "verify your account",
        "sign in", "log in", "confirm your identity", "reset your password", "mfa", "autenticacion",
    ),
    "financiero": (
        "transferencia", "pago pendiente", "realizar un pago", "factura", "cuenta bancaria", "numero de cuenta",
        "nueva cuenta", "cambio de cuenta", "cambiar la cuenta", "deposito", "abono", "cci", "swift", "iban",
        "tarjetas de regalo", "gift card", "wire transfer", "invoice", "payment", "remittance", "comprobante",
        "desembolso", "proveedor", "orden de pago", "cheque", "yape", "plin",
    ),
    "autoridad_confidencialidad": (
        "confidencial", "estrictamente confidencial", "no comente", "no lo comente", "discrecion", "discreto",
        "presidente", "gerente general", "directorio", "junta directiva", "director", "ceo", "cfo",
        "estoy en reunion", "estoy en una reunion", "no puedo atender llamadas", "no puedo hablar",
        "solo por correo", "solo por este medio", "necesito un favor", "estas disponible", "esta disponible",
        "keep this confidential", "are you available", "i need a favor", "in a meeting",
    ),
    "amenaza": (
        "suspendida", "suspendido", "bloqueada", "bloqueado", "sera desactivada", "sera eliminada",
        "cancelacion", "acciones legales", "multa", "sancion", "embargo", "deuda", "suspended", "locked",
        "deactivated", "will be deleted", "legal action", "unusual activity", "actividad inusual",
        "actividad sospechosa", "acceso no autorizado",
    ),
    "documento_compartido": (
        "le han compartido", "te han compartido", "ha compartido", "documento compartido", "ver documento",
        "revisar documento", "abrir documento", "shared a file", "shared with you", "docusign", "onedrive",
        "sharepoint", "buzon de voz", "mensaje de voz", "voicemail", "fax", "escanear el codigo",
        "escanee el codigo", "codigo qr", "scan the qr",
    ),
    "premio_reembolso": (
        "ganador", "ganaste", "premio", "sorteo", "felicitaciones", "reembolso", "devolucion", "beneficio",
        "bono", "lottery", "winner", "refund", "you have won",
    ),
}

CATEGORY_LABELS = {
    "urgencia": "Urgencia / presión de tiempo",
    "credenciales": "Solicitud de credenciales o verificación de cuenta",
    "financiero": "Pagos, transferencias o cambio de cuenta bancaria",
    "autoridad_confidencialidad": "Autoridad o confidencialidad (patrón de fraude del CEO)",
    "amenaza": "Amenazas de bloqueo o consecuencias",
    "documento_compartido": "Documento compartido / buzón de voz / QR (señuelo)",
    "premio_reembolso": "Premios, reembolsos o beneficios",
}


def keyword_hits(text: str) -> dict:
    """Coincidencias por categoría en el texto (asunto + cuerpo)."""
    normalized = " " + norm_text(text) + " "
    hits = {}
    for category, words in KEYWORDS.items():
        found = []
        for word in words:
            pattern = r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])"
            if re.search(pattern, normalized):
                found.append(word)
        if found:
            hits[category] = found
    return hits


def html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html or "")
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    return re.sub(r"\s+", " ", text)


def hidden_text_tricks(html: str) -> list:
    """Trucos de evasión de filtros dentro del HTML del correo."""
    tricks = []
    low = (html or "").lower()
    if re.search(r"font-size\s*:\s*0(?:px|pt|em)?\s*[;\"']", low) or re.search(r"display\s*:\s*none", low):
        tricks.append("Texto oculto con CSS (font-size:0 o display:none) para engañar a los filtros")
    if re.search(r"[\u200b\u200c\u200d\u2060\ufeff]", html or ""):
        tricks.append("Caracteres invisibles de ancho cero intercalados en el texto")
    if len(re.findall(r"<img", low)) >= 1 and len(html_to_text(html).strip()) < 40:
        tricks.append("Correo compuesto casi solo por imágenes (evita el análisis de texto; posible QR)")
    return tricks

