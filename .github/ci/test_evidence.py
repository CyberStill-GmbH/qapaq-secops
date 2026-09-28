import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import generate_evidence


class EvidenceGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "bundle"
        self.event_file = Path(self.temp.name) / "event.json"
        self.event_file.write_text(
            json.dumps(
                {
                    "workflow_run": {
                        "event": "push",
                        "head_branch": "main",
                        "head_sha": "a" * 40,
                        "conclusion": "success",
                    }
                }
            ),
            encoding="utf-8",
        )
        self.environment = patch.dict(
            os.environ,
            {
                "GITHUB_REPOSITORY": "CyberStill-GmbH/qapaq-secops",
                "C09_RUN_ID": "12345",
                "GITHUB_TOKEN": "synthetic-test-token-not-in-output",
                "GITHUB_EVENT_PATH": str(self.event_file),
                "NODE_VERSION": "24.21.0",
                "PNPM_VERSION": "12.4.2",
                "GITLEAKS_VERSION": "8.30.1",
            },
        )
        self.environment.start()
        self.out_patch = patch.object(generate_evidence, "OUT", self.output)
        self.out_patch.start()
        self.api_patch = patch.object(
            generate_evidence,
            "github_json",
            return_value={
                "jobs": [
                    {"name": "CI / required", "conclusion": "success"},
                    {"name": "containers", "conclusion": "skipped"},
                ]
            },
        )
        self.api_patch.start()

    def tearDown(self):
        self.api_patch.stop()
        self.out_patch.stop()
        self.environment.stop()
        self.temp.cleanup()

    def test_bundle_is_allowlisted_and_has_valid_checksums(self):
        generate_evidence.main()
        expected = {
            "manifest.json",
            "checks.json",
            "tool-versions.json",
            "security-summary.json",
            "repository-policy.json",
            "summary.md",
            "checksums.sha256",
        }
        self.assertEqual({path.name for path in self.output.iterdir()}, expected)
        self.assertNotIn("synthetic-test-token", "".join(path.read_text() for path in self.output.iterdir()))
        for line in (self.output / "checksums.sha256").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(generate_evidence.hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)

    def test_non_required_check_failure_blocks_evidence(self):
        with patch.object(
            generate_evidence,
            "github_json",
            return_value={"jobs": [{"name": "CI / required", "conclusion": "success"}, {"name": "lint", "conclusion": "failure"}]},
        ), self.assertRaises(SystemExit):
            generate_evidence.main()


if __name__ == "__main__":
    unittest.main()
