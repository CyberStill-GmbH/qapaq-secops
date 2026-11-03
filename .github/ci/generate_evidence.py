#!/usr/bin/env python3
"""Create a small allowlisted evidence bundle for a successful main CI run."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


OUT = Path("artifacts/c09-evidence")
REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_FILES = 12
MAX_BYTES = 256 * 1024
MAX_JOB_PAGES = 20
JOB_LIST_RETRY_DELAYS_SECONDS = (1, 2, 4, 8, 16)


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


def source_jobs(repository: str, run_id: str, token: str) -> list[dict]:
    """Read the complete paginated job list, retrying only an incomplete/transient view."""
    base_url = f"https://api.github.com/repos/{repository}/actions/runs/{run_id}/jobs"
    for attempt in range(len(JOB_LIST_RETRY_DELAYS_SECONDS) + 1):
        jobs_by_id: dict[str, dict] = {}
        expected_total: int | None = None
        page = 1
        inconsistent = False

        while page <= MAX_JOB_PAGES:
            response = github_json(f"{base_url}?per_page=100&page={page}", token)
            batch = response.get("jobs", [])
            if not isinstance(batch, list):
                raise SystemExit("GitHub returned an invalid source run job list")
            total = response.get("total_count")
            if total is not None:
                if not isinstance(total, int) or total < 0:
                    raise SystemExit("GitHub returned an invalid source run job count")
                if expected_total is not None and expected_total != total:
                    inconsistent = True
                    break
                expected_total = total
            elif expected_total is None:
                # The API includes total_count; this fallback keeps fixtures/adapters explicit
                # while still treating the returned list as complete only when no next page exists.
                expected_total = len(batch)

            for job in batch:
                if not isinstance(job, dict) or not isinstance(job.get("name"), str):
                    raise SystemExit("GitHub returned an invalid source run job")
                key = str(job.get("id", f"{page}:{len(jobs_by_id)}:{job['name']}"))
                jobs_by_id[key] = {
                    "name": job["name"],
                    "status": job.get("status", "completed" if job.get("conclusion") else "unknown"),
                    "conclusion": job.get("conclusion"),
                }

            if expected_total is not None and len(jobs_by_id) >= expected_total:
                break
            if not batch:
                break
            page += 1

        jobs = list(jobs_by_id.values())
        complete = (
            not inconsistent
            and expected_total is not None
            and expected_total > 0
            and len(jobs) == expected_total
            and all(job["status"] == "completed" and job["conclusion"] for job in jobs)
        )
        if complete:
            return jobs

        if attempt == len(JOB_LIST_RETRY_DELAYS_SECONDS):
            raise SystemExit("Source run jobs remain incomplete after bounded retries")
        time.sleep(JOB_LIST_RETRY_DELAYS_SECONDS[attempt])

    raise SystemExit("Source run jobs remain incomplete after bounded retries")


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

    jobs = source_jobs(repository, run_id, token)
    if any(job["conclusion"] not in {"success", "skipped"} for job in jobs):
        raise SystemExit("Source run contains unsuccessful jobs")
    evidence_jobs = [
        {"name": job["name"], "conclusion": job["conclusion"]} for job in jobs
    ]
    if not any(
        job["name"] == "CI / required" and job["conclusion"] == "success"
        for job in evidence_jobs
    ):
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
        "checks.json": {"checks": sorted(evidence_jobs, key=lambda job: job["name"])},
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
        f"- Checks recorded: {len(evidence_jobs)}\n"
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
