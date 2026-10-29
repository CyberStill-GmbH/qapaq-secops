from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "normalize_ubuntu_apt_sources.py"
spec = importlib.util.spec_from_file_location("normalize_ubuntu_apt_sources", SCRIPT)
assert spec and spec.loader
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)


class AptSourceNormalizationTests(unittest.TestCase):
    def test_upgrades_approved_ubuntu_mirror_in_deb822_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sources = pathlib.Path(tmp) / "ubuntu.sources"
            fixture = pathlib.Path(__file__).parent / "fixtures" / "ubuntu-24.04.sources"
            sources.write_text(fixture.read_text(encoding="utf-8"), encoding="utf-8")
            self.assertEqual(normalizer.normalize_sources([sources]), [sources])
            normalized = sources.read_text(encoding="utf-8")
            # azure.archive.ubuntu.com no sirve HTTPS: se usa el archivo oficial.
            self.assertIn("URIs: https://archive.ubuntu.com/ubuntu/", normalized)
            self.assertNotIn("azure.archive.ubuntu.com", normalized)
            self.assertIn("URIs: https://security.ubuntu.com/ubuntu/", normalized)

    def test_moves_https_azure_mirror_left_by_a_previous_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sources = pathlib.Path(tmp) / "ubuntu.sources"
            sources.write_text("URIs: https://azure.archive.ubuntu.com/ubuntu/\n", encoding="utf-8")
            self.assertEqual(normalizer.normalize_sources([sources]), [sources])
            self.assertEqual(sources.read_text(encoding="utf-8"), "URIs: https://archive.ubuntu.com/ubuntu/\n")

    def test_leaves_approved_https_mirror_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sources = pathlib.Path(tmp) / "ubuntu.list"
            original = "deb https://security.ubuntu.com/ubuntu noble-security main\n"
            sources.write_text(original, encoding="utf-8")
            self.assertEqual(normalizer.normalize_sources([sources]), [])
            self.assertEqual(sources.read_text(encoding="utf-8"), original)

    def test_rejects_unapproved_http_without_partial_rewrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ubuntu = pathlib.Path(tmp) / "ubuntu.sources"
            third_party = pathlib.Path(tmp) / "third-party.list"
            ubuntu.write_text("URIs: http://archive.ubuntu.com/ubuntu\n", encoding="utf-8")
            third_party.write_text("deb http://packages.example.invalid stable main\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "outside the approved Ubuntu mirror allowlist"):
                normalizer.normalize_sources([ubuntu, third_party])
            self.assertIn("http://archive.ubuntu.com/ubuntu", ubuntu.read_text(encoding="utf-8"))

    def test_ignores_disabled_deb822_stanza(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sources = pathlib.Path(tmp) / "disabled.sources"
            original = "Types: deb\nURIs: http://packages.example.invalid/ubuntu\nEnabled: no\n"
            sources.write_text(original, encoding="utf-8")
            self.assertEqual(normalizer.normalize_sources([sources]), [])
            self.assertEqual(sources.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
