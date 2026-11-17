"""Lectura de códigos QR en imágenes (quishing). Requiere el extra opcional [qr].

Si OpenCV no está instalado, la función devuelve una lista vacía y el
reporte indica que la lectura de QR no estuvo disponible.
"""
from __future__ import annotations

try:  # Dependencia opcional
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    QR_AVAILABLE = True
except Exception:  # noqa: BLE001
    QR_AVAILABLE = False

IMAGE_TYPES = ("image/png", "image/jpeg", "image/jpg", "image/gif", "image/bmp", "image/webp")


def decode_qr(data: bytes) -> list:
    """Devuelve los textos de todos los QR encontrados en la imagen."""
    if not QR_AVAILABLE or not data:
        return []
    try:
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return []
        detector = cv2.QRCodeDetector()
        ok, texts, _, _ = detector.detectAndDecodeMulti(image)
        results = [t for t in (texts or []) if t] if ok else []
        if not results:
            text, _, _ = detector.detectAndDecode(image)
            if text:
                results = [text]
        return results
    except Exception:  # noqa: BLE001 - imagen corrupta o formato no soportado
        return []

