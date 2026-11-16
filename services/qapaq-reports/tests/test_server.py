import json
import threading
import urllib.error
import urllib.request

import pytest

from app import server

TOKEN = "t" * 32


@pytest.fixture(scope="module")
def base_url():
    srv = server.make_server("127.0.0.1", 0, TOKEN)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def call(url, body=None, token=TOKEN, ctype="application/json", method=None, headers=None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"))
    if ctype:
        req.add_header("Content-Type", ctype)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_healthz_needs_no_token(base_url):
    status, _, body = call(base_url + "/healthz", token=None)
    assert status == 200 and json.loads(body) == {"status": "ok"}


@pytest.mark.parametrize("token", [None, "", "mal-token", TOKEN + "x"])
def test_render_requires_valid_token(base_url, sample, token):
    status, _, body = call(base_url + "/render", sample, token=token)
    assert status == 401 and json.loads(body)["code"] == "UNAUTHORIZED"


def test_invalid_spec_returns_400_with_path(base_url, sample):
    sample["sections"][4]["rows"][2]["score"] = "alto"
    status, _, body = call(base_url + "/render", sample)
    assert status == 400
    assert json.loads(body) == {"code": "SPEC_INVALID", "path": "sections[4].rows[2].score"}


def test_malformed_json_returns_400(base_url):
    status, _, body = call(base_url + "/render", b"{no es json")
    assert status == 400 and json.loads(body)["code"] == "SPEC_INVALID"


def test_body_limit_returns_413_without_reading(base_url):
    import http.client
    host, port = base_url.replace("http://", "").split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=10)
    conn.putrequest("POST", "/render")
    conn.putheader("Authorization", f"Bearer {TOKEN}")
    conn.putheader("Content-Type", "application/json")
    conn.putheader("Content-Length", str(20 * 1024 * 1024 + 1))
    conn.endheaders()
    resp = conn.getresponse()
    assert resp.status == 413
    assert json.loads(resp.read())["code"] == "PAYLOAD_TOO_LARGE"
    conn.close()


@pytest.mark.parametrize("fmt,prefix,ctype", [
    ("csv", b"\xef\xbb\xbf", "text/csv"),
    ("xlsx", b"PK", "spreadsheetml.sheet"),
    ("pdf", b"%PDF", "application/pdf"),
])
def test_render_each_format(base_url, sample, fmt, prefix, ctype):
    status, headers, body = call(base_url + "/render", dict(sample, format=fmt))
    assert status == 200, body[:200]
    assert body.startswith(prefix)
    assert ctype in headers["Content-Type"]
    if fmt == "pdf":
        assert int(headers["X-Qapaq-Report-Pages"]) > 1


def test_unknown_route(base_url):
    assert call(base_url + "/nada", token=None)[0] == 404


def test_render_timeout_returns_422(sample, monkeypatch):
    from app import runner, spec as spec_mod
    monkeypatch.setattr(runner, "_worker", _sleepy)
    assert runner.run_render(spec_mod.validate(dict(sample, format="csv")), timeout=1) is None


def _sleepy(spec, conn):  # pragma: no cover
    import time
    time.sleep(30)


def test_refuses_to_start_without_token(monkeypatch):
    monkeypatch.delenv("QAPAQ_REPORTS_TOKEN", raising=False)
    monkeypatch.delenv("QAPAQ_REPORTS_INSECURE_DEV", raising=False)
    assert server.main() == 2
