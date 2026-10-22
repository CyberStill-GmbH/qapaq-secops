"""Security regression tests for the Azure SIEM first-boot bootstrap."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import sys
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
                            BOOTSTRAP.install_release(release)

            self.assertEqual(failure.exception.code, 1)
            self.assertNotIn("CANARY_SECRET_FROM_INSTALLER", captured_output.getvalue())
            self.assertIn("código 17", captured_output.getvalue())
            self.assertIs(run_installer.call_args.kwargs["stdout"], BOOTSTRAP.subprocess.DEVNULL)
            self.assertIs(run_installer.call_args.kwargs["stderr"], BOOTSTRAP.subprocess.DEVNULL)


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


class RuntimeHealthTests(unittest.TestCase):
    def test_requires_filebeat_and_core_worker_and_checks_api_readiness(self) -> None:
        response = MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        with patch.object(BOOTSTRAP, "run") as run_service:
            with patch.object(BOOTSTRAP.urllib.request, "urlopen", return_value=response):
                BOOTSTRAP.validate_runtime_health()

        checked_services = {
            call.args[-1]
            for call in run_service.call_args_list
            if call.args[:3] == ("systemctl", "is-active", "--quiet")
        }
        self.assertIn("filebeat", checked_services)
        self.assertIn("qapaq-core-worker", checked_services)
        self.assertIn("qapaq-core-api", checked_services)


if __name__ == "__main__":
    unittest.main()
