import importlib.machinery
import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "custom-qapaq-shuffle"
LOADER = importlib.machinery.SourceFileLoader("custom_qapaq_shuffle", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)


class ShuffleWebhookAdapterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.alert_path = self.root / "alert.json"
        self.secret_path = self.root / "shuffle.json"
        self.alert = {
            "id": "1760000000.123",
            "timestamp": "2026-10-19T12:00:00Z",
            "full_log": "private event raw must not leave Wazuh",
            "data": {"srcip": "203.0.113.15", "user": "operator@example.invalid"},
            "agent": {"id": "007", "name": "finance-workstation-01"},
            "manager": {"name": "qapaq-manager"},
            "rule": {
                "id": "100530",
                "level": 12,
                "description": "High confidence threat",
                "groups": ["malware", "syscheck"],
            },
        }
        self.alert_path.write_text(json.dumps(self.alert), encoding="utf-8")
        self.secret_path.write_text(
            json.dumps(
                {
                    "url": "https://ankay.example.invalid/api/v1/webhooks/webhook_12345678-1234-1234-1234-123456789012",
                    "header_token": "synthetic-credential-value-1234567890",
                }
            ),
            encoding="utf-8",
        )
        self.secret_path.chmod(0o640)

    def tearDown(self):
        self.directory.cleanup()

    def test_posts_minimized_alert_and_auth_header(self):
        response = type(
            "Response",
            (),
            {"status": 202, "__enter__": lambda self: self, "__exit__": lambda *args: None},
        )()
        with patch.object(MODULE, "urlopen", return_value=response) as request:
            self.assertEqual(MODULE.forward_alert(self.alert_path, self.secret_path), 0)

        outbound = request.call_args.args[0]
        payload = json.loads(outbound.data)
        serialized = json.dumps(payload)
        self.assertEqual(outbound.get_header("X-qapaq-integration"), "synthetic-credential-value-1234567890")
        self.assertEqual(outbound.get_header("Client-request-id"), self.alert["id"])
        self.assertEqual(payload["source"], "wazuh")
        self.assertEqual(payload["alert"]["rule"]["id"], "100530")
        self.assertEqual(payload["alert"]["agent"]["name"], "finance-workstation-01")
        for private_value in (
            "private event raw must not leave Wazuh",
            "203.0.113.15",
            "operator@example.invalid",
        ):
            self.assertNotIn(private_value, serialized)

    def test_suppresses_alerts_below_level_12(self):
        self.alert["rule"]["level"] = 11
        self.alert_path.write_text(json.dumps(self.alert), encoding="utf-8")
        with patch.object(MODULE, "urlopen") as request:
            self.assertEqual(MODULE.forward_alert(self.alert_path, self.secret_path), 0)
        request.assert_not_called()

    def test_rejects_http_or_non_shuffle_webhook(self):
        config = json.loads(self.secret_path.read_text(encoding="utf-8"))
        config["url"] = "http://ankay.example.invalid/api/v1/webhooks/webhook_12345678-1234-1234-1234-123456789012"
        self.secret_path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaises(ValueError):
            MODULE._endpoint_secret(self.secret_path)

    def test_rejects_publicly_readable_secret_file(self):
        self.secret_path.chmod(0o644)
        with patch.object(
            MODULE.Path,
            "stat",
            return_value=type("Stat", (), {"st_mode": stat.S_IFREG | 0o644})(),
        ), patch.object(MODULE.os, "name", "posix"):
            with self.assertRaises(ValueError):
                MODULE._endpoint_secret(self.secret_path)

    def test_failed_delivery_does_not_log_signed_url_or_token(self):
        secret_text = self.secret_path.read_text(encoding="utf-8")
        with patch.object(MODULE, "urlopen", side_effect=OSError("network failure")):
            with self.assertLogs(level="ERROR") if False else _captured_stderr() as stderr:
                self.assertEqual(MODULE.forward_alert(self.alert_path, self.secret_path), 1)
        self.assertNotIn("webhook_12345678", stderr.getvalue())
        self.assertNotIn("synthetic-credential-value", stderr.getvalue())
        self.assertNotIn(json.loads(secret_text)["url"], stderr.getvalue())


class _captured_stderr:
    def __enter__(self):
        import io
        import sys

        self.buffer = io.StringIO()
        self.previous = sys.stderr
        sys.stderr = self.buffer
        return self.buffer

    def __exit__(self, exc_type, exc_value, traceback):
        import sys

        sys.stderr = self.previous


if __name__ == "__main__":
    unittest.main()
