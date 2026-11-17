"""Unit tests for the QAPAQ Bitdefender / Snyk / Cloudflare collectors (no network)."""

from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "common"))


def load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COMMON = load("qapaq_collector_test", "common/qapaq_collector.py")
GZ = load("qapaq_gravityzone", "bitdefender/gravityzone.py")
SNYK = load("qapaq_snyk", "snyk/issues.py")
CF = load("qapaq_cloudflare", "cloudflare/security.py")


class Response(io.BytesIO):
    def __init__(self, payload: object, status: int = 200) -> None:
        super().__init__(json.dumps(payload).encode())
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class Recorder:
    """Fake urlopen: routes by (method, URL substring / JSON-RPC method)."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, request, timeout=0):
        self.requests.append(request)
        body = json.loads(request.data) if request.data else None
        for matcher, payload in self.routes:
            if matcher(request, body):
                return Response(payload() if callable(payload) else payload)
        raise AssertionError(f"unexpected request {request.full_url}")


class CommonTests(unittest.TestCase):
    def test_commit_batch_is_durable_and_recovers_complete_pending_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            output, state_path = base / "out.jsonl", base / "state.json"
            COMMON.commit_batch(output, state_path, {}, [{"a": 1}], {"cursor": "c1"})
            self.assertEqual(COMMON.read_state(state_path), {"cursor": "c1"})
            # Simulate a crash after append but before the final state commit.
            payload = COMMON.serialize_events([{"a": 2}])
            pending = {"offset": output.stat().st_size, "length": len(payload),
                       "sha256": __import__("hashlib").sha256(payload).hexdigest(), "next": {"cursor": "c2"}}
            COMMON.save_state(state_path, {"cursor": "c1", "pending": pending})
            COMMON.append_bytes(output, payload)
            state, recovered = COMMON.recover_pending(output, state_path, COMMON.read_state(state_path))
            self.assertTrue(recovered)
            self.assertEqual(state, {"cursor": "c2"})
            self.assertEqual(len(output.read_text().splitlines()), 2)

    def test_partial_append_is_truncated_and_cursor_kept(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            output, state_path = base / "out.jsonl", base / "state.json"
            output.write_bytes(b'{"ok":1}\n{"partial')
            pending = {"offset": 9, "length": 30, "sha256": "0" * 64, "next": {"cursor": "new"}}
            COMMON.save_state(state_path, {"cursor": "old", "pending": pending})
            state, recovered = COMMON.recover_pending(output, state_path, COMMON.read_state(state_path))
            self.assertFalse(recovered)
            self.assertEqual(state, {"cursor": "old"})
            self.assertEqual(output.read_bytes(), b'{"ok":1}\n')

    def test_run_collector_preserves_state_and_hides_details_on_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            config = base / "config.json"
            config.write_text(json.dumps({"output_file": str(base / "o.jsonl"), "state_file": str(base / "s.json")}))
            COMMON.save_state(base / "s.json", {"cursor": "keep"})

            def boom(_config, _state):
                raise COMMON.ProviderError("provider denied", 403)

            with patch("sys.stderr", new=io.StringIO()) as stderr:
                self.assertEqual(COMMON.run_collector("t", config, boom), 1)
            self.assertIn("HTTP 403", stderr.getvalue())
            self.assertEqual(COMMON.read_state(base / "s.json"), {"cursor": "keep"})
            self.assertFalse((base / "o.jsonl").exists())

    def test_read_secret_rejects_multiline(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "secret"
            path.write_text("a\nb")
            if hasattr(__import__("os"), "chmod"):
                path.chmod(0o600)
            with self.assertRaises(COMMON.ProviderError):
                COMMON.read_secret(path)


ENDPOINT = {"id": "ep1", "name": "PC1", "isManaged": True, "isIsolated": False}
DETAILS = {
    "id": "ep1", "name": "PC1", "operatingSystem": "Windows", "ip": "192.0.2.1",
    "malwareStatus": {"detection": False, "infected": False},
    "agent": {"signatureOutdated": False, "productOutdated": False},
    "policy": {"name": "Default", "applied": True},
    "modules": {"antimalware": True, "firewall": False, "advancedThreatControl": True},
}


def gz_routes(details: dict, quarantine: list):
    def rpc(method):
        return lambda request, body: bool(body) and body.get("method") == method
    return [
        (rpc("getEndpointsList"), {"result": {"items": [ENDPOINT], "pagesCount": 1}}),
        (rpc("getManagedEndpointDetails"), lambda: {"result": details}),
        (rpc("getQuarantineItemsList"), {"result": {"items": quarantine, "pagesCount": 1}}),
    ]


class GravityZoneTests(unittest.TestCase):
    def test_emits_status_on_first_run_then_only_on_change(self) -> None:
        details = json.loads(json.dumps(DETAILS))
        opener = Recorder(gz_routes(details, []))
        client = GZ.GravityZone(GZ.REGION_BASES["us"], "k", opener=opener, pause=0)
        events, state = GZ.collect({}, {}, client)
        self.assertEqual([e["qapaq"]["event_type"] for e in events], ["endpoint_status"])
        endpoint = events[0]["bitdefender"]["endpoint"]
        self.assertEqual((endpoint["change"], endpoint["antimalware_disabled"], endpoint["modules_disabled"]),
                         ("new", False, ["firewall"]))
        # Auth header is Basic base64("k:") and the key is not in the body.
        request = opener.requests[0]
        self.assertEqual(request.get_header("Authorization"), "Basic azo=")
        self.assertNotIn(b'"k"', request.data)
        events, state = GZ.collect({}, state, client)
        self.assertEqual(events, [])
        details["malwareStatus"]["infected"] = True
        events, _ = GZ.collect({}, state, client)
        self.assertEqual(events[0]["bitdefender"]["endpoint"]["change"], "changed")
        self.assertTrue(events[0]["bitdefender"]["endpoint"]["infected"])

    def test_quarantine_items_are_deduplicated(self) -> None:
        item = {"id": "q1", "threatName": "EICAR", "endpointId": "ep1", "quarantinedOn": "2099-01-01T00:00:00"}
        client = GZ.GravityZone(GZ.REGION_BASES["us"], "k", opener=Recorder(gz_routes(DETAILS, [item])), pause=0)
        events, state = GZ.collect({}, {}, client)
        self.assertEqual(sum(e["qapaq"]["event_type"] == "quarantine_item" for e in events), 1)
        events, _ = GZ.collect({}, state, client)
        self.assertEqual(sum(e["qapaq"]["event_type"] == "quarantine_item" for e in events), 0)

    def test_jsonrpc_error_and_denied_api_raise(self) -> None:
        client = GZ.GravityZone(GZ.REGION_BASES["us"], "k", opener=Recorder([
            (lambda r, b: True, {"error": {"code": -32000, "message": "API Key is not allowed"}}),
        ]), pause=0)
        with self.assertRaises(GZ.ProviderError):
            GZ.collect({}, {}, client)
        with self.assertRaises(GZ.ProviderError):
            GZ.GravityZone("https://evil.example.com/api", "k")


def snyk_issue(issue_id: str, updated: str, severity: str = "high") -> dict:
    return {
        "id": issue_id,
        "attributes": {
            "title": "t", "status": "open", "effective_severity_level": severity, "ignored": False,
            "updated_at": updated, "created_at": updated,
            "exploit_details": {"maturity_levels": [{"level": "Proof of Concept"}, {"level": "Mature"}]},
            "coordinates": [{"is_upgradeable": True, "representations": [{"dependency": {"package_name": "lodash", "package_version": "4"}}]}],
            "problems": [{"id": "CVE-2026-0001"}],
        },
        "relationships": {"scan_item": {"data": {"id": "p1"}}},
    }


class SnykTests(unittest.TestCase):
    ORG = "00000000-0000-4000-8000-000000000001"

    def make(self, pages):
        pages = list(pages)

        def issues():
            return pages.pop(0) if pages else {"data": [], "links": {}}

        return Recorder([
            (lambda r, b: "/projects" in r.full_url, {"data": [{"id": "p1", "attributes": {"name": "repo:package.json"}}]}),
            (lambda r, b: "/issues" in r.full_url, issues),
        ])

    def test_paginates_dedupes_and_advances_cursor(self) -> None:
        now = COMMON.utc_now()
        t1, t2, t3 = (COMMON.iso(now - timedelta(minutes=m)) for m in (120, 60, 30))
        first = {"data": [snyk_issue("i1", t1)], "links": {"next": f"/rest/orgs/{self.ORG}/issues?page=2"}}
        second = {"data": [snyk_issue("i2", t2, "critical")], "links": {}}
        opener = self.make([first, second])
        client = SNYK.Snyk("https://api.snyk.io", "tok", opener=opener)
        events, state = SNYK.collect({"org_id": self.ORG}, {}, client)
        self.assertEqual([e["snyk"]["issue"]["id"] for e in events], ["i1", "i2"])
        self.assertEqual(events[1]["snyk"]["issue"]["exploit_maturity"], "Mature")
        self.assertEqual(events[0]["snyk"]["project"]["name"], "repo:package.json")
        self.assertEqual(state["cursors"][self.ORG], t2)
        self.assertEqual(opener.requests[0].get_header("Authorization"), "token tok")
        self.assertIn("updated_after=", opener.requests[1].full_url)
        # Same (id, updated_at) again → no duplicate; an update → new event.
        opener2 = self.make([{"data": [snyk_issue("i2", t2), snyk_issue("i1", t3)], "links": {}}])
        events, _ = SNYK.collect({"org_id": self.ORG}, state, SNYK.Snyk("https://api.snyk.io", "tok", opener=opener2))
        self.assertEqual([(e["snyk"]["issue"]["id"], e["snyk"]["issue"]["updated_at"]) for e in events], [("i1", t3)])

    def test_rejects_foreign_pagination_and_non_snyk_api(self) -> None:
        with self.assertRaises(SNYK.ProviderError):
            SNYK.Snyk("https://snyk.evil.example", "t")
        client = SNYK.Snyk("https://api.snyk.io", "t", opener=self.make([]))
        with self.assertRaises(SNYK.ProviderError):
            client.get("https://evil.example/rest/x")


class CloudflareTests(unittest.TestCase):
    def test_audit_and_firewall_with_dedupe(self) -> None:
        when = COMMON.iso(COMMON.utc_now() - timedelta(minutes=30))
        audit = [{"id": "a1", "when": when, "action": {"type": "delete", "result": True},
                  "actor": {"email": "x@example.test", "ip": "198.51.100.1"}, "resource": {"type": "waf.ruleset"}}]
        firewall = [{"datetime": when, "action": "block", "clientIP": "203.0.113.1", "rayName": "r1"}]
        opener = Recorder([
            (lambda r, b: "/accounts?" in r.full_url, {"success": True, "result": [{"id": "acc1"}]}),
            (lambda r, b: "/audit_logs" in r.full_url, {"success": True, "result": audit}),
            (lambda r, b: "/zones?" in r.full_url, {"success": True, "result": [{"id": "z1", "name": "example.test"}]}),
            (lambda r, b: r.full_url.endswith("/graphql"),
             {"data": {"viewer": {"zones": [{"firewallEventsAdaptive": firewall}]}}}),
        ])
        client = CF.Cloudflare("tok", opener=opener)
        events, state = CF.collect({"initial_lookback_hours": 2}, {}, client)
        kinds = sorted(e["qapaq"]["event_type"] for e in events)
        self.assertEqual(kinds, ["audit", "firewall"])  # same record in 2 windows is deduped
        self.assertEqual(state["audit_cursors"]["acc1"], when)
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer tok")
        events, _ = CF.collect({"initial_lookback_hours": 2}, state, client)
        self.assertEqual(events, [])

    def test_graphql_errors_do_not_advance(self) -> None:
        opener = Recorder([
            (lambda r, b: "/zones?" in r.full_url, {"success": True, "result": [{"id": "z1", "name": "z"}]}),
            (lambda r, b: r.full_url.endswith("/graphql"), {"errors": [{"message": "denied"}], "data": None}),
        ])
        with self.assertRaises(CF.ProviderError):
            CF.collect({"audit": False}, {}, CF.Cloudflare("t", opener=opener))


if __name__ == "__main__":
    unittest.main()
