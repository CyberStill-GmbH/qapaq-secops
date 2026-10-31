"""Pruebas del render del Compose y del JSON ankay_host (sin red ni Azure)."""

import copy
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE.parent))
import render_ankay_host as render  # noqa: E402

PUBLISHED = json.loads((HERE / "published-fixture.json").read_text(encoding="utf-8"))
PROFILE = json.loads((HERE / "profile-fixture.json").read_text(encoding="utf-8"))
FIXTURE = ROOT / "infra/azure/modules/ankay_host/tests/fixtures/compose.yaml"
SECRET_WORDS = re.compile(r"(PASSWORD|SECRET|TOKEN|API_KEY|HMAC|MODIFIER)[A-Z_]*\s*[:=]\s*(?!\$\{)[^\s#]", re.I)


class RenderTests(unittest.TestCase):
    def test_terraform_fixture_is_the_rendered_template(self):
        compose, host = render.render(PUBLISHED, PROFILE)
        self.assertEqual(FIXTURE.read_text(encoding="utf-8"), compose)
        self.assertEqual(host["compose_sha256"], hashlib.sha256(compose.encode()).hexdigest())

    def test_ankay_host_json_is_complete_and_secret_free(self):
        compose, host = render.render(PUBLISHED, PROFILE)
        self.assertEqual(
            sorted(host),
            sorted(["private_ip_address", "admin_ssh_public_key", "vm_size", "ubuntu_image_version", "data_disk_size_gb",
                    "container_images", "app_images", "compose_yaml", "compose_sha256", "secret_names", "docker_package_versions"]),
        )
        self.assertEqual(host["vm_size"], "Standard_E2bds_v5")
        self.assertEqual(len(host["secret_names"]), 7)
        self.assertEqual(len(host["docker_package_versions"]), 6)
        for line in compose.splitlines():
            self.assertIsNone(SECRET_WORDS.search(line.split("#", 1)[0]) if "${" not in line and "$${" not in line else None, line)
        self.assertNotIn("@@", compose)
        self.assertEqual(len([line for line in compose.splitlines() if "docker.sock" in line]), 1)
        self.assertIn(f"DOCKER_GUARD_ALLOWED_IMAGES: '{PUBLISHED['container_images']['worker']},ankay/apps:qapaq-ankay_1.0.0'", compose)

    def test_rejects_mutable_or_foreign_images_and_bad_hosts(self):
        bad = copy.deepcopy(PUBLISHED)
        bad["container_images"]["backend"] = "ghcr.io/shuffle/shuffle-backend:latest"
        with self.assertRaises(render.RenderError):
            render.render(bad, PROFILE)
        bad = copy.deepcopy(PUBLISHED)
        bad["container_images"]["shuffle-security"] = bad["container_images"].pop("docker-guard")
        with self.assertRaises(render.RenderError):
            render.render(bad, PROFILE)
        for ip in ("10.80.0.33", "10.80.16.36", "10.80.0.63"):
            with self.assertRaises(render.RenderError):
                render.render(PUBLISHED, {**PROFILE, "private_ip_address": ip})
        with self.assertRaises(render.RenderError):
            render.render(PUBLISHED, {**PROFILE, "ubuntu_image_version": "latest"})


if __name__ == "__main__":
    unittest.main()
