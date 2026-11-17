"""Servidor HTTP de informes QAPAQ.

Se usa `http.server.ThreadingHTTPServer` de la libreria estandar: la superficie son dos rutas,
el trafico es interno y de baja concurrencia, y asi la imagen no suma framework ni ASGI.
Cada render corre en un proceso hijo (forkserver) con plazo duro: si WeasyPrint se cuelga o
consume demasiado, se mata el proceso sin afectar al servidor.
Nunca se registra el contenido de los informes (solo metodo, ruta, estado y duracion).
"""
from __future__ import annotations

import hmac
import json
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .runner import run_render
from .spec import SpecError, validate

MAX_BODY = 20 * 1024 * 1024
MIN_TOKEN_LEN = 16


class Handler(BaseHTTPRequestHandler):
    server_version = "qapaq-reports"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30  # anti slowloris

    # --- utilidades ---------------------------------------------------
    def log_message(self, fmt, *args):  # noqa: D401 - sin cuerpos ni cabeceras
        pass

    def _log(self, status: int, started: float) -> None:
        sys.stdout.write(f"{self.command} {self.path.split('?')[0]} {status} {int((time.time() - started) * 1000)}ms\n")
        sys.stdout.flush()

    def _send(self, status: int, body: bytes, content_type: str, started: float, extra: dict | None = None,
              close: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self._log(status, started)

    def _json(self, status: int, obj: dict, started: float, close: bool = False) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json", started, close=close)

    def _authorized(self) -> bool:
        token: str = self.server.token  # type: ignore[attr-defined]
        if self.server.insecure_dev:  # type: ignore[attr-defined]
            return True
        header = self.headers.get("Authorization", "")
        scheme, _, supplied = header.partition(" ")
        if scheme.lower() != "bearer" or not supplied:
            return False
        return hmac.compare_digest(supplied.strip().encode(), token.encode())

    # --- rutas --------------------------------------------------------
    def do_GET(self):  # noqa: N802
        started = time.time()
        if self.path.split("?")[0] == "/healthz":
            return self._json(200, {"status": "ok"}, started)
        self._json(404, {"code": "NOT_FOUND"}, started)

    def do_POST(self):  # noqa: N802
        started = time.time()
        if self.path.split("?")[0] != "/render":
            return self._json(404, {"code": "NOT_FOUND"}, started, close=True)
        if not self._authorized():
            return self._json(401, {"code": "UNAUTHORIZED"}, started, close=True)
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            return self._json(411, {"code": "LENGTH_REQUIRED"}, started, close=True)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._json(411, {"code": "LENGTH_REQUIRED"}, started, close=True)
        if length < 0:
            return self._json(400, {"code": "SPEC_INVALID", "path": "$"}, started, close=True)
        if length > MAX_BODY:
            return self._json(413, {"code": "PAYLOAD_TOO_LARGE"}, started, close=True)
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._json(400, {"code": "SPEC_INVALID", "path": "content-type"}, started, close=True)
        raw = self.rfile.read(length)
        try:
            spec = validate(json.loads(raw))
        except SpecError as exc:
            return self._json(400, {"code": "SPEC_INVALID", "path": exc.path}, started)
        except (ValueError, RecursionError):  # JSON mal formado / demasiado anidado
            return self._json(400, {"code": "SPEC_INVALID", "path": "$"}, started)
        finally:
            del raw
        result = run_render(spec)
        if result == "busy":
            return self._send(503, b'{"code":"BUSY"}', "application/json", started, {"Retry-After": "5"})
        if result is None:
            return self._json(422, {"code": "RENDER_FAILED"}, started)
        content_type, data, pages = result
        extra = {"X-Qapaq-Report-Pages": str(pages)} if pages else None
        self._send(200, data, content_type, started, extra)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, addr, token: str, insecure_dev: bool):
        super().__init__(addr, Handler)
        self.token = token
        self.insecure_dev = insecure_dev


def make_server(host: str, port: int, token: str, insecure_dev: bool = False) -> Server:
    return Server((host, port), token, insecure_dev)


def main() -> int:
    token = os.environ.get("QAPAQ_REPORTS_TOKEN", "")
    insecure = os.environ.get("QAPAQ_REPORTS_INSECURE_DEV") == "1"
    if not insecure and len(token) < MIN_TOKEN_LEN:
        sys.stderr.write("QAPAQ_REPORTS_TOKEN es obligatorio (>= 16 caracteres). "
                         "Solo para desarrollo: QAPAQ_REPORTS_INSECURE_DEV=1.\n")
        return 2
    host = os.environ.get("QAPAQ_REPORTS_BIND", "0.0.0.0")
    port = int(os.environ.get("QAPAQ_REPORTS_PORT", "8090"))
    srv = make_server(host, port, token, insecure)
    sys.stdout.write(f"qapaq-reports escuchando en {host}:{port}{' (INSEGURO: sin token)' if insecure else ''}\n")
    sys.stdout.flush()
    def _stop(*_a):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _stop)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
