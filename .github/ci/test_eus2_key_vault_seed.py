from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch


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

    def test_synthetic_age_handoff_round_trip_and_authentication(self):
        age_binary = os.environ.get(HELPER.AGE_BINARY_ENV) or shutil.which("age")
        age_keygen = shutil.which("age-keygen")
        if not age_binary or not age_keygen:
            self.skipTest("age and age-keygen are required for the synthetic crypto round trip")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "synthetic-wazuh.tar"
            ciphertext_path = root / "synthetic-wazuh.tar.age"
            decrypted_path = root / "decrypted-wazuh.tar"
            identity_path = root / "synthetic-identity.txt"
            archive_path.write_bytes(base64.b64decode(self.valid_wazuh_archive_b64()))

            subprocess.run(
                [age_keygen, "-o", str(identity_path)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=30,
            )
            identity_lines = identity_path.read_text(encoding="ascii").splitlines()
            recipient = next(
                line.removeprefix("# public key: ")
                for line in identity_lines
                if line.startswith("# public key: age1")
            )
            private_identity = next(
                line for line in identity_lines if line.startswith("AGE-SECRET-KEY-1")
            )

            def run_helper_cli(*arguments: str) -> tuple[int, str, str]:
                stdout = io.StringIO()
                stderr = io.StringIO()
                with patch.object(sys, "argv", [str(HELPER_PATH), *arguments]):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        result = HELPER.main()
                return result, stdout.getvalue(), stderr.getvalue()

            with patch.dict(
                os.environ,
                {
                    HELPER.AGE_BINARY_ENV: str(age_binary),
                    HELPER.AGE_RECIPIENT_ENV: recipient,
                },
            ):
                result, stdout, stderr = run_helper_cli(
                    "--encrypt-wazuh-archive", str(archive_path), str(ciphertext_path)
                )
            self.assertEqual(result, 0)
            self.assertNotIn(private_identity, stdout + stderr)

            self.assertTrue(ciphertext_path.is_file())
            self.assertLessEqual(ciphertext_path.stat().st_size, HELPER.MAX_ENCRYPTED_ARCHIVE_BYTES)
            ciphertext = ciphertext_path.read_bytes()
            self.assertNotIn(b"synthetic-private-key-material", ciphertext)
            self.assertNotIn(b"wazuh-passwords.txt", ciphertext)

            with patch.dict(
                os.environ,
                {
                    HELPER.AGE_BINARY_ENV: str(age_binary),
                    HELPER.AGE_IDENTITY_ENV: private_identity,
                    HELPER.AGE_RECIPIENT_ENV: recipient,
                },
            ):
                result, stdout, stderr = run_helper_cli(
                    "--decrypt-wazuh-archive", str(ciphertext_path), str(decrypted_path)
                )
            self.assertEqual(result, 0)
            self.assertNotIn(private_identity, stdout + stderr)

            self.assertEqual(decrypted_path.read_bytes(), archive_path.read_bytes())
            self.assertFalse(decrypted_path.with_name(f".{decrypted_path.name}.age-identity").exists())

            mismatched_recipient_path = root / "must-not-match.tar"
            with self.assertRaises(HELPER.SeedInputError):
                HELPER.decrypt_wazuh_archive(
                    ciphertext_path,
                    mismatched_recipient_path,
                    private_identity,
                    "age1mismatch",
                )
            self.assertFalse(mismatched_recipient_path.exists())

            corrupted_path = root / "corrupted.tar.age"
            damaged = bytearray(ciphertext)
            damaged[-1] ^= 0x01
            corrupted_path.write_bytes(damaged)
            rejected_path = root / "must-not-exist.tar"
            with self.assertRaises(HELPER.SeedInputError):
                HELPER.decrypt_wazuh_archive(
                    corrupted_path,
                    rejected_path,
                    private_identity,
                    recipient,
                )
            self.assertFalse(rejected_path.exists())

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

    def test_wazuh_archive_build_and_seed_jobs_isolate_oidc_and_encrypt_handoff(self):
        workflow = (ROOT / ".github/workflows/generate-eus2-wazuh-install-files.yml").read_text()
        age_installer = (ROOT / ".github/ci/install-pinned-age.sh").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("refs/heads/main", workflow)
        self.assertIn("environment: azure-demo-eus2", workflow)
        self.assertEqual(workflow.count("id-token: write"), 1)
        self.assertIn("GENERATE-EUS2-WAZUH-INSTALL-FILES", workflow)
        self.assertIn("group: seed-eus2-key-vault-secret", workflow)
        self.assertIn("WAZUH_VERSION: 4.14.8", workflow)
        self.assertIn("33d2069715e8500b676d13cefe7ddaea8eb79019", workflow)
        self.assertIn("f470ad7db717b18db7feeed568949643698f0f34", workflow)
        self.assertIn("config/certificate/config_aio.yml", workflow)
        self.assertIn("--generate-config-files", workflow)
        self.assertIn("--validate-wazuh-archive-file", workflow)
        self.assertIn("--encrypt-wazuh-archive", workflow)
        self.assertIn("--decrypt-wazuh-archive", workflow)
        self.assertIn("--write-wazuh-archive", workflow)
        self.assertIn("az deployment group create", workflow)
        self.assertIn("--output none", workflow)
        self.assertIn("--only-show-errors", workflow)
        self.assertIn("if: always()", workflow)
        self.assertIn("sudo -n rm -rf -- \"$work\"", workflow)
        build_block = workflow.split("\n  build:\n", 1)[1].split("\n  seed:\n", 1)[0]
        seed_block = workflow.split("\n  seed:\n", 1)[1]
        self.assertNotIn("environment:", build_block)
        self.assertNotIn("id-token: write", build_block)
        self.assertNotIn("azure/login@", build_block)
        self.assertNotIn("secrets.QAPAQ_EUS2_WAZUH_BUNDLE_AGE_IDENTITY", build_block)
        self.assertNotIn("test_eus2_key_vault_seed.py", build_block)
        self.assertNotIn("AZURE_", build_block)
        self.assertIn("vars.QAPAQ_EUS2_WAZUH_BUNDLE_AGE_RECIPIENT", build_block)
        self.assertNotIn("GH_TOKEN:", build_block)
        self.assertNotIn("GITHUB_TOKEN:", build_block)
        self.assertIn("unset GH_TOKEN GITHUB_TOKEN", build_block)
        self.assertIn("environment: azure-demo-eus2", seed_block)
        self.assertIn("id-token: write", seed_block)
        self.assertIn("secrets.QAPAQ_EUS2_WAZUH_BUNDLE_AGE_IDENTITY", seed_block)
        self.assertIn("vars.QAPAQ_EUS2_WAZUH_BUNDLE_AGE_RECIPIENT", seed_block)
        self.assertIn("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", build_block)
        self.assertIn("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333", seed_block)
        self.assertIn("retention-days: 1", build_block)
        self.assertIn("ciphertext_sha256: ${{ steps.encrypt_bundle.outputs.ciphertext_sha256 }}", build_block)
        self.assertIn("ciphertext_sha256=%s\\n", build_block)
        self.assertEqual(workflow.count('>> "$GITHUB_OUTPUT"'), 1)
        self.assertIn("EXPECTED_CIPHERTEXT_SHA256: ${{ needs.build.outputs.ciphertext_sha256 }}", seed_block)
        self.assertIn('"$actual_sha256" == "$EXPECTED_CIPHERTEXT_SHA256"', seed_block)
        self.assertRegex(build_block, r"(?m)^          path: .*wazuh-install-files\.tar\.age$")
        self.assertNotRegex(build_block, r"(?m)^          path: .*wazuh-install-files\.tar['\"\s]*$")
        installer_step = build_block.split("- name: Build the official installer", 1)[1].split(
            "- name: Generate, validate, and encrypt", 1
        )[0]
        self.assertNotIn("GH_TOKEN:", installer_step)
        generate_at = workflow.index("- name: Generate, validate, and encrypt the Wazuh archive")
        decrypt_at = workflow.index("- name: Decrypt and revalidate the bundle before Azure authentication")
        login_at = workflow.index("- name: Sign in with the EUS2 seeder OIDC identity")
        review_at = workflow.index("- name: Review Key Vault target and create the secret through ARM")
        cleanup_at = workflow.index("- name: Remove ciphertext, decrypted archive, and secure ARM parameters")
        self.assertLess(generate_at, login_at)
        self.assertLess(decrypt_at, login_at)
        self.assertLess(login_at, review_at)
        self.assertLess(review_at, cleanup_at)
        self.assertEqual(
            workflow[login_at:review_at].count("- name: "),
            1,
            "Azure login must immediately precede Key Vault review/write.",
        )
        pre_auth = seed_block[: seed_block.index("- name: Sign in with the EUS2 seeder OIDC identity")]
        self.assertNotIn("az account ", pre_auth)
        self.assertNotIn("az keyvault ", pre_auth)
        self.assertNotIn("az deployment ", pre_auth)
        self.assertIn(
            "new_urls = 'urls=(\"https://raw.githubusercontent.com/wazuh/wazuh/${source_branch}/src/init/dist-detect.sh\")'",
            workflow,
        )
        self.assertIn("source.replace(old_version, new_version).replace(old_urls, new_urls)", workflow)
        self.assertIn("AGE_VERSION='1.3.2'", age_installer)
        self.assertIn(
            "AGE_SHA256='cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10'",
            age_installer,
        )
        self.assertIn("sha256sum --check --status", age_installer)
        for forbidden in (
            "GITHUB_ENV",
            "AGE-SECRET-KEY-1",
            "az keyvault secret set",
            "az role assignment create",
            "echo \"$archive",
            "cat \"$archive",
        ):
            self.assertNotIn(forbidden, workflow)


if __name__ == "__main__":
    unittest.main()
