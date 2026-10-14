import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


REPOSITORY = Path(__file__).resolve().parents[2]
WORKFLOW = REPOSITORY / ".github" / "workflows" / "terraform-demo.yml"


def load_plan_gate() -> str:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    match = re.search(
        r'TFPLAN_JSON="\$RUNNER_TEMP/qapaq-tfplan\.json" python3 - <<\'PY\'\n(.*?)\n\s+PY',
        workflow,
        re.DOTALL,
    )
    if match is None:
        raise AssertionError("Terraform plan safety gate was not found")
    return textwrap.dedent(match.group(1))


class TerraformPlanGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.gate = load_plan_gate()

    def run_gate(self, resource_changes: list[dict]) -> subprocess.CompletedProcess:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as plan_file:
            json.dump({"resource_changes": resource_changes}, plan_file)
            plan_file.flush()
            environment = os.environ | {"TFPLAN_JSON": plan_file.name}
            return subprocess.run(
                [sys.executable, "-c", self.gate],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

    @staticmethod
    def change(address: str, resource_type: str, actions: list[str], before=None, after=None) -> dict:
        return {
            "address": address,
            "type": resource_type,
            "change": {"actions": actions, "before": before, "after": after},
        }

    def test_exact_qapaq_dashboard_records_and_non_dns_create_are_allowed(self):
        result = self.run_gate(
            [
                self.change("aws_route53_record.dashboard", "aws_route53_record", ["no-op"]),
                self.change(
                    "aws_route53_record.wazuh_dashboard[0]",
                    "aws_route53_record",
                    ["create"],
                    after={
                        "name": "qapaq-secops.jappi.net.pe",
                        "type": "A",
                        "records": ["198.51.100.42"],
                    },
                ),
                self.change(
                    "aws_route53_record.wazuh_dashboard_caa[0]",
                    "aws_route53_record",
                    ["create"],
                    after={
                        "name": "qapaq-secops.jappi.net.pe",
                        "type": "CAA",
                        "records": ['0 issue "letsencrypt.org"'],
                    },
                ),
                self.change("aws_ecs_service.worker", "aws_ecs_service", ["create"]),
            ]
        )

        self.assertEqual(0, result.returncode, result.stderr or result.stdout)

    def test_unapproved_route53_mutations_are_rejected(self):
        route53_resources = (
            ("aws_route53_record.dashboard", "aws_route53_record"),
            ("aws_route53_zone.public", "aws_route53_zone"),
            ("aws_route53_zone_association.private", "aws_route53_zone_association"),
            ("aws_route53_record.api", "aws_route53_record"),
        )
        for address, resource_type in route53_resources:
            for action in ("create", "update", "delete", "replace"):
                with self.subTest(resource_type=resource_type, action=action):
                    actions = ["delete", "create"] if action == "replace" else [action]
                    result = self.run_gate([self.change(address, resource_type, actions)])

                    self.assertNotEqual(0, result.returncode)
                    self.assertIn("unapproved DNS change", result.stdout)

    def test_dashboard_dns_allowlist_rejects_wrong_name_or_record(self):
        cases = (
            (
                "aws_route53_record.wazuh_dashboard[0]",
                {"name": "wazuh.jappi.net.pe", "type": "A", "records": ["198.51.100.42"]},
            ),
            (
                "aws_route53_record.wazuh_dashboard[0]",
                {"name": "qapaq-secops.jappi.net.pe", "type": "CNAME", "records": ["example.net"]},
            ),
            (
                "aws_route53_record.wazuh_dashboard_caa[0]",
                {"name": "qapaq-secops.jappi.net.pe", "type": "CAA", "records": ['0 issue "amazon.com"']},
            ),
        )
        for address, after in cases:
            with self.subTest(address=address, after=after):
                result = self.run_gate(
                    [self.change(address, "aws_route53_record", ["create"], after=after)]
                )

                self.assertNotEqual(0, result.returncode)
                self.assertIn("unapproved DNS change", result.stdout)

    def test_only_expected_dashboard_dns_updates_are_allowed(self):
        result = self.run_gate(
            [
                self.change(
                    "aws_route53_record.wazuh_dashboard[0]",
                    "aws_route53_record",
                    ["update"],
                    before={"name": "qapaq-secops.jappi.net.pe", "type": "A"},
                    after={
                        "name": "qapaq-secops.jappi.net.pe.",
                        "type": "A",
                        "records": ["198.51.100.42"],
                    },
                ),
                self.change(
                    "aws_route53_record.wazuh_dashboard_caa[0]",
                    "aws_route53_record",
                    ["update"],
                    before={"name": "qapaq-secops.jappi.net.pe", "type": "CAA"},
                    after={
                        "name": "qapaq-secops.jappi.net.pe",
                        "type": "CAA",
                        "records": ['0 issue "letsencrypt.org"'],
                    },
                ),
            ]
        )

        self.assertEqual(0, result.returncode, result.stderr or result.stdout)

    def test_any_secret_version_mutation_is_rejected(self):
        for action in ("create", "update", "delete", "replace"):
            with self.subTest(action=action):
                actions = ["delete", "create"] if action == "replace" else [action]
                result = self.run_gate(
                    [
                        self.change(
                            "module.cache.aws_secretsmanager_secret_version.auth_token",
                            "aws_secretsmanager_secret_version",
                            actions,
                        )
                    ]
                )

                self.assertNotEqual(0, result.returncode)
                self.assertIn("secret version changes are blocked", result.stdout)

    def test_valkey_auth_version_change_is_rejected(self):
        result = self.run_gate(
            [
                self.change(
                    "module.cache.aws_elasticache_replication_group.this",
                    "aws_elasticache_replication_group",
                    ["update"],
                    before={"auth_token_wo_version": 1},
                    after={"auth_token_wo_version": 2},
                )
            ]
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("Valkey AUTH version change is blocked", result.stdout)

    def test_unrelated_resource_deletion_is_rejected(self):
        result = self.run_gate(
            [self.change("aws_db_instance.main", "aws_db_instance", ["delete"])]
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("unexpected destroy/replacement", result.stdout)


if __name__ == "__main__":
    unittest.main()
