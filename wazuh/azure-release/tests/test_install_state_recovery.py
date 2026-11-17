from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
CHECK_SCRIPT = ROOT / "wazuh/azure-release/check-install-state.sh"


@unittest.skipIf(os.name == "nt" or shutil.which("bash") is None, "requires a POSIX bash runtime")
class InstallStateRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary_directory.name)
        self.expected_manager_version = "4.14.8-1"
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(
            '{"debianPackages":{"wazuh-manager":"' + self.expected_manager_version + '"}}\n',
            encoding="utf-8",
        )
        self.data_root = self.root / "data"
        self.data_root.mkdir()
        for name in ("manager", "indexer", "dashboard"):
            (self.data_root / name).mkdir()
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self._write_executable(
            self.bin_dir / "dpkg-query",
            """#!/usr/bin/env bash
package="$3"
variable="FAKE_STATUS_${package//-/_}"
status="${!variable:-}"
if [[ -z "$status" ]]; then exit 1; fi
version_variable="FAKE_VERSION_${package//-/_}"
version="${!version_variable:-4.14.8-1}"
printf '%s|%s' "$status" "$version"
""",
        )
        self._write_executable(
            self.bin_dir / "systemctl",
            """#!/usr/bin/env bash
printf '%s' "${FAKE_ACTIVE_STATE:-inactive}"
""",
        )
        self.environment = os.environ.copy()
        self.environment.update(
            {
                "PATH": f"{self.bin_dir}{os.pathsep}{self.environment.get('PATH', '')}",
                "QAPAQ_DATA_ROOT": str(self.data_root),
                "QAPAQ_INSTALL_STATE_CORE_ROOT": str(self.root / "qapaq-core"),
                "FAKE_VERSION_wazuh_manager": self.expected_manager_version,
            }
        )

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    @staticmethod
    def _write_executable(path: pathlib.Path, contents: str) -> None:
        path.write_text(contents, encoding="utf-8")
        path.chmod(0o755)

    def _run(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        environment = self.environment | overrides
        return subprocess.run(
            ["bash", str(CHECK_SCRIPT), str(self.manifest)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_allows_only_manager_config_files_residue_on_empty_host(self) -> None:
        result = self._run(FAKE_STATUS_wazuh_manager="config-files")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("config-files de wazuh-manager", result.stdout)
        self.assertTrue((self.data_root / "manager").is_dir())

    def test_rejects_manager_config_files_from_a_different_version(self) -> None:
        result = self._run(
            FAKE_STATUS_wazuh_manager="config-files",
            FAKE_VERSION_wazuh_manager="4.14.7-1",
        )

        self.assertNotEqual(result.returncode, 0)

    def test_allows_clean_first_install(self) -> None:
        result = self._run()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("host limpio", result.stdout)

    def test_rejects_installed_or_partial_package_states(self) -> None:
        for variable, status in (
            ("FAKE_STATUS_wazuh_manager", "installed"),
            ("FAKE_STATUS_wazuh_manager", "half-installed"),
            ("FAKE_STATUS_wazuh_indexer", "config-files"),
            ("FAKE_STATUS_filebeat", "unpacked"),
        ):
            with self.subTest(variable=variable, status=status):
                result = self._run(**{variable: status})
                self.assertNotEqual(result.returncode, 0)

    def test_rejects_populated_or_unknown_durable_entries_without_deleting_them(self) -> None:
        data_file = self.data_root / "manager" / "state.db"
        data_file.write_text("preserve", encoding="utf-8")

        result = self._run(FAKE_STATUS_wazuh_manager="config-files")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(data_file.read_text(encoding="utf-8"), "preserve")

    def test_rejects_durable_secrets_without_deleting_them(self) -> None:
        secret_dir = self.data_root / "secrets"
        secret_dir.mkdir()
        secret_file = secret_dir / "installer-archive"
        secret_file.write_text("preserve", encoding="utf-8")

        result = self._run(FAKE_STATUS_wazuh_manager="config-files")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(secret_file.read_text(encoding="utf-8"), "preserve")

    def test_rejects_active_or_transitioning_service(self) -> None:
        for state in ("active", "activating", "failed"):
            with self.subTest(state=state):
                result = self._run(FAKE_STATUS_wazuh_manager="config-files", FAKE_ACTIVE_STATE=state)
                self.assertNotEqual(result.returncode, 0)

    def test_rejects_existing_core_and_any_install_marker(self) -> None:
        core_root = self.root / "qapaq-core"
        core_root.mkdir()
        result = self._run(FAKE_STATUS_wazuh_manager="config-files")
        self.assertNotEqual(result.returncode, 0)
        core_root.rmdir()

        marker = self.data_root / "bootstrap-install-state.json"
        marker.write_text("invalid", encoding="utf-8")
        result = self._run(FAKE_STATUS_wazuh_manager="config-files")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_text(encoding="utf-8"), "invalid")


if __name__ == "__main__":
    unittest.main()
