"""Unit tests for the QAPAQ alert mail service (no network)."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("qapaq_alert_mail", ROOT / "qapaq_alert_mail.py")
MAIL = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MAIL)


class FakeGraph:
    def __init__(self, fail_status=None):
        self.sent = []
        self.fail_status = fail_status

    def send(self, sender, recipients, subject, text, body_html):
        if self.fail_status:
            raise MAIL.ProviderError("Graph sendMail failed", self.fail_status)
        self.sent.append((sender, recipients, subject, text, body_html))


def alert(alert_id, level, description="desc"):
    return json.dumps({"id": alert_id, "timestamp": "2026-11-04T10:00:00.000+0000",
                       "rule": {"id": "100503", "level": level, "description": description},
                       "agent": {"name": "manager"}}) + "\n"


class AlertMailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.temp.name)
        self.alerts = base / "alerts.json"
        self.alerts.write_text(alert("old", 15))
        self.config = {"alerts_file": str(self.alerts), "state_file": str(base / "state.json"),
                       "from": "soc@example.test", "to": ["a@example.test"], "min_level": 10,
                       "max_emails_per_hour": 2, "max_per_email": 2}

    def tearDown(self):
        self.temp.cleanup()

    def append(self, *lines):
        with self.alerts.open("a") as stream:
            stream.writelines(lines)

    def test_first_run_skips_history_then_batches_filters_and_dedupes(self):
        graph = FakeGraph()
        self.assertEqual(MAIL.run(self.config, graph, now=1000), (0, 0))
        self.append(alert("a1", 12), alert("a2", 9), alert("a3", 10, "<script>x</script>"), alert("a1", 12))
        self.assertEqual(MAIL.run(self.config, graph, now=1001), (2, 0))
        sender, recipients, subject, text, body_html = graph.sent[0]
        self.assertIn("1 crítica(s), 1 alta(s)", subject)
        self.assertIn("&lt;script&gt;", body_html)
        self.assertNotIn("<script>", body_html)
        self.assertIn("https://dev.security.qapaq.pe/app/qapaq-alerts", text)
        self.assertNotIn("a2", text)  # level 9 below threshold
        self.assertEqual(MAIL.run(self.config, graph, now=1002), (0, 0))  # nothing new, no resend

    def test_rate_limit_and_failure_keep_alerts_pending(self):
        MAIL.run(self.config, FakeGraph(), now=1000)
        self.append(alert("b1", 13))
        with self.assertRaises(MAIL.ProviderError):
            MAIL.run(self.config, FakeGraph(fail_status=403), now=1001)
        graph = FakeGraph()
        self.assertEqual(MAIL.run(self.config, graph, now=1002), (1, 0))  # retried from pending
        self.append(alert("b2", 13))
        self.assertEqual(MAIL.run(self.config, graph, now=1003), (1, 0))
        self.append(alert("b3", 13))
        self.assertEqual(MAIL.run(self.config, graph, now=1004), (0, 1))  # 2/hour reached
        self.assertEqual(MAIL.run(self.config, graph, now=1004 + 3600), (1, 0))

    def test_rotation_restarts_from_new_file(self):
        MAIL.run(self.config, FakeGraph(), now=1000)
        self.alerts.unlink()
        self.alerts.write_text(alert("c1", 12))
        graph = FakeGraph()
        state = json.loads(pathlib.Path(self.config["state_file"]).read_text())
        state["position"]["inode"] = -1  # inode differs after rotation
        pathlib.Path(self.config["state_file"]).write_text(json.dumps(state))
        self.assertEqual(MAIL.run(self.config, graph, now=1001), (1, 0))


if __name__ == "__main__":
    unittest.main()
