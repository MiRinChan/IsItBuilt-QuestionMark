import test from "node:test";
import assert from "node:assert/strict";

import {
  barWidth,
  copyRevision,
  currentRows,
  formatDate,
  formatPercent,
  isFinished,
  lockCommandFor,
  nextTargetId,
  rowProgress,
} from "../site/app.js";

const data = {
  targets: {
    "nixos-unstable": {
      meta: {
        id: "nixos-unstable",
        label: "nixos-unstable",
        jobset: "nixos/unstable",
        repository: "NixOS/nixpkgs",
        repositoryUrl: "https://github.com/NixOS/nixpkgs",
      },
      rows: [
        { eval: 3, rev: "c".repeat(40), timestamp: "2026-08-12T00:00:00Z", succeeded: 90, failed: 5, queued: 5, delta: null, status: null },
        { eval: 2, rev: "b".repeat(40), timestamp: "2026-08-11T00:00:00Z", succeeded: 95, failed: 5, queued: 0, delta: "+10", status: null },
        { eval: 1, rev: "a".repeat(40), timestamp: null, succeeded: 0, failed: 0, queued: 0, delta: null, status: "Eval Errors" },
      ],
    },
    "nixpkgs-unstable": {
      meta: { id: "nixpkgs-unstable", label: "nixpkgs-unstable", jobset: "nixpkgs/unstable" },
      rows: [],
    },
  },
};

test("formats percentages to one decimal", () => {
  assert.equal(formatPercent(96.234), "96.2%");
  assert.equal(formatPercent(null), "unavailable");
});

test("row progress counts succeeded over all builds", () => {
  assert.equal(rowProgress(data.targets["nixos-unstable"].rows[0]), 90);
  assert.equal(rowProgress({ succeeded: 0, failed: 0, queued: 0 }), null);
});

test("finished rows have zero queued", () => {
  assert.equal(isFinished({ succeeded: 95, failed: 5, queued: 0 }), true);
  assert.equal(isFinished({ succeeded: 90, failed: 5, queued: 5 }), false);
});

test("commit dates come from the eval timestamp", () => {
  assert.equal(formatDate({ timestamp: "2026-08-11T16:37:53Z" }), "2026-08-11");
  assert.equal(formatDate({ timestamp: null }), "");
  assert.equal(formatDate({}), "");
});

test("bar width uses a log scale that spreads out high progress", () => {
  assert.equal(barWidth(100), 100);
  assert.equal(barWidth(0), 0);
  assert.equal(barWidth(null), 0);
  const highGap = barWidth(99) - barWidth(95);
  const lowGap = barWidth(60) - barWidth(56);
  assert.ok(highGap > lowGap, "99-95 must be wider than 60-56");
  for (const value of [0, 50, 90, 99, 100]) {
    assert.ok(barWidth(value) >= 0 && barWidth(value) <= 100);
  }
  assert.ok(barWidth(50) < barWidth(90) && barWidth(90) < barWidth(99));
});

test("rows are shown newest first with no filtering", () => {
  const rows = currentRows(data);
  assert.deepEqual(rows.map((row) => row.eval), [3, 2, 1]);
  assert.equal(currentRows({ targets: { "nixos-unstable": { rows: [] } } }).length, 0);
  assert.deepEqual(currentRows({}), []);
});

test("the title switch cycles through measurement targets", () => {
  assert.equal(nextTargetId(data, "nixos-unstable"), "nixpkgs-unstable");
  assert.equal(nextTargetId(data, "nixpkgs-unstable"), "nixos-unstable");
  assert.equal(nextTargetId({ targets: {} }, "x"), null);
});

test("flake.lock help uses the nixpkgs repository", () => {
  assert.equal(
    lockCommandFor(data.targets["nixos-unstable"].meta),
    [
      "nix flake lock --override-input nixpkgs \\",
      "  github:NixOS/nixpkgs/<commit hash>",
    ].join("\n"),
  );
});

test("copying falls back to a textarea when the clipboard is unavailable", async () => {
  let copied = "";
  const documentObject = {
    body: {
      append(node) {
        node.select();
        node.remove();
      },
    },
    createElement() {
      return {
        select() {
          copied = this.value;
        },
        remove() {},
        setAttribute() {},
        style: {},
      };
    },
    execCommand() {
      return true;
    },
  };
  assert.equal(await copyRevision("abc", null, documentObject), true);
  assert.equal(copied, "abc");
});
