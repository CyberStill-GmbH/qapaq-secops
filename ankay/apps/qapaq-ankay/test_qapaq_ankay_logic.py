"""Pruebas de la lógica de la app QAPAQ Ankay (sin SDK ni red)."""

import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "1.0.0" / "src"))
import qapaq_ankay_logic as logic  # noqa: E402

KEY = "k" * 48
CATALOG = {
    "playbooks": {
        "triage.wazuh-high-severity": {"version": "1.0.0", "effects": "none", "steps": ["classify"], "sources": ["wazuh"], "required": [], "prohibited": []},
        "qapaq.phishing-triage": {"version": "1.0.0", "effects": "none", "steps": ["a", "b"], "sources": ["m365"], "required": ["tenantRef"], "prohibited": ["mailBody"]},
        "containment.m365-revoke-sessions": {"version": "0.1.0", "effects": "identity-session-revocation", "status": "disabled", "steps": [], "required": [], "prohibited": []},
    },
    "wazuhRoutes": [
        {"playbookId": "triage.wazuh-high-severity", "ruleIds": [], "ruleGroups": [], "minLevel": 12},
        {"playbookId": "phishing.endpoint-office-child-process", "ruleIds": ["101100"], "ruleGroups": [], "minLevel": 12},
    ],
}


def alert(**overrides):
    body = {
        "schemaVersion": "1.0.0",
        "source": "wazuh",
        "alert": {"id": "1698412345.12345", "rule": {"id": "101100", "level": 13, "groups": ["sysmon"]}, "agent": {"name": "pc-01"}},
    }
    body["alert"].update(overrides)
    return json.dumps(body)


def envelope(dispatch, *, timestamp=1_000_000, nonce="n" * 24, key=KEY):
    message = f"{timestamp}.{nonce}.{logic.canonical_json(dispatch)}".encode()
    mac = hmac.new(key.encode(), message, hashlib.sha256).hexdigest()
    return json.dumps({"schemaVersion": "1.0.0", "dispatch": dispatch, "signature": {"alg": "HMAC-SHA256", "timestamp": timestamp, "nonce": nonce, "mac": mac}})


def dispatch(playbook="qapaq.phishing-triage", version="1.0.0", **extra):
    body = {
        "playbookId": playbook,
        "playbookVersion": version,
        "executionKey": "exec-test-0000000000000000",
        "incidentRef": "inc:2026-0001",
        "alertRef": "alert:1698412345.12345",
        "inputs": {"tenantRef": "tenant:qapaq"},
    }
    body.update(extra)
    return body


never_seen = lambda key: False  # noqa: E731
now = lambda: 1_000_100  # noqa: E731


class WazuhTriageTests(unittest.TestCase):
    def test_routes_and_stays_read_only(self):
        result = logic.triage_wazuh_alert(alert(), CATALOG, never_seen)
        self.assertEqual(result["status"], "triaged")
        self.assertEqual(result["candidatePlaybooks"], ["phishing.endpoint-office-child-process", "triage.wazuh-high-severity"])
        self.assertEqual(result["effects"], "none")

    def test_duplicates_and_low_levels(self):
        self.assertEqual(logic.triage_wazuh_alert(alert(), CATALOG, lambda key: True)["status"], "duplicate")
        low = alert(rule={"id": "5501", "level": 5, "groups": []})
        self.assertEqual(logic.triage_wazuh_alert(low, CATALOG, never_seen)["status"], "ignored-below-threshold")

    def test_rejects_malformed_payloads(self):
        for bad in ("[]", "{}", alert(id="unknown"), alert(rule={"id": "x1", "level": 13}), alert(rule={"id": "1", "level": "13"})):
            with self.assertRaises(logic.TriageError):
                logic.triage_wazuh_alert(bad, CATALOG, never_seen)


class DispatchTests(unittest.TestCase):
    def verify(self, raw, playbook="qapaq.phishing-triage", seen=never_seen):
        return logic.verify_dispatch(raw, KEY, CATALOG, playbook, seen, now=now)

    def test_valid_dispatch_is_verified_and_prepared(self):
        verified = self.verify(envelope(dispatch()))
        self.assertEqual(verified["status"], "verified")
        prepared = logic.prepare_read_only_triage(json.dumps(verified), CATALOG)
        self.assertEqual(prepared["effects"], "none")
        self.assertEqual(len(prepared["steps"]), 2)

    def test_signature_replay_and_scope_are_enforced(self):
        cases = {
            "wrong key": envelope(dispatch(), key="x" * 48),
            "old": envelope(dispatch(), timestamp=1),
            "other playbook": envelope(dispatch(playbook="triage.wazuh-high-severity")),
            "old version": envelope(dispatch(version="0.9.0")),
            "prohibited field": envelope(dispatch(inputs={"tenantRef": "t", "mail_body": "x"})),
            "token field": envelope(dispatch(inputs={"tenantRef": "t", "nested": {"accessToken": "x"}})),
            "missing required": envelope(dispatch(inputs={})),
            "bad execution key": envelope(dispatch(executionKey="short")),
        }
        for name, raw in cases.items():
            with self.subTest(name), self.assertRaises(logic.TriageError):
                self.verify(raw)
        self.assertEqual(self.verify(envelope(dispatch()), seen=lambda key: True)["status"], "duplicate")

    def test_tampering_after_signing_fails(self):
        raw = json.loads(envelope(dispatch()))
        raw["dispatch"]["incidentRef"] = "inc:other"
        with self.assertRaises(logic.TriageError):
            self.verify(json.dumps(raw))

    def test_effectful_playbooks_need_approval_and_are_never_executed(self):
        body = dispatch(playbook="containment.m365-revoke-sessions", version="0.1.0", inputs={})
        with self.assertRaises(logic.TriageError):
            self.verify(envelope(body), playbook="containment.m365-revoke-sessions")
        body["approvalRef"] = "approval:2026-0001"
        verified = self.verify(envelope(body), playbook="containment.m365-revoke-sessions")
        held = logic.hold_for_outbox(json.dumps(verified), CATALOG)
        self.assertEqual(held["status"], "blocked-awaiting-qapaq-outbox")
        self.assertEqual(held["effects"], "none")
        with self.assertRaises(logic.TriageError):
            logic.prepare_read_only_triage(json.dumps(verified), CATALOG)

    def test_short_keys_are_refused(self):
        with self.assertRaises(logic.TriageError):
            logic.verify_dispatch(envelope(dispatch()), "short", CATALOG, "qapaq.phishing-triage", never_seen, now=now)


if __name__ == "__main__":
    unittest.main()
