import { describe, expect, test } from "bun:test";
import {
  barClass,
  barWidth,
  escapeHtml,
  formatDate,
  formatPercent,
  formatUpdated,
  isFinished,
  renderPage,
  renderSite,
  rowProgress,
  subText,
} from "../src/render.ts";
import type { DataFile, EvalRow, TargetData } from "../src/scanner.ts";

const row = (overrides: Partial<EvalRow> = {}): EvalRow => ({
  eval: 1828024,
  rev: "867dcbc30bafe3c862ef88620f2e7a109d7d3be5",
  timestamp: "2026-08-12T06:44:42Z",
  succeeded: 146467,
  failed: 2572,
  queued: 5898,
  delta: null,
  status: "Eval Errors",
  ...overrides,
});

const target = (id: string, rows: EvalRow[] = [row()]): TargetData => ({
  meta: {
    id,
    label: id,
    jobset: id === "nixpkgs-unstable" ? "nixpkgs/unstable" : "nixos/unstable",
    repository: "NixOS/nixpkgs",
    repositoryUrl: "https://github.com/NixOS/nixpkgs",
    branch: id,
  },
  generatedAt: "2026-08-12T12:00:00Z",
  lastAttemptAt: "2026-08-12T12:00:00Z",
  rows,
});

const data: DataFile = {
  schemaVersion: 1,
  generatedAt: "2026-08-12T12:00:00Z",
  targets: {
    "nixos-unstable": target("nixos-unstable"),
    "nixpkgs-unstable": target("nixpkgs-unstable", []),
  },
};

describe("metrics", () => {
  test("formats percentages to one decimal", () => {
    expect(formatPercent(96.234)).toBe("96.2%");
    expect(formatPercent(null)).toBe("unavailable");
  });

  test("row progress counts succeeded over all builds", () => {
    expect(rowProgress(row())).toBeCloseTo(94.532, 2);
    expect(rowProgress({ succeeded: 0, failed: 0, queued: 0 })).toBeNull();
  });

  test("finished rows have zero queued", () => {
    expect(isFinished(row({ queued: 0 }))).toBe(true);
    expect(isFinished(row({ queued: 5 }))).toBe(false);
  });

  test("bar width uses a log scale that spreads out high progress", () => {
    expect(barWidth(100)).toBe(100);
    expect(barWidth(0)).toBe(0);
    expect(barWidth(null)).toBe(0);
    expect(barWidth(99) - barWidth(95)).toBeGreaterThan(barWidth(60) - barWidth(56));
    for (const value of [0, 50, 90, 99, 100]) {
      expect(barWidth(value)).toBeGreaterThanOrEqual(0);
      expect(barWidth(value)).toBeLessThanOrEqual(100);
    }
    expect(barWidth(50)).toBeLessThan(barWidth(90));
  });

  test("bar classes reflect readiness", () => {
    expect(barClass(row({ queued: 0, failed: 0 }))).toBe("ready");
    expect(barClass(row({ queued: 0, failed: 5 }))).toBe("high");
    expect(barClass(row({ succeeded: 75, failed: 10, queued: 15 }))).toBe("medium");
    expect(barClass(row({ succeeded: 10, failed: 10, queued: 80 }))).toBe("low");
  });

  test("sub text distinguishes queued from fully built", () => {
    expect(subText(row({ queued: 5898, failed: 2572 }))).toBe("5,898 queued · 2,572 failed");
    expect(subText(row({ queued: 0, failed: 2572 }))).toBe("fully built · 2,572 failed");
    expect(subText(row({ queued: 0, failed: 0 }))).toBe("fully built");
  });
});

describe("formatting", () => {
  test("dates come from the eval timestamp", () => {
    expect(formatDate("2026-08-11T16:37:53Z")).toBe("2026-08-11");
    expect(formatDate(null)).toBe("");
    expect(formatDate("garbage")).toBe("");
  });

  test("updated timestamps are readable", () => {
    expect(formatUpdated("2026-08-12T12:00:00Z")).toBe("2026-08-12 12:00 UTC");
    expect(formatUpdated(null)).toBe("not yet measured");
  });

  test("html is escaped", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("page rendering", () => {
  test("renders index for the first target and a page per target", () => {
    const pages = renderSite(data);
    expect(pages.map((page) => page.path)).toEqual(["index.html", "nixpkgs-unstable.html"]);
    for (const page of pages) {
      expect(page.html).not.toMatch(/<script/i);
    }
  });

  test("index page contains rows, metrics, links and help", () => {
    const [index] = renderSite(data);
    expect(index.html).toContain("Is nixos-unstable built on Hydra yet?");
    expect(index.html).toContain('href="./nixpkgs-unstable.html"');
    expect(index.html).toContain('aria-current="page"');
    expect(index.html).toContain("94.5%");
    expect(index.html).toContain("5,898 queued · 2,572 failed");
    expect(index.html).toContain("https://github.com/NixOS/nixpkgs/commit/867dcbc30bafe3c862ef88620f2e7a109d7d3be5");
    expect(index.html).toContain("https://hydra.nixos.org/eval/1828024");
    expect(index.html).toContain("867dcbc30bafe3c862ef88620f2e7a109d7d3be5");
    expect(index.html).toContain("Hydra reports: Eval Errors.");
    expect(index.html).toContain("nix flake lock --override-input nixpkgs \\");
    expect(index.html).toContain("Last updated: 2026-08-12 12:00 UTC");
    expect(index.html).not.toContain("<script");
  });

  test("second target page links back to the index", () => {
    const [, nixpkgsPage] = renderSite(data);
    expect(nixpkgsPage.html).toContain("Is nixpkgs-unstable built on Hydra yet?");
    expect(nixpkgsPage.html).toContain('href="./index.html"');
    expect(nixpkgsPage.html).toContain("No measurements yet.");
  });

  test("empty target still renders a valid page", () => {
    const html = renderPage(target("nixos-unstable", []), data.targets);
    expect(html).toContain("No measurements yet.");
    expect(html).not.toContain("<script");
  });

  test("delta and full revision appear in the details", () => {
    const html = renderPage(
      target("nixos-unstable", [row({ delta: "+208", queued: 0 })]),
      data.targets,
    );
    expect(html).toContain("+208");
    expect(html).toContain("fully built");
  });
});
