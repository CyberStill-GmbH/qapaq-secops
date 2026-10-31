from __future__ import annotations

import importlib.util
import os
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("fetch-runtime-secrets.py")
SPEC = importlib.util.spec_from_file_location("ankay_fetch_runtime_secrets", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimeSecretHelpersTest(unittest.TestCase):
    def test_mapping_accepts_valid_names_and_rejects_invalid_identifiers(self) -> None:
        self.assertEqual(
            MODULE.parse_mapping('{"SHUFFLE_PASSWORD":"ankay-password"}'),
            {"SHUFFLE_PASSWORD": "ankay-password"},
        )
        with self.assertRaises(MODULE.BootstrapError):
            MODULE.parse_mapping('{"SHUFFLE PASSWORD":"ankay-password"}')

    def test_compose_environment_value_is_quoted(self) -> None:
        quoted = MODULE.compose_env_quote("value with 'quote' and \\slash")
        self.assertTrue(quoted.startswith("'"))
        self.assertTrue(quoted.endswith("'"))
        self.assertIn("\\'", quoted)
        self.assertIn("\\\\", quoted)

    @unittest.skipUnless(os.name == "posix", "POSIX mode bits are used by the Linux guest")
    def test_private_file_is_written_atomically_with_root_only_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory, "runtime.env")
            MODULE.write_private_file(target, b"SHUFFLE_PASSWORD='test'\n")
            self.assertEqual(target.read_bytes(), b"SHUFFLE_PASSWORD='test'\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertFalse(list(pathlib.Path(directory).glob(".runtime.env.*")))

    def test_import_environment_only_maps_existing_secret_variables(self) -> None:
        mapping = {"ANKAY_ADMIN_API_KEY": "ankay-admin-api-key"}
        self.assertEqual(
            MODULE.parse_import_env('{"SHUFFLE_API_KEY":"ANKAY_ADMIN_API_KEY"}', mapping),
            {"SHUFFLE_API_KEY": "ANKAY_ADMIN_API_KEY"},
        )
        for raw in ('{"SHUFFLE_API_KEY":"OTHER"}', '{"bad name":"ANKAY_ADMIN_API_KEY"}', "[]"):
            with self.assertRaises(MODULE.BootstrapError):
                MODULE.parse_import_env(raw, mapping)

    def test_docker_env_file_keeps_values_literal(self) -> None:
        self.assertEqual(MODULE.docker_env_file({"A": "x'y=z"}), b"A=x'y=z\n")

    @unittest.skipUnless(os.name == "posix", "bcrypt via libxcrypt exists only on the Linux guest")
    def test_opensearch_users_store_only_a_bcrypt_hash(self) -> None:
        try:
            content = MODULE.opensearch_internal_users("Synthetic-Passw0rd-For-Tests").decode()
        except MODULE.BootstrapError:
            self.skipTest("bcrypt is unavailable in this Python build")
        self.assertNotIn("Synthetic-Passw0rd-For-Tests", content)
        self.assertRegex(content, r'hash: "\$2[aby]\$12\$')
        self.assertIn('    - "admin"', content)


if __name__ == "__main__":
    unittest.main()
