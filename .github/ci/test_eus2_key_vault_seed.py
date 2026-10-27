from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import pathlib
import tarfile
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[2]
HELPER_PATH = pathlib.Path(__file__).with_name("prepare-eus2-key-vault-parameters.py")
SPEC = importlib.util.spec_from_file_location("eus2_kv_seed", HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class KeyVaultSeedHelperTests(unittest.TestCase):
    def test_exact_allowlist_maps_to_expected_key_vault_names(self):
        self.assertEqual(
            {
                "QAPAQ_EUS2_ENTRA_CLIENT_SECRET": "qapaq-entra-client-secret",
                "QAPAQ_EUS2_OFFICE365_CLIENT_SECRET": "office365-client-secret",
                "QAPAQ_EUS2_SOPHOS_CLIENT_ID": "sophos-client-id",
                "QAPAQ_EUS2_SOPHOS_CLIENT_SECRET": "sophos-client-secret",
                "QAPAQ_EUS2_CATO_API_KEY": "cato-api-key",
                "QAPAQ_EUS2_TEAMS_WORKFLOW_URL": "qapaq-teams-workflow-url",
                "QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64": "wazuh-install-files.tar.b64",
                "QAPAQ_EUS2_WAZUH_INDEXER_READER_BOOTSTRAP": "wazuh-reader-b64",
                "QAPAQ_EUS2_WAZUH_INDEXER_PROXY_CA_BOOTSTRAP": "wazuh-proxy-ca",
            },
            {**HELPER.SOURCE_TO_SECRET, **HELPER.BOOTSTRAP_SOURCE_TO_SECRET},
        )

    def test_bootstrap_placeholder_is_fixed_and_only_allows_two_indexer_refs(self):
        for source, expected_name in HELPER.BOOTSTRAP_SOURCE_TO_SECRET.items():
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                destination = pathlib.Path(directory) / "parameters.json"
                HELPER.write_bootstrap_placeholder(destination, source)
                payload = json.loads(destination.read_text(encoding="utf-8"))
                self.assertEqual(payload["parameters"]["secretName"]["value"], expected_name)
                self.assertEqual(
                    payload["parameters"]["secretValue"]["value"],
                    HELPER.BOOTSTRAP_PLACEHOLDER,
                )
                if os.name != "nt":
                    self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(HELPER.SeedInputError):
            HELPER.write_bootstrap_placeholder(
                pathlib.Path("unused"), "QAPAQ_EUS2_ENTRA_CLIENT_SECRET"
            )
        with self.assertRaises(HELPER.SeedInputError):
            HELPER._validate_secret(
                "QAPAQ_EUS2_WAZUH_INDEXER_READER_BOOTSTRAP",
                "caller-controlled-value",
            )

    def test_unknown_source_is_rejected(self):
        with self.assertRaises(HELPER.SeedInputError):
            HELPER.resolve_secret_name("SOME_OTHER_GITHUB_SECRET")

    def test_parameters_are_create_only_and_file_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "parameters.json"
            HELPER.write_parameters(destination, "QAPAQ_EUS2_ENTRA_CLIENT_SECRET", "synthetic-test-value")
            payload = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(payload["parameters"]["secretName"]["value"], "qapaq-entra-client-secret")
            self.assertEqual(payload["parameters"]["secretValue"]["value"], "synthetic-test-value")
            if os.name != "nt":
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                HELPER.write_parameters(destination, "QAPAQ_EUS2_ENTRA_CLIENT_SECRET", "other-test-value")

    def test_multiline_and_empty_values_are_rejected(self):
        for value in ("", "line-one\nline-two", "line-one\rline-two", "with\x00null"):
            with self.subTest(value_kind=len(value)):
                with self.assertRaises(HELPER.SeedInputError):
                    HELPER._validate_secret("QAPAQ_EUS2_CATO_API_KEY", value)

    def test_teams_workflow_input_requires_https(self):
        with self.assertRaises(HELPER.SeedInputError):
            HELPER._validate_secret("QAPAQ_EUS2_TEAMS_WORKFLOW_URL", "http://example.invalid/webhook")
        with self.assertRaises(HELPER.SeedInputError):
            HELPER._validate_secret("QAPAQ_EUS2_TEAMS_WORKFLOW_URL", "https://user:pass@example.invalid/hook")

    @staticmethod
    def valid_wazuh_archive_b64() -> str:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:") as archive:
            for name, content in (
                ("wazuh-install-files/wazuh-passwords.txt", b"synthetic"),
                ("wazuh-install-files/wazuh-certificates/indexer.pem", b"synthetic"),
            ):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        return base64.b64encode(buffer.getvalue()).decode("ascii")

    def test_wazuh_archive_is_validated_without_extraction(self):
        HELPER._validate_secret(
            "QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64", self.valid_wazuh_archive_b64()
        )
        with self.assertRaises(HELPER.SeedInputError):
            HELPER._validate_secret("QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64", "not-base64")

    def test_wazuh_archive_rejects_path_traversal(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:") as archive:
            for name, content in (
                ("../wazuh-install-files/wazuh-passwords.txt", b"synthetic"),
                ("wazuh-install-files/wazuh-certificates/indexer.pem", b"synthetic"),
            ):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        with self.assertRaises(HELPER.SeedInputError):
            HELPER._validate_secret("QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64", encoded)


class WorkflowContractTests(unittest.TestCase):
    def test_workflow_is_manual_and_has_separate_validated_secret_job(self):
        workflow = (ROOT / ".github/workflows/seed-eus2-key-vault-secret.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("needs: validate_request", workflow)
        self.assertIn("environment: azure-demo-eus2", workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("refs/heads/main", workflow)
        self.assertIn("SEED-EUS2-SECRET", workflow)
        self.assertIn("QAPAQ_EUS2_WAZUH_INDEXER_READER_BOOTSTRAP", workflow)
        self.assertIn("QAPAQ_EUS2_WAZUH_INDEXER_PROXY_CA_BOOTSTRAP", workflow)
        self.assertIn("--write-bootstrap-placeholder", workflow)
        self.assertIn("SELECTED_SECRET_VALUE:", workflow)

    def test_workflow_uses_arm_and_never_changes_network_or_rbac(self):
        workflow = (ROOT / ".github/workflows/seed-eus2-key-vault-secret.yml").read_text()
        template = (ROOT / "infra/azure/secrets/eus2-key-vault-secret.json").read_text()
        self.assertIn("az deployment group create", workflow)
        self.assertIn("--output none", workflow)
        self.assertIn('"type": "secureString"', template)
        self.assertIn('"wazuh-reader-b64"', template)
        self.assertIn('"wazuh-proxy-ca"', template)
        placeholder_step = workflow.split("Create fixed bootstrap placeholder parameter file", 1)[1].split(
            "\n      - name:", 1
        )[0]
        self.assertIn("--write-bootstrap-placeholder", placeholder_step)
        self.assertNotIn("SELECTED_SECRET_VALUE", placeholder_step)
        self.assertNotIn("secrets[inputs.source_secret]", placeholder_step)
        for forbidden in (
            "az keyvault secret set",
            "az role assignment create",
            "Microsoft.Authorization/roleAssignments/write",
            "--public-network-access",
            "--default-action",
            "--bypass",
        ):
            self.assertNotIn(forbidden, workflow)

    def test_workflow_pins_external_actions_and_sets_job_timeouts(self):
        workflow = (ROOT / ".github/workflows/seed-eus2-key-vault-secret.yml").read_text()
        self.assertRegex(workflow, r"actions/checkout@[0-9a-f]{40}")
        self.assertRegex(workflow, r"azure/login@[0-9a-f]{40}")
        self.assertRegex(workflow, r"timeout-minutes:\s*\d+")


if __name__ == "__main__":
    unittest.main()
