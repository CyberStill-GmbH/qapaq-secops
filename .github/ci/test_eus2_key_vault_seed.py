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
            },
            HELPER.SOURCE_TO_SECRET,
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

    def test_generated_wazuh_archive_is_encoded_into_private_arm_parameters(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "wazuh-install-files.tar"
            parameters_path = root / "arm-parameters.json"
            encoded = self.valid_wazuh_archive_b64()
            archive_path.write_bytes(base64.b64decode(encoded))

            HELPER.write_wazuh_archive_parameters(parameters_path, archive_path)

            payload = json.loads(parameters_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["parameters"]["secretName"]["value"],
                "wazuh-install-files.tar.b64",
            )
            self.assertEqual(payload["parameters"]["secretValue"]["value"], encoded)
            if os.name != "nt":
                self.assertEqual(parameters_path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                HELPER.write_wazuh_archive_parameters(parameters_path, archive_path)

    def test_generated_wazuh_archive_rejects_symlinks_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "archive.tar"
            parameters_path = root / "parameters.json"
            archive_path.write_bytes(base64.b64decode(self.valid_wazuh_archive_b64()))
            symlink_path = root / "archive-link.tar"
            try:
                symlink_path.symlink_to(archive_path)
            except (OSError, NotImplementedError):
                pass
            else:
                with self.assertRaises(HELPER.SeedInputError):
                    HELPER.write_wazuh_archive_parameters(parameters_path, symlink_path)

            archive_path.write_bytes(b"x" * (HELPER.MAX_ARCHIVE_BYTES + 1))
            with self.assertRaises(HELPER.SeedInputError):
                HELPER.write_wazuh_archive_parameters(parameters_path, archive_path)

    def test_official_wazuh_archive_root_ca_key_is_accepted_for_protected_storage(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:") as archive:
            for name, content in (
                ("wazuh-install-files/wazuh-passwords.txt", b"synthetic"),
                ("wazuh-install-files/wazuh-certificates/indexer.pem", b"synthetic"),
                ("wazuh-install-files/root-ca.key", b"synthetic-private-key-material"),
            ):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
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

    def test_workflow_uses_arm_and_never_changes_network_or_rbac(self):
        workflow = (ROOT / ".github/workflows/seed-eus2-key-vault-secret.yml").read_text()
        template = (ROOT / "infra/azure/secrets/eus2-key-vault-secret.json").read_text()
        self.assertIn("az deployment group create", workflow)
        self.assertIn("--output none", workflow)
        self.assertIn('"type": "secureString"', template)
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

    def test_wazuh_archive_workflow_is_manual_gated_and_never_publishes_secret_values(self):
        workflow = (ROOT / ".github/workflows/generate-eus2-wazuh-install-files.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("refs/heads/main", workflow)
        self.assertIn("environment: azure-demo-eus2", workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("GENERATE-EUS2-WAZUH-INSTALL-FILES", workflow)
        self.assertIn("group: seed-eus2-key-vault-secret", workflow)
        self.assertIn("WAZUH_VERSION: 4.14.8", workflow)
        self.assertIn("33d2069715e8500b676d13cefe7ddaea8eb79019", workflow)
        self.assertIn("f470ad7db717b18db7feeed568949643698f0f34", workflow)
        self.assertIn("config/certificate/config_aio.yml", workflow)
        self.assertIn("--generate-config-files", workflow)
        self.assertIn("--write-wazuh-archive", workflow)
        self.assertIn("az deployment group create", workflow)
        self.assertIn("--output none", workflow)
        self.assertIn("--only-show-errors", workflow)
        self.assertIn("trap cleanup EXIT", workflow)
        self.assertIn("sudo -n rm -rf -- \"$work\"", workflow)
        self.assertIn(
            "new_urls = 'urls=(\"https://raw.githubusercontent.com/wazuh/wazuh/${source_branch}/src/init/dist-detect.sh\")'",
            workflow,
        )
        self.assertIn("source.replace(old_version, new_version).replace(old_urls, new_urls)", workflow)
        for forbidden in (
            "actions/upload-artifact",
            "GITHUB_OUTPUT",
            "GITHUB_ENV",
            "az keyvault secret set",
            "az role assignment create",
            "echo \"$archive",
            "cat \"$archive",
        ):
            self.assertNotIn(forbidden, workflow)


if __name__ == "__main__":
    unittest.main()
