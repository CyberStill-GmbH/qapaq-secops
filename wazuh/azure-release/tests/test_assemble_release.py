from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import unittest
from argparse import Namespace
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "assemble_release.py"
spec = importlib.util.spec_from_file_location("assemble_release", SCRIPT)
assert spec and spec.loader
assemble_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assemble_release)

INSTALLER_SCRIPT = SCRIPT.parent / "install_detection_rules.py"
installer_spec = importlib.util.spec_from_file_location("install_detection_rules_for_bundle_test", INSTALLER_SCRIPT)
assert installer_spec and installer_spec.loader
install_detection_rules = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(install_detection_rules)


class AssembleReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.assistant = self.root / "assistant"
        (self.assistant / ".git").mkdir(parents=True)
        (self.assistant / "wazuh-install.sh").write_text("#!/bin/bash\n", encoding="utf-8")
        (self.assistant / "LICENSE").write_text("GPL-2.0\n", encoding="utf-8")
        (self.assistant / "VERSION.json").write_text("{}\n", encoding="utf-8")
        self.inputs = {}
        for name in ("manager", "indexer", "filebeat", "dashboard", "fb-config", "key", "module", "template", "installer", "verify"):
            path = self.root / f"{name}.input"
            path.write_text(f"{name}\n", encoding="utf-8")
            self.inputs[name] = path
        self.inputs["core"] = self.root / "qapaq-core-0123456789ab.tar.gz"
        self.inputs["core"].write_bytes(b"fake archive input for contract assembly")
        self.inputs["installer"].write_text(
            'QAPAQ_O365_SECRET_SOURCE="file:$SECRETS/office365-client-secret"\n'
            'QAPAQ_PROVIDER_INGESTION_JSON=optional\n'
            'python3 "$HERE/wazuh/launch-detections/install_detection_rules.py"\n'
            'qapaq-teams-workflow-url optional\n'
            'python3 "$HERE/wazuh/teams/apply_teams_workflow.py"\n', encoding="utf-8"
        )
        (self.root / "output").mkdir()
        self.args = Namespace(
            assistant_dir=str(self.assistant), output_dir=str(self.root / "output"),
            qapaq_commit="0123456789abcdef0123456789abcdef01234567",
            manager_deb=str(self.inputs["manager"]), indexer_deb=str(self.inputs["indexer"]),
            filebeat_deb=str(self.inputs["filebeat"]), dashboard_deb=str(self.inputs["dashboard"]),
            core_archive=str(self.inputs["core"]), filebeat_config=str(self.inputs["fb-config"]),
            wazuh_signing_key=str(self.inputs["key"]), filebeat_module=str(self.inputs["module"]),
            filebeat_template=str(self.inputs["template"]), install_script=str(self.inputs["installer"]),
            verify_credentials_script=str(self.inputs["verify"]),
            repo_root=str(pathlib.Path(__file__).resolve().parents[3]),
            manager_commit="f" * 40, indexer_commit="e" * 40,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_assembles_contract_consumed_by_terraform_bootstrap(self) -> None:
        def fake_command(*args: str) -> str:
            if args[:3] == ("git", "-C", str(self.assistant.resolve())):
                return assemble_release.ASSISTANT_COMMIT if args[-1] == "HEAD" else assemble_release.ASSISTANT_TAG
            raise AssertionError(args)

        versions = {"wazuh-manager": "4.14.8-1", "wazuh-indexer": "4.14.8-1", "filebeat": "7.10.2-2", "wazuh-dashboard": "4.14.8-1qapaq1"}

        def fake_package(path: pathlib.Path, name: str, version: str | None = None) -> str:
            actual = versions[name]
            if version and actual != version:
                raise ValueError("unexpected Debian version")
            return actual

        with patch.object(assemble_release, "command", side_effect=fake_command), patch.object(
            assemble_release, "validate_package", side_effect=fake_package
        ):
            bundle = assemble_release.assemble(self.args)

        root = self.root / "output" / "qapaq-siem-0123456789ab"
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["debianPackages"], versions)
        self.assertEqual(manifest["qapaqCommit"], self.args.qapaq_commit)
        self.assertEqual(manifest["qapaqCoreSourceCommit"], "0123456789ab")
        self.assertEqual(manifest["components"]["openSearchDashboards"], "2.19.6")
        self.assertEqual(manifest["qapaqAssistant"]["name"], "Qapaqzito")
        self.assertEqual(manifest["qapaqAssistant"]["status"], "bundled-with-dashboard-and-core")
        self.assertEqual(manifest["qapaqAssistant"]["provider"], "anthropic")
        self.assertEqual(manifest["qapaqAssistant"]["activation"], "assistant_secret_name-and-api-egress-required")
        self.assertFalse(manifest["qapaqAssistant"]["secretValueBundled"])
        self.assertIn("wazuh/azure-release/normalize_ubuntu_apt_sources.py", manifest["files"])
        self.assertIn("wazuh/office365/apply-office365.sh", manifest["files"])
        self.assertIn("wazuh/office365/ossec-office365.xml.tmpl", manifest["files"])
        self.assertIn("wazuh/office365/rules/qapaq_office365_rules.xml", manifest["files"])
        self.assertIn("wazuh/provider-ingestion/cato/events_feed.py", manifest["files"])
        self.assertIn("wazuh/teams/custom-qapaq-teams", manifest["files"])
        self.assertIn("wazuh/teams/apply_teams_workflow.py", manifest["files"])
        self.assertIn("wazuh/teams/ossec-teams-workflow.xml", manifest["files"])
        for edge_file in (
            "wazuh/azure-release/configure_edge_azure.sh",
            "wazuh/edge/apply-edge.sh",
            "wazuh/edge/qapaq-edge.conf",
            "wazuh/indexer/security/apply-security.sh",
            "wazuh/dashboard/opensearch_dashboards.qapaq.yml",
        ):
            self.assertIn(edge_file, manifest["files"])
        self.assertIn("wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml", manifest["files"])
        self.assertIn("wazuh/endpoint/rules/qapaq_endpoint_rules.xml", manifest["files"])
        self.assertIn("wazuh/active-directory/rules/qapaq_active_directory_rules.xml", manifest["files"])
        self.assertEqual(
            set(manifest["detectionPack"]["rules"]),
            {
                "wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
                "wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
                "wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
                "wazuh/finance/rules/qapaq_finance_rules.xml",
                "wazuh/priority/rules/qapaq_priority_rules.xml",
            },
        )
        self.assertEqual(
            set(manifest["detectionPack"]["installedByDefault"]),
            {
                "wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
                "wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
                "wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
            },
        )
        installer_rules = {
            (pathlib.PurePosixPath("wazuh") / rule.as_posix()).as_posix()
            for rule in install_detection_rules.RULE_FILES
        }
        self.assertEqual(set(manifest["detectionPack"]["installedByDefault"]), installer_rules)
        self.assertEqual(
            manifest["detectionPack"]["activation"],
            "baseline-rules-installed-context-packs-require-live-cdb-lists-and-review",
        )
        finance_pack = manifest["detectionPack"]["candidatePacks"]["finance"]
        self.assertEqual(finance_pack["status"], "candidate-disabled")
        self.assertTrue(finance_pack["requiresProductionContextLists"])
        self.assertEqual(finance_pack["evidence"], "synthetic-logtest-only")
        priority_pack = manifest["detectionPack"]["candidatePacks"]["priority"]
        self.assertEqual(priority_pack["status"], "candidate-disabled")
        self.assertTrue(priority_pack["requiresProductionContextLists"])
        self.assertEqual(priority_pack["evidence"], "synthetic-logtest-only")
        for path in finance_pack["contextLists"] + priority_pack["contextLists"]:
            self.assertIn(path, manifest["files"])
        self.assertIn("wazuh/launch-detections/catalog.json", manifest["files"])
        self.assertIn("wazuh/launch-detections/install_detection_rules.py", manifest["files"])
        self.assertEqual(
            manifest["detectionPack"]["activation"],
            "baseline-rules-installed-context-packs-require-live-cdb-lists-and-review",
        )
        profile_pack = manifest["agentProfilePack"]
        self.assertEqual(profile_pack["status"], "candidate-disabled")
        self.assertEqual(profile_pack["activation"], "owner-approval-and-domain-controller-pilot-required")
        self.assertFalse(profile_pack["installerAppliesAgentProfiles"])
        self.assertEqual(
            set(profile_pack["profiles"]),
            {
                "wazuh/agent-profiles/windows-domain-controller.agent.conf",
                "wazuh/agent-profiles/windows-pilot.agent.conf",
                "wazuh/agent-profiles/windows-sysmon-pilot.agent.conf",
            },
        )
        self.assertIn("wazuh/agent-profiles/active-directory/profile-catalog.json", manifest["files"])
        self.assertIn("wazuh/agent-profiles/active-directory/README.md", manifest["files"])
        agent_pack = manifest["agentDeploymentPack"]
        self.assertEqual(agent_pack["status"], "candidate-pilot-required")
        self.assertEqual(agent_pack["activation"], "owner-approval-pilot-per-profile")
        self.assertFalse(agent_pack["installerAppliesAgentProfiles"])
        self.assertTrue(agent_pack["requiresPrivacyReviewForCommandLines"])
        self.assertIn("wazuh/agent-deployment/profile-catalog.json", manifest["files"])
        self.assertIn("wazuh/agent-deployment/deploy/windows/Install-QapaqWazuhAgent.ps1", manifest["files"])
        self.assertIn("wazuh/agent-deployment/docs/README.md", manifest["files"])
        self.assertIn("wazuh/priority/apply-priority.sh", manifest["files"])
        context_sources = [
            pathlib.Path(self.args.repo_root) / "infra" / path
            for pack in manifest["detectionPack"]["candidatePacks"].values()
            for path in pack["contextLists"]
        ]
        for source in context_sources:
            with self.subTest(context_list=source.name):
                assemble_release.validate_synthetic_context_list(source)
        installer_text = (root / "install.sh").read_text(encoding="utf-8")
        self.assertNotIn("agent-profiles", installer_text)
        self.assertNotIn("agent-deployment", installer_text)
        self.assertIn("install_detection_rules.py", (root / "install.sh").read_text(encoding="utf-8"))
        self.assertIn("qapaq-teams-workflow-url", (root / "install.sh").read_text(encoding="utf-8"))
        state_check = root / "wazuh/azure-release/check-install-state.sh"
        self.assertTrue(state_check.is_file())
        self.assertIn("config-files", state_check.read_text(encoding="utf-8"))
        self.assertIn("wazuh/provider-ingestion/sophos/upstream/LICENSE-2.0.txt", manifest["files"])
        self.assertIn("wazuh/provider-ingestion/sophos/UPSTREAM-SOURCE.json", manifest["files"])
        self.assertEqual(
            manifest["sources"]["sophosCentralSiemIntegration"]["commit"],
            assemble_release.SOPHOS_SIEM_COMMIT,
        )
        office365_script = (root / "wazuh" / "office365" / "apply-office365.sh").read_text().lower()
        self.assertIn("file:*", office365_script)
        # El bootstrap de Azure rechaza cualquier llamada AWS dentro del bundle.
        self.assertNotIn("aws-secretsmanager", office365_script)
        self.assertNotIn("aws secretsmanager", office365_script)
        azure_installer = (root / "install.sh").read_text().lower()
        self.assertIn('qapaq_o365_secret_source="file:$secrets/office365-client-secret"', azure_installer)
        self.assertNotIn("aws-secretsmanager:", azure_installer)
        self.assertIn("qapaq_provider_ingestion_json", azure_installer)
        self.assertIn("wazuh/teams/apply_teams_workflow.py", azure_installer)
        self.assertEqual(manifest["optionalIntegrations"], ["sophos-central-siem-api", "cato-events-feed", "microsoft-teams-workflows"])
        self.assertEqual(set(("managerDeb", "indexerDeb", "filebeatDeb", "qapaqDashboardDeb", "qapaqCoreArchive")) - set(manifest["artifacts"]), set())
        for filename, digest in manifest["files"].items():
            self.assertEqual(assemble_release.sha256(root / filename), digest)
        self.assertTrue(bundle.is_file())
        self.assertEqual(assemble_release.sha256(bundle), (self.root / "output" / "SHA256SUMS").read_text().split()[0])
        # El edge y Ankay se empaquetan siempre, pero sin edge.json install.sh no los aplica.
        for packaged in (
            "wazuh/azure-release/configure_edge_azure.sh",
            "wazuh/edge/apply-edge.sh",
            "wazuh/indexer/security/apply-security.sh",
            "wazuh/scripts/indexer-admin.sh",
            "wazuh/shuffle/apply_ankay_webhook.py",
            "wazuh/shuffle/custom-qapaq-shuffle",
        ):
            self.assertIn(packaged, manifest["files"])
        self.assertNotIn("edge.json", manifest["files"])
        real_installer = (pathlib.Path(__file__).resolve().parents[1] / "install.sh").read_text(encoding="utf-8")
        self.assertIn('if [[ -s "$HERE/edge.json" ]]', real_installer)

    def test_rejects_dirty_output_directory(self) -> None:
        (self.root / "output" / "keep.txt").write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "output directory must be empty"):
            assemble_release.assemble(self.args)

    def test_rejects_context_list_without_synthetic_domain_marker(self) -> None:
        context_list = self.root / "qapaq-real-context.example"
        context_list.write_text("finance-admin@qapaq.pe:admin\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "non-synthetic key"):
            assemble_release.validate_synthetic_context_list(context_list)

    def test_bundles_public_edge_config_when_requested_without_ankay(self) -> None:
        edge_config = self.root / "edge.json"
        edge_config.write_text(
            '{"schemaVersion": 1, "hostname": "app.jappi.net.pe", "extraHostnames": []}\n',
            encoding="utf-8",
        )
        self.args.edge_config = str(edge_config)

        def fake_command(*args: str) -> str:
            if args[:3] == ("git", "-C", str(self.assistant.resolve())):
                return assemble_release.ASSISTANT_COMMIT if args[-1] == "HEAD" else assemble_release.ASSISTANT_TAG
            raise AssertionError(args)

        versions = {
            "wazuh-manager": "4.14.8-1",
            "wazuh-indexer": "4.14.8-1",
            "filebeat": "7.10.2-2",
            "wazuh-dashboard": "4.14.8-1qapaq1",
        }

        with patch.object(assemble_release, "command", side_effect=fake_command), patch.object(
            assemble_release,
            "validate_package",
            side_effect=lambda path, name, version=None: versions[name],
        ):
            bundle = assemble_release.assemble(self.args)

        root = self.root / "output" / "qapaq-siem-0123456789ab"
        edge = json.loads((root / "edge.json").read_text(encoding="utf-8"))
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(edge["hostname"], "app.jappi.net.pe")
        self.assertNotIn("ankayUpstream", edge)
        self.assertIn("edge.json", manifest["files"])
        self.assertEqual(manifest["files"]["edge.json"], assemble_release.sha256(root / "edge.json"))
        self.assertTrue(bundle.is_file())


if __name__ == "__main__":
    unittest.main()
