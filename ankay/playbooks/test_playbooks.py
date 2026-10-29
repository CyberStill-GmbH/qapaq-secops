"""Pruebas del generador de workflows y del importador idempotente de Ankay."""

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_workflows  # noqa: E402
import import_playbooks  # noqa: E402

SECRETS = {
    "ANKAY_WAZUH_WEBHOOK_TOKEN": "w" * 40,
    "ANKAY_DISPATCH_WEBHOOK_TOKEN": "d" * 40,
    "ANKAY_DISPATCH_HMAC_KEY": "h" * 48,
}


class GeneratorTests(unittest.TestCase):
    def test_dist_is_current(self):
        files = build_workflows.build(build_workflows.ROOT)
        for name, content in files.items():
            self.assertEqual((build_workflows.DIST / name).read_text(encoding="utf-8"), content, name)

    def test_every_catalog_playbook_is_generated_and_guarded(self):
        files = build_workflows.build(build_workflows.ROOT)
        catalog = json.loads(files["ankay-catalog.json"])
        self.assertIn("docs/security/ankay-playbooks/catalog.yaml", catalog["sources"])
        for pid, spec in catalog["playbooks"].items():
            workflow = json.loads(files[f"workflows/{pid}.json"])
            names = [action["name"] for action in workflow["actions"]]
            self.assertEqual(names[0], "verify_governed_dispatch", pid)
            if spec["effects"] in build_workflows.READ_ONLY_EFFECTS:
                self.assertEqual(names, ["verify_governed_dispatch", "prepare_read_only_triage"], pid)
            else:
                self.assertEqual(names, ["verify_governed_dispatch", "hold_for_outbox"], pid)
            self.assertTrue(all(a["app_name"] == "QAPAQ Ankay" for a in workflow["actions"]))
            self.assertEqual(workflow["triggers"][0]["trigger_type"], "WEBHOOK")
        intake = json.loads(files["workflows/wazuh.alert-intake.json"])
        self.assertEqual([a["name"] for a in intake["actions"]], ["triage_wazuh_alert"])

    def test_extra_catalogs_are_loaded_and_effects_need_sod(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "docs/security/ankay-playbooks"
            target.mkdir(parents=True)
            (target / "finance-catalog.yaml").write_text(
                "schemaVersion: 1\ncatalogId: qapaq-ankay-finance\nplaybooks:\n"
                "  - id: finance.bec-triage\n    version: '1.0.0'\n    sources: [wazuh-m365]\n"
                "    actions: [correlate]\n    approval: none-for-read-only\n    effects: none\n",
                encoding="utf-8",
            )
            files = build_workflows.build(root)
            self.assertIn("workflows/finance.bec-triage.json", files)
            (target / "bad-catalog.yaml").write_text(
                "schemaVersion: 1\ncatalogId: bad\nplaybooks:\n"
                "  - id: finance.freeze\n    version: '1.0.0'\n    approval: none\n    effects: account-freeze\n",
                encoding="utf-8",
            )
            with self.assertRaises(build_workflows.CatalogError):
                build_workflows.build(root)

    def test_handwritten_workflows_cannot_add_third_party_apps(self):
        with self.assertRaises(build_workflows.CatalogError):
            build_workflows.validate_handwritten(
                {"name": "QAPAQ · x", "tags": ["ankay-playbook:x@1.0.0"], "actions": [{"app_name": "Shuffle Tools", "app_version": "1.2.0", "name": "execute_python"}], "triggers": []},
                "x.workflow.json",
                {},
            )


class FakeShuffle(BaseHTTPRequestHandler):
    state: dict = {}

    def log_message(self, *args):
        pass

    def _send(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"null")

    def do_GET(self):
        state = self.state
        if self.headers.get("Authorization") != "Bearer " + "a" * 40:
            return self._send({"success": False}, 401)
        if self.path == "/api/v1/_ah/health":
            return self._send("OK")
        if self.path == "/api/v1/apps":
            return self._send([{"id": "app-1", "name": "QAPAQ Ankay", "app_version": "1.0.0"}])
        if self.path == "/api/v1/apps/authentication":
            return self._send({"success": True, "data": state["auths"]})
        if self.path == "/api/v1/workflows":
            return self._send(list(state["workflows"].values()))
        return self._send({"success": False}, 404)

    def do_PUT(self):
        state = self.state
        body = self._body()
        if self.path == "/api/v1/apps/authentication":
            state["auths"].append({"id": "auth-1", "label": body["label"], "app": body["app"]})
            return self._send({"success": True, "id": "auth-1"})
        workflow_id = self.path.rsplit("/", 1)[1]
        state["workflows"][workflow_id] = body
        state["puts"] += 1
        return self._send({"success": True})

    def do_POST(self):
        state = self.state
        body = self._body()
        if self.path == "/api/v1/workflows":
            workflow_id = f"wf-{len(state['workflows']) + 1}"
            state["workflows"][workflow_id] = {"id": workflow_id, **body}
            return self._send({"id": workflow_id})
        if self.path == "/api/v1/hooks/new":
            state["hooks"][body["id"]] = body
            return self._send({"success": True})
        return self._send({"success": False}, 404)


class ImporterTests(unittest.TestCase):
    def setUp(self):
        FakeShuffle.state = {"auths": [], "workflows": {}, "hooks": {}, "puts": 0}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeShuffle)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.api = import_playbooks.ShuffleApi(f"http://127.0.0.1:{self.server.server_port}", "a" * 40)

    def tearDown(self):
        self.server.shutdown()

    def test_import_is_idempotent(self):
        directory = build_workflows.DIST / "workflows"
        total = len(list(directory.glob("*.json")))
        first = import_playbooks.import_all(self.api, directory, SECRETS)
        self.assertEqual(first, {"created": total, "updated": 0, "unchanged": 0})
        second = import_playbooks.import_all(self.api, directory, SECRETS)
        self.assertEqual(second, {"created": 0, "updated": 0, "unchanged": total})
        state = FakeShuffle.state
        self.assertEqual(len(state["auths"]), 1)
        self.assertEqual(len(state["workflows"]), total)
        stored = json.dumps(list(state["workflows"].values()))
        self.assertNotIn("__QAPAQ_ANKAY_", stored)
        intake = build_workflows.stable_id("wazuh.alert-intake", "webhook")
        self.assertEqual(state["hooks"][intake]["auth"], "X-Qapaq-Integration: " + "w" * 40)
        others = [hook for key, hook in state["hooks"].items() if key != intake]
        self.assertTrue(all(hook["auth"].endswith("d" * 40) for hook in others))

    def test_secrets_are_validated_without_echoing_them(self):
        with self.assertRaises(import_playbooks.ImportError_) as raised:
            import_playbooks.load_secrets({"ANKAY_WAZUH_WEBHOOK_TOKEN": "short-secret-value"})
        self.assertNotIn("short-secret-value", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
