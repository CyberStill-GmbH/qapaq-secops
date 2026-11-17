"""Configuración: dominios protegidos, nombres VIP y carpeta de reportes.

La configuración se lee (si existe) desde:
  - Windows: %APPDATA%\\Qapaq\\cintel\\config.json
  - Linux/macOS: ~/.config/qapaq-cintel/config.json
o desde la ruta indicada en la variable de entorno CINTEL_CONFIG.

Ejemplo de config.json:
{
  "dominios_protegidos": ["qapaq.pe"],
  "nombres_vip": ["Nombre Apellido del Presidente", "Gerente General"],
  "marcas": ["qapaq"],
  "carpeta_salida": "D:/Riesgos/Qapaq Phishing Contra-inteligencia"
}
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess  # nosec B404
import sys
from dataclasses import dataclass, field
from pathlib import Path

from cintel import __product__

REPORT_FOLDER_NAME = __product__  # "Qapaq Phishing Contra-inteligencia"

# Dominios propios de la organización: cualquier dominio parecido es sospechoso.
DEFAULT_PROTECTED_DOMAINS = ["qapaq.pe"]
# Marcas cuyo uso en nombres visibles, subdominios o rutas se vigila.
DEFAULT_BRANDS = ["qapaq"]


@dataclass
class Config:
    protected_domains: list = field(default_factory=lambda: list(DEFAULT_PROTECTED_DOMAINS))
    vip_names: list = field(default_factory=list)
    brands: list = field(default_factory=lambda: list(DEFAULT_BRANDS))
    output_dir: Path | None = None
    config_path: Path | None = None


def config_file_path() -> Path:
    env = os.environ.get("CINTEL_CONFIG")
    if env:
        return Path(env).expanduser()
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / "Qapaq" / "cintel" / "config.json"
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "qapaq-cintel" / "config.json"


def load_config() -> Config:
    cfg = Config()
    path = config_file_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            print(f"[aviso] No se pudo leer la configuración {path}: {exc}", file=sys.stderr)
            return cfg
        cfg.config_path = path
        # Se combinan los valores del archivo con los predeterminados.
        for dom in data.get("dominios_protegidos", []):
            dom = str(dom).lower().strip().rstrip(".")
            if dom and dom not in cfg.protected_domains:
                cfg.protected_domains.append(dom)
        cfg.vip_names = [str(n).strip() for n in data.get("nombres_vip", []) if str(n).strip()]
        for brand in data.get("marcas", []):
            brand = str(brand).lower().strip()
            if brand and brand not in cfg.brands:
                cfg.brands.append(brand)
        if data.get("carpeta_salida"):
            cfg.output_dir = Path(data["carpeta_salida"]).expanduser()
    # Las marcas incluyen siempre la etiqueta principal de cada dominio protegido.
    for dom in cfg.protected_domains:
        label = dom.split(".")[0]
        if len(label) >= 4 and label not in cfg.brands:
            cfg.brands.append(label)
    return cfg


def _windows_documents_dir() -> Path | None:
    """Carpeta Documentos real en Windows (respeta redirección a OneDrive)."""
    try:
        import ctypes
        from ctypes import wintypes

        # FOLDERID_Documents = {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                        ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

        folder_id = GUID(0xFDD39AD0, 0x238F, 0x46AF,
                         (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
        path_ptr = ctypes.c_wchar_p()
        result = ctypes.windll.shell32.SHGetKnownFolderPath(
            ctypes.byref(folder_id), 0, None, ctypes.byref(path_ptr))
        if result != 0:
            return None
        value = path_ptr.value
        ctypes.windll.ole32.CoTaskMemFree(path_ptr)
        return Path(value) if value else None
    except Exception:  # noqa: BLE001 - cualquier fallo vuelve al valor por defecto
        return None


def _linux_documents_dir() -> Path | None:
    tool = shutil.which("xdg-user-dir")
    if not tool:
        return None
    try:
        # Argumentos fijos y ejecutable resuelto con shutil.which; no se usa shell.
        result = subprocess.run([tool, "DOCUMENTS"], capture_output=True, text=True, timeout=3, check=False)  # nosec B603
        out = result.stdout.strip()
        if out and Path(out).is_dir() and Path(out) != Path.home():
            return Path(out)
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def default_output_root(cfg: Config | None = None) -> Path:
    """Carpeta raíz de reportes.

    Prioridad: variable CINTEL_SALIDA > config.json > Documentos/<nombre del producto>.
    """
    env = os.environ.get("CINTEL_SALIDA")
    if env:
        return Path(env).expanduser()
    if cfg and cfg.output_dir:
        return cfg.output_dir
    docs = _windows_documents_dir() if os.name == "nt" else _linux_documents_dir()
    if docs is None:
        candidate = Path.home() / "Documents"
        docs = candidate if candidate.is_dir() else Path.home()
    return docs / REPORT_FOLDER_NAME

