from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from src.scanner import (
    atomic_write,
    load_existing,
    merge_rows,
    parse_evals_page,
    validate_rows,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class EvalsPageParsingTests(unittest.TestCase):
    def test_nixos_unstable_fixture(self) -> None:
        rows = parse_evals_page((FIXTURES / "evals-nixos-unstable.html").read_text())
        self.assertEqual(len(rows), 8)
        latest = rows[0]
        self.assertEqual(latest["eval"], 1828024)
        self.assertEqual(latest["rev"], "867dcbc30bafe3c862ef88620f2e7a109d7d3be5")
        self.assertEqual(latest["timestamp"], "2026-08-12T06:44:42Z")
        self.assertEqual(latest["succeeded"], 146467)
        self.assertEqual(latest["failed"], 2572)
        self.assertEqual(latest["queued"], 5898)
        self.assertIsNone(latest["delta"])
        self.assertEqual(latest["status"], "Eval Errors")

    def test_nixpkgs_unstable_fixture(self) -> None:
        rows = parse_evals_page((FIXTURES / "evals-nixpkgs-unstable.html").read_text())
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows[0]["eval"], 1828030)
        self.assertEqual(rows[0]["rev"], "044bfe75bfe4c7bbe043dc17b5e42ea823b84a09")

    def test_unstable_small_fixture_missing_cells_default_to_zero(self) -> None:
        rows = parse_evals_page((FIXTURES / "evals-nixos-unstable-small.html").read_text())
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows[0]["eval"], 1828023)
        self.assertEqual(rows[0]["succeeded"], 120)
        self.assertEqual(rows[0]["failed"], 0)
        self.assertEqual(rows[0]["queued"], 0)
        self.assertIsNone(rows[0]["delta"])

    def test_finished_eval_has_zero_queued_and_delta(self) -> None:
        rows = parse_evals_page((FIXTURES / "evals-nixos-unstable.html").read_text())
        finished = next(row for row in rows if row["eval"] == 1827979)
        self.assertEqual(finished["queued"], 0)
        self.assertEqual(finished["delta"], "+208")

    def test_rows_are_sorted_newest_first(self) -> None:
        rows = parse_evals_page((FIXTURES / "evals-nixos-unstable.html").read_text())
        ids = [row["eval"] for row in rows]
        self.assertEqual(ids, sorted(ids, reverse=True))

    def test_garbage_markup_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_evals_page("<html><body>no table here</body></html>")
        with self.assertRaises(ValueError):
            parse_evals_page("<table><tbody><tr><td>x</td></tr></tbody></table>")

    def test_revision_always_full(self) -> None:
        for fixture in ("evals-nixos-unstable.html", "evals-nixpkgs-unstable.html", "evals-nixos-unstable-small.html"):
            for row in parse_evals_page((FIXTURES / fixture).read_text()):
                self.assertRegex(row["rev"], r"^[0-9a-f]{40}$")


class RowValidationTests(unittest.TestCase):
    def test_validation_accepts_valid_rows(self) -> None:
        validate_rows([
            {"eval": 2, "rev": "a" * 40, "timestamp": "2026-08-12T00:00:00Z",
             "succeeded": 10, "failed": 0, "queued": 0, "delta": None, "status": None},
            {"eval": 1, "rev": "b" * 40, "timestamp": None,
             "succeeded": 0, "failed": 0, "queued": 0, "delta": "-5", "status": "Eval Errors"},
        ])

    def test_validation_rejects_bad_rows(self) -> None:
        with self.assertRaises(ValueError):
            validate_rows([{"eval": 1, "rev": "z", "succeeded": -1, "failed": 0, "queued": 0}])
        with self.assertRaises(ValueError):
            validate_rows([{"eval": "1", "rev": "a" * 40, "succeeded": 1, "failed": 0, "queued": 0}])
        with self.assertRaises(ValueError):
            validate_rows([{"eval": 2, "rev": "a" * 40, "succeeded": 1, "failed": 0, "queued": 0},
                           {"eval": 2, "rev": "b" * 40, "succeeded": 1, "failed": 0, "queued": 0}])
        with self.assertRaises(ValueError):
            validate_rows([{"eval": 1, "rev": "a" * 40, "succeeded": 1, "failed": 0, "queued": 0},
                           {"eval": 2, "rev": "b" * 40, "succeeded": 1, "failed": 0, "queued": 0}])

    def test_validation_rejects_unsorted_rows(self) -> None:
        rows = [
            {"eval": 1, "rev": "a" * 40, "succeeded": 1, "failed": 0, "queued": 0},
            {"eval": 2, "rev": "b" * 40, "succeeded": 1, "failed": 0, "queued": 0},
        ]
        with self.assertRaises(ValueError):
            validate_rows(rows)


class MergeTests(unittest.TestCase):
    def row(self, eval_id: int, queued: int = 0) -> dict:
        return {"eval": eval_id, "rev": f"{eval_id:040d}", "timestamp": None,
                "succeeded": 10, "failed": 0, "queued": queued, "delta": None, "status": None}

    def test_fresh_rows_replace_previous_and_new_ones_are_added(self) -> None:
        merged = merge_rows([self.row(2), self.row(1)], [self.row(2, 5), self.row(3)], limit=10)
        ids = [row["eval"] for row in merged]
        self.assertEqual(ids, [3, 2, 1])
        self.assertEqual(merged[1]["queued"], 5)

    def test_history_is_pruned_newest_first(self) -> None:
        merged = merge_rows([self.row(i) for i in range(1, 6)], [self.row(6)], limit=3)
        self.assertEqual([row["eval"] for row in merged], [6, 5, 4])


class StorageTests(unittest.TestCase):
    def test_atomic_write_and_load_existing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            atomic_write(path, {"schemaVersion": 1, "targets": {"t": {"rows": []}}})
            self.assertTrue(path.exists())
            data = load_existing(path)
            self.assertEqual(data["targets"]["t"]["rows"], [])

    def test_load_existing_missing_file_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = load_existing(Path(directory) / "missing.json")
            self.assertEqual(data, {"schemaVersion": 1, "generatedAt": None, "targets": {}})

    def test_load_existing_rejects_malformed_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            path.write_text(json.dumps([1, 2, 3]))
            with self.assertRaises(ValueError):
                load_existing(path)


if __name__ == "__main__":
    unittest.main()
