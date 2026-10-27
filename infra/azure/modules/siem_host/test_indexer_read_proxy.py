#!/usr/bin/env python3
"""Local contract tests for the Azure Indexer read-only proxy bootstrap."""

from __future__ import annotations

import base64
import unittest
from unittest.mock import MagicMock, patch

import indexer_read_proxy as proxy


PRIVATE_IP = "10.80.16.4"
READER_NAME = "wazuh-reader-b64"
CA_NAME = "wazuh-proxy-ca"
CERTIFICATE = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n"


def valid_config() -> dict[str, str]:
    return {
        "private_ip_address": PRIVATE_IP,
        "reader_secret_name": READER_NAME,
        "proxy_ca_secret_name": CA_NAME,
    }


class IndexerReadProxyTests(unittest.TestCase):
    def test_contract_rejects_public_ip_duplicate_or_value_like_secret_name(self) -> None:
        for config in (
            {**valid_config(), "private_ip_address": "8.8.8.8"},
            {**valid_config(), "proxy_ca_secret_name": READER_NAME},
            {**valid_config(), "reader_secret_name": "secret/value"},
        ):
            with self.subTest(config={key: value for key, value in config.items()}):
                with self.assertRaises(proxy.IndexerProxyError):
                    proxy.validate_config(config)

    def test_generated_reader_credential_has_required_classes_and_is_not_logged(self) -> None:
        password, basic_auth, publish = proxy.reader_password_from_secret(None)
        self.assertTrue(publish)
        self.assertEqual(len(password), 48)
        self.assertRegex(password, r"[a-z]")
        self.assertRegex(password, r"[A-Z]")
        self.assertRegex(password, r"[0-9]")
        self.assertRegex(password, r"[!@#$%^&*()\-_=+\[\]{}.,?]")
        self.assertNotRegex(password, r"[:\s\x00-\x1f\x7f]")
        self.assertEqual(
            base64.b64decode(basic_auth, validate=True).decode("ascii"),
            f"{proxy.READER_USER}:{password}",
        )

    def test_existing_basic_auth_reference_is_reused(self) -> None:
        basic_auth = base64.b64encode(b"qapaq_reader:Existing-R3ader!Credential").decode("ascii")
        password, result, publish = proxy.reader_password_from_secret(basic_auth)
        self.assertEqual(password, "Existing-R3ader!Credential")
        self.assertEqual(result, basic_auth)
        self.assertFalse(publish)

    def test_rejects_non_base64_or_wrong_reader_reference_without_echoing_it(self) -> None:
        for value in ("not-base64-secret", base64.b64encode(b"admin:secret").decode("ascii")):
            with self.subTest(value="redacted"):
                with self.assertRaises(proxy.IndexerProxyError) as caught:
                    proxy.reader_password_from_secret(value)
                self.assertNotIn(value, str(caught.exception))

    def test_proxy_is_separate_from_indexer_and_has_closed_route_allowlist(self) -> None:
        config = proxy._nginx_configuration(PRIVATE_IP, "https://127.0.0.1:9200", "indexer.local")
        self.assertIn(f"listen {PRIVATE_IP}:9443 ssl;", config)
        self.assertIn("proxy_pass https://127.0.0.1:9200;", config)
        self.assertIn("proxy_ssl_verify on;", config)
        self.assertIn("proxy_ssl_server_name on;", config)
        self.assertIn("proxy_ssl_name indexer.local;", config)
        self.assertIn("location = /_cluster/health", config)
        self.assertIn("/wazuh-alerts-[A-Za-z0-9.*-]+/_search", config)
        self.assertIn("location / { return 403; }", config)
        self.assertNotIn("listen 10.80.16.4:9200", config)

    def test_local_https_transport_connects_to_ip_but_verifies_certificate_identity(self):
        raw_socket = MagicMock()
        tls_socket = MagicMock()
        context = MagicMock()
        context.wrap_socket.return_value = tls_socket
        connection = proxy._PinnedLocalHTTPSConnection(
            connect_host="127.0.0.1",
            tls_name="indexer.local",
            port=proxy.INDEXER_PORT,
            context=context,
            timeout=5,
        )
        with patch.object(proxy.socket, "create_connection", return_value=raw_socket) as create_connection:
            connection.connect()
        create_connection.assert_called_once_with(("127.0.0.1", proxy.INDEXER_PORT), 5, None)
        context.wrap_socket.assert_called_once_with(raw_socket, server_hostname="indexer.local")
        connection.close()

    def test_selects_loopback_first_then_private_ip_only_if_needed(self) -> None:
        with patch.object(proxy.socket, "create_connection", return_value=MagicMock()):
            self.assertEqual(
                proxy._select_indexer_endpoint(PRIVATE_IP),
                "https://127.0.0.1:9200",
            )

        with patch.object(
            proxy.socket,
            "create_connection",
            side_effect=[OSError("closed"), MagicMock()],
        ):
            self.assertEqual(
                proxy._select_indexer_endpoint(PRIVATE_IP),
                f"https://{PRIVATE_IP}:9200",
            )

    @patch.object(proxy, "_probe", side_effect=[200, 200, 403, 403])
    @patch.object(proxy, "_apply_nginx", return_value=(b"old nginx config", 0o640))
    @patch.object(proxy, "_upstream_tls_name", return_value="indexer.local")
    @patch.object(proxy, "_select_indexer_endpoint", return_value="https://127.0.0.1:9200")
    @patch.object(proxy, "_admin_password", return_value="Synthetic-admin-password")
    @patch.object(proxy, "_prepare_proxy_certificate", return_value=(CERTIFICATE, True))
    @patch.object(
        proxy,
        "_indexer_request",
        side_effect=[
            (404, {}),
            (404, {}),
            (200, {}),
            (404, {}),
            (201, {}),
            (201, {}),
            (201, {}),
        ],
    )
    def test_bootstrap_probes_before_publishing_only_generated_values(
        self,
        _indexer_request: MagicMock,
        _prepare_certificate: MagicMock,
        _admin_password: MagicMock,
        _select_endpoint: MagicMock,
        _tls_name: MagicMock,
        _apply_nginx: MagicMock,
        _probe: MagicMock,
    ) -> None:
        published: dict[str, str] = {}
        messages: list[str] = []

        with patch.object(proxy, "_restore_nginx"):
            proxy.configure(valid_config(), "bootstrap-pending", "bootstrap-pending", published.__setitem__, messages.append)

        self.assertEqual(set(published), {READER_NAME, CA_NAME})
        self.assertEqual(published[CA_NAME], CERTIFICATE)
        decoded = base64.b64decode(published[READER_NAME], validate=True).decode("ascii")
        self.assertTrue(decoded.startswith(f"{proxy.READER_USER}:"))
        all_output = "\n".join(messages)
        self.assertNotIn(decoded.partition(":")[2], all_output)
        self.assertNotIn("Synthetic-admin-password", all_output)
        self.assertEqual(_probe.call_count, 4)
        role_write = next(
            call for call in _indexer_request.call_args_list
            if call.args[1] == "PUT" and call.args[2].endswith("/roles/qapaq_alerts_read")
        )
        self.assertEqual(
            role_write.args[4]["cluster_permissions"],
            ["cluster:monitor/health"],
        )
        self.assertNotIn("cluster_monitor", role_write.args[4]["cluster_permissions"])

    def test_second_key_vault_write_failure_restores_both_placeholders_and_rolls_back(self) -> None:
        published = {READER_NAME: proxy.PLACEHOLDER, CA_NAME: proxy.PLACEHOLDER}
        writes: list[tuple[str, str]] = []
        messages: list[str] = []

        def set_secret(name: str, value: str) -> None:
            # Simulate a lost response after Key Vault committed the CA value.
            published[name] = value
            writes.append((name, value))
            if name == CA_NAME and value != proxy.PLACEHOLDER:
                raise RuntimeError("synthetic transport failure after commit")

        with (
            patch.object(proxy, "_probe", side_effect=[200, 200, 403, 403]),
            patch.object(proxy, "_apply_nginx", return_value=(b"previous nginx", 0o640)),
            patch.object(proxy, "_restore_nginx") as restore_nginx,
            patch.object(proxy, "_upstream_tls_name", return_value="indexer.local"),
            patch.object(proxy, "_select_indexer_endpoint", return_value="https://127.0.0.1:9200"),
            patch.object(proxy, "_admin_password", return_value="Synthetic-admin-password"),
            patch.object(proxy, "_prepare_proxy_certificate", return_value=(CERTIFICATE, True)),
            patch.object(
                proxy,
                "_indexer_request",
                side_effect=[
                    (404, {}), (404, {}), (200, {}), (404, {}),
                    (201, {}), (201, {}), (201, {}),
                    (200, {}), (200, {}), (200, {}),
                ],
            ) as indexer_request,
        ):
            with self.assertRaises(RuntimeError):
                proxy.configure(
                    valid_config(),
                    proxy.PLACEHOLDER,
                    proxy.PLACEHOLDER,
                    set_secret,
                    messages.append,
                )

        self.assertEqual(published, {READER_NAME: proxy.PLACEHOLDER, CA_NAME: proxy.PLACEHOLDER})
        self.assertEqual(
            [name for name, _ in writes],
            [READER_NAME, CA_NAME, CA_NAME, READER_NAME],
        )
        self.assertTrue(all(value == proxy.PLACEHOLDER for _, value in writes[2:]))
        restore_nginx.assert_called_once_with(b"previous nginx", 0o640)
        self.assertEqual(indexer_request.call_count, 10)
        self.assertNotIn("Synthetic-admin-password", "\n".join(messages))
        self.assertNotIn(CERTIFICATE, "\n".join(messages))
        for _, value in writes[:2]:
            self.assertNotIn(value, "\n".join(messages))

    @patch.object(proxy, "_restore_nginx")
    @patch.object(proxy, "_probe", side_effect=[200, 200, 200, 403])
    @patch.object(proxy, "_apply_nginx", return_value=(None, None))
    @patch.object(proxy, "_upstream_tls_name", return_value="indexer.local")
    @patch.object(proxy, "_select_indexer_endpoint", return_value="https://127.0.0.1:9200")
    @patch.object(proxy, "_admin_password", return_value="Synthetic-admin-password")
    @patch.object(proxy, "_prepare_proxy_certificate", return_value=(CERTIFICATE, True))
    @patch.object(
        proxy,
        "_indexer_request",
        side_effect=[
            (404, {}),
            (404, {}),
            (200, {}),
            (404, {}),
            (201, {}),
            (201, {}),
            (201, {}),
            (200, {}),
            (200, {}),
            (200, {}),
        ],
    )
    def test_failed_write_probe_rolls_back_and_never_publishes(
        self,
        _indexer_request: MagicMock,
        _prepare_certificate: MagicMock,
        _admin_password: MagicMock,
        _select_endpoint: MagicMock,
        _tls_name: MagicMock,
        _apply_nginx: MagicMock,
        _probe: MagicMock,
        restore_nginx: MagicMock,
    ) -> None:
        published: list[tuple[str, str]] = []
        with self.assertRaises(proxy.IndexerProxyError):
            proxy.configure(
                valid_config(),
                "bootstrap-pending",
                "bootstrap-pending",
                lambda name, value: published.append((name, value)),
                lambda _message: None,
            )
        restore_nginx.assert_called_once_with(None, None)
        self.assertEqual(
            published,
            [(CA_NAME, proxy.PLACEHOLDER), (READER_NAME, proxy.PLACEHOLDER)],
        )
        self.assertEqual(_indexer_request.call_count, 10)
        self.assertEqual(
            [
                call.args[1:3]
                for call in _indexer_request.call_args_list[7:]
            ],
            [
                ("DELETE", "/_plugins/_security/api/internalusers/qapaq_reader"),
                ("DELETE", "/_plugins/_security/api/rolesmapping/qapaq_alerts_read"),
                ("DELETE", "/_plugins/_security/api/roles/qapaq_alerts_read"),
            ],
        )

    @patch.object(
        proxy,
        "_indexer_request",
        side_effect=[(404, {}), (200, {}), (404, {})],
    )
    @patch.object(proxy, "_admin_password", return_value="Synthetic-admin-password")
    @patch.object(proxy, "_select_indexer_endpoint", return_value="https://127.0.0.1:9200")
    @patch.object(proxy, "_upstream_tls_name", return_value="indexer.local")
    @patch.object(proxy, "_prepare_proxy_certificate", return_value=(CERTIFICATE, True))
    def test_refuses_to_rotate_preexisting_reader_when_key_vault_has_placeholder(
        self,
        _prepare_certificate: MagicMock,
        _tls_name: MagicMock,
        _select_endpoint: MagicMock,
        _admin_password: MagicMock,
        indexer_request: MagicMock,
    ) -> None:
        with self.assertRaises(proxy.IndexerProxyError):
            proxy.configure(
                valid_config(),
                "bootstrap-pending",
                "bootstrap-pending",
                lambda _name, _value: None,
                lambda _message: None,
            )
        self.assertEqual(indexer_request.call_count, 2)

    @patch.object(
        proxy,
        "_indexer_request",
        side_effect=[
            (404, {}),
            (200, {proxy.READER_USER: {"backend_roles": []}}),
            (200, {"all_access": {"users": [proxy.READER_USER], "backend_roles": []}}),
        ],
    )
    @patch.object(proxy, "_admin_password", return_value="Synthetic-admin-password")
    @patch.object(proxy, "_select_indexer_endpoint", return_value="https://127.0.0.1:9200")
    @patch.object(proxy, "_upstream_tls_name", return_value="indexer.local")
    @patch.object(proxy, "_prepare_proxy_certificate", return_value=(CERTIFICATE, False))
    def test_refuses_existing_reader_mapped_to_a_privileged_role(
        self,
        _prepare_certificate: MagicMock,
        _tls_name: MagicMock,
        _select_endpoint: MagicMock,
        _admin_password: MagicMock,
        indexer_request: MagicMock,
    ) -> None:
        credential = base64.b64encode(b"qapaq_reader:Existing-R3ader!Credential").decode("ascii")
        with self.assertRaises(proxy.IndexerProxyError):
            proxy.configure(
                valid_config(),
                credential,
                CERTIFICATE,
                lambda _name, _value: None,
                lambda _message: None,
            )
        self.assertEqual(indexer_request.call_count, 3)

    @patch.object(proxy, "_admin_password", return_value="Synthetic-admin-password")
    @patch.object(proxy, "_select_indexer_endpoint", return_value="https://127.0.0.1:9200")
    @patch.object(proxy, "_upstream_tls_name", return_value="indexer.local")
    @patch.object(proxy, "_prepare_proxy_certificate", return_value=(CERTIFICATE, False))
    @patch.object(proxy, "_indexer_request")
    def test_refuses_other_role_host_mappings_that_match_or_may_match_proxy(
        self,
        indexer_request: MagicMock,
        _prepare_certificate: MagicMock,
        _tls_name: MagicMock,
        _select_endpoint: MagicMock,
        _admin_password: MagicMock,
    ) -> None:
        credential = base64.b64encode(
            b"qapaq_reader:Existing-R3ader!Credential"
        ).decode("ascii")
        for hosts in (
            ["*"],
            ["127.0.0.1"],
            [PRIVATE_IP],
            ["siem-indexer.internal"],
            ["10.80.16.0/24"],
        ):
            with self.subTest(hosts=hosts):
                indexer_request.reset_mock()
                indexer_request.side_effect = [
                    (404, {}),
                    (404, {}),
                    (200, {"all_access": {"users": [], "backend_roles": [], "hosts": hosts}}),
                ]
                with self.assertRaises(proxy.IndexerProxyError):
                    proxy.configure(
                        valid_config(),
                        credential,
                        CERTIFICATE,
                        lambda _name, _value: self.fail("unexpected Key Vault write"),
                        lambda _message: None,
                    )
                self.assertEqual(indexer_request.call_count, 3)

    def test_nonmatching_literal_host_mapping_does_not_match_proxy_sources(self) -> None:
        self.assertFalse(
            proxy._host_mapping_may_apply(
                ["198.51.100.19", "10.80.17.*"],
                {"127.0.0.1", PRIVATE_IP},
            )
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
