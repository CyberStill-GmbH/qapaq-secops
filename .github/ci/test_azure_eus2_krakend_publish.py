from pathlib import Path
import re
import unittest


WORKFLOW = Path(__file__).parents[1] / "workflows" / "azure-eus2-krakend-publish.yml"


class AzureEus2KrakenDPublishWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_publication_is_manual_main_only_and_requires_exact_commit_ci(self):
        self.assertIn("  workflow_dispatch:\n", self.workflow)
        self.assertNotIn("  pull_request:\n", self.workflow)
        self.assertGreaterEqual(self.workflow.count("if: github.ref == 'refs/heads/main'"), 3)
        self.assertIn("CI / required", self.workflow)
        self.assertIn('"$GITHUB_EVENT_NAME" == workflow_dispatch', self.workflow)
        self.assertIn("actions/workflows/ci.yml/runs?branch=main", self.workflow)
        self.assertIn("COMMIT_SHA: ${{ github.sha }}", self.workflow)
        self.assertIn("ref: ${{ github.sha }}", self.workflow)

    def test_ci_build_is_exact_existing_script_and_has_no_cloud_credentials(self):
        build_job = self.workflow.split("  build:\n", 1)[1].split("\n  publish:\n", 1)[0]
        self.assertIn("bash .github/ci/verify-container-images.sh", build_job)
        self.assertIn("docker save qapaq-ci:krakend", build_job)
        self.assertNotIn("id-token: write", build_job)
        self.assertNotIn("azure/login@", build_job)
        self.assertIn("retention-days: 1", build_job)

    def test_only_protected_publish_job_receives_oidc_and_targets_exact_eus2_acr(self):
        publish_job = self.workflow.split("  publish:\n", 1)[1]
        self.assertIn("environment: azure-demo-eus2", publish_job)
        self.assertIn("id-token: write", publish_job)
        self.assertEqual(self.workflow.count("id-token: write"), 1)
        self.assertIn("actions/workflows/ci.yml/runs?branch=main", publish_job)
        self.assertIn("azure/login@a641126d1b8aa4d1fa005f4f92df94a3a4c4c906", publish_job)
        self.assertIn('EXPECTED_SUBSCRIPTION_ID: "aaf787f8-5964-4470-9eb6-89d15eacda61"', publish_job)
        self.assertIn("EXPECTED_ACR_NAME: qapaqsecopsdemoeus3a2405f3", publish_job)
        self.assertIn("registries/qapaqsecopsdemoeus3a2405f3", publish_job)
        self.assertIn("== eastus2", publish_job)
        self.assertIn(".adminUserEnabled", publish_job)
        self.assertIn("${{ vars.AZURE_EUS2_GITHUB_PUBLISHER_CLIENT_ID }}", publish_job)

    def test_artifact_is_bound_to_source_commit_and_push_emits_digest_not_latest(self):
        publish_job = self.workflow.split("  publish:\n", 1)[1]
        self.assertIn("sha256sum --check --strict SHA256SUMS", publish_job)
        self.assertIn('grep -Fxq "commit=$COMMIT_SHA" metadata.txt', publish_job)
        self.assertIn('source_image=qapaq-ci:krakend', publish_job)
        self.assertIn('sha256sum krakend-image.tar.gz | awk', publish_job)
        self.assertIn("git-${COMMIT_SHA}-sha256-${image_sha256}", publish_job)
        self.assertIn("Refusing to overwrite an existing content-addressed image tag", publish_job)
        self.assertIn('^sha256:[0-9a-f]{64}$', publish_job)
        self.assertIn("${REPOSITORY}@${digest}", publish_job)
        self.assertEqual(publish_job.count('docker push "$image"'), 1)
        self.assertNotIn(":latest", publish_job)

    def test_workflow_does_not_deploy_or_mutate_infrastructure(self):
        self.assertNotIn("terraform apply", self.workflow.lower())
        self.assertNotIn("az containerapp", self.workflow.lower())
        self.assertNotIn("az network", self.workflow.lower())
        self.assertNotIn("docker push", self.workflow.split("  publish:\n", 1)[0])
        self.assertIn("Deployment: not performed.", self.workflow)

    def test_all_actions_are_pinned_and_every_job_has_timeout(self):
        action_lines = re.findall(r"(?m)^\s+uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$", self.workflow)
        self.assertGreater(len(action_lines), 0)
        for reference, comment in action_lines:
            self.assertRegex(reference, r"@[0-9a-fA-F]{40}$")
            self.assertRegex(comment or "", r"\bv\d")
        for job in ("ci-gate", "build", "publish"):
            section = re.search(
                rf"(?ms)^  {job}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)", self.workflow
            ).group(1)
            self.assertRegex(section, r"(?m)^    timeout-minutes:\s*\d+\s*$", job)


if __name__ == "__main__":
    unittest.main()
