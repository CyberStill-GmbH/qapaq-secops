"""Ejecucion aislada del render: proceso hijo (forkserver) con plazo duro.

Si WeasyPrint se cuelga o se excede, se mata el hijo sin afectar al servidor.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import threading

RENDER_TIMEOUT = float(os.environ.get("QAPAQ_REPORTS_RENDER_TIMEOUT", "60"))
MAX_CONCURRENT = int(os.environ.get("QAPAQ_REPORTS_MAX_CONCURRENT", "2"))

_ctx = mp.get_context("forkserver")
_ctx.set_forkserver_preload(["app.renderers"])
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


def _worker(spec, conn) -> None:  # pragma: no cover - corre en el hijo
    try:
        from .renderers import render
        conn.send(("ok", render(spec)))
    except BaseException:  # noqa: BLE001 - el padre responde RENDER_FAILED sin detalles
        conn.send(("error", None))
    finally:
        conn.close()


def run_render(spec, timeout: float = RENDER_TIMEOUT):
    """Devuelve (content_type, bytes, pages), None si falla/expira, o "busy"."""
    if not _slots.acquire(timeout=5):
        return "busy"
    try:
        parent, child = _ctx.Pipe(duplex=False)
        proc = _ctx.Process(target=_worker, args=(spec, child), daemon=True)
        proc.start()
        child.close()
        try:
            if parent.poll(timeout):
                status, payload = parent.recv()
                return payload if status == "ok" else None
            return None
        except (EOFError, OSError):
            return None
        finally:
            if proc.is_alive():
                proc.kill()
            proc.join(5)
            parent.close()
    finally:
        _slots.release()
