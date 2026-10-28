from __future__ import annotations

import importlib.util
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "install_detection_rules.py"
spec = importlib.util.spec_from_file_location("install_detection_rules", SCRIPT)
assert spec and spec.loader
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallDetectionRulesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / "wazuh"
        (self.root / "etc/rules").mkdir(parents=True)
        (self.root / "bin").mkdir()
        (self.root / "bin/wazuh-analysisd").write_text("test stub\n", encoding="utf-8")
        self.conf = self.root / "etc/ossec.conf"
        self.conf.write_text(
            "<ossec_config>\n  <ruleset>\n    <rule_dir>ruleset/rules</rule_dir>\n  </ruleset>\n</ossec_config>\n",
            encoding="utf-8",
        )
        repo_root = pathlib.Path(__file__).resolve().parents[3]
        self.bundle_wazuh = pathlib.Path(self.temp.name) / "bundle/wazuh"
        (self.bundle_wazuh / "launch-detections/rules").mkdir(parents=True)
        (self.bundle_wazuh / "endpoint/rules").mkdir(parents=True)
        (self.bundle_wazuh / "active-directory/rules").mkdir(parents=True)
        shutil.copyfile(
            repo_root / "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
            self.bundle_wazuh / "launch-detections/rules/qapaq_launch_provider_rules.xml",
        )
        shutil.copyfile(
            repo_root / "infra/wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
            self.bundle_wazuh / "endpoint/rules/qapaq_endpoint_rules.xml",
        )
        shutil.copyfile(
            repo_root / "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
            self.bundle_wazuh / "active-directory/rules/qapaq_active_directory_rules.xml",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_installs_rules_registers_local_directory_and_restarts(self) -> None:
        with patch.object(installer, "grp", None), patch.object(
            installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
        ) as run:
            installer.install(self.bundle_wazuh, self.root)

        self.assertIn("<rule_dir>etc/rules</rule_dir>", self.conf.read_text(encoding="utf-8"))
        self.assertTrue((self.root / "etc/rules/qapaq_launch_provider_rules.xml").is_file())
        self.assertTrue((self.root / "etc/rules/qapaq_endpoint_rules.xml").is_file())
        self.assertTrue((self.root / "etc/rules/qapaq_active_directory_rules.xml").is_file())
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[0][-1], "-t")
        self.assertEqual(run.call_args_list[1].args[0], ["systemctl", "restart", "wazuh-manager"])

    def test_repeat_does_not_duplicate_local_rules_directory(self) -> None:
        with patch.object(installer, "grp", None), patch.object(
            installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
        ):
            installer.install(self.bundle_wazuh, self.root)
            installer.install(self.bundle_wazuh, self.root)

        self.assertEqual(self.conf.read_text(encoding="utf-8").count("<rule_dir>etc/rules</rule_dir>"), 1)

    def test_analysisd_failure_restores_existing_config_and_rules(self) -> None:
        original_conf = self.conf.read_bytes()
        target = self.root / "etc/rules/qapaq_endpoint_rules.xml"
        target.write_text("previous endpoint rules\n", encoding="utf-8")
        with patch.object(installer, "grp", None), patch.object(
            installer.subprocess,
            "run",
            side_effect=[subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0)],
        ), self.assertRaisesRegex(installer.InstallError, "previous local rules were restored"):
            installer.install(self.bundle_wazuh, self.root)

        self.assertEqual(self.conf.read_bytes(), original_conf)
        self.assertEqual(target.read_text(encoding="utf-8"), "previous endpoint rules\n")
        self.assertFalse((self.root / "etc/rules/qapaq_launch_provider_rules.xml").exists())
        self.assertFalse((self.root / "etc/rules/qapaq_active_directory_rules.xml").exists())


if __name__ == "__main__":
    unittest.main()
