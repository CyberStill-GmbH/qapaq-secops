"""Security regression tests for the Azure SIEM first-boot bootstrap."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import types
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


BOOTSTRAP_PATH = pathlib.Path(__file__).with_name("bootstrap-siem.py")
SPEC = importlib.util.spec_from_file_location("qapaq_siem_bootstrap", BOOTSTRAP_PATH)
assert SPEC is not None and SPEC.loader is not None
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
with patch.dict(sys.modules, {"pwd": types.ModuleType("pwd")}):
    SPEC.loader.exec_module(BOOTSTRAP)


class InstallerOutputTests(unittest.TestCase):
    def test_installer_output_is_discarded_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            release = pathlib.Path(temporary_directory)
            installer = release / "install.sh"
            installer.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            (release / "manifest.json").write_text('{"debianPackages":{}}\n', encoding="utf-8")
            captured_output = io.StringIO()
            completed = SimpleNamespace(
                returncode=17,
                stdout="CANARY_SECRET_FROM_INSTALLER",
                stderr="CANARY_SECRET_FROM_INSTALLER",
            )

            with patch.object(BOOTSTRAP.subprocess, "run", return_value=completed) as run_installer:
                with patch.object(BOOTSTRAP, "installer_required", return_value=True):
                    with contextlib.redirect_stdout(captured_output):
                        with self.assertRaises(SystemExit) as failure:
                            BOOTSTRAP.install_release(
                                release,
                                {
                                    "office365": {
                                        "tenant_id": "45f2f938-dbe3-4a3e-8a54-930893f94ef8",
                                        "client_id": "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998",
                                        "api_type": "commercial",
                                        "enable_dlp": False,
                                    }
                                },
                            )

            self.assertEqual(failure.exception.code, 1)
            self.assertNotIn("CANARY_SECRET_FROM_INSTALLER", captured_output.getvalue())
            self.assertIn("código 17", captured_output.getvalue())
            self.assertIs(run_installer.call_args.kwargs["stdout"], BOOTSTRAP.subprocess.DEVNULL)
            self.assertIs(run_installer.call_args.kwargs["stderr"], BOOTSTRAP.subprocess.DEVNULL)
            self.assertEqual(run_installer.call_args.kwargs["env"]["QAPAQ_O365_TENANT_ID"], "45f2f938-dbe3-4a3e-8a54-930893f94ef8")
            self.assertEqual(run_installer.call_args.kwargs["env"]["QAPAQ_O365_CLIENT_ID"], "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998")
            self.assertNotIn("QAPAQ_O365_CLIENT_SECRET", run_installer.call_args.kwargs["env"])


class ProviderIngestionValidationTests(unittest.TestCase):
    def _base_config(self) -> dict:
        return {
            "expected": BOOTSTRAP.EXPECTED,
            "artifact_sha256": "a" * 64,
            "artifact_url": "https://releases.blob.core.windows.net/private/bundle.tar.gz",
            "identity_client_id": "managed-identity-client-id",
            "key_vault_uri": "https://kv-qapaq-test.vault.azure.net/",
            "office365": {
                "tenant_id": "45f2f938-dbe3-4a3e-8a54-930893f94ef8",
                "client_id": "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998",
                "api_type": "commercial",
                "enable_dlp": False,
            },
            "wazuh_secret_names": {
                "office365-client-secret": "office365-secret",
                "wazuh-install-files.tar.b64": "wazuh-install-files-tar-b64",
            },
            "core_secret_names": {
                "QAPAQ_ENTRA_CLIENT_SECRET": "entra-client-secret",
            },
            "data_disk_size_gb": 128,
        }

    def _load_config(self, config: dict) -> dict:
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "bootstrap.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with patch.object(BOOTSTRAP, "CONFIG_PATH", path):
                return BOOTSTRAP.load_config()

    def _assert_config_rejected(self, config: dict, expected_message: str) -> None:
        captured_output = io.StringIO()
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "bootstrap.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with patch.object(BOOTSTRAP, "CONFIG_PATH", path):
                with contextlib.redirect_stdout(captured_output):
                    with self.assertRaises(SystemExit):
                        BOOTSTRAP.load_config()
        self.assertIn(expected_message, captured_output.getvalue())

    def test_accepts_postgres_with_matching_secret_names_and_references(self) -> None:
        config = self._base_config()
        config["core_environment"] = {
            "QAPAQ_SOC_PERSISTENCE": "postgres",
            "QAPAQ_POSTGRES_PASSWORD_REF": "secret://keyvault/qapaq-postgres-password",
            "QAPAQ_ENTITY_REF_KEY_REF": "secret://keyvault/qapaq-entity-ref-key",
        }
        config["core_secret_names"].update({
            "QAPAQ_POSTGRES_PASSWORD": "qapaq-postgres-password",
            "QAPAQ_ENTITY_REF_KEY": "qapaq-entity-ref-key",
        })

        loaded = self._load_config(config)

        self.assertEqual(loaded["core_environment"]["QAPAQ_SOC_PERSISTENCE"], "postgres")

    def test_rejects_postgres_without_password_secret_mapping(self) -> None:
        config = self._base_config()
        config["core_environment"] = {"QAPAQ_SOC_PERSISTENCE": "postgres"}
        config["core_secret_names"]["QAPAQ_ENTITY_REF_KEY"] = "qapaq-entity-ref-key"

        self._assert_config_rejected(config, "persistencia PostgreSQL requiere referencias Key Vault")

    def test_rejects_postgres_without_entity_reference_key_mapping(self) -> None:
        config = self._base_config()
        config["core_environment"] = {"QAPAQ_SOC_PERSISTENCE": "postgres"}
        config["core_secret_names"]["QAPAQ_POSTGRES_PASSWORD"] = "qapaq-postgres-password"

        self._assert_config_rejected(config, "persistencia PostgreSQL requiere referencias Key Vault")

    def test_rejects_core_reference_that_does_not_match_secret_mapping(self) -> None:
        config = self._base_config()
        config["core_environment"] = {
            "QAPAQ_POSTGRES_PASSWORD_REF": "secret://keyvault/unmapped-password",
        }
        config["core_secret_names"]["QAPAQ_POSTGRES_PASSWORD"] = "qapaq-postgres-password"
        config["core_secret_names"]["QAPAQ_ENTITY_REF_KEY"] = "qapaq-entity-ref-key"

        self._assert_config_rejected(config, "la referencia Core no coincide")

    def test_accepts_provider_references_without_secret_values(self) -> None:
        config = self._base_config()
        config["provider_ingestion"] = {
            "sophos_enabled": "true",
            "sophos_tenant_id": "45f2f938-dbe3-4a3e-8a54-930893f94ef8",
            "sophos_data_region": "eu01",
            "cato_enabled": "true",
            "cato_account_id": "12345",
        }
        config["wazuh_secret_names"].update({
            "sophos-client-id": "sophos-client-id-secret",
            "sophos-client-secret": "sophos-client-secret-secret",
            "cato-api-key": "cato-api-key-secret",
        })
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "bootstrap.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with patch.object(BOOTSTRAP, "CONFIG_PATH", path):
                self.assertEqual(BOOTSTRAP.load_config()["provider_ingestion"]["cato_account_id"], "12345")

    def test_rejects_enabled_source_without_key_vault_references(self) -> None:
        config = self._base_config()
        config["provider_ingestion"] = {
            "cato_enabled": "true",
            "cato_account_id": "12345",
        }
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "bootstrap.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with patch.object(BOOTSTRAP, "CONFIG_PATH", path):
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.load_config()

    def test_rejects_missing_install_archive_reference_during_preflight(self) -> None:
        config = self._base_config()
        del config["wazuh_secret_names"]["wazuh-install-files.tar.b64"]
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "bootstrap.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            captured_output = io.StringIO()
            with patch.object(BOOTSTRAP, "CONFIG_PATH", path):
                with contextlib.redirect_stdout(captured_output):
                    with self.assertRaises(SystemExit):
                        BOOTSTRAP.load_config()
            self.assertIn("wazuh-install-files.tar.b64", captured_output.getvalue())

    def test_materializes_optional_teams_reference_only_as_root_only_file(self) -> None:
        config = self._base_config()
        config["wazuh_secret_names"]["qapaq-teams-workflow-url"] = "teams-workflow"
        config["core_secret_names"]["QAPAQ_TEAMS_WORKFLOW_URL"] = "core-teams-workflow"
        expected_url = "https://prod-01.westus.logic.azure.com/workflows/synthetic?sig=not-real"
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            with patch.object(BOOTSTRAP, "WAZUH_SECRET_DIR", root / "secrets"):
                with patch.object(BOOTSTRAP, "CORE_ENV_PATH", root / "core" / "core.env"):
                    with patch.object(BOOTSTRAP, "get_token", return_value="synthetic-token"):
                        with patch.object(BOOTSTRAP, "key_vault_get", return_value=expected_url) as get_secret:
                            with patch.object(BOOTSTRAP.pwd, "getpwnam", return_value=SimpleNamespace(pw_gid=1000), create=True):
                                with patch.object(BOOTSTRAP.os, "chown", create=True):
                                    with patch.object(BOOTSTRAP.os, "O_NOFOLLOW", 0, create=True):
                                        BOOTSTRAP.materialize_secrets(config)

            secret_file = root / "secrets" / "qapaq-teams-workflow-url"
            self.assertEqual(secret_file.read_text(encoding="utf-8"), expected_url)
            core_environment = (root / "core" / "core.env").read_text(encoding="utf-8")
            self.assertIn('QAPAQ_ENTRA_CLIENT_SECRET_REF="secret://keyvault/entra-client-secret"', core_environment)
            self.assertIn('QAPAQ_TEAMS_WORKFLOW_URL_REF="secret://keyvault/core-teams-workflow"', core_environment)
            self.assertIn('QAPAQ_SECRET_PROVIDER_TYPE="azure-key-vault"', core_environment)
            self.assertIn('QAPAQ_SECRET_PROVIDER_ENDPOINT="https://kv-qapaq-test.vault.azure.net"', core_environment)
            self.assertIn('AZURE_CLIENT_ID="managed-identity-client-id"', core_environment)
            self.assertNotIn("QAPAQ_ENTRA_CLIENT_SECRET=", core_environment)
            self.assertNotIn(expected_url, core_environment)
            fetched_names = {call.args[2] for call in get_secret.call_args_list}
            self.assertNotIn("entra-client-secret", fetched_names)
            self.assertNotIn("core-teams-workflow", fetched_names)
            self.assertEqual(fetched_names, {"office365-secret", "wazuh-install-files-tar-b64", "teams-workflow"})
            if BOOTSTRAP.os.name != "nt":
                self.assertEqual(secret_file.stat().st_mode & 0o777, 0o600)


class InstallerIdempotencyTests(unittest.TestCase):
    def test_same_recorded_release_skips_the_one_shot_installer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_root = pathlib.Path(temporary_directory)
            release = data_root / ("a" * 64)
            release.mkdir()
            (data_root / "bootstrap-install-state.json").write_text(
                '{"schemaVersion":1,"artifactSha256":"' + release.name + '"}\n',
                encoding="utf-8",
            )

            with patch.object(BOOTSTRAP, "DATA_ROOT", data_root):
                self.assertFalse(BOOTSTRAP.installer_required(release))

    def test_different_release_does_not_trigger_implicit_upgrade(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_root = pathlib.Path(temporary_directory)
            release = data_root / ("b" * 64)
            release.mkdir()
            (data_root / "bootstrap-install-state.json").write_text(
                '{"schemaVersion":1,"artifactSha256":"' + ("a" * 64) + '"}\n',
                encoding="utf-8",
            )

            with patch.object(BOOTSTRAP, "DATA_ROOT", data_root):
                with self.assertRaises(SystemExit) as failure:
                    BOOTSTRAP.installer_required(release)

            self.assertEqual(failure.exception.code, 1)

    def test_symlink_install_state_fails_closed(self) -> None:
        release = pathlib.Path("e" * 64)
        state_path = SimpleNamespace(
            exists=lambda: True,
            lstat=lambda: SimpleNamespace(st_mode=BOOTSTRAP.stat.S_IFLNK),
        )

        with patch.object(BOOTSTRAP, "install_state_path", return_value=state_path):
            with self.assertRaises(SystemExit) as failure:
                BOOTSTRAP.installer_required(release)

        self.assertEqual(failure.exception.code, 1)

    def test_existing_manager_package_blocks_first_boot_reinstall(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_root = pathlib.Path(temporary_directory)
            release = data_root / ("c" * 64)
            release.mkdir()

            with patch.object(BOOTSTRAP, "DATA_ROOT", data_root):
                with patch.object(BOOTSTRAP, "package_registered", side_effect=lambda name: name == "wazuh-manager"):
                    with self.assertRaises(SystemExit) as failure:
                        BOOTSTRAP.installer_required(release)

            self.assertEqual(failure.exception.code, 1)

    def test_unmarked_wazuh_data_blocks_first_boot_reinstall(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_root = pathlib.Path(temporary_directory)
            release = data_root / ("d" * 64)
            release.mkdir()
            manager_data = data_root / "manager"
            manager_data.mkdir()
            (manager_data / "state.db").write_text("preserve", encoding="utf-8")

            with patch.object(BOOTSTRAP, "DATA_ROOT", data_root):
                with patch.object(BOOTSTRAP, "package_registered", return_value=False):
                    with self.assertRaises(SystemExit) as failure:
                        BOOTSTRAP.installer_required(release)

            self.assertEqual(failure.exception.code, 1)
            self.assertEqual((manager_data / "state.db").read_text(encoding="utf-8"), "preserve")


class DataDiskFormattingTests(unittest.TestCase):
    @staticmethod
    def result(code: int, output: str = "") -> SimpleNamespace:
        return SimpleNamespace(returncode=code, stdout=output)

    def test_existing_ext4_is_preserved_without_formatting(self) -> None:
        with patch.object(BOOTSTRAP.subprocess, "run", return_value=self.result(0, "TYPE=ext4\nUUID=existing\n")):
            with patch.object(BOOTSTRAP, "run") as command:
                BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_not_called()

    def test_recognized_non_ext4_filesystem_fails_closed(self) -> None:
        with patch.object(BOOTSTRAP.subprocess, "run", return_value=self.result(0, "TYPE=xfs\n")):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_not_called()

    def test_blkid_operational_error_fails_closed(self) -> None:
        with patch.object(BOOTSTRAP.subprocess, "run", return_value=self.result(4)):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_not_called()

    def test_unrecognized_signature_fails_closed(self) -> None:
        with patch.object(
            BOOTSTRAP.subprocess, "run",
            side_effect=[self.result(2), self.result(0, "offset TYPE\n0000   custom\n")],
        ):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_not_called()

    def test_unrecognized_nonzero_data_fails_closed(self) -> None:
        with patch.object(
            BOOTSTRAP.subprocess, "run",
            side_effect=[self.result(2), self.result(0), self.result(1)],
        ):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_not_called()

    def test_zero_scan_error_fails_closed(self) -> None:
        with patch.object(
            BOOTSTRAP.subprocess, "run",
            side_effect=[self.result(2), self.result(0), self.result(2)],
        ):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_not_called()

    def test_formats_only_when_signature_probe_and_full_zero_scan_pass(self) -> None:
        with patch.object(
            BOOTSTRAP.subprocess, "run",
            side_effect=[self.result(2), self.result(0), self.result(0), self.result(0, "TYPE=ext4\n")],
        ):
            with patch.object(BOOTSTRAP, "run") as command:
                BOOTSTRAP.ensure_ext4_or_format("/dev/sdc", 128 * 1024**3)

        command.assert_called_once_with("mkfs.ext4", "-m", "1", "-L", "qapaq-siem-data", "/dev/sdc")


class DebianArtifactMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.content = pathlib.Path(self.temporary_directory.name)
        self.manifest = {
            "artifacts": {
                "managerDeb": "manager.deb",
                "indexerDeb": "indexer.deb",
                "filebeatDeb": "filebeat.deb",
                "qapaqDashboardDeb": "dashboard.deb",
            },
            "debianPackages": {
                "wazuh-manager": "4.14.8-1",
                "wazuh-indexer": "4.14.8-1",
                "filebeat": "7.10.2-2",
                "wazuh-dashboard": "4.14.8-1qapaq1",
            },
        }
        for artifact in self.manifest["artifacts"].values():
            (self.content / artifact).write_bytes(b"test package placeholder")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def metadata(self, overrides: dict[tuple[str, str], str] | None = None):
        expected = {
            ("manager.deb", "Package"): "wazuh-manager",
            ("manager.deb", "Version"): "4.14.8-1",
            ("indexer.deb", "Package"): "wazuh-indexer",
            ("indexer.deb", "Version"): "4.14.8-1",
            ("filebeat.deb", "Package"): "filebeat",
            ("filebeat.deb", "Version"): "7.10.2-2",
            ("dashboard.deb", "Package"): "wazuh-dashboard",
            ("dashboard.deb", "Version"): "4.14.8-1qapaq1",
        }
        expected.update(
            {
                (filename, "Architecture"): "amd64"
                for filename in ("manager.deb", "indexer.deb", "filebeat.deb", "dashboard.deb")
            }
        )
        expected.update(overrides or {})

        def run_metadata(*args: str, capture: bool = False) -> str:
            return expected[(pathlib.Path(args[2]).name, args[3])]

        return run_metadata

    def test_accepts_debs_when_metadata_matches_manifest_and_pins(self) -> None:
        with patch.object(BOOTSTRAP, "run", side_effect=self.metadata()):
            BOOTSTRAP.validate_debian_artifacts(self.content, self.manifest)

    def test_rejects_package_name_mismatch_before_install(self) -> None:
        metadata = self.metadata({("manager.deb", "Package"): "unrelated-package"})
        with patch.object(BOOTSTRAP, "run", side_effect=metadata):
            with self.assertRaises(SystemExit):
                BOOTSTRAP.validate_debian_artifacts(self.content, self.manifest)

    def test_rejects_filebeat_version_even_if_manifest_matches_it(self) -> None:
        self.manifest["debianPackages"]["filebeat"] = "7.10.2-3"
        metadata = self.metadata({("filebeat.deb", "Version"): "7.10.2-3"})
        with patch.object(BOOTSTRAP, "run", side_effect=metadata):
            with self.assertRaises(SystemExit):
                BOOTSTRAP.validate_debian_artifacts(self.content, self.manifest)

    def test_rejects_non_amd64_package(self) -> None:
        metadata = self.metadata({("indexer.deb", "Architecture"): "arm64"})
        with patch.object(BOOTSTRAP, "run", side_effect=metadata):
            with self.assertRaises(SystemExit):
                BOOTSTRAP.validate_debian_artifacts(self.content, self.manifest)

    def test_invalid_package_metadata_blocks_main_before_install(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = pathlib.Path(temporary_directory)
            bundle_root = root / "qapaq-siem-release"
            (bundle_root / "packages").mkdir(parents=True)
            (bundle_root / "install.sh").write_text(
                "#!/usr/bin/env bash\n# Test payload; must never execute.\nexit 0\n",
                encoding="utf-8",
            )
            artifact_paths = {
                "managerDeb": "packages/manager.deb",
                "indexerDeb": "packages/indexer.deb",
                "filebeatDeb": "packages/filebeat.deb",
                "qapaqDashboardDeb": "packages/dashboard.deb",
                "qapaqCoreArchive": "packages/qapaq-core.tar.gz",
            }
            for relative_path in artifact_paths.values():
                (bundle_root / relative_path).write_bytes(b"test artifact")
            package_versions = {
                "wazuh-manager": "4.14.8-1",
                "wazuh-indexer": "4.14.8-1",
                "filebeat": "7.10.2-2",
                "wazuh-dashboard": "4.14.8-1qapaq1",
            }
            file_paths = ["install.sh", *artifact_paths.values()]
            manifest = {
                "schemaVersion": 1,
                "components": {
                    "wazuhManager": "4.14.8",
                    "wazuhIndexer": "4.14.8",
                    "wazuhFilebeat": "4.14.8",
                    "wazuhDashboard": "4.14.8",
                    "openSearchDashboards": "2.19.6",
                    "qapaqCoreNode": "24.21.0",
                },
                "qapaqDashboardPackage": "4.14.8-1qapaq1",
                "qapaqCoreSourceCommit": "a" * 12,
                "debianPackages": package_versions,
                "artifacts": artifact_paths,
                "files": {
                    relative_path: hashlib.sha256((bundle_root / relative_path).read_bytes()).hexdigest()
                    for relative_path in file_paths
                },
            }
            (bundle_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            bundle = root / "release.tar.gz"
            with tarfile.open(bundle, "w:gz") as archive:
                archive.add(bundle_root, arcname=bundle_root.name)
            artifact_sha256 = hashlib.sha256(bundle.read_bytes()).hexdigest()
            config = {"artifact_sha256": artifact_sha256, "data_disk_size_gb": 128}

            def copy_bundle(_config: dict, destination: pathlib.Path) -> None:
                destination.write_bytes(bundle.read_bytes())

            def invalid_metadata(*args: str, capture: bool = False) -> str:
                if args[3] == "Package":
                    return "not-wazuh-manager"
                return "4.14.8-1"

            with patch.object(BOOTSTRAP.os, "geteuid", return_value=0, create=True):
                with patch.object(BOOTSTRAP, "load_config", return_value=config):
                    with patch.object(BOOTSTRAP, "mount_data_disk"):
                        with patch.object(BOOTSTRAP, "fetch_bundle", side_effect=copy_bundle):
                            with patch.object(BOOTSTRAP, "materialize_secrets") as materialize:
                                with patch.object(BOOTSTRAP, "install_release") as install:
                                    with patch.object(BOOTSTRAP, "run", side_effect=invalid_metadata):
                                        with patch.object(BOOTSTRAP, "RELEASE_ROOT", root / "releases"):
                                            with patch.object(BOOTSTRAP.tarfile.TarFile, "chown"):
                                                with self.assertRaises(SystemExit):
                                                    BOOTSTRAP.main()

            materialize.assert_not_called()
            install.assert_not_called()
            self.assertFalse((root / "releases" / artifact_sha256).exists())


class RuntimeHealthTests(unittest.TestCase):
    @staticmethod
    def ready_response(status: int) -> MagicMock:
        response = MagicMock()
        response.status = status
        response.__enter__.return_value = response
        return response

    def test_requires_filebeat_and_core_worker_and_checks_api_readiness(self) -> None:
        with patch.object(BOOTSTRAP, "run") as run_service:
            with patch.object(BOOTSTRAP.urllib.request, "urlopen", return_value=self.ready_response(200)):
                BOOTSTRAP.validate_runtime_health()

        checked_services = {
            call.args[-1]
            for call in run_service.call_args_list
            if call.args[:3] == ("systemctl", "is-active", "--quiet")
        }
        self.assertIn("filebeat", checked_services)
        self.assertIn("qapaq-core-worker", checked_services)
        self.assertIn("qapaq-core-api", checked_services)

    def test_missing_systemd_service_fails_before_readiness_check(self) -> None:
        def service_missing(*args: str, **_kwargs: object) -> None:
            if args[-1] == "filebeat":
                raise SystemExit(1)

        with patch.object(BOOTSTRAP, "run", side_effect=service_missing):
            with patch.object(BOOTSTRAP.urllib.request, "urlopen") as urlopen:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.validate_runtime_health()

        urlopen.assert_not_called()

    def test_readiness_retries_timeout_and_non_200_until_200(self) -> None:
        with patch.object(BOOTSTRAP, "run"):
            with patch.object(
                BOOTSTRAP.urllib.request,
                "urlopen",
                side_effect=[TimeoutError("timed out"), self.ready_response(503), self.ready_response(200)],
            ) as urlopen:
                with patch.object(BOOTSTRAP.time, "sleep"):
                    BOOTSTRAP.validate_runtime_health()

        self.assertEqual(urlopen.call_count, 3)

    def test_readiness_fails_after_only_timeouts_or_non_200_responses(self) -> None:
        with patch.object(BOOTSTRAP, "run"):
            with patch.object(
                BOOTSTRAP.urllib.request,
                "urlopen",
                side_effect=[TimeoutError("timed out"), *[self.ready_response(503) for _ in range(59)]],
            ) as urlopen:
                with patch.object(BOOTSTRAP.time, "sleep"):
                    with self.assertRaises(SystemExit):
                        BOOTSTRAP.validate_runtime_health()

        self.assertEqual(urlopen.call_count, 60)


if __name__ == "__main__":
    unittest.main()
