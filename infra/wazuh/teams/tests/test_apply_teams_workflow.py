import importlib.util
import pathlib
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).parents[1] / "apply_teams_workflow.py"
SPEC = importlib.util.spec_from_file_location("apply_teams_workflow", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TeamsWorkflowInstallerTests(unittest.TestCase):
    def test_adds_block_once_and_replaces_owned_block_idempotently(self):
        config = "<ossec_config>\n  <global/>\n</ossec_config>\n"
        block = "<integration><name>custom-qapaq-teams</name></integration>"
        installed = MODULE.merge_config(config, block)
        self.assertEqual(installed.count("<name>custom-qapaq-teams</name>"), 1)
        self.assertEqual(MODULE.merge_config(installed, block), installed)

    def test_refuses_unmarked_existing_integration(self):
        config = (
            "<ossec_config><integration><name>custom-qapaq-teams</name>"
            "</integration></ossec_config>"
        )
        with self.assertRaisesRegex(ValueError, "sin los marcadores"):
            MODULE.merge_config(config, "<integration/>")

    def test_rejects_duplicate_owned_blocks_or_missing_root(self):
        duplicate = (
            "<ossec_config>\n"
            + MODULE.BEGIN + "\nx\n" + MODULE.END + "\n"
            + MODULE.BEGIN + "\ny\n" + MODULE.END + "\n"
            + "</ossec_config>"
        )
        with self.assertRaisesRegex(ValueError, "más de un bloque"):
            MODULE.merge_config(duplicate, "<integration/>")
        with self.assertRaisesRegex(ValueError, "no contiene el cierre"):
            MODULE.merge_config("<bad/>", "<integration/>")

    def test_accepts_synthetic_current_workflows_endpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            secret = pathlib.Path(temporary) / "secret"
            secret.write_text(
                "https://prod-01.westus.logic.azure.com/workflows/id/triggers/manual/paths/invoke?sig=synthetic",
                encoding="utf-8",
            )
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
            with patch.object(pathlib.Path, "lstat", return_value=metadata):
                MODULE.validate_secret_file(secret)

    def test_rejects_legacy_endpoint_non_root_owner_and_loose_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            secret = pathlib.Path(temporary) / "secret"
            secret.write_text("https://outlook.office.com/IncomingWebhook/x", encoding="utf-8")
            good_file = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
            with patch.object(pathlib.Path, "lstat", return_value=good_file):
                with self.assertRaises(SystemExit):
                    MODULE.validate_secret_file(secret)
            for metadata in (
                SimpleNamespace(st_mode=stat.S_IFREG | 0o640, st_uid=0),
                SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1000),
                SimpleNamespace(st_mode=stat.S_IFLNK | 0o600, st_uid=0),
            ):
                with patch.object(pathlib.Path, "lstat", return_value=metadata):
                    with self.assertRaises(SystemExit):
                        MODULE.validate_secret_file(secret)

    def test_rejects_non_https_port_even_on_a_workflows_hostname(self):
        with tempfile.TemporaryDirectory() as temporary:
            secret = pathlib.Path(temporary) / "secret"
            secret.write_text(
                "https://prod-01.westus.logic.azure.com:8443/workflows/id?sig=synthetic",
                encoding="utf-8",
            )
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
            with patch.object(pathlib.Path, "lstat", return_value=metadata):
                with self.assertRaises(SystemExit):
                    MODULE.validate_secret_file(secret)


if __name__ == "__main__":
    unittest.main()
