#!/usr/bin/env python3
"""Query Hydra for the build progress of nixos-unstable / nixpkgs-unstable commits."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = 1
USER_AGENT = "isitbuilt-scanner/1.0 (+https://github.com/MiRinChan/IsItBuilt-QuestionMark)"
FULL_REV_RE = re.compile(r"copyToClipboard\('([0-9a-f]{40})'")
SHORT_REV_RE = re.compile(r"<tt>([0-9a-f]+)</tt>")
DATETIME_RE = re.compile(r'<time[^>]*datetime="([^"]+)"')
EVAL_ID_RE = re.compile(r"/eval/(\d+)")
BADGE_SUCCESS_RE = re.compile(r"badge-success\">(\d+)")
BADGE_DANGER_RE = re.compile(r"badge-danger\">(\d+)")
BADGE_SECONDARY_RE = re.compile(r"badge-secondary\">(\d+)")
BADGE_WARNING_RE = re.compile(r"badge-warning\">([^<]+)<")
DELTA_RE = re.compile(r"<strong>([+-]\d+)</strong>")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def eprint(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def load_config(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict) or not isinstance(config.get("targets"), list):
        raise ValueError(f"{path} is not a valid config: expected 'targets' list")
    return config


def http_get(url: str, timeout: float, retries: int, backoff: float) -> str:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(backoff * (2 ** (attempt - 1)))
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            if error.code < 500:
                raise
            last_error = error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
    raise RuntimeError(f"GET {url} failed after {retries + 1} attempts: {last_error}")


def parse_eval_row(block: str) -> dict | None:
    eval_match = EVAL_ID_RE.search(block)
    if not eval_match:
        return None
    datetime_match = DATETIME_RE.search(block)
    succeeded = BADGE_SUCCESS_RE.findall(block)
    failed = BADGE_DANGER_RE.findall(block)
    queued = BADGE_SECONDARY_RE.findall(block)
    delta = DELTA_RE.findall(block)
    status = BADGE_WARNING_RE.findall(block)
    full_rev = FULL_REV_RE.search(block)
    short_rev = SHORT_REV_RE.search(block)
    rev = full_rev.group(1) if full_rev else short_rev.group(1) if short_rev else None
    if not rev:
        return None
    return {
        "eval": int(eval_match.group(1)),
        "rev": rev,
        "timestamp": datetime_match.group(1) if datetime_match else None,
        "succeeded": int(succeeded[0]) if succeeded else 0,
        "failed": int(failed[0]) if failed else 0,
        "queued": int(queued[0]) if queued else 0,
        "delta": delta[0] if delta else None,
        "status": status[0] if status else None,
    }


def parse_evals_page(markup: str) -> list[dict]:
    body = re.search(r"<tbody>(.*?)</tbody>", markup, re.S)
    if not body:
        raise ValueError("could not find a <tbody> with evaluation rows in the evals page")
    rows: list[dict] = []
    for block in re.findall(r"<tr[^>]*>(.*?)</tr>", body.group(1), re.S):
        row = parse_eval_row(block)
        if row:
            rows.append(row)
    if not rows:
        raise ValueError("the evals page contained no parseable evaluation rows")
    rows.sort(key=lambda row: row["eval"], reverse=True)
    return rows


def validate_row(row: dict) -> list[str]:
    problems: list[str] = []
    if not isinstance(row.get("eval"), int) or row["eval"] <= 0:
        problems.append(f"invalid eval id {row.get('eval')!r}")
    rev = row.get("rev")
    if not isinstance(rev, str) or not re.fullmatch(r"[0-9a-f]{7,40}", rev):
        problems.append(f"invalid revision {rev!r}")
    for key in ("succeeded", "failed", "queued"):
        if not isinstance(row.get(key), int) or row[key] < 0:
            problems.append(f"invalid {key} {row.get(key)!r}")
    return problems


def validate_rows(rows: list[dict]) -> None:
    seen: set[int] = set()
    for row in rows:
        problems = validate_row(row)
        if problems:
            raise ValueError(f"invalid row for eval {row.get('eval')}: {', '.join(problems)}")
        if row["eval"] in seen:
            raise ValueError(f"duplicate eval {row['eval']} in rows")
        seen.add(row["eval"])
    ids = [row["eval"] for row in rows]
    if ids != sorted(ids, reverse=True):
        raise ValueError("rows must be sorted newest first")


def merge_rows(previous: list[dict], fresh: list[dict], limit: int) -> list[dict]:
    by_eval = {row["eval"]: row for row in previous}
    by_eval.update({row["eval"]: row for row in fresh})
    rows = sorted(by_eval.values(), key=lambda row: row["eval"], reverse=True)
    return rows[:limit]


def load_existing(path: Path) -> dict:
    if not path.exists():
        return {"schemaVersion": SCHEMA_VERSION, "generatedAt": None, "targets": {}}
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("targets"), dict):
        raise ValueError(f"{path} is not a valid data file")
    return data


def atomic_write(path: Path, data: dict) -> None:
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, prefix=".data.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(payload)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def scan_target(target: dict, config: dict) -> dict | None:
    url = f"{config['hydraUrl'].rstrip('/')}/jobset/{target['jobset']}/evals"
    eprint(f"scanning {target['id']} ({target['jobset']}): {url}")
    markup = http_get(
        url,
        timeout=config["http"]["requestTimeoutSeconds"],
        retries=config["http"]["retries"],
        backoff=config["http"]["retryBackoffSeconds"],
    )
    rows = parse_evals_page(markup)
    validate_rows(rows)
    return {
        "meta": {
            "id": target["id"],
            "label": target.get("label", target["id"]),
            "jobset": target["jobset"],
            "repository": target["repository"],
            "repositoryUrl": target["repositoryUrl"],
            "branch": target["branch"],
        },
        "generatedAt": utc_now(),
        "lastAttemptAt": utc_now(),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--data", type=Path, default=ROOT / "site" / "data.json")
    args = parser.parse_args()

    config = load_config(args.config)
    existing = load_existing(args.data)
    previous = existing.get("targets", {})
    limit = int(config.get("historyLimit", 30))

    targets: dict[str, dict] = {}
    succeeded = 0
    for target in config["targets"]:
        target_id = target["id"]
        prior = previous.get(target_id)
        prior_rows = prior.get("rows", []) if isinstance(prior, dict) else []
        try:
            fresh = scan_target(target, config)
        except Exception as error:
            eprint(f"error scanning {target_id}: {error}")
            if prior is not None:
                targets[target_id] = dict(prior)
                targets[target_id]["lastAttemptAt"] = utc_now()
            continue
        rows = merge_rows(prior_rows, fresh["rows"], limit)
        validate_rows(rows)
        targets[target_id] = {
            "meta": fresh["meta"],
            "generatedAt": fresh["generatedAt"],
            "lastAttemptAt": fresh["lastAttemptAt"],
            "rows": rows,
        }
        succeeded += 1

    if not succeeded:
        if targets:
            eprint("every target failed to refresh; keeping previous data")
            return 0
        raise SystemExit("no target could be scanned and no previous data exists")

    data = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": utc_now(),
        "targets": targets,
    }
    atomic_write(args.data, data)
    eprint(f"wrote {args.data} ({succeeded} target(s) refreshed, {len(targets)} target(s) total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
