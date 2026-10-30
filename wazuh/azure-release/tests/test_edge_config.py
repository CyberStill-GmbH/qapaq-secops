"""Pruebas de edge.json y del instalador del webhook Wazuh → Ankay (sin root ni Wazuh)."""

import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


def load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


edge = load("write_edge_config", ROOT / "wazuh/azure-release/write_edge_config.py")
webhook = load("apply_ankay_webhook", ROOT / "infra/wazuh/shuffle/apply_ankay_webhook.py")


class EdgeConfigTests(unittest.TestCase):
    def test_edge_with_ankay_uses_the_deterministic_intake_webhook(self):
        config = edge.build({"EDGE_HOSTNAME": "app.jappi.net.pe", "ANKAY_PRIVATE_IP": "10.80.0.36"})
        self.assertEqual(config["ankayUpstream"], "10.80.0.36:3001")
        self.assertEqual(
            config["ankayWebhookUrl"],
            "http://10.80.0.36:5001/api/v1/hooks/webhook_d182096e-5305-5016-a069-c65851fdc5fa",
        )
        webhook.validate_url(config["ankayWebhookUrl"])

    def test_edge_without_ankay_and_invalid_inputs(self):
        self.assertNotIn("ankayUpstream", edge.build({"EDGE_HOSTNAME": "app.jappi.net.pe"}))
        for env in ({"EDGE_HOSTNAME": "App.Example"}, {"EDGE_HOSTNAME": "app.jappi.net.pe", "ANKAY_PRIVATE_IP": "8.8.8.8"}):
            with self.assertRaises(ValueError):
                edge.build(env)

    def test_ossec_merge_is_idempotent_and_refuses_unowned_blocks(self):
        block = "<integration>\n  <name>custom-qapaq-shuffle</name>\n</integration>"
        base = "<ossec_config>\n  <global/>\n</ossec_config>\n"
        once = webhook.merge_config(base, block)
        self.assertEqual(webhook.merge_config(once, block), once)
        self.assertEqual(once.count(webhook.BEGIN), 1)
        with self.assertRaises(ValueError):
            webhook.merge_config(base.replace("<global/>", block), block)

    def test_webhook_url_must_be_private_backend(self):
        for bad in (
            "https://10.80.0.36:5001/api/v1/hooks/webhook_d182096e-5305-5016-a069-c65851fdc5fa",
            "http://8.8.8.8:5001/api/v1/hooks/webhook_d182096e-5305-5016-a069-c65851fdc5fa",
            "http://10.80.0.36:3001/api/v1/hooks/webhook_d182096e-5305-5016-a069-c65851fdc5fa",
        ):
            with self.subTest(bad=bad), self.assertRaises(SystemExit):
                webhook.validate_url(bad)


if __name__ == "__main__":
    unittest.main()
