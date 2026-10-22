"""Security regression tests for the Azure SIEM first-boot bootstrap."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch


BOOTSTRAP_PATH = pathlib.Path(__file__).with_name("bootstrap-siem.py")
SPEC = importlib.util.spec_from_file_location("qapaq_siem_bootstrap", BOOTSTRAP_PATH)
assert SPEC is not None and SPEC.loader is not None
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
with patch.dict(sys.modules, {"pwd": types.ModuleType("pwd")}):
    SPEC.loader.exec_module(BOOTSTRAP)


class InstallerOutputTests(unittest.TestCase):
    def test_installer_output_is_discarded_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            release = pathlib.Path(temporary_directory)
            installer = release / "install.sh"
            installer.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            captured_output = io.StringIO()
            completed = SimpleNamespace(
                returncode=17,
                stdout="CANARY_SECRET_FROM_INSTALLER",
                stderr="CANARY_SECRET_FROM_INSTALLER",
            )

            with patch.object(BOOTSTRAP.subprocess, "run", return_value=completed) as run_installer:
                with contextlib.redirect_stdout(captured_output):
                    with self.assertRaises(SystemExit) as failure:
                        BOOTSTRAP.install_release(release)

            self.assertEqual(failure.exception.code, 1)
            self.assertNotIn("CANARY_SECRET_FROM_INSTALLER", captured_output.getvalue())
            self.assertIn("código 17", captured_output.getvalue())
            self.assertIs(run_installer.call_args.kwargs["stdout"], BOOTSTRAP.subprocess.DEVNULL)
            self.assertIs(run_installer.call_args.kwargs["stderr"], BOOTSTRAP.subprocess.DEVNULL)


if __name__ == "__main__":
    unittest.main()
