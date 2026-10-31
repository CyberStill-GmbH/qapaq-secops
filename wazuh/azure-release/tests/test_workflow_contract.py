from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]
BUNDLE_WORKFLOW = ROOT / ".github/workflows/azure-siem-release-bundle.yml"
PUBLISH_WORKFLOW = ROOT / ".github/workflows/azure-siem-release-publish.yml"


class AzureReleaseWorkflowContractTests(unittest.TestCase):
    def test_bundle_requires_merged_candidate_sha_and_verified_build_provenance(self) -> None:
        workflow = BUNDLE_WORKFLOW.read_text(encoding="utf-8")
        assembler = (ROOT / "wazuh/azure-release/assemble_release.py").read_text(encoding="utf-8")

        for contract in (
            "release_sha:",
            "required: true",
            'git merge-base --is-ancestor "$RELEASE_SHA" "$GITHUB_SHA"',
            'git diff --quiet "$RELEASE_SHA" "$GITHUB_SHA" --',
            "wazuh/azure-release/install.sh",
            "wazuh/azure-release/check-install-state.sh",
            "wazuh/azure-release/assemble_release.py wazuh/azure-release/install.sh",
            "wazuh/azure-release/verify_wazuh_credentials_tar.py",
            "wazuh/azure-release/install_detection_rules.py",
            "wazuh/azure-release/configure_edge_azure.sh wazuh/azure-release/write_edge_config.py",
            "wazuh/edge wazuh/indexer/security wazuh/scripts/indexer-admin.sh",
            "infra/wazuh/endpoint/rules infra/wazuh/launch-detections/rules",
            "infra/wazuh/active-directory/rules",
            "infra/wazuh/active-directory/agent-groups infra/wazuh/active-directory/profile-catalog.json infra/wazuh/active-directory/README.md",
            "infra/wazuh/launch-detections/agent-groups",
            "infra/wazuh/teams",
            "docs/security/launch-detection-catalog-2026-10-20.json",
            "wazuh/core wazuh/dashboard wazuh/office365",
            "wazuh/provider-ingestion ':!wazuh/provider-ingestion/tests/**'",
            ".github/workflows/qapaq-dashboard-azure.yml .github/workflows/qapaq-core-azure.yml",
            "jq -e --arg sha \"$expected_sha\" --arg workflow \"$workflow\"",
            'artifact_name="$(jq -er --arg prefix "$artifact_prefix"',
            'artifacts="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/artifacts")"',
            '[[ "$DASHBOARD_BUILD_SHA" == "$CORE_BUILD_SHA" ]]',
            'release_tree="$(git rev-parse "$QAPAQ_SHA^{tree}")"',
            'grep -Fxq "commit=$DASHBOARD_BUILD_SHA" "$RUNNER_TEMP/dashboard/package-metadata.txt"',
            '.head_sha == $sha and (.head_branch == "main" or .event == "pull_request") and .status == "completed" and .conclusion == "success"',
            'validate_prerequisites_run "$PREREQUISITES_RUN_ID"',
            'git cat-file -e "$source_sha^{commit}"',
            'git merge-base --is-ancestor "$source_sha" "$RELEASE_SHA"',
            'git diff --quiet "$source_sha" "$RELEASE_SHA" -- .github/workflows/azure-siem-prerequisites-experimental.yml',
            'git/commits/$DASHBOARD_BUILD_SHA',
            'validate_run "$DASHBOARD_RUN_ID"',
            'validate_run "$CORE_RUN_ID"',
            'pattern: qapaq-dashboard-*',
            'pattern: qapaq-core-azure-*',
            'QAPAQ_SHA: ${{ inputs.release_sha }}',
            'assert manifest["qapaqCommit"] == sys.argv[3]',
            'assert manifest["agentProfilePack"]["status"] == "candidate-disabled"',
            'assert manifest["agentProfilePack"]["installerAppliesAgentProfiles"] is False',
            'assert set(manifest["detectionPack"]["installedByDefault"]) ==',
            'assert pack["status"] == "candidate-disabled"',
            'assert "agent-profiles" not in installer',
            'assert "agent-deployment" not in installer',
            'EDGE_HOSTNAME: ${{ inputs.edge_hostname }}',
            'ANKAY_PRIVATE_IP: ${{ inputs.ankay_private_ip }}',
            '--edge-config "$RUNNER_TEMP/edge.json"',
            'edge["hostname"] == os.environ["EDGE_HOSTNAME"]',
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, workflow)
        self.assertIn('"qapaqCommit": qapaq_commit', assembler)

    def test_siembundle_installer_never_activates_candidate_packs_or_agent_profiles(self) -> None:
        installer = (ROOT / "wazuh/azure-release/install.sh").read_text(encoding="utf-8")
        for forbidden in (
            "wazuh/priority/apply-priority.sh",
            "apply-agent-groups.sh",
            "Install-QapaqWazuhAgent.ps1",
            "wazuh/agent-deployment",
            "wazuh/agent-profiles",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, installer)

    def test_wazuh_aio_readiness_port_matches_qapaq_dashboard_and_edge(self) -> None:
        installer = (ROOT / "wazuh/azure-release/install.sh").read_text(encoding="utf-8")
        dashboard_config = (ROOT / "wazuh/dashboard/opensearch_dashboards.qapaq.yml").read_text(encoding="utf-8")
        edge_config = (ROOT / "wazuh/edge/qapaq-edge.conf").read_text(encoding="utf-8")

        self.assertIn("readonly QAPAQ_DASHBOARD_PORT=5601", installer)
        self.assertIn('--port "$QAPAQ_DASHBOARD_PORT"', installer)
        self.assertIn("server.port: 5601", dashboard_config)
        self.assertIn("server 127.0.0.1:5601;", edge_config)

    def test_publisher_checks_ancestor_and_bundle_manifest_commit(self) -> None:
        workflow = PUBLISH_WORKFLOW.read_text(encoding="utf-8")

        for contract in (
            "compare/$SOURCE_SHA...$bundle_run_sha",
            '(.status == "ahead" or .status == "identical") and .merge_base_commit.sha == $sha',
            'tar -xOf "$bundle" "$manifest_name"',
            "'.status == \"installable-candidate\" and .qapaqCommit == $sha'",
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, workflow)


if __name__ == "__main__":
    unittest.main()
