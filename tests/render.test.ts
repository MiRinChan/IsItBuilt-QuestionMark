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
  test("renders a single page containing every target", () => {
    const pages = renderSite(data);
    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe("index.html");
    expect(pages[0].html).not.toMatch(/<script/i);
  });

  test("title is a checkbox toggle between the two targets", () => {
    const html = renderPage(data);
    expect(html).toContain('id="target-toggle" class="target-toggle"');
    expect(html).toContain('label for="target-toggle" class="target-switch"');
    expect(html).toContain('<code class="t-label t-0">nixos-unstable</code>');
    expect(html).toContain('<code class="t-label t-1">nixpkgs-unstable</code>');
    expect(html).toContain(".target-toggle:not(:checked) ~ main #pane-0 { display: block; }");
    expect(html).toContain(".target-toggle:checked ~ main #pane-1 { display: block; }");
    expect(html).toContain(".target-toggle:checked ~ main .t-0 { display: none; }");
    expect(html).toContain(".target-toggle:not(:checked) ~ main .t-1 { display: none; }");
  });

  test("each target renders a pane and there is no separate nav", () => {
    const html = renderPage(data);
    expect(html).toContain('id="pane-0" class="target-pane"');
    expect(html).toContain('id="pane-1" class="target-pane"');
    expect(html).not.toContain("<nav");
  });

  test("all targets' rows and metrics are present", () => {
    const html = renderPage(data);
    expect(html).toContain("94.5%");
    expect(html).toContain("5,898 queued · 2,572 failed");
    expect(html).toContain("https://github.com/NixOS/nixpkgs/commit/867dcbc30bafe3c862ef88620f2e7a109d7d3be5");
    expect(html).toContain("https://hydra.nixos.org/eval/1828024");
    expect(html).toContain("867dcbc30bafe3c862ef88620f2e7a109d7d3be5");
    expect(html).toContain("Last updated: 2026-08-12 12:00 UTC");
    expect(html).toContain("No measurements yet.");
  });

  test("help is a pure-CSS dialog controlled by a checkbox", () => {
    const html = renderPage(data);
    expect(html).toContain('id="help-toggle"');
    expect(html).toContain("<dialog class=\"help-dialog\"");
    expect(html).toContain("nix flake lock --override-input nixpkgs \\");
    expect(html).toContain("JavaScript-Free");
    expect(html).toContain("label for=\"help-toggle\" class=\"help-backdrop\"");
    expect(html).toContain("label for=\"help-toggle\" class=\"help-open\"");
    expect(html).not.toContain("<script");
  });

  test("delta and full revision appear in the details", () => {
    const single: DataFile = {
      ...data,
      targets: { "nixos-unstable": target("nixos-unstable", [row({ delta: "+208", queued: 0 })]) },
    };
    const html = renderPage(single);
    expect(html).toContain("+208");
    expect(html).toContain("fully built");
  });

  test("empty data is rejected", () => {
    expect(() => renderSite({ ...data, targets: {} })).toThrow("no targets");
  });
});
