"""Pruebas del plan de publicación de Ankay en EUS2 (sin red ni Azure)."""

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("plan", Path(__file__).with_name("ankay-publication-plan.py"))
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)

SHA = "a" * 40


def write(path: Path, content: bytes) -> str:
    path.write_bytes(content)
    return hashlib.sha256(content).hexdigest()


def fixture(root: Path) -> tuple[Path, Path]:
    front = root / "frontend"
    run = root / "runtime"
    front.mkdir()
    run.mkdir()
    image = write(front / "image.tar.gz", b"frontend-image")
    source_name = f"ankay-qapaq-frontend-source-{SHA}.tar.gz"
    source = write(front / source_name, b"frontend-source")
    (front / "metadata.txt").write_text(
        f"commit={SHA}\nimage=ankay-qapaq-frontend:{SHA}\nimage_sha256={image}\nsource_sha256={source}\n", encoding="utf-8"
    )
    (front / "SHA256SUMS").write_text(f"{image}  image.tar.gz\n{source}  {source_name}\n", encoding="utf-8")
    built = {}
    sums = []
    for key in plan.RUNTIME_KEYS:
        archive = f"{key}-image.tar.gz"
        digest = write(run / archive, key.encode())
        built[key] = {"archive": archive, "repository": f"ankay-qapaq-{key}", "archiveSha256": digest}
        sums.append(f"{digest}  {archive}")
    corresponding = write(run / "shuffle-corresponding-source.tar.gz", b"runtime-source")
    sums.append(f"{corresponding}  shuffle-corresponding-source.tar.gz")
    manifest = json.dumps({"schemaVersion": 2, "targetPlatform": "linux/amd64", "built": built, "sourceArchiveSha256": corresponding}).encode()
    sums.append(f"{write(run / 'component-manifest.json', manifest)}  component-manifest.json")
    (run / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    return front, run


class PublicationPlanTests(unittest.TestCase):
    def test_plan_has_seven_content_addressed_images_and_two_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            front, run = fixture(Path(tmp))
            result = plan.build_plan(front, run, SHA, "qapaqsecopsdemoeus3a2405f3.azurecr.io", "acct", "siem-release")
        self.assertEqual([i["key"] for i in result["images"]], ["frontend", *plan.RUNTIME_KEYS])
        for image in result["images"]:
            self.assertRegex(image["tag"], rf"^git-{SHA}-sha256-[0-9a-f]{{64}}$")
        self.assertEqual(len(result["sources"]), 2)
        self.assertTrue(all(s["blob"].startswith(f"ankay-source/{SHA}/") for s in result["sources"]))

    def test_tampered_or_incomplete_artifacts_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            front, run = fixture(Path(tmp))
            (run / "worker-image.tar.gz").write_bytes(b"tampered")
            with self.assertRaises(plan.PlanError):
                plan.build_plan(front, run, SHA, "acr", "acct", "c")
        with tempfile.TemporaryDirectory() as tmp:
            front, run = fixture(Path(tmp))
            with self.assertRaises(plan.PlanError):
                plan.build_plan(front, run, "b" * 40, "acr", "acct", "c")


if __name__ == "__main__":
    unittest.main()
