from pathlib import Path
import unittest


WORKFLOW = Path(__file__).parents[1] / "workflows" / "ci.yml"


class CodeQLWorkflowTests(unittest.TestCase):
    def test_analysis_is_preserved_without_requiring_code_scanning(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("github/codeql-action/analyze@", workflow)
        self.assertIn("output: codeql-results", workflow)
        self.assertIn("upload: never", workflow)
        self.assertIn("upload-database: false", workflow)
        self.assertIn("actions/upload-artifact@", workflow)
        self.assertIn("path: codeql-results", workflow)
        self.assertIn("if-no-files-found: error", workflow)

    def test_codeql_job_has_least_privilege_permissions(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        codeql_job = workflow.split("  codeql:\n", 1)[1].split("\n  secrets:\n", 1)[0]

        self.assertIn("actions: read", codeql_job)
        self.assertIn("contents: read", codeql_job)
        self.assertNotIn("security-events: write", codeql_job)


if __name__ == "__main__":
    unittest.main()
