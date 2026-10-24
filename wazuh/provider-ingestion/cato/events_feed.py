#!/usr/bin/env python3
"""Fetch Cato Networks eventsFeed pages and emit JSONL for Wazuh."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import tempfile
import urllib.error
import urllib.request


MAX_RESPONSE_BYTES = 32 * 1024 * 1024
DEFAULT_ENDPOINT = "https://api.catonetworks.com/api/v1/graphql2"
QUERY = """query eventsFeed($accountIDs: [ID!], $marker: String) {
  eventsFeed(accountIDs: $accountIDs, marker: $marker) {
    marker fetchedCount accounts { id errorString records { fieldsMap } }
  }
}"""


class ProviderError(Exception):
    """A safe-to-report connector failure without provider response contents."""


def parse_payload(payload: object, account_id: str) -> tuple[str, list[dict]]:
    if not isinstance(payload, dict) or payload.get("errors"):
        raise ProviderError("provider response is invalid")
    data = payload.get("data")
    feed = data.get("eventsFeed") if isinstance(data, dict) else None
    if not isinstance(feed, dict):
        raise ProviderError("provider response is invalid")
    marker = feed.get("marker")
    accounts = feed.get("accounts")
    fetched_count = feed.get("fetchedCount")
    if (
        not isinstance(marker, str) or not marker or len(marker) > 4096
        or not isinstance(accounts, list) or not isinstance(fetched_count, int) or fetched_count < 0
    ):
        raise ProviderError("provider response is invalid")
    selected = [entry for entry in accounts if isinstance(entry, dict) and str(entry.get("id")) == account_id]
    if not selected and fetched_count == 0 and not accounts:
        # Cato documents that the first marker request may return no records and only
        # establish the queue position.
        return marker, []
    if len(selected) != 1 or selected[0].get("errorString"):
        raise ProviderError("provider response is invalid")
    records = selected[0].get("records")
    if not isinstance(records, list):
        raise ProviderError("provider response is invalid")
    events = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("fieldsMap"), dict):
            raise ProviderError("provider response is invalid")
        fields = record["fieldsMap"]
        if len(fields) > 500:
            raise ProviderError("provider response is invalid")
        events.append({
            "integration": {"vendor": "cato", "product": "eventsFeed"},
            "event": {"id": str(fields.get("event_id", "")), "provider": "Cato Networks"},
            "cato": {"account_id": account_id, "fields": fields},
        })
    return marker, events


def read_state(path: pathlib.Path) -> str | None:
    if path.is_symlink():
        raise ProviderError("local cursor state is invalid")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise ProviderError("local cursor state is invalid") from error
    marker = raw.get("marker") if isinstance(raw, dict) else None
    if not isinstance(marker, str) or not marker or len(marker) > 4096:
        raise ProviderError("local cursor state is invalid")
    return marker


def save_state(path: pathlib.Path, marker: str) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".cato-marker-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o640)
            json.dump({"marker": marker}, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if hasattr(os, "O_DIRECTORY"):
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append_events(path: pathlib.Path, events: list[dict]) -> None:
    if not events:
        return
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o640)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        for event in events:
            stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def fetch(endpoint: str, account_id: str, api_key: str, marker: str | None) -> tuple[str, list[dict]]:
    if not endpoint.startswith("https://") or len(endpoint) > 256:
        raise ProviderError("connector endpoint is invalid")
    body = json.dumps({"query": QUERY, "variables": {"accountIDs": [account_id], "marker": marker}}).encode()
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", "x-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise ProviderError("provider request failed")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ProviderError("provider request failed") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ProviderError("provider response is too large")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError("provider response is invalid") from error
    return parse_payload(payload, account_id)


def run(config_path: pathlib.Path) -> int:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        account_id = config["account_id"]
        endpoint = config.get("endpoint", DEFAULT_ENDPOINT)
        key_path = pathlib.Path(config["api_key_file"])
        state_path = pathlib.Path(config["state_file"])
        output_path = pathlib.Path(config["output_file"])
        api_key = key_path.read_text(encoding="utf-8").strip()
        if (
            not isinstance(account_id, str)
            or not account_id.isdigit()
            or not api_key
            or len(api_key) > 4096
            or any(char in api_key for char in "\r\n\x00")
        ):
            raise ProviderError("connector configuration is invalid")
        old_marker = read_state(state_path)
        new_marker, events = fetch(endpoint, account_id, api_key, old_marker)
        append_events(output_path, events)
        # Commit only after the complete response is validated and emitted. A crash before
        # this point replays the same provider batch rather than silently skipping it.
        save_state(state_path, new_marker)
        return 0
    except (OSError, KeyError, TypeError, json.JSONDecodeError, ProviderError):
        print("qapaq-cato-ingest: provider poll failed; cursor preserved", file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=pathlib.Path)
    return run(parser.parse_args().config)


if __name__ == "__main__":
    raise SystemExit(main())
