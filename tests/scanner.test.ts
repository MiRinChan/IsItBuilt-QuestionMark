import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  atomicWrite,
  loadExisting,
  mergeRows,
  parseEvalsPage,
  validateRows,
} from "../src/scanner.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function fixture(name: string): Promise<string> {
  return Bun.file(path.join(FIXTURES, name)).text();
}

describe("evals page parsing", () => {
  test("nixos-unstable fixture", async () => {
    const rows = parseEvalsPage(await fixture("evals-nixos-unstable.html"));
    expect(rows).toHaveLength(8);
    const latest = rows[0];
    expect(latest.eval).toBe(1828024);
    expect(latest.rev).toBe("867dcbc30bafe3c862ef88620f2e7a109d7d3be5");
    expect(latest.timestamp).toBe("2026-08-12T06:44:42Z");
    expect(latest.succeeded).toBe(146467);
    expect(latest.failed).toBe(2572);
    expect(latest.queued).toBe(5898);
    expect(latest.delta).toBeNull();
    expect(latest.status).toBe("Eval Errors");
  });

  test("nixpkgs-unstable fixture", async () => {
    const rows = parseEvalsPage(await fixture("evals-nixpkgs-unstable.html"));
    expect(rows).toHaveLength(8);
    expect(rows[0].eval).toBe(1828030);
    expect(rows[0].rev).toBe("044bfe75bfe4c7bbe043dc17b5e42ea823b84a09");
  });

  test("unstable-small fixture missing cells default to zero", async () => {
    const rows = parseEvalsPage(await fixture("evals-nixos-unstable-small.html"));
    expect(rows).toHaveLength(8);
    expect(rows[0].eval).toBe(1828023);
    expect(rows[0].succeeded).toBe(120);
    expect(rows[0].failed).toBe(0);
    expect(rows[0].queued).toBe(0);
    expect(rows[0].delta).toBeNull();
  });

  test("finished eval has zero queued and delta", async () => {
    const rows = parseEvalsPage(await fixture("evals-nixos-unstable.html"));
    const finished = rows.find((row) => row.eval === 1827979);
    expect(finished?.queued).toBe(0);
    expect(finished?.delta).toBe("+208");
  });

  test("rows are sorted newest first", async () => {
    const rows = parseEvalsPage(await fixture("evals-nixos-unstable.html"));
    const ids = rows.map((row) => row.eval);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  test("garbage markup is rejected", async () => {
    expect(() => parseEvalsPage("<html><body>no table here</body></html>")).toThrow();
    expect(() =>
      parseEvalsPage("<table><tbody><tr><td>x</td></tr></tbody></table>"),
    ).toThrow();
  });

  test("revision is always full length", async () => {
    for (const name of [
      "evals-nixos-unstable.html",
      "evals-nixpkgs-unstable.html",
      "evals-nixos-unstable-small.html",
    ]) {
      for (const row of parseEvalsPage(await fixture(name))) {
        expect(row.rev).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });
});

describe("row validation", () => {
  const valid = [
    { eval: 2, rev: "a".repeat(40), timestamp: "2026-08-12T00:00:00Z", succeeded: 10, failed: 0, queued: 0, delta: null, status: null },
    { eval: 1, rev: "b".repeat(40), timestamp: null, succeeded: 0, failed: 0, queued: 0, delta: "-5", status: "Eval Errors" },
  ];
  test("accepts valid rows", () => validateRows(valid));

  test("rejects bad rows", () => {
    expect(() =>
      validateRows([{ eval: 1, rev: "z", succeeded: -1, failed: 0, queued: 0 }]),
    ).toThrow();
    expect(() =>
      validateRows([{ eval: 1.5, rev: "a".repeat(40), succeeded: 1, failed: 0, queued: 0 }]),
    ).toThrow();
    expect(() =>
      validateRows([
        { eval: 2, rev: "a".repeat(40), succeeded: 1, failed: 0, queued: 0 },
        { eval: 2, rev: "b".repeat(40), succeeded: 1, failed: 0, queued: 0 },
      ]),
    ).toThrow("duplicate eval");
  });

  test("rejects unsorted rows", () => {
    expect(() =>
      validateRows([
        { eval: 1, rev: "a".repeat(40), succeeded: 1, failed: 0, queued: 0 },
        { eval: 2, rev: "b".repeat(40), succeeded: 1, failed: 0, queued: 0 },
      ]),
    ).toThrow("newest first");
  });
});

describe("merge", () => {
  const row = (evalId: number, queued = 0) => ({
    eval: evalId,
    rev: String(evalId).padStart(40, "0"),
    timestamp: null,
    succeeded: 10,
    failed: 0,
    queued,
    delta: null,
    status: null,
  });

  test("fresh rows replace previous and new ones are added", () => {
    const merged = mergeRows([row(2), row(1)], [row(2, 5), row(3)], 10);
    expect(merged.map((r) => r.eval)).toEqual([3, 2, 1]);
    expect(merged[1].queued).toBe(5);
  });

  test("history is pruned newest first", () => {
    const merged = mergeRows([row(1), row(2), row(3), row(4), row(5)], [row(6)], 3);
    expect(merged.map((r) => r.eval)).toEqual([6, 5, 4]);
  });
});

describe("storage", () => {
  test("atomic write and load existing", async () => {
    const path = `${FIXTURES}/.tmp-data.json`;
    atomicWrite(path, { schemaVersion: 1, generatedAt: null, targets: { t: { rows: [] } } });
    const data = await loadExisting(path);
    expect(data.targets.t.rows).toEqual([]);
    Bun.spawnSync(["rm", "-f", path]);
  });

  test("load existing missing file returns empty", async () => {
    const data = await loadExisting(`${FIXTURES}/missing.json`);
    expect(data).toEqual({ schemaVersion: 1, generatedAt: null, targets: {} });
  });

  test("load existing rejects malformed file", async () => {
    const path = `${FIXTURES}/.tmp-malformed.json`;
    await Bun.write(path, "[1, 2, 3]");
    expect(loadExisting(path)).rejects.toThrow();
    Bun.spawnSync(["rm", "-f", path]);
  });
});
