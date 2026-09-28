import json
from pathlib import Path
import tempfile
import unittest

from discover import discover


class DiscoverTests(unittest.TestCase):
    def create_repository(self, files: dict[str, str]) -> tuple[tempfile.TemporaryDirectory, Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        (root / ".github" / "ci").mkdir(parents=True, exist_ok=True)
        containers = root / ".github" / "ci" / "containers.json"
        if not containers.exists():
            containers.write_text("[]\n", encoding="utf-8")
        return temporary, root

    def test_repository_without_application_reports_checks_as_not_configured(self):
        temporary, root = self.create_repository({"README.md": "# repository\n"})
        self.addCleanup(temporary.cleanup)

        result = discover(["README.md", ".github/ci/containers.json"], root)

        self.assertFalse(result["has_pnpm"])
        self.assertFalse(result["has_containers"])
        self.assertEqual([], result["languages"])

    def test_complete_pnpm_workspace_is_detected(self):
        files = {
            ".nvmrc": "24.21.0\n",
            "package.json": json.dumps({"packageManager": "pnpm@12.4.2"}),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
            "apps/api/package.json": json.dumps({"name": "api"}),
            "apps/api/src/main.ts": "export {};\n",
        }
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        tracked = list(files) + [".github/ci/containers.json"]
        result = discover(tracked, root)

        self.assertTrue(result["has_pnpm"])
        self.assertIn("javascript-typescript", result["languages"])

    def test_typescript_and_python_are_analyzed_by_codeql(self):
        files = {
            "apps/api/src/main.ts": "export {};\n",
            ".github/ci/discover.py": "def discover(): pass\n",
        }
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        result = discover(list(files), root)

        self.assertEqual(["javascript-typescript", "python"], result["languages"])

    def test_incomplete_pnpm_workspace_fails_closed(self):
        files = {"package.json": json.dumps({"packageManager": "pnpm@12.4.2"})}
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        with self.assertRaisesRegex(ValueError, "missing root pnpm inputs"):
            discover(["package.json", ".github/ci/containers.json"], root)

    def test_npm_lockfile_is_rejected(self):
        files = {
            ".nvmrc": "24.21.0\n",
            "package.json": json.dumps({"packageManager": "pnpm@12.4.2"}),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "pnpm-workspace.yaml": "packages: []\n",
            "package-lock.json": "{}\n",
        }
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        with self.assertRaisesRegex(ValueError, "accepted workspace uses pnpm"):
            discover(list(files) + [".github/ci/containers.json"], root)

    def test_unapproved_pnpm_version_fails_closed(self):
        files = {
            ".nvmrc": "24.21.0\n",
            "package.json": json.dumps({"packageManager": "pnpm@latest"}),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "pnpm-workspace.yaml": "packages: []\n",
        }
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        with self.assertRaisesRegex(ValueError, "packageManager must be pnpm@12.4.2"):
            discover(list(files) + [".github/ci/containers.json"], root)

    def test_unregistered_dockerfile_fails_closed(self):
        files = {"apps/api/Dockerfile": "FROM scratch\n"}
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        with self.assertRaisesRegex(ValueError, "add every Dockerfile"):
            discover(list(files) + [".github/ci/containers.json"], root)

    def test_registered_container_is_detected(self):
        containers = json.dumps([{"dockerfile": "apps/api/Dockerfile", "context": "apps/api"}])
        files = {
            ".github/ci/containers.json": containers,
            "apps/api/Dockerfile": "FROM scratch\n",
        }
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        result = discover(list(files), root)

        self.assertTrue(result["has_containers"])
        self.assertEqual(json.loads(containers), result["containers"])

    def test_container_path_traversal_is_rejected(self):
        containers = json.dumps([{"dockerfile": "../Dockerfile", "context": "."}])
        files = {".github/ci/containers.json": containers}
        temporary, root = self.create_repository(files)
        self.addCleanup(temporary.cleanup)

        with self.assertRaisesRegex(ValueError, "escapes the checkout"):
            discover([".github/ci/containers.json"], root)


if __name__ == "__main__":
    unittest.main()
