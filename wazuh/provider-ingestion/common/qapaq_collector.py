#!/usr/bin/env python3
"""Shared runtime for the QAPAQ read-only provider collectors (Bitdefender, Snyk, Cloudflare).

Contract shared with ``cato/events_feed.py``:

- Secrets are read from local files only (0600, never symlinks) and never printed.
- Output is JSONL appended with ``fsync``; Wazuh reads it via ``<localfile log_format="json">``.
- The cursor/state is committed with a write-ahead checkpoint: before appending, the state file
  records ``{offset, length, sha256, next}`` of the batch. On restart a complete durable batch is
  recognised and the cursor advances without a second append; a partial batch is truncated back
  to its offset and fetched again from the unchanged cursor.
- Errors are reported with a generic message and, at most, the HTTP status code. Provider
  response bodies are not logged: they can echo request headers or tenant data.

Runs on the Wazuh manager's bundled Python (3.10) or any CPython >= 3.10; stdlib only.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_BATCH_BYTES = 64 * 1024 * 1024
DEFAULT_ROTATE_BYTES = 256 * 1024 * 1024
USER_AGENT = "qapaq-soc-collector/1.0"


class ProviderError(Exception):
    """A connector failure that is safe to report (no secrets, no provider payload)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def read_secret(path: pathlib.Path) -> str:
    """Read one secret value from a restricted local file."""
    if path.is_symlink():
        raise ProviderError("secret file is invalid")
    try:
        metadata = path.stat()
    except OSError as error:
        raise ProviderError("secret file is missing") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ProviderError("secret file is invalid")
    if os.name != "nt" and metadata.st_mode & 0o077:
        raise ProviderError("secret file permissions are too open (expected 0600)")
    value = path.read_text(encoding="utf-8").strip()
    if not value or len(value) > 8192 or any(char in value for char in "\r\n\x00"):
        raise ProviderError("secret file content is invalid")
    return value


def load_config(path: pathlib.Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProviderError("collector configuration is unreadable") from error
    if not isinstance(raw, dict):
        raise ProviderError("collector configuration is invalid")
    return raw


# --------------------------------------------------------------------------- HTTP


def http_json(
    method: str,
    url: str,
    headers: dict[str, str],
    body: object | None = None,
    timeout: float = 30,
    opener=None,
) -> tuple[int, object]:
    """Call a JSON API over HTTPS. Returns ``(status, payload)``; raises on transport errors.

    HTTP error statuses are returned (not raised) so callers can map 401/403/429 explicitly;
    the error body is parsed but callers must not log it.
    """
    if not url.startswith("https://"):
        raise ProviderError("provider endpoint must be https")
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    headers = dict(headers)
    request.add_header("User-Agent", USER_AGENT)
    request.add_header("Accept", headers.pop("Accept", "application/json"))
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for name, value in headers.items():
        request.add_header(name, value)
    open_url = opener or urllib.request.urlopen
    try:
        with open_url(request, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            raw = error.read(MAX_RESPONSE_BYTES + 1)
        except OSError:
            raw = b""
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ProviderError("provider request failed (network)") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ProviderError("provider response is too large", status)
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        if status >= 400:
            return status, None
        raise ProviderError("provider response is not JSON", status) from error


# --------------------------------------------------------------------------- state


def read_state(path: pathlib.Path) -> dict:
    if path.is_symlink():
        raise ProviderError("local state is invalid")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise ProviderError("local state is invalid") from error
    if not isinstance(raw, dict):
        raise ProviderError("local state is invalid")
    pending = raw.get("pending")
    if pending is not None and (
        not isinstance(pending, dict)
        or type(pending.get("offset")) is not int
        or pending["offset"] < 0
        or type(pending.get("length")) is not int
        or not 0 < pending["length"] <= MAX_BATCH_BYTES
        or not isinstance(pending.get("sha256"), str)
        or len(pending["sha256"]) != 64
        or not isinstance(pending.get("next"), dict)
    ):
        raise ProviderError("local pending batch state is invalid")
    return raw


def save_state(path: pathlib.Path, state: dict) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".qapaq-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), 0o640)
            json.dump(state, stream, separators=(",", ":"), sort_keys=True)
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


# --------------------------------------------------------------------------- JSONL


def serialize_events(events: list[dict]) -> bytes:
    return b"".join(
        (json.dumps(event, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        for event in events
    )


def output_size(path: pathlib.Path) -> int:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return 0
    if not stat.S_ISREG(metadata.st_mode):
        raise ProviderError("local event output is not a regular file")
    return metadata.st_size


def append_bytes(path: pathlib.Path, payload: bytes) -> None:
    if not payload:
        return
    if path.is_symlink():
        raise ProviderError("local event output is invalid")
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o640)
    with os.fdopen(fd, "ab") as stream:
        view = memoryview(payload)
        while view:
            written = stream.write(view)
            if written is None or written <= 0:
                raise OSError("short write to local event output")
            view = view[written:]
        stream.flush()
        os.fsync(stream.fileno())


def recover_pending(output: pathlib.Path, state_path: pathlib.Path, state: dict) -> tuple[dict, bool]:
    """Resolve a write-ahead checkpoint left by an interrupted run."""
    pending = state.get("pending")
    if pending is None:
        return state, False
    size = output_size(output)
    offset, length = pending["offset"], pending["length"]
    if size < offset:
        raise ProviderError("local event output changed during a pending batch")
    if size == offset + length:
        with output.open("rb") as stream:
            stream.seek(offset)
            written = stream.read(length)
        if len(written) == length and hashlib.sha256(written).hexdigest() == pending["sha256"]:
            committed = dict(pending["next"])
            save_state(state_path, committed)
            return committed, True
    if size > offset + length:
        raise ProviderError("local event output has unexpected data after a pending batch")
    if output.exists():
        with output.open("r+b") as stream:
            stream.truncate(offset)
            stream.flush()
            os.fsync(stream.fileno())
    rolled_back = {key: value for key, value in state.items() if key != "pending"}
    save_state(state_path, rolled_back)
    return rolled_back, False


def rotate_if_needed(output: pathlib.Path, limit: int) -> None:
    """Keep one previous generation; Wazuh logcollector follows the new inode."""
    if output_size(output) > limit:
        os.replace(output, output.with_name(output.name + ".1"))


def commit_batch(output: pathlib.Path, state_path: pathlib.Path, state: dict, events: list[dict], next_state: dict) -> int:
    """Append ``events`` durably, then advance the state to ``next_state``."""
    payload = serialize_events(events)
    if len(payload) > MAX_BATCH_BYTES:
        raise ProviderError("provider event batch is too large")
    if not payload:
        save_state(state_path, next_state)
        return 0
    offset = output_size(output)
    pending = {
        "offset": offset,
        "length": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "next": next_state,
    }
    checkpoint = {key: value for key, value in state.items() if key != "pending"}
    checkpoint["pending"] = pending
    save_state(state_path, checkpoint)
    append_bytes(output, payload)
    save_state(state_path, next_state)
    return len(events)


def run_collector(name: str, config_path: pathlib.Path, collect) -> int:
    """Generic driver. ``collect(config, state) -> (events, next_state)``."""
    try:
        config = load_config(config_path)
        output = pathlib.Path(config["output_file"])
        state_path = pathlib.Path(config["state_file"])
        state = read_state(state_path)
        state, recovered = recover_pending(output, state_path, state)
        if recovered:
            print(f"{name}: recovered a durable batch from the previous run", file=sys.stderr)
            return 0
        rotate_if_needed(output, int(config.get("rotate_bytes", DEFAULT_ROTATE_BYTES)))
        events, next_state = collect(config, state)
        next_state = {key: value for key, value in next_state.items() if key != "pending"}
        next_state["last_success"] = iso(utc_now())
        written = commit_batch(output, state_path, state, events, next_state)
        print(f"{name}: ok events={written}", file=sys.stderr)
        return 0
    except ProviderError as error:
        status = f" (HTTP {error.status})" if error.status else ""
        print(f"{name}: poll failed: {error}{status}; cursor preserved", file=sys.stderr)
        return 1
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"{name}: poll failed ({type(error).__name__}); cursor preserved", file=sys.stderr)
        return 1


def bounded_ids(values, limit: int) -> list:
    """Keep the most recent ``limit`` dedupe keys (insertion order)."""
    values = list(dict.fromkeys(values))
    return values[-limit:]
