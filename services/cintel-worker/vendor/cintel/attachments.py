"""Análisis ESTÁTICO de adjuntos: nunca se ejecutan ni se abren con aplicaciones.

Detecta extensiones peligrosas, doble extensión, carácter RTLO, discrepancia
entre extensión y contenido real (firma "magic"), macros de Office, PDFs con
JavaScript/acciones automáticas, ZIP cifrados o con ejecutables dentro y
adjuntos HTML/SVG (usados para robo de credenciales y HTML smuggling).
"""
from __future__ import annotations

import io
import re
import zipfile

from cintel.util import hashes

EXECUTABLE_EXT = {
    "exe", "scr", "com", "pif", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "ps1",
    "psm1", "msi", "msp", "mst", "lnk", "jar", "cpl", "dll", "reg", "chm", "appx", "appxbundle",
    "msix", "msixbundle", "application", "gadget", "xll", "url", "inf", "scf", "sys", "ocx", "vb",
    "elf", "sh", "apk", "dmg", "pkg", "app", "iqy", "slk", "settingcontent-ms", "library-ms", "one",
    "website", "xbap", "wim",
}
DISK_IMAGE_EXT = {"iso", "img", "vhd", "vhdx"}
ARCHIVE_EXT = {"zip", "rar", "7z", "gz", "tgz", "tar", "cab", "ace", "arj", "lzh", "bz2", "xz", "z", "uue", "r00"}
MACRO_EXT = {"docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm", "xlsb"}
LEGACY_OFFICE_EXT = {"doc", "dot", "xls", "xlt", "ppt", "pps", "rtf"}
HTML_EXT = {"htm", "html", "shtml", "xhtml", "mht", "mhtml", "svg", "xht"}
DOC_EXT = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "jpg", "jpeg", "png", "gif", "csv", "rtf"}

MAGIC = (
    (b"MZ", "Ejecutable de Windows (PE)"),
    (b"\x7fELF", "Ejecutable de Linux (ELF)"),
    (b"%PDF", "PDF"),
    (b"PK\x03\x04", "ZIP / Office OOXML"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "Contenedor OLE (Office 97-2003 / MSI / MSG)"),
    (b"Rar!", "RAR"),
    (b"7z\xbc\xaf\x27\x1c", "7-Zip"),
    (b"\x1f\x8b", "GZIP"),
    (b"MSCF", "CAB"),
    (b"{\\rtf", "RTF"),
    (b"\x89PNG", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"GIF8", "GIF"),
    (b"L\x00\x00\x00\x01\x14\x02\x00", "Acceso directo de Windows (LNK)"),
)
RTLO = chr(0x202E)  # Right-To-Left Override


def magic_type(data: bytes) -> str | None:
    for signature, name in MAGIC:
        if data.startswith(signature):
            return name
    if data[:0x8006][0x8001:0x8006] == b"CD001":
        return "Imagen de disco ISO"
    head = data[:512].lstrip().lower()
    if head.startswith((b"<!doctype html", b"<html", b"<svg", b"<?xml")) or b"<script" in head:
        return "HTML/SVG/XML"
    return None


def _extensions(filename: str) -> list:
    name = filename.lower().strip().rstrip(".")
    return [p for p in name.split(".")[1:] if p and len(p) <= 20]


def analyze_attachment(filename: str, content_type: str, data: bytes) -> dict:
    """Devuelve metadatos, hashes e indicadores de riesgo de un adjunto."""
    indicators = []

    def add(level, text):
        indicators.append({"nivel": level, "texto": text})

    filename = filename or "(sin nombre)"
    exts = _extensions(filename)
    ext = exts[-1] if exts else ""
    real = magic_type(data)
    if RTLO in filename:
        add("critico", "El nombre usa el carácter RTLO (U+202E) para invertir y ocultar la extensión real")
    if ext in EXECUTABLE_EXT:
        add("critico", f"Extensión ejecutable/peligrosa: .{ext}")
    elif ext in DISK_IMAGE_EXT:
        add("alto", f"Imagen de disco .{ext}: técnica para evadir Mark-of-the-Web y entregar malware")
    elif ext in MACRO_EXT:
        add("alto", f"Documento de Office con macros habilitadas (.{ext})")
    elif ext in HTML_EXT:
        add("alto", f"Adjunto .{ext}: usado para formularios falsos de inicio de sesión y HTML smuggling")
    elif ext in ARCHIVE_EXT:
        add("medio", f"Archivo comprimido .{ext}: puede ocultar ejecutables a los filtros")
    if len(exts) >= 2 and exts[-2] in DOC_EXT and ext in (EXECUTABLE_EXT | HTML_EXT | DISK_IMAGE_EXT | ARCHIVE_EXT):
        add("critico" if ext in EXECUTABLE_EXT else "alto",
            f"Doble extensión engañosa: '.{exts[-2]}.{ext}' aparenta ser .{exts[-2]}")
    if re.search(r"\s{5,}\.\w+$", filename):
        add("alto", "Muchos espacios antes de la extensión (oculta la extensión real)")
    if real == "Ejecutable de Windows (PE)" and ext not in ("exe", "dll", "scr", "sys", "ocx", "cpl", "com"):
        add("critico", f"El contenido real es un ejecutable de Windows aunque la extensión es .{ext or '(ninguna)'}")
    if real == "HTML/SVG/XML" and ext in DOC_EXT:
        add("alto", f"El contenido real es HTML/SVG aunque la extensión es .{ext}")
    if real == "Imagen de disco ISO" and ext not in DISK_IMAGE_EXT:
        add("alto", "El contenido real es una imagen de disco ISO")

    details = {}
    # ---- Office / ZIP ----
    if data.startswith(b"PK\x03\x04"):
        details.update(_inspect_zip(data, ext, add))
    # ---- OLE (Office antiguo) ----
    if data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        if b"_VBA_PROJECT" in data or b"V\x00B\x00A\x00" in data or b"Macros" in data:
            add("alto", "Documento Office 97-2003 con proyecto de macros VBA")
        if b"Equation" in data and b"Native" in data:
            add("alto", "Objeto 'Equation Editor' incrustado (exploit histórico CVE-2017-11882)")
    # ---- RTF ----
    if data[:5] == b"{\\rtf" and (b"\\objdata" in data or b"\\objupdate" in data):
        add("alto", "RTF con objetos OLE incrustados (vector frecuente de exploits)")
    # ---- PDF ----
    if data.startswith(b"%PDF"):
        details.update(_inspect_pdf(data, add))
    # ---- HTML / SVG ----
    if real == "HTML/SVG/XML" or ext in HTML_EXT:
        details.update(_inspect_html_attachment(data, add))

    result = {"nombre": filename, "tipo_declarado": content_type, "tipo_real": real,
              "tamano_bytes": len(data), "extension": ext or None, "indicadores": indicators}
    result.update(hashes(data))
    result.update(details)
    return result


def _inspect_zip(data: bytes, ext: str, add) -> dict:
    info = {}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = zf.infolist()
            names = [i.filename for i in infos]
            info["contenido_zip"] = names[:50]
            if any(i.flag_bits & 0x1 for i in infos):
                add("alto", "ZIP protegido con contraseña: impide el análisis de los filtros (táctica de evasión)")
            if any(n.lower().endswith("vbaproject.bin") for n in names):
                add("alto", "Documento Office con macros VBA (vbaProject.bin)")
            if any("oleobject" in n.lower() for n in names):
                add("medio", "Documento Office con objetos OLE incrustados")
            rels = [n for n in names if n.endswith(".rels")]
            for rel in rels[:20]:
                try:
                    text = zf.read(rel)[:200000].decode("utf-8", "ignore")
                except (KeyError, RuntimeError, zipfile.BadZipFile, NotImplementedError):
                    continue
                if re.search(r'TargetMode="External"', text) and re.search(r"attachedTemplate|oleObject|frame", text, re.I):
                    add("alto", "Plantilla u objeto remoto (template injection): descarga contenido al abrir")
                    break
            inner = [n for n in names if _extensions(n) and _extensions(n)[-1] in (EXECUTABLE_EXT | DISK_IMAGE_EXT | HTML_EXT)]
            if inner and ext in ARCHIVE_EXT | {""}:
                add("critico" if any(_extensions(n)[-1] in EXECUTABLE_EXT for n in inner) else "alto",
                    "El comprimido contiene archivos peligrosos: " + ", ".join(inner[:5]))
            nested = [n for n in names if _extensions(n) and _extensions(n)[-1] in ARCHIVE_EXT]
            if nested and ext in ARCHIVE_EXT:
                add("medio", "Comprimido anidado dentro de otro comprimido: " + ", ".join(nested[:3]))
    except (zipfile.BadZipFile, OSError, ValueError, RuntimeError):
        add("bajo", "Estructura ZIP dañada o no estándar (no se pudo inspeccionar)")
    return info


def _inspect_pdf(data: bytes, add) -> dict:
    sample = data[:5_000_000]
    keys = {
        b"/JavaScript": ("alto", "PDF con JavaScript"), b"/JS": ("alto", "PDF con JavaScript"),
        b"/OpenAction": ("medio", "PDF con acción automática al abrir (/OpenAction)"),
        b"/AA": ("medio", "PDF con acciones adicionales automáticas (/AA)"),
        b"/Launch": ("alto", "PDF que intenta ejecutar programas (/Launch)"),
        b"/EmbeddedFile": ("alto", "PDF con archivos incrustados"),
        b"/XFA": ("bajo", "PDF con formularios XFA"), b"/AcroForm": ("bajo", "PDF con formulario"),
    }
    seen = set()
    for key, (level, text) in keys.items():
        if re.search(re.escape(key) + rb"(?![A-Za-z])", sample) and text not in seen:
            seen.add(text)
            add(level, text)
    uris = sorted({u.decode("latin-1", "ignore") for u in re.findall(rb"/URI\s*\(([^)]{4,500})\)", sample)})
    if uris:
        add("medio", f"PDF con {len(uris)} enlace(s): revisar si es un señuelo que lleva a una web de phishing")
    if re.search(rb"/ObjStm", sample) and not uris:
        add("info", "PDF con objetos comprimidos: los enlaces internos pueden no ser visibles en análisis estático")
    return {"urls_pdf": uris[:50]}


def _inspect_html_attachment(data: bytes, add) -> dict:
    text = data[:3_000_000].decode("utf-8", "ignore")
    low = text.lower()
    if 'type="password"' in low or "type='password'" in low or "type=password" in low:
        add("critico", "El adjunto HTML contiene un campo de contraseña (formulario falso de inicio de sesión)")
    if re.search(r"atob\(|unescape\(|fromcharcode|eval\(|document\.write\(|window\.location|location\.href", low):
        add("alto", "JavaScript ofuscado o con redirección automática en el adjunto")
    if re.search(r"(?:msSaveOrOpenBlob|new\s+blob\(|createobjecturl)", low):
        add("alto", "Patrón de HTML smuggling (construye un archivo en el navegador)")
    if re.search(r"(?:telegram\.org/bot|api\.telegram\.org|discord(?:app)?\.com/api/webhooks)", low):
        add("critico", "Exfiltración de datos hacia bot de Telegram/Discord")
    if re.search(r"<form[^>]+action=[\"']?https?://", low):
        add("alto", "Formulario que envía datos a un servidor externo")
    return {"html_texto": text}

