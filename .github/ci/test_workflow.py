import json
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

    def test_terraform_is_validated_without_backend_or_aws_access(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        terraform_job = workflow.split("  terraform:\n", 1)[1].split("\n  pnpm-audit:\n", 1)[0]
        gate_job = workflow.split("  gate:\n", 1)[1]

        self.assertIn("terraform fmt -check -recursive", terraform_job)
        self.assertIn("terraform init -backend=false", terraform_job)
        self.assertIn("-lockfile=readonly", terraform_job)
        self.assertIn("terraform validate -no-color", terraform_job)
        self.assertNotIn("configure-aws-credentials", terraform_job)
        self.assertNotIn("id-token: write", workflow)
        self.assertIn("terraform", gate_job.split("required = [", 1)[1].split("]", 1)[0])

    def test_container_manifest_has_a_matching_build(self):
        manifest_path = Path(__file__).parents[1] / "ci" / "containers.json"
        script_path = Path(__file__).parents[1] / "ci" / "verify-container-images.sh"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        script = script_path.read_text(encoding="utf-8")

        for image in manifest:
            dockerfile = re.escape(image["dockerfile"])
            context = re.escape(image["context"])
            with self.subTest(dockerfile=image["dockerfile"]):
                self.assertRegex(
                    script,
                    rf"(?m)^docker build --file {dockerfile} --tag qapaq-ci:\S+ {context}$",
                )

    def test_terraform_audit_skips_plan_and_mutating_steps(self):
        workflow = (WORKFLOWS / "terraform-demo.yml").read_text(encoding="utf-8")

        def step_body(name):
            match = re.search(
                rf"(?ms)^      - name: {re.escape(name)}\n(.*?)(?=^      - name:|\Z)",
                workflow,
            )
            self.assertIsNotNone(match, name)
            return match.group(1)

        plan_step = step_body("Terraform Plan")
        gate_step = step_body("Reject unexpected destruction or secret rotation")
        apply_step = step_body("Terraform Apply")

        self.assertNotIn("bootstrap-dns", workflow)
        self.assertIn("inputs.action != 'audit'", plan_step)
        self.assertIn("inputs.action != 'audit'", gate_step)
        self.assertIn("inputs.action == 'apply'", apply_step)
        self.assertIn("inputs.action == 'audit'", workflow)

    def test_apply_requires_http_200_for_dashboard_and_api(self):
        workflow = (WORKFLOWS / "terraform-demo.yml").read_text(encoding="utf-8")
        step = re.search(
            r"(?ms)^      - name: Verify public endpoints return HTTP 200\n(.*?)(?=^      - name:|\Z)",
            workflow,
        )
        self.assertIsNotNone(step)
        body = step.group(1)

        self.assertIn("inputs.action == 'apply'", body)
        self.assertIn("--write-out '%{http_code}'", body)
        self.assertIn('[[ "$http_status" == "200" ]]', body)
        self.assertIn("https://qapaq-secops.jappi.net.pe/qapaq-api/api/health/ready", body)
        self.assertIn('return 1', body)

    def test_dashboard_certificate_uses_lets_encrypt_and_automatic_renewal(self):
        repository = Path(__file__).resolve().parents[2]
        dns_config = (repository / "infra" / "aws" / "wazuh_dashboard_dns.tf").read_text(
            encoding="utf-8"
        )
        domain_script = (
            repository / "infra" / "aws" / "scripts" / "configure-wazuh-domain.sh"
        ).read_text(encoding="utf-8")
        bootstrap = (
            repository / "infra" / "aws" / "modules" / "wazuh_public" / "bootstrap.sh.tftpl"
        ).read_text(encoding="utf-8")

        self.assertIn('records = ["0 issue \\"letsencrypt.org\\""]', dns_config)
        self.assertIn('-d "$dashboard_hostname"', domain_script)
        self.assertIn("--keep-until-expiring", domain_script)
        self.assertIn("systemctl enable --now snap.certbot.renew.timer", bootstrap)
        self.assertIn("systemctl is-active --quiet snap.certbot.renew.timer", bootstrap)
        self.assertNotIn("snap.certbot.renew.timer || true", bootstrap)
        self.assertIn("systemctl is-active --quiet snap.certbot.renew.timer", domain_script)
        self.assertIn('certbot certificates --cert-name "$certificate_name"', domain_script)
        self.assertIn("/etc/letsencrypt/renewal-hooks/deploy/20-reload-nginx", bootstrap)
        self.assertIn("systemctl reload nginx", bootstrap)

    def test_worker_saas_egress_exception_is_scoped_and_expires(self):
        security = (
            Path(__file__).resolve().parents[2]
            / "infra"
            / "aws"
            / "modules"
            / "security"
            / "main.tf"
        ).read_text(encoding="utf-8")
        exception = re.search(
            r"(?m)^#trivy:ignore:AWS-0104:exp:2027-04-14\n"
            r'resource "aws_vpc_security_group_egress_rule" "worker_to_external_https" \{([^}]+)\}',
            security,
        )
        self.assertIsNotNone(exception)
        self.assertIn('from_port         = 443', exception.group(1))
        self.assertIn('to_port           = 443', exception.group(1))

    def test_historical_gitleaks_exceptions_are_exact_test_findings(self):
        repository = Path(__file__).resolve().parents[2]
        ignored = (repository / ".gitleaksignore").read_text(encoding="utf-8")
        self.assertIn(
            "31c02a30213c534a446b2790f9e9c7e6cbd53691:apps/api/test/idempotency.spec.ts:generic-api-key:11",
            ignored,
        )
        self.assertIn(
            "31c02a30213c534a446b2790f9e9c7e6cbd53691:platform/runtime/test/valkey.spec.ts:generic-api-key:450",
            ignored,
        )

    def test_wazuh_overlay_build_runs_on_pr_without_aws_permissions(self):
        workflow = (WORKFLOWS / "qapaq-dashboard.yml").read_text(encoding="utf-8")
        validate_job = workflow.split("  validate_overlay:\n", 1)[1].split("\n  build:\n", 1)[0]

        self.assertIn("  pull_request:\n", workflow)
        self.assertIn("if: github.event_name == 'pull_request'", validate_job)
        self.assertIn("permissions:\n      contents: read", validate_job)
        self.assertNotIn("id-token: write", validate_job)
        self.assertIn("bash wazuh/dashboard/build.sh", validate_job)
        self.assertIn("dpkg-deb --field ./*.deb Package Version", validate_job)

    def test_wazuh_overlay_build_uses_its_pinned_yarn_outside_the_repo_root(self):
        build = (Path(__file__).resolve().parents[2] / "wazuh/dashboard/build.sh").read_text(
            encoding="utf-8"
        )
        ensure_node = build.split("ensure_node() {", 1)[1].split("\n}", 1)[0]

        self.assertIn('local yarn_bin="$WORK/yarn/bin/yarn"', ensure_node)
        self.assertIn('npm install --global --silent --prefix "$WORK/yarn" "yarn@$YARN_VERSION"', ensure_node)
        self.assertIn('export PATH="$WORK/yarn/bin:$WORK/node/bin:$PATH"', ensure_node)
        self.assertNotRegex(ensure_node, r'\[\s*"\$\(yarn --version')
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
                self.assertRegex(block, r"(?m)^    timeout-minutes:\s*\d+\s*$", f"{path.name}: {header.group(1)}")

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


if __name__ == "__main__":
    unittest.main()
