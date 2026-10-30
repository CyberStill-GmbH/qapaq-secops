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

    def test_transient_partial_job_list_is_retried_then_recorded(self):
        partial = {
            "total_count": 2,
            "jobs": [
                {"id": 1, "name": "CI / required", "status": "completed", "conclusion": "success"}
            ],
        }
        empty_page = {"total_count": 2, "jobs": []}
        complete = {
            "total_count": 2,
            "jobs": [
                {"id": 1, "name": "CI / required", "status": "completed", "conclusion": "success"},
                {"id": 2, "name": "quality", "status": "completed", "conclusion": "success"},
            ],
        }

        def response(url, _token):
            if "page=2" in url:
                return empty_page
            response.calls += 1
            return partial if response.calls == 1 else complete

        response.calls = 0
        with patch.object(generate_evidence, "github_json", side_effect=response), patch.object(
            generate_evidence, "time"
        ) as sleep:
            generate_evidence.main()

        checks = json.loads((self.output / "checks.json").read_text(encoding="utf-8"))["checks"]
        self.assertEqual(len(checks), 2)
        self.assertEqual(response.calls, 2)
        sleep.sleep.assert_called_once_with(1)

    def test_job_list_paginates_before_evidence_is_written(self):
        pages = {
            1: {
                "total_count": 2,
                "jobs": [
                    {"id": 1, "name": "CI / required", "status": "completed", "conclusion": "success"}
                ],
            },
            2: {
                "total_count": 2,
                "jobs": [
                    {"id": 2, "name": "quality", "status": "completed", "conclusion": "success"}
                ],
            },
        }

        def response(url, _token):
            page = int(url.rsplit("page=", 1)[1])
            return pages[page]

        with patch.object(generate_evidence, "github_json", side_effect=response):
            generate_evidence.main()

        checks = json.loads((self.output / "checks.json").read_text(encoding="utf-8"))["checks"]
        self.assertEqual({check["name"] for check in checks}, {"CI / required", "quality"})

    def test_incomplete_jobs_fail_closed_after_bounded_retries(self):
        partial = {
            "total_count": 2,
            "jobs": [
                {"id": 1, "name": "CI / required", "status": "completed", "conclusion": "success"}
            ],
        }
        empty_page = {"total_count": 2, "jobs": []}
        with patch.object(
            generate_evidence,
            "github_json",
            side_effect=lambda url, _token: empty_page if "page=2" in url else partial,
        ), patch.object(generate_evidence, "time") as sleep, self.assertRaises(SystemExit):
            generate_evidence.main()

        self.assertEqual(sleep.sleep.call_count, len(generate_evidence.JOB_LIST_RETRY_DELAYS_SECONDS))
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
