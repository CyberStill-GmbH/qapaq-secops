"""Pruebas sintéticas del paso que sincroniza el descriptor Guava de OpenSAML."""

import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("sync_opensaml_guava_descriptor.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def descriptors(version: str) -> dict[str, bytes]:
    return {
        sync.DESCRIPTORS[0]: f"artifactId=guava\ngroupId=com.google.guava\nversion={version}\n".encode(),
        sync.DESCRIPTORS[1]: f"<project><artifactId>guava</artifactId><parent><version>{version}</version></parent></project>".encode(),
    }


def write_jar(path: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)


class GuavaDescriptorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write_jar(self.root / sync.PATCHED_JAR, {**descriptors(sync.PATCHED_VERSION), sync.REQUIRED_CLASS: b"\xca\xfe"})

    def tearDown(self):
        self.tmp.cleanup()

    def test_replaces_only_the_descriptor_with_the_patched_copy(self):
        opensaml = self.root / "opensaml-3.9.0.0-all.jar"
        write_jar(opensaml, {**descriptors(sync.EXPECTED_VERSION), "org/opensaml/core/Version.class": b"x"})
        self.assertEqual(sync.synchronize(opensaml, sync.patched_descriptors(self.root)), 2)
        with zipfile.ZipFile(opensaml) as archive:
            self.assertIn(b"version=33.7.2-jre", archive.read(sync.DESCRIPTORS[0]))
            self.assertEqual(archive.read("org/opensaml/core/Version.class"), b"x")
        self.assertNotIn(b"33.0.0-jre", opensaml.read_bytes())

    def test_refuses_when_guava_classes_are_bundled(self):
        opensaml = self.root / "opensaml-3.9.0.0-all.jar"
        write_jar(opensaml, {**descriptors(sync.EXPECTED_VERSION), "com/google/common/base/Strings.class": b"x"})
        with self.assertRaises(ValueError):
            sync.synchronize(opensaml, sync.patched_descriptors(self.root))


if __name__ == "__main__":
    unittest.main()
