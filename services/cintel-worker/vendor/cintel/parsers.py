"""Carga de evidencias: .eml (Outlook, Gmail, M365), .msg (Outlook) y cabeceras sueltas.

Todos los formatos se convierten a un `email.message.EmailMessage` estándar
para que el resto del análisis sea idéntico sin importar el cliente de correo.
"""
from __future__ import annotations

import email
from email import policy
from email.message import EmailMessage
from pathlib import Path

MSG_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # Contenedor OLE (formato .msg de Outlook)


class EvidenceError(Exception):
    """Error al cargar un archivo de evidencia."""


def _looks_like_headers_only(data: bytes) -> bool:
    """True si el texto parece un bloque de cabeceras sin cuerpo (copiado de Outlook/Gmail)."""
    head = data.lstrip()[:4000]
    normalized = head.replace(b"\r\n", b"\n")
    return b"\n\n" not in normalized and b":" in head


def parse_bytes(data: bytes) -> tuple[EmailMessage, bool]:
    """Convierte bytes RFC 5322 a mensaje. Devuelve (mensaje, solo_cabeceras)."""
    # Quitar BOM y espacios iniciales que deja el copiar/pegar.
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    data = data.lstrip(b"\r\n\t ")
    headers_only = _looks_like_headers_only(data)
    if headers_only:
        data = data.rstrip(b"\r\n") + b"\r\n\r\n"
    # Las cabeceras de Gmail "Mostrar original" a veces se pegan con sangría
    # inconsistente; el parser de la librería estándar es tolerante a esto.
    msg = email.message_from_bytes(data, policy=policy.default)
    return msg, headers_only


TRANSPORT_PREFIXES = ("received", "authentication-results", "arc-", "dkim-signature", "return-path",
                      "x-ms-", "x-forefront", "x-microsoft", "x-gm-", "x-google", "x-originating")


def _merge_transport_headers(converted: EmailMessage, raw_headers: str) -> None:
    """Restaura en el mensaje convertido las cabeceras de transporte originales del .msg."""
    original = email.message_from_string(raw_headers.strip() + "\r\n\r\n", policy=policy.default)
    present = {k.lower() for k in converted.keys()}
    seen = set()
    for key in original.keys():
        low = key.lower()
        if low in seen:
            continue
        seen.add(low)
        if low in present and not low.startswith(TRANSPORT_PREFIXES):
            continue
        try:
            values = original.get_all(key) or []
            del converted[key]
            for value in values:
                converted[key] = value
        except (ValueError, TypeError):
            continue  # Cabecera malformada: se omite sin interrumpir el análisis.


def parse_msg_file(path: Path) -> EmailMessage:
    """Convierte un .msg de Outlook a EmailMessage usando extract-msg (dependencia opcional)."""
    try:
        import extract_msg  # type: ignore
    except ImportError as exc:
        raise EvidenceError(
            "Para analizar archivos .msg de Outlook instale el extra: pip install \"qapaq-cintel[msg]\" "
            "o exporte el correo como .eml (Archivo > Guardar como)."
        ) from exc
    try:
        msg_file = extract_msg.openMsg(str(path))
        try:
            converted = msg_file.asEmailMessage()
            # asEmailMessage no siempre conserva las cabeceras de transporte originales
            # (Received, Authentication-Results); se reinsertan desde headerText.
            raw_headers = getattr(msg_file, "headerText", None) or ""
            if raw_headers.strip():
                _merge_transport_headers(converted, raw_headers)
            return converted
        finally:
            msg_file.close()
    except EvidenceError:
        raise
    except Exception as exc:  # noqa: BLE001 - extract-msg lanza excepciones variadas
        raise EvidenceError(f"No se pudo leer el archivo .msg: {exc}") from exc


def load_evidence(path: Path) -> dict:
    """Lee un archivo de evidencia y devuelve el mensaje con sus metadatos."""
    path = Path(path)
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise EvidenceError(f"No se pudo leer {path}: {exc}") from exc
    if not data.strip():
        raise EvidenceError(f"El archivo {path} está vacío")
    if data.startswith(MSG_MAGIC) or path.suffix.lower() == ".msg":
        msg = parse_msg_file(path)
        return {"mensaje": msg, "datos": data, "tipo": "msg (Outlook)", "solo_cabeceras": False}
    msg, headers_only = parse_bytes(data)
    kind = "cabeceras" if headers_only else "eml"
    return {"mensaje": msg, "datos": data, "tipo": kind, "solo_cabeceras": headers_only}

