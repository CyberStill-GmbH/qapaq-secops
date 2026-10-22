"""Regression tests: Ankay must never format ambiguous or non-empty disks."""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).with_name("prepare-data-disk.py")
SPEC = importlib.util.spec_from_file_location("ankay_prepare_data_disk", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BOOTSTRAP
SPEC.loader.exec_module(BOOTSTRAP)


class DiskFormattingTests(unittest.TestCase):
    @staticmethod
    def result(code: int, output: str = ""):
        return type("Result", (), {"returncode": code, "stdout": output})()

    def test_existing_ext4_is_preserved(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", return_value="ext4"):
            with patch.object(BOOTSTRAP, "run") as command:
                BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_not_called()

    def test_non_ext4_format_fails_without_mkfs(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", return_value="xfs"):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_not_called()

    def test_unknown_blkid_failure_fails_closed(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", side_effect=SystemExit(1)):
            with patch.object(BOOTSTRAP, "run") as command:
                with self.assertRaises(SystemExit):
                    BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_not_called()

    def test_wipefs_signature_fails_without_mkfs(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", return_value=None):
            with patch.object(BOOTSTRAP, "probe", return_value=self.result(0, "offset TYPE\n0000 custom\n")):
                with patch.object(BOOTSTRAP, "run") as command:
                    with self.assertRaises(SystemExit):
                        BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_not_called()

    def test_data_without_signatures_fails_without_mkfs(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", return_value=None):
            with patch.object(
                BOOTSTRAP, "probe", side_effect=[self.result(0), self.result(1)]
            ):
                with patch.object(BOOTSTRAP, "run") as command:
                    with self.assertRaises(SystemExit):
                        BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_not_called()

    def test_zero_scan_error_fails_without_mkfs(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", return_value=None):
            with patch.object(
                BOOTSTRAP, "probe", side_effect=[self.result(0), self.result(2)]
            ):
                with patch.object(BOOTSTRAP, "run") as command:
                    with self.assertRaises(SystemExit):
                        BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_not_called()

    def test_formats_only_after_empty_disk_probes_pass(self) -> None:
        with patch.object(BOOTSTRAP, "filesystem_type", side_effect=[None, "ext4"]):
            with patch.object(BOOTSTRAP, "probe", side_effect=[self.result(0), self.result(0)]):
                with patch.object(BOOTSTRAP, "run") as command:
                    BOOTSTRAP.initialize_if_blank("/dev/sdc", 64 * 1024**3)
        command.assert_called_once_with("mkfs.ext4", "-F", "-L", "ankay-data", "/dev/sdc")

    def test_layout_rejects_partitioned_lun(self) -> None:
        layout = self.result(0, '{"blockdevices":[{"name":"/dev/sdc","type":"disk","children":[{"name":"/dev/sdc1","type":"part"}]}]}')
        with patch.object(BOOTSTRAP, "DEVICE_LINK", type("Link", (), {"is_symlink": lambda self: True})()):
            with patch.object(BOOTSTRAP.os, "stat", return_value=type("Info", (), {"st_mode": BOOTSTRAP.stat.S_IFBLK})()):
                with patch.object(BOOTSTRAP.os.path, "realpath", return_value="/dev/sdc"):
                    with patch.object(BOOTSTRAP, "probe", side_effect=[layout]):
                        with self.assertRaises(SystemExit):
                            BOOTSTRAP.inspect_layout("/dev/sdc", 64 * 1024**3)


if __name__ == "__main__":
    unittest.main()
