import io
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify_core_archive import verify_archive


ROOT = "qapaq-core-0123456789ab"


def make_archive(entries: list[tuple[tarfile.TarInfo, bytes | None]]) -> Path:
    temp = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
    temp.close()
    path = Path(temp.name)
    with tarfile.open(path, "w:gz") as archive:
        for entry, payload in entries:
            if entry.isfile():
                body = payload if payload is not None else b"placeholder"
                entry.size = len(body)
                archive.addfile(entry, io.BytesIO(body))
            else:
                archive.addfile(entry)
    return path


def valid_entries() -> list[tuple[tarfile.TarInfo, bytes | None]]:
    entries = []
    root = tarfile.TarInfo(f"{ROOT}/")
    root.type = tarfile.DIRTYPE
    entries.append((root, None))
    for path in ("node/", "node/bin/", "api/", "worker/", "systemd/"):
        directory = tarfile.TarInfo(f"{ROOT}/{path}")
        directory.type = tarfile.DIRTYPE
        entries.append((directory, None))
    for path, payload in (
        ("node/bin/node", b"node"),
        ("RELEASE", b"0123456789ab\n"),
    ):
        file = tarfile.TarInfo(f"{ROOT}/{path}")
        entries.append((file, payload))
    link = tarfile.TarInfo(f"{ROOT}/node/bin/node-link")
    link.type = tarfile.SYMTYPE
    link.linkname = "node"
    entries.append((link, None))
    return entries


class VerifyCoreArchiveTests(unittest.TestCase):
    def test_accepts_required_layout_and_internal_symlink(self):
        archive = make_archive(valid_entries())
        self.addCleanup(archive.unlink)
        self.assertEqual(verify_archive(archive), ROOT)

    def test_rejects_path_traversal(self):
        entries = valid_entries()
        malicious = tarfile.TarInfo(f"{ROOT}/../../escape")
        entries.append((malicious, b"bad"))
        archive = make_archive(entries)
        self.addCleanup(archive.unlink)
        with self.assertRaisesRegex(ValueError, "traversal"):
            verify_archive(archive)

    def test_rejects_symlink_outside_root(self):
        entries = valid_entries()
        malicious = tarfile.TarInfo(f"{ROOT}/node/out")
        malicious.type = tarfile.SYMTYPE
        malicious.linkname = "../../../../etc/passwd"
        entries.append((malicious, None))
        archive = make_archive(entries)
        self.addCleanup(archive.unlink)
        with self.assertRaisesRegex(ValueError, "enlace fuera"):
            verify_archive(archive)

    def test_rejects_special_files(self):
        entries = valid_entries()
        special = tarfile.TarInfo(f"{ROOT}/device")
        special.type = tarfile.FIFOTYPE
        entries.append((special, None))
        archive = make_archive(entries)
        self.addCleanup(archive.unlink)
        with self.assertRaisesRegex(ValueError, "especial"):
            verify_archive(archive)


if __name__ == "__main__":
    unittest.main()
