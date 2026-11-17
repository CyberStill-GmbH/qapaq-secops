import hashlib
import hmac
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "custom-qapaq.py"
LOADER = importlib.machinery.SourceFileLoader("custom_qapaq", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)

SECRET = "synthetic-hmac-secret-with-at-least-32-bytes"
HOOK_URL = "https://qapaq-api.example.invalid/api/ingest/wazuh"
VECTOR_PATH = SCRIPT.parents[3] / "tests" / "fixtures" / "wazuh-push-hmac-vector.json"
VECTOR = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
SENT_AT = int(VECTOR["timestamp"])


class FakeResponse:
    def __init__(self, status):
        self.status = status
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        self.closed = True


class WazuhPushAdapterTests(unittest.TestCase):
    def setUp(self):
        # Keep test artifacts inside the writable workspace; CI gets the same isolation.
        self.alert_file = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".json", prefix=".custom-qapaq-alert-",
            dir=SCRIPT.parents[3], delete=False,
        )
        self.log_file = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".log", prefix=".custom-qapaq-log-",
            dir=SCRIPT.parents[3], delete=False,
        )
        self.alert_path = Path(self.alert_file.name)
        self.log_path = Path(self.log_file.name)
        self.secret_path = self.log_path.with_suffix(".secret")
        self.alert_file.close()
        self.log_file.close()
        self.secret_path.write_text(SECRET, encoding="ascii")
        self.ca_path = self.log_path.with_suffix(".ca")
        self.ca_path.write_text("synthetic CA bundle path", encoding="ascii")
        self.ca_env = patch.dict(os.environ, {MODULE.CA_FILE_ENV: str(self.ca_path)})
        self.ca_env.start()
        self.tls_context = MODULE.ssl.SSLContext(MODULE.ssl.PROTOCOL_TLS_CLIENT)
        self.create_context = patch.object(
            MODULE.ssl, "create_default_context", return_value=self.tls_context
        )
        self.create_context.start()
        MODULE.LOG = str(self.log_path)
        MODULE.SECRET_FILE = str(self.secret_path)
        self.alert = {
            "id": "1760000000.123",
            "timestamp": "2026-11-11T12:00:00.000+0000",
            "manager": {"name": "qapaq-manager", "id": "000", "private": "must-not-send"},
            "full_log": "SENSITIVE FULL LOG MUST NOT LEAVE WAZUH",
            "data": {"user": "analyst@example.invalid", "token": "private-token"},
            "rule": {"id": "100530", "level": 12, "description": "private rule detail"},
            "agent": {"id": "007", "name": "finance-workstation-01"},
        }
        self.write_alert()

    def tearDown(self):
        self.create_context.stop()
        self.ca_env.stop()
        self.alert_path.unlink(missing_ok=True)
        self.log_path.unlink(missing_ok=True)
        self.secret_path.unlink(missing_ok=True)
        self.ca_path.unlink(missing_ok=True)

    def write_alert(self):
        self.alert_path.write_text(json.dumps(self.alert), encoding="utf-8")

    def call_main(self, url=HOOK_URL):
        return MODULE.main(["custom-qapaq", str(self.alert_path), MODULE.SECRET_MARKER, url])

    def test_posts_only_lookup_hint_and_signs_canonical_utf8_payload(self):
        self.alert["manager"]["name"] = VECTOR["body"]["managerName"]
        self.write_alert()
        response = FakeResponse(202)

        with patch.object(MODULE.time, "time", return_value=SENT_AT), patch.object(
            MODULE.urllib.request, "urlopen", return_value=response
        ) as urlopen:
            self.assertEqual(self.call_main(), 0)

        request, = urlopen.call_args.args
        self.assertEqual(urlopen.call_args.kwargs["timeout"], MODULE.REQUEST_TIMEOUT_SECONDS)
        context = urlopen.call_args.kwargs["context"]
        self.assertIsInstance(context, MODULE.ssl.SSLContext)
        self.assertEqual(context.verify_mode, MODULE.ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(request.full_url, HOOK_URL)
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(request.get_header("X-qapaq-timestamp"), str(SENT_AT))

        expected_hint = VECTOR["body"]
        expected_body = VECTOR["canonicalBody"].encode("utf-8")
        self.assertEqual(request.data, expected_body)
        self.assertIn("á".encode("utf-8"), request.data)
        self.assertNotIn(b"\\ud83d", request.data.lower())
        self.assertEqual(json.loads(request.data), expected_hint)

        expected_signature = hmac.new(
            VECTOR["secret"].encode("utf-8"),
            VECTOR["timestamp"].encode("ascii") + b"." + expected_body,
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(expected_signature, VECTOR["signature"])
        self.assertEqual(
            request.get_header("X-qapaq-signature"),
            f"sha256={expected_signature}",
        )
        self.assertTrue(response.closed)

        serialized = request.data.decode("utf-8")
        for private_value in (
            "SENSITIVE FULL LOG MUST NOT LEAVE WAZUH",
            "analyst@example.invalid",
            "private-token",
            "private rule detail",
            "finance-workstation-01",
            "must-not-send",
        ):
            self.assertNotIn(private_value, serialized)
        self.assertEqual(
            set(json.loads(request.data)), {"alertId", "managerName", "occurredAt"}
        )

    def test_tls_context_uses_a_trusted_ca_bundle_and_keeps_verification_enabled(self):
        context = MODULE.trusted_tls_context()
        self.assertEqual(context.verify_mode, MODULE.ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        MODULE.ssl.create_default_context.assert_called_once_with(cafile=str(self.ca_path))

    def test_tls_context_fails_closed_when_explicit_ca_mount_is_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(OSError, "configured edge CA bundle is unavailable"):
                MODULE.trusted_tls_context()

        with patch.dict(os.environ, {MODULE.CA_FILE_ENV: str(self.ca_path) + ".missing"}):
            with self.assertRaisesRegex(OSError, "configured edge CA bundle is unavailable"):
                MODULE.trusted_tls_context()

    def test_numeric_alert_id_is_normalized_to_string(self):
        self.alert["id"] = 42
        self.write_alert()
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(202)) as urlopen:
            self.assertEqual(self.call_main(), 0)
        self.assertEqual(json.loads(urlopen.call_args.args[0].data)["alertId"], "42")

    def test_string_alert_id_is_preserved(self):
        self.alert["id"] = "00042"
        self.write_alert()
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(202)) as urlopen:
            self.assertEqual(self.call_main(), 0)
        self.assertEqual(json.loads(urlopen.call_args.args[0].data)["alertId"], "00042")

    def test_rejects_missing_or_invalid_lookup_fields_without_network_call(self):
        invalid_alerts = []
        for field in ("id", "timestamp", "manager"):
            candidate = dict(self.alert)
            candidate.pop(field)
            invalid_alerts.append(candidate)

        invalid_alerts.extend(
            [
                {**self.alert, "id": True},
                {**self.alert, "id": 42.5},
                {**self.alert, "timestamp": 123},
                {**self.alert, "manager": {"name": ""}},
                {**self.alert, "manager": {"name": 42}},
            ]
        )

        with patch.object(MODULE.urllib.request, "urlopen") as urlopen:
            for alert in invalid_alerts:
                with self.subTest(alert=alert):
                    self.alert_path.write_text(json.dumps(alert), encoding="utf-8")
                    self.assertEqual(self.call_main(), 1)
            urlopen.assert_not_called()

    def test_requires_https_and_does_not_post_or_log_payload(self):
        with patch.object(MODULE.urllib.request, "urlopen") as urlopen:
            self.assertEqual(self.call_main("http://qapaq-api.example.invalid/api/ingest/wazuh"), 1)
        urlopen.assert_not_called()
        self.assertTrue(self.log_path.exists())
        log_text = self.log_path.read_text(encoding="utf-8")
        self.assertIn("hook_url debe ser https", log_text)
        self.assertNotIn("SENSITIVE FULL LOG MUST NOT LEAVE WAZUH", log_text)
        self.assertNotIn(SECRET, log_text)

    def test_202_is_accepted_and_non_success_http_error_is_best_effort(self):
        with patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(202)) as urlopen:
            self.assertEqual(self.call_main(), 0)
        urlopen.assert_called_once()

        error = urllib.error.HTTPError(
            HOOK_URL,
            400,
            "synthetic provider failure",
            hdrs=None,
            fp=None,
        )
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=error) as urlopen:
            self.assertEqual(self.call_main(), 0)
        urlopen.assert_called_once()
        log_text = self.log_path.read_text(encoding="utf-8")
        self.assertIn("HTTP 400", log_text)
        self.assertNotIn("synthetic provider failure", log_text)
        self.assertNotIn(SECRET, log_text)

    def test_retries_transient_network_failure_with_a_fresh_signature(self):
        response = FakeResponse(202)
        timeout = urllib.error.URLError(TimeoutError("synthetic timeout"))
        with patch.object(MODULE.time, "time", side_effect=[SENT_AT, SENT_AT + 1]), patch.object(
            MODULE.time, "sleep"
        ) as sleep, patch.object(
            MODULE.urllib.request, "urlopen", side_effect=[timeout, response]
        ) as urlopen:
            self.assertEqual(self.call_main(), 0)

        self.assertEqual(urlopen.call_count, 2)
        first, second = (call.args[0] for call in urlopen.call_args_list)
        self.assertNotEqual(first.get_header("X-qapaq-timestamp"), second.get_header("X-qapaq-timestamp"))
        self.assertEqual(second.data, first.data)
        self.assertEqual(
            second.get_header("X-qapaq-signature"),
            "sha256="
            + hmac.new(
                SECRET.encode("utf-8"),
                str(SENT_AT + 1).encode("ascii") + b"." + second.data,
                hashlib.sha256,
            ).hexdigest(),
        )
        sleep.assert_called_once_with(MODULE.RETRY_BACKOFF_SECONDS[0])
        self.assertTrue(response.closed)

    def test_retries_provider_5xx_but_not_permanent_4xx(self):
        unavailable = urllib.error.HTTPError(
            HOOK_URL,
            503,
            "synthetic transient failure",
            hdrs=None,
            fp=None,
        )
        response = FakeResponse(202)
        with patch.object(
            MODULE.urllib.request, "urlopen", side_effect=[unavailable, response]
        ) as urlopen, patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(self.call_main(), 0)
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(MODULE.RETRY_BACKOFF_SECONDS[0])
        self.assertTrue(response.closed)

    def test_does_not_retry_tls_trust_failure(self):
        error = urllib.error.URLError(MODULE.ssl.SSLCertVerificationError("untrusted"))
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=error) as urlopen, patch.object(
            MODULE.time, "sleep"
        ) as sleep:
            self.assertEqual(self.call_main(), 0)
        urlopen.assert_called_once()
        sleep.assert_not_called()
        log_text = self.log_path.read_text(encoding="utf-8")
        self.assertNotIn("synthetic provider failure", log_text)
        self.assertNotIn(SECRET, log_text)

    def test_timeout_retries_are_bounded_and_do_not_log_diagnostics(self):
        with patch.object(
            MODULE.urllib.request,
            "urlopen",
            side_effect=TimeoutError("private network diagnostic"),
        ) as urlopen, patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(self.call_main(), 0)
        self.assertEqual(urlopen.call_count, MODULE.MAX_REQUEST_ATTEMPTS)
        self.assertEqual(sleep.call_count, MODULE.MAX_REQUEST_ATTEMPTS - 1)
        log_text = self.log_path.read_text(encoding="utf-8")
        self.assertIn("TimeoutError", log_text)
        self.assertNotIn("private network diagnostic", log_text)
        self.assertNotIn(SECRET, log_text)

    def test_missing_cli_arguments_returns_error(self):
        self.assertEqual(MODULE.main(["custom-qapaq"]), 1)
        self.assertIn("argumentos insuficientes", self.log_path.read_text(encoding="utf-8"))

    def test_secret_is_loaded_from_file_without_passing_secret_in_argv(self):
        with patch.object(MODULE.time, "time", return_value=SENT_AT), patch.object(
            MODULE.urllib.request, "urlopen", return_value=FakeResponse(202)
        ) as urlopen:
            argv = ["custom-qapaq", str(self.alert_path), MODULE.SECRET_MARKER, HOOK_URL]
            self.assertNotIn(SECRET, argv)
            self.assertEqual(MODULE.main(argv), 0)
        posted, = urlopen.call_args.args
        expected = hmac.new(
            SECRET.encode("utf-8"),
            str(SENT_AT).encode("ascii") + b"." + posted.data,
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(posted.get_header("X-qapaq-signature"), f"sha256={expected}")

    def test_missing_secret_file_fails_closed(self):
        self.secret_path.unlink()
        with patch.object(MODULE.urllib.request, "urlopen") as urlopen:
            self.assertEqual(self.call_main(), 1)
        urlopen.assert_not_called()
        self.assertNotIn(SECRET, self.log_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
