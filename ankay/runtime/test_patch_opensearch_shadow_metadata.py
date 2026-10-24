import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

from prune_opensearch_shadow_metadata import synchronize_descriptors, verify_patched_runtime


class PruneOpenSearchShadowMetadataTests(unittest.TestCase):
    def _make_jar(
        self,
        directory: Path,
        *,
        class_entry: str | None = None,
        class_content: bytes = b"class",
        version: str = "2.22.2",
    ) -> Path:
        jar_path = directory / "opensaml-3.9.0.0-all.jar"
        with zipfile.ZipFile(jar_path, "w") as archive:
            for artifact in ("jackson-core", "jackson-databind"):
                base = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}"
                archive.writestr(
                    f"{base}/pom.properties",
                    f"artifactId={artifact}\ngroupId=com.fasterxml.jackson.core\nversion={version}\n",
                )
                archive.writestr(
                    f"{base}/pom.xml",
                    "<project><parent><version>2.22.2</version></parent>"
                    f"<version>2.22.2</version><tag>{artifact}-2.22.2</tag></project>\n",
                )
            archive.writestr("META-INF/services/com.fasterxml.jackson.core.JsonFactory", "provider\n")
            archive.writestr("META-INF/maven/com.fasterxml.jackson.core/jackson-annotations/pom.properties", "version=2.22\n")
            if class_entry:
                archive.writestr(class_entry, class_content)
        return jar_path

    @staticmethod
    def _jackson_classes() -> set[str]:
        return {"JsonFactory.class", "ObjectMapper.class"}

    def test_updates_only_metadata_when_implementation_classes_are_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory))
            self.assertEqual(synchronize_descriptors(jar_path, self._jackson_classes()), 4)
            with zipfile.ZipFile(jar_path) as archive:
                names = set(archive.namelist())
                for artifact in ("jackson-core", "jackson-databind"):
                    base = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}"
                    self.assertIn(f"{base}/pom.properties", names)
                    self.assertIn(f"{base}/pom.xml", names)
                    self.assertIn("version=2.22.3", archive.read(f"{base}/pom.properties").decode())
                    self.assertIn("2.22.3", archive.read(f"{base}/pom.xml").decode())
                    self.assertNotIn("2.22.2", archive.read(f"{base}/pom.xml").decode())
                self.assertIn("META-INF/services/com.fasterxml.jackson.core.JsonFactory", names)
                self.assertIn("META-INF/maven/com.fasterxml.jackson.core/jackson-annotations/pom.properties", names)

    def test_refuses_canonical_and_multi_release_jackson_classes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for class_entry in (
                "com/fasterxml/jackson/core/JsonFactory.class",
                "META-INF/versions/17/shaded/namespace/JsonFactory.class",
            ):
                jar_path = self._make_jar(Path(directory), class_entry=class_entry)
                original = jar_path.read_bytes()
                with self.assertRaisesRegex(ValueError, "implementation classes are present"):
                    synchronize_descriptors(jar_path, self._jackson_classes())
                self.assertEqual(jar_path.read_bytes(), original)

    def test_preserves_references_to_external_jackson_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(
                Path(directory), class_entry="shaded/pkg/Other.class", class_content=b"Ltools/jackson/core/JsonFactory;"
            )
            self.assertEqual(synchronize_descriptors(jar_path, self._jackson_classes()), 4)
            with zipfile.ZipFile(jar_path) as archive:
                self.assertIn("shaded/pkg/Other.class", archive.namelist())

    def test_allows_reviewed_opensaml_class_name_collisions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory), class_entry="org/opensaml/core/Version.class")
            self.assertEqual(synchronize_descriptors(jar_path, self._jackson_classes() | {"Version.class"}), 4)

    def test_refuses_nested_archive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory))
            with zipfile.ZipFile(jar_path, "a") as archive:
                archive.writestr("lib/nested.jar", b"PK")
            with self.assertRaisesRegex(ValueError, "nested archives"):
                synchronize_descriptors(jar_path, self._jackson_classes())

    def test_refuses_signed_archive_members_and_manifest_digests(self) -> None:
        for signed_entry, manifest in (
            ("META-INF/OPENSSL.SF", b"Manifest-Version: 1.0\n"),
            (None, b"Manifest-Version: 1.0\nSHA-256-Digest: abc\n"),
        ):
            with tempfile.TemporaryDirectory() as directory:
                jar_path = self._make_jar(Path(directory))
                with zipfile.ZipFile(jar_path, "a") as archive:
                    archive.writestr("META-INF/MANIFEST.MF", manifest)
                    if signed_entry:
                        archive.writestr(signed_entry, b"signature")
                with self.assertRaisesRegex(ValueError, "signed OpenSAML archive"):
                    synchronize_descriptors(jar_path, self._jackson_classes())

    def test_refuses_unexpected_descriptor_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jar_path = self._make_jar(Path(directory), version="2.22.3")
            original = jar_path.read_bytes()
            with self.assertRaisesRegex(ValueError, "Unexpected jackson-core descriptor version"):
                synchronize_descriptors(jar_path, self._jackson_classes())
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
                synchronize_descriptors(jar_path, self._jackson_classes())

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
            class_basenames = verify_patched_runtime(root)
            self.assertEqual(class_basenames, {"JsonFactory.class", "ObjectMapper.class"})

            (lib / "jackson-databind-2.22.3.jar").unlink()
            with self.assertRaisesRegex(ValueError, "Patched runtime dependency is missing"):
                verify_patched_runtime(root)


if __name__ == "__main__":
    unittest.main()
