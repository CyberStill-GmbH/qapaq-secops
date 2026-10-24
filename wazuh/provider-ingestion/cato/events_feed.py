#!/usr/bin/env python3
"""Fetch Cato Networks eventsFeed pages and emit JSONL for Wazuh."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile
import urllib.error
import urllib.request


MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_BATCH_BYTES = 64 * 1024 * 1024
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


def read_state(path: pathlib.Path) -> dict:
    if path.is_symlink():
        raise ProviderError("local cursor state is invalid")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"marker": None}
    except (OSError, json.JSONDecodeError) as error:
        raise ProviderError("local cursor state is invalid") from error
    if not isinstance(raw, dict) or set(raw) - {"marker", "pending"}:
        raise ProviderError("local cursor state is invalid")
    marker = raw.get("marker")
    if marker is not None and (not isinstance(marker, str) or not marker or len(marker) > 4096):
        raise ProviderError("local cursor state is invalid")
    pending = raw.get("pending")
    if pending is not None:
        if (
            not isinstance(pending, dict)
            or not isinstance(pending.get("marker"), str)
            or not pending["marker"]
            or type(pending.get("offset")) is not int
            or pending["offset"] < 0
            or type(pending.get("length")) is not int
            or pending["length"] <= 0
            or pending["length"] > MAX_BATCH_BYTES
            or not isinstance(pending.get("sha256"), str)
            or len(pending["sha256"]) != 64
            or any(char not in "0123456789abcdef" for char in pending["sha256"])
        ):
            raise ProviderError("local pending batch state is invalid")
    return {"marker": marker, "pending": pending} if pending else {"marker": marker}


def save_state(path: pathlib.Path, marker: str | None, pending: dict | None = None) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".cato-marker-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o640)
            state = {"marker": marker}
            if pending is not None:
                state["pending"] = pending
            json.dump(state, stream, separators=(",", ":"))
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


def serialize_events(events: list[dict]) -> bytes:
    return b"".join(
        (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        for event in events
    )


def append_bytes(path: pathlib.Path, payload: bytes) -> None:
    if not payload:
        return
    if path.is_symlink():
        raise ProviderError("local event output is invalid")
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o640)
    with os.fdopen(fd, "ab") as stream:
        view = memoryview(payload)
        while view:
            written = stream.write(view)
            if written is None or written <= 0:
                raise OSError("short write to local event output")
            view = view[written:]
        stream.flush()
        os.fsync(stream.fileno())


def output_size(path: pathlib.Path) -> int:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return 0
    if not stat.S_ISREG(metadata.st_mode):
        raise ProviderError("local event output is not a regular file")
    return metadata.st_size


def recover_pending(path: pathlib.Path, state_path: pathlib.Path, state: dict) -> tuple[dict, bool]:
    pending = state.get("pending")
    if pending is None:
        return state, False

    size = output_size(path)
    offset = pending["offset"]
    length = pending["length"]
    if size < offset:
        raise ProviderError("local event output changed during a pending batch")

    if size == offset + length:
        with path.open("rb") as stream:
            stream.seek(offset)
            written_batch = stream.read(length)
        if len(written_batch) == length and hashlib.sha256(written_batch).hexdigest() == pending["sha256"]:
            committed = {"marker": pending["marker"]}
            save_state(state_path, committed["marker"])
            return committed, True

    if size > offset + length:
        raise ProviderError("local event output has unexpected data after a pending batch")

    # An incomplete append is rolled back to its recorded byte offset, then fetched again
    # from the unchanged provider cursor. A complete append is recognized above and the
    # cursor advances without writing the same Cato events twice.
    if path.exists():
        with path.open("r+b") as stream:
            stream.truncate(offset)
            stream.flush()
            os.fsync(stream.fileno())
    recovered = {"marker": state.get("marker")}
    save_state(state_path, recovered["marker"])
    return recovered, False


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
        state = read_state(state_path)
        state, recovered_complete_batch = recover_pending(output_path, state_path, state)
        if recovered_complete_batch:
            return 0
        old_marker = state["marker"]
        new_marker, events = fetch(endpoint, account_id, api_key, old_marker)
        payload = serialize_events(events)
        if len(payload) > MAX_BATCH_BYTES:
            raise ProviderError("provider event batch is too large")
        if not payload:
            save_state(state_path, new_marker)
            return 0

        offset = output_size(output_path)
        pending = {
            "marker": new_marker,
            "offset": offset,
            "length": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        # Persist a write-ahead checkpoint before output. On restart, a complete durable
        # batch advances the marker; a partial batch is truncated and fetched again.
        save_state(state_path, old_marker, pending)
        append_bytes(output_path, payload)
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
