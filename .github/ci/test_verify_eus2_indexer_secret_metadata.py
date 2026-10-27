from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import unittest
from unittest.mock import Mock


SCRIPT = pathlib.Path(__file__).with_name("verify-eus2-indexer-secret-metadata.py")
SPEC = importlib.util.spec_from_file_location("eus2_indexer_metadata", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def gateway() -> dict[str, str]:
    return {
        "indexer_reader_secret_name": "wazuh-reader-b64",
        "indexer_proxy_ca_secret_name": "wazuh-proxy-ca",
    }


def environment(**overrides: str) -> dict[str, str]:
    return {
        "AZURE_SUBSCRIPTION_ID": HELPER.SUBSCRIPTION_ID,
        "TF_VAR_krakend_gateway": json.dumps(gateway()),
        **overrides,
    }


class IndexerSecretMetadataTests(unittest.TestCase):
    def test_optional_gateway_off_does_not_call_azure_cli(self):
        run = Mock()
        HELPER.verify_metadata(environment(TF_VAR_krakend_gateway="null"), run=run)
        run.assert_not_called()

    def test_exact_two_secret_resource_ids_are_selected(self):
        ids = HELPER.selected_secret_ids(environment())
        self.assertEqual(
            ids,
            [
                "/subscriptions/aaf787f8-5964-4470-9eb6-89d15eacda61/resourceGroups/"
                "rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.KeyVault/vaults/"
                "kv-qapaqsecopsd-3a2405f3/secrets/wazuh-reader-b64",
                "/subscriptions/aaf787f8-5964-4470-9eb6-89d15eacda61/resourceGroups/"
                "rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.KeyVault/vaults/"
                "kv-qapaqsecopsd-3a2405f3/secrets/wazuh-proxy-ca",
            ],
        )

    def test_rejects_other_or_missing_secret_names(self):
        for candidate in (
            {"indexer_reader_secret_name": "other", "indexer_proxy_ca_secret_name": "wazuh-proxy-ca"},
            {"indexer_reader_secret_name": "wazuh-reader-b64"},
        ):
            with self.subTest(candidate=candidate):
                raw = json.dumps(candidate)
                with self.assertRaises(HELPER.PreflightError):
                    HELPER.selected_secret_ids({"TF_VAR_krakend_gateway": raw})

    def test_cli_queries_only_scope_and_enabled_metadata(self):
        responses = []
        for secret_id in HELPER.selected_secret_ids(environment()):
            responses.append(
                subprocess.CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout=json.dumps({"id": secret_id, "enabled": True}),
                    stderr="",
                )
            )
        run = Mock(side_effect=responses)

        HELPER.verify_metadata(environment(), run=run)

        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            command = call.args[0]
            self.assertEqual(command[:3], ["az", "resource", "show"])
            query = command[command.index("--query") + 1]
            self.assertEqual(query, "{id:id,enabled:properties.attributes.enabled}")
            self.assertNotIn("properties.value", command)

    def test_missing_or_disabled_reference_fails_without_echoing_cli_output(self):
        run = Mock(
            return_value=subprocess.CompletedProcess(
                args=[],
                returncode=1,
                stdout="sensitive-looking-output",
                stderr="credential-shaped-output",
            )
        )
        with self.assertRaises(HELPER.PreflightError) as caught:
            HELPER.verify_metadata(environment(), run=run)
        self.assertNotIn("sensitive-looking-output", str(caught.exception))
        self.assertNotIn("credential-shaped-output", str(caught.exception))

        disabled = HELPER.selected_secret_ids(environment())[0]
        run = Mock(
            return_value=subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps({"id": disabled, "enabled": False}),
                stderr="",
            )
        )
        with self.assertRaises(HELPER.PreflightError):
            HELPER.verify_metadata(environment(), run=run)

    def test_requires_expected_subscription_context(self):
        with self.assertRaises(HELPER.PreflightError):
            HELPER.verify_metadata(environment(AZURE_SUBSCRIPTION_ID="00000000-0000-4000-8000-000000000000"))

    def test_terraform_workflow_checks_metadata_before_plan_and_apply(self):
        workflow = (pathlib.Path(__file__).parents[1] / "workflows/terraform-azure-demo-eus2.yml").read_text()
        self.assertEqual(workflow.count("python3 .github/ci/verify-eus2-indexer-secret-metadata.py"), 2)
        self.assertEqual(workflow.count("Sign in before optional KrakenD secret metadata preflight"), 2)
        self.assertIn("TF_VAR_krakend_gateway:", workflow)
        self.assertIn("id-token: write", workflow)


if __name__ == "__main__":
    unittest.main(verbosity=2)
