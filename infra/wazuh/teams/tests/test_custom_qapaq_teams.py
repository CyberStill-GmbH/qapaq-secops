import importlib.machinery
import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "custom-qapaq-teams"
LOADER = importlib.machinery.SourceFileLoader("custom_qapaq_teams", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)


class TeamsWorkflowAdapterTests(unittest.TestCase):
    def test_posts_adaptive_card_with_only_minimal_fields(self):
        alert = {
            "id": "1760000000.123",
            "timestamp": "2026-10-19T12:00:00Z",
            "full_log": "private email and IP must not leave Wazuh",
            "agent": {"name": "finance-workstation-1"},
            "data": {"srcip": "203.0.113.8"},
            "rule": {"id": "100530", "level": 12, "description": "PII"},
        }
        with tempfile.TemporaryDirectory() as directory:
            alert_path = Path(directory) / "alert.json"
            secret_path = Path(directory) / "workflow-url"
            alert_path.write_text(json.dumps(alert), encoding="utf-8")
            secret_path.write_text(
                "https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=secret\n",
                encoding="utf-8",
            )
            secret_path.chmod(0o640)
            response = type("Response", (), {"status": 202, "__enter__": lambda self: self, "__exit__": lambda *args: None})()
            with patch.object(MODULE, "urlopen", return_value=response) as request:
                self.assertEqual(MODULE.send_alert(alert_path, secret_path), 0)

        sent_request = request.call_args.args[0]
        body = json.loads(sent_request.data)
        serialized = json.dumps(body)
        self.assertEqual(sent_request.get_header("Client-request-id"), "1760000000.123")
        self.assertEqual(body["type"], "message")
        self.assertIn("AdaptiveCard", serialized)
        for forbidden in ("private email", "finance-workstation-1", "203.0.113.8", "PII"):
            self.assertNotIn(forbidden, serialized)

    def test_suppresses_alerts_below_level_12(self):
        alert = {"rule": {"id": "5", "level": 11}}
        self.assertIsNone(MODULE._payload(alert))

    def test_rejects_legacy_connector_path(self):
        with tempfile.TemporaryDirectory() as directory:
            secret_path = Path(directory) / "workflow-url"
            secret_path.write_text(
                "https://outlook.office.com/webhook/tenant/IncomingWebhook/key\n",
                encoding="utf-8",
            )
            secret_path.chmod(0o640)
            with self.assertRaises(ValueError):
                MODULE._workflow_url(secret_path)

    def test_rejects_world_readable_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            secret_path = Path(directory) / "workflow-url"
            secret_path.write_text(
                "https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=secret\n",
                encoding="utf-8",
            )
            secret_path.chmod(0o644)
            with patch.object(
                MODULE.Path,
                "stat",
                return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o644),
            ):
                with patch.object(MODULE.os, "name", "posix"):
                    with self.assertRaises(ValueError):
                        MODULE._workflow_url(secret_path)


if __name__ == "__main__":
    unittest.main()
