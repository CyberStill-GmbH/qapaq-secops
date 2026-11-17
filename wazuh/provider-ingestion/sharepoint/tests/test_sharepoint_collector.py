"""Pruebas del collector QAPAQ SharePoint/OneDrive sin red (python -m unittest)."""

from __future__ import annotations

import base64
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG.parent / "common"))


def load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


SP = load("qapaq_sharepoint", PKG / "sharepoint.py")
MG = load("qapaq_m365_graph", PKG / "m365_graph.py")
COMMON = load("qapaq_collector_sp", PKG.parent / "common" / "qapaq_collector.py")
NOW = datetime(2026, 11, 9, 15, 0, tzinfo=timezone.utc)


def token(roles: list[str]) -> str:
    claims = base64.urlsafe_b64encode(json.dumps({"roles": roles}).encode()).decode().rstrip("=")
    return f"h.{claims}.s"


class FakeTokens:
    def __init__(self, graph_roles, manage_roles=()):
        self.map = {SP.GRAPH_SCOPE: list(graph_roles), SP.MANAGE_SCOPE: list(manage_roles)}

    def roles(self, scope):
        return 200, sorted(self.map[scope])

    def get(self, scope):
        return token(self.map[scope])


class FakeGraph(MG.Graph):
    """Rutea por (método, fragmento de URL) y registra las llamadas."""

    def __init__(self, tokens, routes):
        super().__init__(tokens, sleep=lambda _s: None)
        self.routes, self.calls = routes, []

    def call(self, method, url, body=None, scope=MG.GRAPH_SCOPE, headers=None, ok=(200,)):
        self.calls.append((method, url, body))
        for (m, fragment), response in self.routes.items():
            if m == method and fragment in url:
                status, payload = response(url, body) if callable(response) else response
                if status not in ok:
                    raise SP.ProviderError("rejected", status)
                return status, payload
        raise AssertionError(f"ruta no esperada {method} {url}")


def record(i: int, op="FileDownloaded", user="ana@qapaq-lab.example", ip="198.51.100.20", created="2026-11-09T14:00:00Z"):
    return {"id": f"rec-{i}", "createdDateTime": created, "auditLogRecordType": "SharePointFileOperation", "operation": op,
            "userPrincipalName": user, "clientIp": ip, "objectId": f"https://x.example/f{i}", "service": "SharePoint",
            "auditData": {"Id": f"rec-{i}", "Operation": op, "UserId": user, "ClientIP": ip, "CreationTime": created[:-1],
                          "Workload": "SharePoint", "ObjectId": f"https://x.example/f{i}"}}


class CapabilityTests(unittest.TestCase):
    def test_blocked_without_permissions_emits_capability_once(self):
        graph = FakeGraph(FakeTokens(["User.Read.All"]), {})
        events, state = SP.collect_audit({"credentials_dir": "-"}, {}, graph, NOW)
        self.assertEqual(state["audit_path"], "blocked")
        kinds = {e["qapaq"]["capability"]["feature"]: e["qapaq"]["capability"] for e in events}
        self.assertEqual(kinds["audit_graph_sharepoint"]["status"], "blocked")
        self.assertEqual(kinds["audit_graph_sharepoint"]["missing"], "AuditLogsQuery-SharePoint.Read.All")
        self.assertEqual(kinds["users"]["status"], "enabled")
        self.assertEqual(graph.calls, [])
        again, _ = SP.collect_audit({"credentials_dir": "-"}, state, graph, NOW + timedelta(minutes=10))
        self.assertEqual(again, [])  # sin cambios ni recordatorio de 24 h

    def test_revoked_permission_is_flagged_as_changed(self):
        state = {"capabilities": {"audit_graph_sharepoint": "enabled"}, "capabilities_emitted_at": SP.iso(NOW)}
        graph = FakeGraph(FakeTokens([]), {})
        events, _ = SP.collect_audit({"credentials_dir": "-"}, state, graph, NOW)
        changed = [e["qapaq"]["capability"] for e in events if e["qapaq"]["capability"]["feature"] == "audit_graph_sharepoint"]
        self.assertEqual(changed[0]["changed"], "true")
        self.assertEqual(changed[0]["previous"], "enabled")

    def test_native_path_does_not_duplicate_the_office365_module(self):
        graph = FakeGraph(FakeTokens(["AuditLogsQuery.Read.All"], ["ActivityFeed.Read"]), {})
        _events, state = SP.collect_audit({"credentials_dir": "-"}, {}, graph, NOW)
        self.assertEqual(state["audit_path"], "native")
        self.assertEqual(graph.calls, [])


class AuditGraphTests(unittest.TestCase):
    roles = ["AuditLogsQuery-SharePoint.Read.All", "AuditLogsQuery-OneDrive.Read.All", "User.Read.All"]

    def test_query_lifecycle_paging_dedupe_and_cursor(self):
        created = {}

        def create(_url, body):
            created.update(body)
            return 201, {"id": "q1", "status": "notStarted"}

        pages = {
            "records?$top": (200, {"value": [record(1), record(2)], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page"}),
            "next-page": (200, {"value": [record(2), record(3, user="Ex@QAPAQ-lab.example")]}),
        }
        routes = {("POST", "/security/auditLog/queries"): create,
                  ("GET", "/security/auditLog/queries/q1/records"): lambda url, _b: pages["records?$top"],
                  ("GET", "next-page"): pages["next-page"],
                  ("GET", "/users?"): (200, {"value": [{"userPrincipalName": "ex@qapaq-lab.example"}]})}
        status = {"value": "running"}
        routes[("GET", "/security/auditLog/queries/q1")] = lambda url, _b: (200, {"status": status["value"]})
        graph = FakeGraph(FakeTokens(self.roles), routes)
        config = {"credentials_dir": "-", "initial_lookback_hours": 24}
        events, state = SP.collect_audit(config, {}, graph, NOW)
        self.assertEqual(state["query"]["id"], "q1")
        self.assertEqual(created["recordTypeFilters"], SP.SHAREPOINT_TYPES + SP.ONEDRIVE_TYPES)
        self.assertEqual(created["filterEndDateTime"], SP.iso(NOW - timedelta(minutes=30)))
        # Todavía corriendo: no avanza.
        events, state = SP.collect_audit(config, state, graph, NOW + timedelta(minutes=10))
        self.assertEqual([e for e in events if e["qapaq"]["event_type"] == "audit"], [])
        status["value"] = "succeeded"
        events, state = SP.collect_audit(config, state, graph, NOW + timedelta(minutes=20))
        audits = [e for e in events if e["qapaq"]["event_type"] == "audit"]
        self.assertEqual([e["office365"]["Id"] for e in audits], ["rec-1", "rec-2", "rec-3"])
        first = audits[0]
        self.assertEqual(first["integration"], "office365")
        self.assertEqual(first["office365"]["RecordType"], 6)
        self.assertEqual(first["office365"]["Subscription"], "Audit.SharePoint")
        self.assertEqual(first["qapaq"]["after_hours"], "false")  # 09:00 en Lima
        self.assertEqual(audits[2]["qapaq"]["user_disabled"], "true")
        self.assertNotIn("query", state)
        self.assertEqual(state["cursor"], SP.iso(NOW - timedelta(minutes=30)))
        # Siguiente ventana con solape: los ids vistos no se repiten.
        self.assertIn("rec-1", state["seen"])

    def test_budget_resumes_paging_next_run(self):
        routes = {("GET", "/security/auditLog/queries/q1/records"): (200, {"value": [record(1)], "@odata.nextLink": "https://graph.microsoft.com/v1.0/p2"}),
                  ("GET", "/security/auditLog/queries/q1"): (200, {"status": "succeeded"}),
                  ("GET", "/users?"): (200, {"value": []})}
        graph = FakeGraph(FakeTokens(self.roles), routes)
        state = {"query": {"id": "q1", "start": "2026-11-08T00:00:00Z", "end": "2026-11-09T00:00:00Z", "created": SP.iso(NOW)}}
        events, state = SP.collect_audit({"credentials_dir": "-", "max_records_per_run": 1}, state, graph, NOW)
        self.assertEqual(state["query"]["next"], "https://graph.microsoft.com/v1.0/p2")
        self.assertNotIn("cursor", state)

    def test_failed_query_is_recreated_and_400_retries_core_types(self):
        bodies = []

        def create(_url, body):
            bodies.append(list(body["recordTypeFilters"]))
            return (400, None) if len(bodies) == 1 else (201, {"id": "q2"})

        graph = FakeGraph(FakeTokens(["AuditLogsQuery.Read.All"]), {
            ("GET", "/security/auditLog/queries/q1"): (200, {"status": "failed"}),
            ("POST", "/security/auditLog/queries"): create})
        state = {"query": {"id": "q1", "start": "a", "end": "b", "created": SP.iso(NOW)}, "cursor": SP.iso(NOW - timedelta(hours=2))}
        _e, state = SP.collect_audit({"credentials_dir": "-"}, state, graph, NOW)
        self.assertEqual(state["failed_queries"], 1)
        _e, state = SP.collect_audit({"credentials_dir": "-"}, state, graph, NOW)
        self.assertIn("ComplianceDLPSharePoint", bodies[0])
        self.assertEqual(bodies[1], SP.SHAREPOINT_TYPES + SP.ONEDRIVE_TYPES)
        self.assertEqual(state["query"]["id"], "q2")


class EnricherTests(unittest.TestCase):
    def test_after_hours_lima_and_weekend(self):
        enricher = SP.Enricher({}, {}, set())
        self.assertTrue(enricher.after_hours(datetime(2026, 11, 9, 2, 0, tzinfo=timezone.utc)))   # 21:00 Lima
        self.assertFalse(enricher.after_hours(datetime(2026, 11, 9, 15, 0, tzinfo=timezone.utc)))  # 10:00 Lima
        self.assertTrue(enricher.after_hours(datetime(2026, 11, 8, 15, 0, tzinfo=timezone.utc)))   # domingo

    def test_new_network_only_after_warmup(self):
        enricher = SP.Enricher({"baseline_warmup_days": 7}, {}, set())
        day0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
        self.assertFalse(enricher.first_seen("a@x", "198.51.100.10", day0))
        self.assertFalse(enricher.first_seen("a@x", "203.0.113.5", day0 + timedelta(days=1)))  # calentamiento
        self.assertFalse(enricher.first_seen("a@x", "198.51.100.99", day0 + timedelta(days=8)))  # misma /24
        self.assertTrue(enricher.first_seen("a@x", "192.0.2.7", day0 + timedelta(days=8)))
        self.assertFalse(enricher.first_seen("a@x", "10.0.0.1", day0 + timedelta(days=8)))  # privada: sin señal


class PostureTests(unittest.TestCase):
    roles = ["SharePointTenantSettings.Read.All", "Sites.Read.All"]

    def routes(self, sharing="existingExternalUserSharingOnly"):
        settings = {"sharingCapability": sharing, "isResharingByExternalUsersEnabled": False,
                    "sharingDomainRestrictionMode": "none", "tenantDefaultTimezone": "SA Pacific"}
        sites = {"value": [
            {"id": "s-old", "webUrl": "https://t.example/sites/old", "displayName": "Old", "createdDateTime": "2025-01-01T00:00:00Z"},
            {"id": "s-new", "webUrl": "https://t.example/sites/new", "displayName": "New", "createdDateTime": "2026-11-08T00:00:00Z"},
            {"id": "s-me", "webUrl": "https://t-my.example/personal/x", "createdDateTime": "2026-11-08T00:00:00Z", "isPersonalSite": True},
        ]}
        children = {"value": [{"id": "i1", "name": "plan.xlsx", "webUrl": "https://t.example/sites/new/plan.xlsx", "shared": {"scope": "anonymous"}},
                              {"id": "i2", "name": "privado.docx", "webUrl": "https://t.example/x"}]}
        perms = {"value": [{"id": "p1", "roles": ["write"], "link": {"scope": "anonymous", "type": "edit"}},
                           {"id": "p2", "roles": ["read"], "grantedToV2": {"user": {"email": "amigo@gmail.com", "displayName": "A"}}},
                           {"id": "p3", "roles": ["read"], "grantedToV2": {"user": {"email": "colega@qapaq-lab.example"}}}]}
        return {("GET", "/admin/sharepoint/settings"): (200, settings),
                ("GET", "/sites/getAllSites"): (200, sites),
                ("GET", "/organization"): (200, {"value": [{"verifiedDomains": [{"name": "qapaq-lab.example"}]}]}),
                ("GET", "/drives?"): (200, {"value": [{"id": "d1", "name": "Documentos"}]}),
                ("GET", "/root/children"): (200, children),
                ("GET", "/permissions"): (200, perms)}

    def test_first_run_snapshot_findings_and_recent_site(self):
        graph = FakeGraph(FakeTokens(self.roles), self.routes())
        events, state = SP.collect_posture({"credentials_dir": "-"}, {}, graph, NOW)
        types = [e["qapaq"]["event_type"] for e in events]
        self.assertIn("tenant_settings_snapshot", types)
        self.assertEqual(types.count("site_created"), 2)  # solo los recientes en la primera vuelta
        findings = [e["sharepoint"] for e in events if e["qapaq"]["event_type"] == "sharing_finding"]
        kinds = sorted(f["finding"]["kind"] for f in findings)
        self.assertEqual(kinds, ["anonymous_link", "anonymous_link", "external_permission", "external_permission"])
        self.assertIn("recent_site_external_sharing", types)
        # Solo pidió permisos del ítem compartido.
        self.assertEqual(sum(1 for c in graph.calls if "/permissions" in c[1]), 2)
        again, _ = SP.collect_posture({"credentials_dir": "-"}, state, graph, NOW + timedelta(hours=1))
        self.assertEqual([e for e in again if e["qapaq"]["event_type"] in ("sharing_finding", "site_created")], [])

    def test_tenant_weakening_is_classified(self):
        graph = FakeGraph(FakeTokens(self.roles), self.routes())
        _e, state = SP.collect_posture({"credentials_dir": "-", "sites": False}, {}, graph, NOW)
        graph = FakeGraph(FakeTokens(self.roles), self.routes("externalUserAndGuestSharing"))
        events, _ = SP.collect_posture({"credentials_dir": "-", "sites": False}, state, graph, NOW + timedelta(hours=1))
        changes = [e["sharepoint"]["change"] for e in events if e["qapaq"]["event_type"] == "tenant_setting_changed"]
        self.assertEqual(changes, [{"setting": "sharingCapability", "old": "existingExternalUserSharingOnly",
                                    "new": "externalUserAndGuestSharing", "direction": "weakened"}])

    def test_compare_directions(self):
        self.assertEqual(SP.compare("sharingDomainRestrictionMode", "allowList", "none"), "weakened")
        self.assertEqual(SP.compare("isRequireAcceptingUserToMatchInvitedUserEnabled", True, False), "weakened")
        self.assertEqual(SP.compare("sharingBlockedDomainList", ["a.example"], []), "weakened")
        self.assertEqual(SP.compare("sharingCapability", "externalUserSharingOnly", "disabled"), "strengthened")


class DriverTests(unittest.TestCase):
    def test_run_collector_writes_jsonl_and_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            out, st, cfg = (pathlib.Path(tmp) / n for n in ("o.jsonl", "s.json", "c.json"))
            cfg.write_text(json.dumps({"output_file": str(out), "state_file": str(st), "credentials_dir": "-"}))
            graph = FakeGraph(FakeTokens([]), {})
            code = SP.run_collector("t", cfg, lambda c, s: SP.collect_audit(c, s, graph, NOW))
            self.assertEqual(code, 0)
            lines = out.read_text().splitlines()
            self.assertTrue(lines and all(json.loads(x)["qapaq"]["event_type"] == "capability" for x in lines))
            self.assertEqual(json.loads(st.read_text())["audit_path"], "blocked")

    def test_safe_path_hides_ids(self):
        self.assertEqual(MG.safe_path("https://graph.microsoft.com/v1.0/security/auditLog/queries/0f9a8b7c-1111-2222-3333-444455556666/records"),
                         "/v1.0/security/auditLog/queries/{id}/records")


if __name__ == "__main__":
    unittest.main()
