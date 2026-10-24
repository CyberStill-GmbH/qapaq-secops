import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

from prune_opensearch_shadow_metadata import prune_descriptors, verify_patched_runtime


class PruneOpenSearchShadowMetadataTests(unittest.TestCase):
    def _make_jar(self, directory: Path, *, include_class: bool = False, version: str = "2.22.2") -> Path:
        jar_path = directory / "opensaml-3.9.0.0-all.jar"
        with zipfile.ZipFile(jar_path, "w") as archive:
            for artifact in ("jackson-core", "jackson-databind"):
                base = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}"
                archive.writestr(
                    f"{base}/pom.properties",
                    f"artifactId={artifact}\ngroupId=com.fasterxml.jackson.core\nversion={version}\n",
                )
                archive.writestr(f"{base}/pom.xml", "<project/>\n")
            archive.writestr("META-INF/services/com.fasterxml.jackson.core.JsonFactory", "provider\n")
            archive.writestr("META-INF/maven/com.fasterxml.jackson.core/jackson-annotations/pom.properties", "version=2.22\n")
            if include_class:
                archive.writestr("com/fasterxml/jackson/core/JsonFactory.class", b"class")
        return jar_path

    def test_removes_only_metadata_when_classes_are_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory))
            self.assertEqual(prune_descriptors(jar_path), 4)
            with zipfile.ZipFile(jar_path) as archive:
                names = set(archive.namelist())
                self.assertFalse(any("/jackson-core/" in name or "/jackson-databind/" in name for name in names))
                self.assertIn("META-INF/services/com.fasterxml.jackson.core.JsonFactory", names)
                self.assertIn("META-INF/maven/com.fasterxml.jackson.core/jackson-annotations/pom.properties", names)

    def test_refuses_to_modify_jar_with_jackson_classes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory), include_class=True)
            original = jar_path.read_bytes()
            with self.assertRaisesRegex(ValueError, "Jackson classes are present"):
                prune_descriptors(jar_path)
            self.assertEqual(jar_path.read_bytes(), original)

    def test_refuses_unexpected_descriptor_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory), version="2.22.3")
            original = jar_path.read_bytes()
            with self.assertRaisesRegex(ValueError, "Unexpected jackson-core descriptor version"):
                prune_descriptors(jar_path)
            self.assertEqual(jar_path.read_bytes(), original)

    def test_preserves_duplicate_license_entries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(jar_path, "a") as archive:
                    archive.writestr("META-INF/LICENSE", b"license one")
                    archive.writestr("META-INF/LICENSE", b"license two")

                expected = [
                    b"license one" if index == 0 else b"license two"
                    for index in range(2)
                ]
                prune_descriptors(jar_path)

            with zipfile.ZipFile(jar_path) as archive:
                entries = [entry for entry in archive.infolist() if entry.filename == "META-INF/LICENSE"]
                actual = [archive.read(entry) for entry in entries]
            self.assertEqual(actual, expected)

    def test_requires_corrected_runtime_jars_and_classes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lib = root / "lib"
            lib.mkdir()
            artifacts = (
                ("jackson-core-2.22.3.jar", "jackson-core", "com/fasterxml/jackson/core/JsonFactory.class"),
                (
                    "jackson-databind-2.22.3.jar",
                    "jackson-databind",
                    "com/fasterxml/jackson/databind/ObjectMapper.class",
                ),
            )
            for name, artifact, class_name in artifacts:
                with zipfile.ZipFile(lib / name, "w") as archive:
                    base = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}"
                    archive.writestr(f"{base}/pom.properties", "version=2.22.3\n")
                    archive.writestr(class_name, b"patched-class")
            verify_patched_runtime(root)

            (lib / "jackson-databind-2.22.3.jar").unlink()
            with self.assertRaisesRegex(ValueError, "Patched runtime dependency is missing"):
                verify_patched_runtime(root)


if __name__ == "__main__":
    unittest.main()
