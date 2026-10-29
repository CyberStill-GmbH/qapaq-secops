#!/usr/bin/env python3
"""Require HTTPS for Ubuntu mirrors and reject unapproved HTTP APT sources."""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from urllib.parse import urlsplit

UBUNTU_MIRRORS = {
    "archive.ubuntu.com",
    "azure.archive.ubuntu.com",
    "security.ubuntu.com",
}
URL = re.compile(r"https?://[^\s,]+", re.IGNORECASE)
# azure.archive.ubuntu.com solo sirve HTTP; por HTTPS se usa el archivo oficial de Ubuntu.
HTTPS_HOST_FOR = {"azure.archive.ubuntu.com": "archive.ubuntu.com"}


def normalize_sources(paths: list[pathlib.Path]) -> list[pathlib.Path]:
    """Rewrite approved Ubuntu HTTP mirror URLs; reject any other active HTTP source."""
    pending: list[tuple[pathlib.Path, str]] = []

    def rewrite_line(line: str) -> str:
        if not line.strip() or line.lstrip().startswith("#"):
            return line

        def upgrade(match: re.Match[str]) -> str:
            url = match.group(0)
            parsed = urlsplit(url)
            host = (parsed.hostname or "").lower()
            if parsed.scheme.lower() != "http":
                if host in HTTPS_HOST_FOR and parsed.port is None:
                    return "https://" + HTTPS_HOST_FOR[host] + url[len("https://") + len(parsed.netloc) :]
                return url
            if host not in UBUNTU_MIRRORS or parsed.port is not None:
                raise ValueError("active HTTP APT source is outside the approved Ubuntu mirror allowlist")
            return "https://" + HTTPS_HOST_FOR.get(host, parsed.netloc) + url[len("http://") + len(parsed.netloc) :]

        return URL.sub(upgrade, line)

    for path in paths:
        if not path.is_file():
            continue
        original = path.read_text(encoding="utf-8")
        lines = original.splitlines(keepends=True)
        updated_lines: list[str] = []
        if path.suffix == ".sources":
            stanza: list[str] = []

            def flush_stanza() -> None:
                disabled = any(
                    re.match(r"^\s*Enabled\s*:\s*no\s*$", item, re.IGNORECASE)
                    for item in stanza
                )
                updated_lines.extend(stanza if disabled else [rewrite_line(item) for item in stanza])
                stanza.clear()

            for line in lines:
                if line.strip():
                    stanza.append(line)
                else:
                    if stanza:
                        flush_stanza()
                    updated_lines.append(line)
            if stanza:
                flush_stanza()
        else:
            updated_lines = [rewrite_line(line) for line in lines]
        pending.append((path, "".join(updated_lines)))

    changed: list[pathlib.Path] = []
    for path, updated in pending:
        if updated != path.read_text(encoding="utf-8"):
            path.write_text(updated, encoding="utf-8")
            changed.append(path)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources-list", type=pathlib.Path, default=pathlib.Path("/etc/apt/sources.list"))
    parser.add_argument("--sources-dir", type=pathlib.Path, default=pathlib.Path("/etc/apt/sources.list.d"))
    args = parser.parse_args()
    paths = [args.sources_list, *args.sources_dir.glob("*.list"), *args.sources_dir.glob("*.sources")]
    try:
        normalize_sources(paths)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"qapaq-siem-apt: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
