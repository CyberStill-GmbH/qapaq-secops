#!/usr/bin/env python3
"""Create a small allowlisted evidence bundle for a successful main CI run."""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


OUT = Path("artifacts/c09-evidence")
REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_FILES = 12
MAX_BYTES = 256 * 1024


def github_json(url: str, token: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def main() -> None:
    repository = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ["C09_RUN_ID"]
    token = os.environ["GITHUB_TOKEN"]
    event_path = Path(os.environ["GITHUB_EVENT_PATH"])
    event = json.loads(event_path.read_text(encoding="utf-8"))
    workflow_run = event["workflow_run"]
    if (
        workflow_run.get("event") != "push"
        or workflow_run.get("head_branch") != "main"
        or workflow_run.get("conclusion") != "success"
    ):
        raise SystemExit("Evidence may only be generated for a successful main push run")

    jobs_response = github_json(
        f"https://api.github.com/repos/{repository}/actions/runs/{run_id}/jobs?per_page=100",
        token,
    )
    jobs = [
        {"name": job["name"], "conclusion": job.get("conclusion", "unknown")}
        for job in jobs_response.get("jobs", [])
    ]
    if not jobs or any(job["conclusion"] not in {"success", "skipped"} for job in jobs):
        raise SystemExit("Source run jobs are incomplete or unsuccessful")
    if not any(job["name"] == "CI / required" and job["conclusion"] == "success" for job in jobs):
        raise SystemExit("Source run does not contain a successful CI / required check")

    OUT.mkdir(parents=True, exist_ok=True)
    data = {
        "manifest.json": {
            "repository": repository,
            "commit": workflow_run["head_sha"],
            "run_id": run_id,
            "event": "push",
            "branch": "main",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "source_conclusion": "success",
        },
        "checks.json": {"checks": sorted(jobs, key=lambda job: job["name"])},
        "tool-versions.json": {
            "node": os.environ["NODE_VERSION"],
            "pnpm": os.environ["PNPM_VERSION"],
            "gitleaks": os.environ["GITLEAKS_VERSION"],
            "trivy": "0.74.0 (repository scanner pin)",
        },
        "security-summary.json": {
            "gitleaks": "passed in source CI run",
            "trivy_filesystem": "passed in source CI run",
            "codeql": "passed in source CI run; SARIF upload disabled by repository plan",
            "dependency_audit": "passed in source CI run",
            "finding_counts": "not exported by source workflow",
        },
        "repository-policy.json": json.loads(
            (REPO_ROOT / "docs/reference/repository-policy.json").read_text(encoding="utf-8")
        ),
    }
    for name, value in data.items():
        (OUT / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = (
        "# C-09 CI evidence\n\n"
        f"- Repository: `{repository}`\n"
        f"- Commit: `{workflow_run['head_sha']}`\n"
        f"- Source run: `{run_id}` (successful push to `main`)\n"
        f"- Checks recorded: {len(jobs)}\n"
        "- This is operational CI evidence, not an immutable audit archive.\n"
    )
    (OUT / "summary.md").write_text(summary, encoding="utf-8")

    files = sorted(path for path in OUT.iterdir() if path.is_file())
    if len(files) > MAX_FILES or sum(path.stat().st_size for path in files) > MAX_BYTES:
        raise SystemExit("Evidence exceeds the configured file or size limit")

    sensitive = re.compile(
        r"(?i)(gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|"
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(password|secret|token)\s*[:=]\s*\S+)"
    )
    for path in files:
        if sensitive.search(path.read_text(encoding="utf-8")):
            raise SystemExit(f"Sensitive pattern detected in evidence file: {path.name}")

    lines = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in files]
    (OUT / "checksums.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
