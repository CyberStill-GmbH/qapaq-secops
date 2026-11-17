"""Shared fixtures for the platform-monitoring tests (no network, no docker)."""

from __future__ import annotations

import gzip
import json
import pathlib
import sys
from datetime import datetime, timezone

import pytest

HERE = pathlib.Path(__file__).resolve().parent
PM = HERE.parent
COMMON = PM.parent / "provider-ingestion" / "common"
for path in (PM, COMMON):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)

KEV = {"CVE-2021-44228": {"dateAdded": "2021-12-10", "dueDate": "2021-12-24", "knownRansomwareCampaignUse": "Known"}}
EPSS_ROWS = [
    ("CVE-2021-44228", 0.97, 0.9999),
    ("CVE-2023-0001", 0.62, 0.98),
    ("CVE-2023-0002", 0.30, 0.90),
    ("CVE-2020-0003", 0.002, 0.10),
    ("CVE-2020-0004", 0.01, 0.30),
]


def epss_csv(rows=EPSS_ROWS, extra: int = 0) -> bytes:
    lines = ["#model_version:v2025.03.14,score_date:2026-11-09T00:00:00+0000", "cve,epss,percentile"]
    lines += [f"{c},{e},{p}" for c, e, p in rows]
    lines += [f"CVE-2010-{i:05d},0.00100,0.05000" for i in range(extra)]
    return gzip.compress(("\n".join(lines) + "\n").encode())


def kev_json(cves=KEV, count_pad: int = 0) -> bytes:
    vulns = [{"cveID": c, **v} for c, v in cves.items()]
    vulns += [{"cveID": f"CVE-2015-{i:05d}", "dateAdded": "2022-01-01"} for i in range(count_pad)]
    return json.dumps({"catalogVersion": "2026.11.08", "dateReleased": "2026-11-08", "vulnerabilities": vulns}).encode()


@pytest.fixture
def cache_dir(tmp_path):
    cache = tmp_path / "vulnprio"
    cache.mkdir()
    (cache / "kev.json").write_text(json.dumps({"generated_at": "2026-11-09T06:00:00Z", "catalog_version": "2026.11.08",
                                                "cves": KEV}))
    (cache / "epss.csv.gz").write_bytes(epss_csv())
    (cache / "exposure.json").write_text(json.dumps({"snyk_projects": ["web/portal.example"],
                                                     "snyk_project_patterns": ["^public-"], "agents": ["qapaq-soc-dev-node"]}))
    return cache


@pytest.fixture
def now():
    return NOW
