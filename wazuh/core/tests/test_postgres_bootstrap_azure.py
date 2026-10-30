from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "postgres-bootstrap-azure.py"
SPEC = importlib.util.spec_from_file_location("postgres_bootstrap_azure", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CORE_ENV = "\n".join(
    [
        'QAPAQ_POSTGRES_DATABASE="qapaq_secops"',
        'QAPAQ_POSTGRES_HOST="psql-qapaqsecopsdemoeus-3a2405f3.postgres.database.azure.com"',
        'QAPAQ_POSTGRES_PASSWORD_REF="secret://keyvault/qapaq-postgres-app-password"',
        'QAPAQ_POSTGRES_TLS="true"',
        'QAPAQ_POSTGRES_USERNAME="qapaq_soc_runtime"',
        'QAPAQ_SOC_PERSISTENCE="postgres"',
        'QAPAQ_ENTRA_SCOPES="openid \\"profile\\" C:\\\\path"',
        "",
    ]
)
RUNTIME = "r" * 64
MASTER = "synthetic-master-password"


class CoreEnvTests(unittest.TestCase):
    def test_parses_systemd_quoted_values(self):
        values = MODULE.parse_core_env(CORE_ENV)
        self.assertEqual(values["QAPAQ_SOC_PERSISTENCE"], "postgres")
        self.assertEqual(values["QAPAQ_ENTRA_SCOPES"], 'openid "profile" C:\\path')

    def test_rejects_unquoted_or_injected_lines(self):
        for text in ("QAPAQ_X=unquoted", 'QAPAQ_X="a" ; rm -rf /', 'lower="x"'):
            with self.subTest(text=text), self.assertRaises(MODULE.BootstrapError):
                MODULE.parse_core_env(text)

    def test_extracts_only_postgres_connection_settings(self):
        settings = MODULE.postgres_settings(MODULE.parse_core_env(CORE_ENV))
        self.assertEqual(
            settings,
            {
                "QAPAQ_POSTGRES_HOST": "psql-qapaqsecopsdemoeus-3a2405f3.postgres.database.azure.com",
                "QAPAQ_POSTGRES_PORT": "5432",
                "QAPAQ_POSTGRES_DATABASE": "qapaq_secops",
                "QAPAQ_POSTGRES_TLS": "true",
            },
        )

    def test_requires_tls_azure_host_and_runtime_username(self):
        base = MODULE.parse_core_env(CORE_ENV)
        for key, value in (
            ("QAPAQ_POSTGRES_TLS", "false"),
            ("QAPAQ_POSTGRES_HOST", "db.example.test"),
            ("QAPAQ_POSTGRES_USERNAME", "qapaqbootstrap"),
            ("QAPAQ_POSTGRES_DATABASE", "qapaq;drop"),
        ):
            with self.subTest(key=key), self.assertRaises(MODULE.BootstrapError):
                MODULE.postgres_settings({**base, key: value})


class CredentialTests(unittest.TestCase):
    def environment(self, **overrides):
        return {
            "QAPAQ_MASTER_USERNAME": "qapaqbootstrap",
            "QAPAQ_MASTER_PASSWORD": MASTER,
            "QAPAQ_RUNTIME_PASSWORD": RUNTIME,
            **overrides,
        }

    def test_accepts_protected_parameters(self):
        self.assertEqual(MODULE.credentials(self.environment())["QAPAQ_RUNTIME_PASSWORD"], RUNTIME)

    def test_rejects_weak_or_confused_credentials(self):
        for overrides in (
            {"QAPAQ_RUNTIME_PASSWORD": "short"},
            {"QAPAQ_RUNTIME_PASSWORD": "a" * 40 + "'"},
            {"QAPAQ_MASTER_USERNAME": "qapaq_soc_runtime"},
            {"QAPAQ_MASTER_PASSWORD": ""},
            {"QAPAQ_MASTER_PASSWORD": RUNTIME},
        ):
            with self.subTest(overrides=list(overrides)), self.assertRaises(MODULE.BootstrapError) as raised:
                MODULE.credentials(self.environment(**overrides))
            for secret in (MASTER, RUNTIME):
                self.assertNotIn(secret, str(raised.exception))

    def test_migrator_environment_does_not_inherit_process_environment(self):
        release = pathlib.Path("/opt/qapaq-core/releases/abc")
        env = MODULE.migrator_environment(
            release,
            {"QAPAQ_POSTGRES_HOST": "h"},
            MODULE.credentials(self.environment()),
        )
        self.assertEqual(env["NODE_EXTRA_CA_CERTS"], str(release / "certs/rds-global-bundle.pem"))
        self.assertNotIn("AZURE_CLIENT_ID", env)
        self.assertEqual(
            set(env) - {"PATH", "HOME", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "QAPAQ_POSTGRES_HOST"},
            {"QAPAQ_MASTER_USERNAME", "QAPAQ_MASTER_PASSWORD", "QAPAQ_RUNTIME_PASSWORD"},
        )


class OutputTests(unittest.TestCase):
    def test_forwards_only_migrator_json_events(self):
        stdout = "\n".join(
            [
                json.dumps({"service": "qapaq-secops-migrator", "event": "migrate.applied"}),
                f"Error: connect postgresql://qapaqbootstrap:{MASTER}@host/db",
                json.dumps({"service": "other", "event": "x"}),
            ]
        )
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            MODULE.forward_migrator_output(stdout)
        self.assertEqual(buffer.getvalue().count("\n"), 1)
        self.assertIn("migrate.applied", buffer.getvalue())
        self.assertNotIn(MASTER, buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
