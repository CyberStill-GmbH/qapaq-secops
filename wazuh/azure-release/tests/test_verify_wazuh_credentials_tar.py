from __future__ import annotations

import importlib.util
import io
import os
import pathlib
import tarfile
import tempfile
import unittest
import base64
import gzip
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "verify_wazuh_credentials_tar.py"
spec = importlib.util.spec_from_file_location("verify_wazuh_credentials_tar", SCRIPT)
assert spec and spec.loader
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def credential_tar(*members: tuple[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


class WazuhCredentialsArchiveTests(unittest.TestCase):
    def test_accepts_official_flat_layout_from_wazuh_install_assistant(self) -> None:
        payload = credential_tar(
            ("wazuh-install-files/wazuh-passwords.txt", b"fixture only\n"),
            ("wazuh-install-files/root-ca.pem", b"fixture ca only\n"),
            ("wazuh-install-files/admin.pem", b"fixture admin only\n"),
            ("wazuh-install-files/wazuh-indexer.pem", b"fixture node only\n"),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "wazuh-install-files.tar"
            source.write_bytes(base64.b64encode(payload))
            verifier.decode_and_validate(source, output)
            self.assertEqual(output.read_bytes(), payload)

    def test_accepts_gzip_from_assistant_and_writes_plain_tar(self) -> None:
        plain = credential_tar(
            ("wazuh-install-files/wazuh-passwords.txt", b"fixture only\n"),
            ("wazuh-install-files/root-ca.pem", b"fixture ca only\n"),
            ("wazuh-install-files/admin.pem", b"fixture admin only\n"),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "wazuh-install-files.tar"
            source.write_bytes(base64.b64encode(gzip.compress(plain)))
            verifier.decode_and_validate(source, output)
            self.assertEqual(output.read_bytes(), plain)

    def test_rejects_flat_layout_without_admin_certificate(self) -> None:
        payload = credential_tar(
            ("wazuh-install-files/wazuh-passwords.txt", b"fixture only\n"),
            ("wazuh-install-files/root-ca.pem", b"fixture ca only\n"),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            source.write_bytes(base64.b64encode(payload))
            with self.assertRaises(ValueError):
                verifier.decode_and_validate(source, pathlib.Path(directory) / "out.tar")

    def test_accepts_one_line_base64_with_expected_files(self) -> None:
        payload = credential_tar(
            ("wazuh-install-files/wazuh-passwords.txt", b"fixture only\n"),
            ("wazuh-install-files/wazuh-certificates/node.pem", b"fixture cert only\n"),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "wazuh-install-files.tar"
            source.write_bytes(base64.b64encode(payload))
            verifier.decode_and_validate(source, output)
            self.assertEqual(output.read_bytes(), payload)
            if os.name == "posix":
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_rejects_multiline_or_traversal_archive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "out.tar"
            source.write_bytes(base64.b64encode(b"not important") + b"\n")
            with self.assertRaisesRegex(ValueError, "one-line base64"):
                verifier.decode_and_validate(source, output)
            payload = credential_tar(
                ("wazuh-install-files/wazuh-passwords.txt", b"fixture only\n"),
                ("wazuh-install-files/wazuh-certificates/../../outside", b"fixture only\n"),
            )
            source.write_bytes(base64.b64encode(payload))
            with self.assertRaisesRegex(ValueError, "unsafe member"):
                verifier.decode_and_validate(source, output)

    def test_rejects_duplicate_paths_after_directory_normalization(self) -> None:
        payload = credential_tar(
            ("wazuh-install-files/wazuh-passwords.txt", b"fixture only\n"),
            ("wazuh-install-files/wazuh-certificates", b"fixture cert only\n"),
            ("wazuh-install-files/wazuh-certificates/", b""),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "out.tar"
            source.write_bytes(base64.b64encode(payload))
            with self.assertRaisesRegex(ValueError, "duplicate member paths"):
                verifier.decode_and_validate(source, output)

    def test_rejects_too_many_members(self) -> None:
        payload = credential_tar(
            *((f"wazuh-install-files/extra-{index}", b"") for index in range(3))
        )
        with tempfile.TemporaryDirectory() as directory, patch.object(verifier, "MAX_ARCHIVE_MEMBERS", 2):
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "out.tar"
            source.write_bytes(base64.b64encode(payload))
            with self.assertRaisesRegex(ValueError, "too many members"):
                verifier.decode_and_validate(source, output)

    def test_rejects_member_and_aggregate_expansion_limits(self) -> None:
        payload = credential_tar(
            ("wazuh-install-files/wazuh-passwords.txt", b"ab"),
            ("wazuh-install-files/wazuh-certificates/node.pem", b"cd"),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "secret.b64"
            output = pathlib.Path(directory) / "out.tar"
            source.write_bytes(base64.b64encode(payload))
            with patch.object(verifier, "MAX_MEMBER_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "member exceeds"):
                    verifier.decode_and_validate(source, output)
            with patch.object(verifier, "MAX_MEMBER_BYTES", 4), patch.object(verifier, "MAX_EXTRACTED_BYTES", 3):
                with self.assertRaisesRegex(ValueError, "expanded size"):
                    verifier.decode_and_validate(source, output)


if __name__ == "__main__":
    unittest.main()
