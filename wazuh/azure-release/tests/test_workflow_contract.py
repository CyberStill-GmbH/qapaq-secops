from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]
BUNDLE_WORKFLOW = ROOT / ".github/workflows/azure-siem-release-bundle.yml"
PUBLISH_WORKFLOW = ROOT / ".github/workflows/azure-siem-release-publish.yml"


class AzureReleaseWorkflowContractTests(unittest.TestCase):
    def test_bundle_requires_merged_candidate_sha_and_exact_source_runs(self) -> None:
        workflow = BUNDLE_WORKFLOW.read_text(encoding="utf-8")
        assembler = (ROOT / "wazuh/azure-release/assemble_release.py").read_text(encoding="utf-8")

        for contract in (
            "release_sha:",
            "required: true",
            'git merge-base --is-ancestor "$RELEASE_SHA" "$GITHUB_SHA"',
            'git diff --quiet "$RELEASE_SHA" "$GITHUB_SHA" --',
            "wazuh/azure-release/install.sh wazuh/azure-release/verify_wazuh_credentials_tar.py",
            "wazuh/core wazuh/dashboard wazuh/office365",
            "wazuh/provider-ingestion ':!wazuh/provider-ingestion/tests/**'",
            "jq -e --arg sha \"$RELEASE_SHA\" --arg workflow \"$workflow\"",
            ".head_sha == $sha and .head_branch == \"main\" and .status == \"completed\" and .conclusion == \"success\"",
            'name: qapaq-dashboard-${{ inputs.release_sha }}',
            'name: qapaq-core-azure-${{ inputs.release_sha }}',
            'QAPAQ_SHA: ${{ inputs.release_sha }}',
            'assert manifest["qapaqCommit"] == sys.argv[3]',
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, workflow)
        self.assertIn('"qapaqCommit": qapaq_commit', assembler)

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
