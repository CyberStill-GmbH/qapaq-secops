from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[2]
HELPER_PATH = pathlib.Path(__file__).with_name("prepare-eus2-postgres-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("eus2_postgres_bootstrap", HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)
TEMPLATE = json.loads((ROOT / "infra/azure/secrets/eus2-postgres-bootstrap.json").read_text(encoding="utf-8"))
WORKFLOW = (ROOT / ".github/workflows/bootstrap-eus2-postgres.yml").read_text(encoding="utf-8")
MASTER = "synthetic-admin-password"


def tokens():
    values = iter(["r" * 64, "e" * 64])
    return lambda _length: next(values)


class PostgresBootstrapParameterTests(unittest.TestCase):
    def build(self, create_entity_ref_key=False):
        return HELPER.build_parameters(
            master_password=MASTER,
            create_entity_ref_key=create_entity_ref_key,
            run_id="123456",
            run_attempt="1",
            token=tokens(),
        )["parameters"]

    def test_parameters_match_template_and_fixed_targets(self):
        parameters = self.build()
        self.assertTrue(set(parameters) <= set(TEMPLATE["parameters"]))
        for name in ("vaultName", "vmName", "location", "masterUsername"):
            self.assertIn(parameters[name]["value"], TEMPLATE["parameters"][name]["allowedValues"])
        self.assertEqual(parameters["runCommandName"]["value"], "qapaq-postgres-bootstrap-123456-1")
        self.assertEqual(parameters["runtimePassword"]["value"], "r" * 64)
        self.assertNotIn("entityRefKey", parameters)

    def test_entity_ref_key_is_only_generated_when_absent(self):
        parameters = self.build(create_entity_ref_key=True)
        self.assertTrue(parameters["createEntityRefKey"]["value"])
        self.assertEqual(parameters["entityRefKey"]["value"], "e" * 64)

    def test_secrets_are_secure_strings_and_only_reach_protected_parameters(self):
        for name in ("masterPassword", "runtimePassword", "entityRefKey"):
            self.assertEqual(TEMPLATE["parameters"][name]["type"], "secureString")
        run_command = next(
            resource
            for resource in TEMPLATE["resources"]
            if resource["type"] == "Microsoft.Compute/virtualMachines/runCommands"
        )
        properties = run_command["properties"]
        self.assertNotIn("parameters", properties)
        self.assertEqual(
            {item["name"] for item in properties["protectedParameters"]},
            {"QAPAQ_MASTER_USERNAME", "QAPAQ_MASTER_PASSWORD", "QAPAQ_RUNTIME_PASSWORD"},
        )
        self.assertTrue(properties["treatFailureAsDeploymentFailure"])
        self.assertFalse(properties["asyncExecution"])
        # Key Vault is written before the database changes, so a rerun always converges.
        self.assertTrue(any("qapaq-postgres-app-password" in item for item in run_command["dependsOn"]))
        self.assertNotIn(MASTER, json.dumps(TEMPLATE))

    def test_script_wraps_host_bootstrap_without_expansion(self):
        script = HELPER.run_command_script()
        self.assertTrue(script.startswith("#!/bin/bash\nset -euo pipefail\n"))
        self.assertIn(f"<<'{HELPER.HEREDOC_DELIMITER}'", script)
        self.assertTrue(script.rstrip("\n").endswith(HELPER.HEREDOC_DELIMITER))
        self.assertIn("azure-bootstrap", script)
        self.assertLessEqual(len(script), TEMPLATE["parameters"]["script"]["maxLength"])

    def test_rejects_invalid_inputs_without_echoing_values(self):
        for password in ("", "synthetic\nbreak"):
            with self.assertRaises(HELPER.BootstrapInputError) as raised:
                HELPER.build_parameters(
                    master_password=password,
                    create_entity_ref_key=False,
                    run_id="1",
                    run_attempt="1",
                    token=tokens(),
                )
            self.assertNotIn("synthetic", str(raised.exception))
        with self.assertRaises(HELPER.BootstrapInputError):
            HELPER.run_command_name("1; rm", "1")

    def test_parameter_file_is_private_and_create_only(self):
        payload = HELPER.build_parameters(
            master_password=MASTER,
            create_entity_ref_key=False,
            run_id="1",
            run_attempt="1",
            token=tokens(),
        )
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "parameters.json"
            HELPER.write_parameters(destination, payload)
            if os.name != "nt":
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                HELPER.write_parameters(destination, payload)


class PostgresBootstrapWorkflowTests(unittest.TestCase):
    def test_workflow_is_manual_main_only_and_confirmed(self):
        self.assertIn("workflow_dispatch:", WORKFLOW)
        self.assertIn("refs/heads/main", WORKFLOW)
        self.assertIn("BOOTSTRAP-EUS2-POSTGRES", WORKFLOW)
        self.assertNotIn("pull_request", WORKFLOW)

    def test_workflow_never_rotates_an_existing_entity_key_and_cleans_up(self):
        self.assertIn("qapaq-entity-ref-key", WORKFLOW)
        self.assertIn("CREATE_ENTITY_REF_KEY", WORKFLOW)
        self.assertIn("az vm run-command delete", WORKFLOW)
        self.assertIn("rm -f", WORKFLOW)

    def test_secrets_are_only_passed_through_environment(self):
        self.assertIn("POSTGRES_ADMIN_PASSWORD: ${{ secrets.AZURE_EUS2_POSTGRES_ADMIN_PASSWORD }}", WORKFLOW)
        self.assertNotIn("--protected-parameters", WORKFLOW)
        self.assertNotIn("set -x", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
