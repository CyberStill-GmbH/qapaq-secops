from pathlib import Path
import re
import unittest


WORKFLOW = Path(__file__).parents[1] / "workflows" / "ci.yml"
WORKFLOWS = Path(__file__).parents[1] / "workflows"


class CodeQLWorkflowTests(unittest.TestCase):
    def test_analysis_is_preserved_without_requiring_code_scanning(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("github/codeql-action/analyze@", workflow)
        self.assertIn("output: codeql-results", workflow)
        self.assertIn("upload: never", workflow)
        self.assertIn("upload-database: false", workflow)
        self.assertIn("actions/upload-artifact@", workflow)
        self.assertIn("path: codeql-results", workflow)
        self.assertIn("if-no-files-found: error", workflow)

    def test_codeql_job_has_least_privilege_permissions(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        codeql_job = workflow.split("  codeql:\n", 1)[1].split("\n  secrets:\n", 1)[0]

        self.assertIn("actions: read", codeql_job)
        self.assertIn("contents: read", codeql_job)
        self.assertNotIn("security-events: write", codeql_job)


class WorkflowPolicyTests(unittest.TestCase):
    def test_pr_workflow_uses_read_only_permissions_and_no_privileged_pr_event(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("  pull_request:\n", workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertRegex(workflow, r"(?m)^permissions:\n  contents: read$")
        self.assertNotRegex(workflow, r"(?m)^\s+(?:contents|pull-requests):\s*write\s*$")
        self.assertNotRegex(workflow, r"(?m)^\s*continue-on-error:")
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("cancel-in-progress: true", workflow)

    def test_all_jobs_have_timeouts_and_actions_use_full_commit_shas(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        job_section = workflow.split("jobs:\n", 1)[1]
        job_headers = list(re.finditer(r"(?m)^  ([a-zA-Z0-9_-]+):\s*$", job_section))

        self.assertGreater(len(job_headers), 0)
        for index, header in enumerate(job_headers):
            end = job_headers[index + 1].start() if index + 1 < len(job_headers) else len(job_section)
            block = job_section[header.start():end]
            self.assertRegex(block, r"(?m)^    timeout-minutes:\s*\d+\s*$", header.group(1))

        action_lines = re.findall(r"(?m)^\s*-\s+uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$", workflow)
        self.assertGreater(len(action_lines), 0)
        for reference, comment in action_lines:
            self.assertRegex(reference, r"@(?:[0-9a-fA-F]{40})$", reference)
            self.assertRegex(comment or "", r"\bv\d", reference)

    def test_frozen_lockfile_and_stable_required_aggregator_are_present(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("pnpm install --frozen-lockfile", workflow)
        self.assertIn("name: CI / required", workflow)
        self.assertIn("if: always()", workflow)
        self.assertIn("jobs[name]['result'] != 'success'", workflow)

    def test_qapaq_dashboard_pr_build_is_read_only(self):
        workflow = (WORKFLOWS / "qapaq-dashboard.yml").read_text(encoding="utf-8")
        validate_job = workflow.split("  validate-dashboard:\n", 1)[1].split(
            "\n  build-dashboard:\n", 1
        )[0]

        self.assertIn("  pull_request:\n", workflow)
        self.assertIn("github.event_name == 'pull_request'", validate_job)
        self.assertIn("permissions:\n      contents: read", validate_job)
        self.assertNotIn("id-token: write", validate_job)
        self.assertIn("bash wazuh/dashboard/build.sh", validate_job)
        self.assertIn("sha256sum -c SHA256SUMS", validate_job)

    def test_qapaq_dashboard_uses_its_pinned_yarn_outside_corepack_context(self):
        build = (Path(__file__).resolve().parents[2] / "wazuh/dashboard/build.sh").read_text(
            encoding="utf-8"
        )
        ensure_node = build.split("ensure_node() {", 1)[1].split("\n}", 1)[0]

        self.assertIn('local yarn_bin="$WORK/yarn/bin/yarn"', ensure_node)
        self.assertIn(
            'npm install --global --silent --prefix "$WORK/yarn" "yarn@$YARN_VERSION"',
            ensure_node,
        )
        self.assertIn('export PATH="$WORK/yarn/bin:$WORK/node/bin:$PATH"', ensure_node)
        self.assertIn("hash -r", ensure_node)
        self.assertRegex(build, r'\(\s*cd "\$OSD"\s+yarn config set network-timeout')

    def test_policy_rejects_unpinned_action_reference(self):
        fixture = "      - uses: actions/checkout@v4 # v4\n"
        reference = re.search(r"(?m)^\s*-\s+uses:\s*([^\s#]+)", fixture).group(1)

        self.assertNotRegex(reference, r"@(?:[0-9a-fA-F]{40})$")

    def test_all_workflows_pin_external_actions_and_set_job_timeouts(self):
        for path in WORKFLOWS.glob("*.yml"):
            workflow = path.read_text(encoding="utf-8")
            action_lines = re.findall(r"(?m)^\s*-\s+uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$", workflow)
            for reference, comment in action_lines:
                self.assertRegex(reference, r"@(?:[0-9a-fA-F]{40})$", f"{path.name}: {reference}")
                self.assertRegex(comment or "", r"\bv\d", f"{path.name}: missing readable action version")

            job_section = workflow.split("jobs:\n", 1)[1]
            headers = list(re.finditer(r"(?m)^  ([a-zA-Z0-9_-]+):\s*$", job_section))
            for index, header in enumerate(headers):
                end = headers[index + 1].start() if index + 1 < len(headers) else len(job_section)
                block = job_section[header.start():end]
                self.assertRegex(
                    block,
                    r"(?m)^    timeout-minutes:\s*\d+\s*(?:#.*)?$",
                    f"{path.name}: {header.group(1)}",
                )

    def test_evidence_runs_only_after_successful_main_push_and_scans_before_upload(self):
        workflow = (WORKFLOWS / "evidence.yml").read_text(encoding="utf-8")

        self.assertIn("workflow_run:", workflow)
        self.assertIn("github.event.workflow_run.event == 'push'", workflow)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", workflow)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", workflow)
        self.assertIn("actions: read", workflow)
        self.assertIn("contents: read", workflow)
        self.assertIn("gitleaks dir --redact=100 --exit-code=1", workflow)
        self.assertLess(workflow.index("gitleaks dir"), workflow.index("actions/upload-artifact@"))
        self.assertIn("retention-days: 14", workflow)


    def test_release_bundle_summary_quotes_revision_safely(self):
        workflow = (WORKFLOWS / "azure-siem-release-bundle.yml").read_text(
            encoding="utf-8"
        )
        summary_step = workflow.split(
            "      - name: Summarize runtime gates\n", 1
        )[1].split("\n      - name:", 1)[0]

        self.assertIn("RELEASE_SHA: ${{ inputs.release_sha }}", summary_step)
        self.assertIn("printf '%s\\n'", summary_step)
        self.assertIn(r"\`$RELEASE_SHA\`", summary_step)
        self.assertNotIn(
            'echo "- QAPAQ source commit: `${{ inputs.release_sha }}`', summary_step
        )


if __name__ == "__main__":
    unittest.main()
