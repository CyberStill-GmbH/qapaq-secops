from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CATO = load_module("qapaq_cato_events_feed", ROOT / "cato/events_feed.py")
CONFIGURE = load_module("qapaq_provider_configure", ROOT / "configure.py")


def cato_payload(marker: str = "opaque-1", records: list | None = None) -> dict:
    return {
        "data": {
            "eventsFeed": {
                "marker": marker,
                "fetchedCount": len(records or []),
                "accounts": [{"id": "12345", "errorString": "", "records": records or []}],
            }
        }
    }


class CatoEventsFeedTests(unittest.TestCase):
    def test_preserves_marker_and_normalizes_provider_envelope(self) -> None:
        marker, events = CATO.parse_payload(
            cato_payload(records=[{"fieldsMap": {"event_id": "evt-1", "event_type": "Threat", "time": "123"}}]),
            "12345",
        )
        self.assertEqual(marker, "opaque-1")
        self.assertEqual(events[0]["integration"], {"vendor": "cato", "product": "eventsFeed"})
        self.assertEqual(events[0]["cato"]["fields"]["event_type"], "Threat")

    def test_accepts_catos_documented_empty_initial_marker_page(self) -> None:
        marker, events = CATO.parse_payload({
            "data": {"eventsFeed": {"marker": "initial-position", "fetchedCount": 0, "accounts": []}}
        }, "12345")
        self.assertEqual(marker, "initial-position")
        self.assertEqual(events, [])

    def test_does_not_accept_graphql_errors_or_account_error(self) -> None:
        with self.assertRaises(CATO.ProviderError):
            CATO.parse_payload({"errors": [{"message": "denied"}], "data": {}}, "12345")
        payload = cato_payload()
        payload["data"]["eventsFeed"]["accounts"][0]["errorString"] = "permission denied"
        with self.assertRaises(CATO.ProviderError):
            CATO.parse_payload(payload, "12345")

    def test_request_hides_api_key_from_body_and_saves_cursor_after_output(self) -> None:
        record = {"fieldsMap": {"event_id": "evt-1"}}
        response = io.BytesIO(json.dumps(cato_payload(records=[record])).encode())
        response.status = 200
        with patch.object(CATO.urllib.request, "urlopen", return_value=response) as opener:
            marker, events = CATO.fetch(CATO.DEFAULT_ENDPOINT, "12345", "test-api-key", None)
        request = opener.call_args.args[0]
        self.assertEqual(request.get_header("X-api-key"), "test-api-key")
        self.assertNotIn(b"test-api-key", request.data)
        self.assertEqual((marker, len(events)), ("opaque-1", 1))

    def test_failed_response_preserves_previous_cursor_and_does_not_append(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            secret = base / "api-key"
            state = base / "state.json"
            output = base / "events.jsonl"
            config = base / "config.json"
            secret.write_text("credential-canary", encoding="utf-8")
            state.write_text('{"marker":"old-marker"}\n', encoding="utf-8")
            config.write_text(json.dumps({
                "account_id": "12345", "api_key_file": str(secret),
                "state_file": str(state), "output_file": str(output),
            }), encoding="utf-8")
            with patch.object(CATO, "fetch", side_effect=CATO.ProviderError("not logged")):
                self.assertEqual(CATO.run(config), 1)
            self.assertEqual(json.loads(state.read_text(encoding="utf-8"))["marker"], "old-marker")
            self.assertFalse(output.exists())

    def test_cursor_commits_only_after_jsonl_is_durable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            secret = base / "api-key"
            state = base / "state.json"
            output = base / "events.jsonl"
            config = base / "config.json"
            secret.write_text("test-api-key", encoding="utf-8")
            config.write_text(json.dumps({
                "account_id": "12345", "api_key_file": str(secret),
                "state_file": str(state), "output_file": str(output),
            }), encoding="utf-8")
            with patch.object(CATO, "fetch", return_value=("marker-2", [{"event": {"id": "evt-1"}}])):
                self.assertEqual(CATO.run(config), 0)
            self.assertEqual(json.loads(state.read_text(encoding="utf-8"))["marker"], "marker-2")
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["event"]["id"], "evt-1")


class ProviderConfigurationTests(unittest.TestCase):
    def test_config_installs_sources_idempotently_and_keeps_secret_out_of_ossec_xml(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            root = base / "ossec"
            secrets = base / "secrets"
            units = base / "units"
            secrets.mkdir()
            units.mkdir()
            (secrets / "sophos-client-id").write_text("client-id-canary", encoding="utf-8")
            (secrets / "sophos-client-secret").write_text("client-secret%canary", encoding="utf-8")
            (secrets / "cato-api-key").write_text("cato-key-canary", encoding="utf-8")
            ossec_conf = root / "etc/ossec.conf"
            ossec_conf.parent.mkdir(parents=True)
            ossec_conf.write_text("<ossec_config><ruleset/></ossec_config>\n", encoding="utf-8")
            config_path = base / "providers.json"
            config_path.write_text(json.dumps({
                "sophos_enabled": "true", "sophos_tenant_id": "45f2f938-dbe3-4a3e-8a54-930893f94ef8",
                "sophos_data_region": "eu01", "cato_enabled": "true", "cato_account_id": "12345",
            }), encoding="utf-8")
            with patch.object(CONFIGURE.subprocess, "run") as systemctl:
                self.assertEqual(CONFIGURE.run(config_path, root, secrets, ossec_conf, units), 0)
                self.assertEqual(CONFIGURE.run(config_path, root, secrets, ossec_conf, units), 0)
            xml = ossec_conf.read_text(encoding="utf-8")
            self.assertEqual(xml.count(CONFIGURE.BEGIN), 1)
            self.assertIn("<log_format>json</log_format>", xml)
            self.assertNotIn("client-secret-canary", xml)
            sophos_config = (secrets / "sophos-client.ini").read_text(encoding="utf-8")
            self.assertIn("client-secret%%canary", sophos_config)
            parser = CONFIGURE.configparser.ConfigParser()
            parser.read(secrets / "sophos-client.ini")
            self.assertEqual(parser["login"]["client_secret"], "client-secret%canary")
            self.assertEqual(json.loads((root / "etc/qapaq-providers/cato/config.json").read_text())["account_id"], "12345")
            self.assertTrue((units / "qapaq-sophos-ingest.timer").is_file())
            self.assertTrue((units / "qapaq-cato-ingest.timer").is_file())
            self.assertGreaterEqual(systemctl.call_count, 6)

    def test_unknown_or_incomplete_config_fails_without_changing_wazuh(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            config_path = base / "providers.json"
            config_path.write_text('{"cato_enabled":"true","cato_account_id":"bad"}', encoding="utf-8")
            root = base / "ossec"
            ossec_conf = root / "etc/ossec.conf"
            ossec_conf.parent.mkdir(parents=True)
            original = "<ossec_config/>\n"
            ossec_conf.write_text(original, encoding="utf-8")
            self.assertEqual(CONFIGURE.run(config_path, root, base / "secrets", ossec_conf, base / "units"), 1)
            self.assertEqual(ossec_conf.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
