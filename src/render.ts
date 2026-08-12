/** Server-side rendering of the no-JS static pages. */

import type { DataFile, EvalRow, TargetData } from "./scanner.ts";

export interface RenderedPage {
  path: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatPercent(value: number | null): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "unavailable";
}

export function rowProgress(row: EvalRow): number | null {
  const total = row.succeeded + row.failed + row.queued;
  return total > 0 ? (row.succeeded / total) * 100 : null;
}

export function isFinished(row: EvalRow): boolean {
  return row.queued === 0;
}

export function barWidth(value: number | null): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped >= 100) return 100;
  return 100 * (1 - Math.log10(101 - clamped) / Math.log10(101));
}

export function barClass(row: EvalRow): string {
  if (isFinished(row) && row.failed === 0) return "ready";
  const value = rowProgress(row);
  if (value >= 90) return "high";
  if (value >= 70) return "medium";
  return "low";
}

export function subText(row: EvalRow): string {
  const parts = [];
  if (row.queued > 0) {
    parts.push(`${row.queued.toLocaleString("en-US")} queued`);
  } else {
    parts.push("fully built");
  }
  if (row.failed > 0) parts.push(`${row.failed.toLocaleString("en-US")} failed`);
  return parts.join(" · ");
}

export function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toISOString().slice(0, 10);
}

export function formatUpdated(value: string | null): string {
  if (!value) return "not yet measured";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function renderRow(row: EvalRow, target: TargetData): string {
  const progress = rowProgress(row);
  const width = isFinished(row) ? 100 : barWidth(progress);
  const percent = progress === null ? "no builds" : formatPercent(progress);
  const commitUrl = `${target.meta.repositoryUrl}/commit/${encodeURIComponent(row.rev)}`;
  const evalUrl = `https://hydra.nixos.org/eval/${row.eval}`;

  const counts = [
    ["succeeded", formatCount(row.succeeded)],
    ["failed", formatCount(row.failed)],
    ["queued", formatCount(row.queued)],
    ["new vs previous", row.delta ?? "—"],
    ["evaluation", String(row.eval)],
  ]
    .map(
      ([label, value]) =>
        `<section class="count-detail"><p class="count-name">${escapeHtml(label)}</p>` +
        `<p class="count-value">${escapeHtml(value)}</p></section>`,
    )
    .join("");

  return `<details class="result">
  <summary class="result-summary">
    <span class="row-bar ${barClass(row)}" style="width: ${width}%"></span>
    <span class="cell commit-cell">
      <code class="commit-hash">${escapeHtml(row.rev.slice(0, 12))}</code>
      <span class="commit-date">${escapeHtml(formatDate(row.timestamp))}</span>
    </span>
    <span class="cell rate-cell">
      <span class="metric-text">${escapeHtml(percent)}</span>
      <span class="metric-sub">${escapeHtml(subText(row))}</span>
    </span>
  </summary>
  <div class="details">
    ${counts}
    <p class="revision-line"><span class="revision-label">revision:</span> <code>${escapeHtml(row.rev)}</code></p>
    <div class="row-links">
      <a class="hydra-link" href="${evalUrl}" target="_blank" rel="noreferrer">Open Hydra evaluation ${row.eval} ↗</a>
      <a class="hydra-link" href="${commitUrl}" target="_blank" rel="noreferrer">GitHub commit ↗</a>
    </div>
  </div>
</details>`;
}

function renderRows(target: TargetData): string {
  if (!target.rows.length) {
    return `<p class="empty">No measurements yet. The scheduled scanner will populate this page.</p>`;
  }
  return target.rows.map((row) => renderRow(row, target)).join("");
}

function renderHero(targets: Record<string, TargetData>): string {
  const ids = Object.keys(targets);
  const labels = ids
    .map((id, index) => `<code class="t-label t-${index}">${escapeHtml(targets[id].meta.label)}</code>`)
    .join("");
  return `<header class="hero">
    <h1>Is<br /><label for="target-toggle" class="target-switch">${labels}</label><br />built on Hydra yet?</h1>
  </header>`;
}

function renderPanes(targets: Record<string, TargetData>): string {
  return Object.keys(targets)
    .map((id, index) => {
      const target = targets[id];
      return `<section id="pane-${index}" class="target-pane">
  <section class="results" aria-labelledby="results-title-${escapeHtml(target.meta.id)}">
    <h2 id="results-title-${escapeHtml(target.meta.id)}" class="visually-hidden">Hydra build progress for ${escapeHtml(target.meta.label)}</h2>
    <div class="table-head" aria-hidden="true">
      <span>commit</span>
      <span>build progress</span>
    </div>
    <div class="rows">
      ${renderRows(target)}
    </div>
  </section>
<p class="updated">Last updated: ${escapeHtml(formatUpdated(target.generatedAt))}</p>
</section>`;
    })
    .join("");
}

function renderSwitchCss(targets: Record<string, TargetData>): string {
  const ids = Object.keys(targets);
  const rules: string[] = [
    ".target-toggle:focus-visible ~ main .target-switch { outline: 0.04em solid var(--ink); outline-offset: 0.1em; }",
  ];
  for (let i = 0; i < ids.length; i++) {
    if (i === 0) {
      rules.push(`.target-toggle:not(:checked) ~ main #pane-0 { display: block; }`);
      rules.push(`.target-toggle:not(:checked) ~ main .t-${ids.length - 1} { display: none; }`);
    } else {
      rules.push(`.target-toggle:checked ~ main #pane-${i} { display: block; }`);
      rules.push(`.target-toggle:checked ~ main .t-0 { display: none; }`);
    }
  }
  return `<style>\n${rules.join("\n")}\n</style>`;
}

function renderHelpToggle(): string {
  return `<input type="checkbox" id="help-toggle" class="help-toggle" />` +
    `<label for="help-toggle" class="help-open" aria-label="Help">?</label>`;
}

function renderHelpDialog(): string {
  const lockCommand = [
    "nix flake lock --override-input nixpkgs \\",
    "  github:NixOS/nixpkgs/<commit hash>",
  ].join("\n");
  return `<label for="help-toggle" class="help-backdrop" aria-hidden="true"></label>
<dialog class="help-dialog" aria-labelledby="help-title">
  <label for="help-toggle" class="help-close" aria-label="Close help">×</label>
  <h2 id="help-title">Tips</h2>
  <p>Pin commit by:</p>
  <pre><code style="user-select: all;" >${escapeHtml(lockCommand)}</code></pre>
  <p>
    By the way, this page is JavaScript-Free. If you are a libre software dissidents, you can feel free to browse it.
  </p>
</dialog>`;
}

export function renderPage(data: DataFile): string {
  const targets = data.targets;
  const ids = Object.keys(targets);
  if (!ids.length) throw new Error("no targets to render");
  const defaultLabel = escapeHtml(targets[ids[0]].meta.label);
  const description = `How far has the current ${defaultLabel} commit been built on Hydra?`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(description)}" />
    <title>Is it built on Hydra yet?</title>
    <link rel="stylesheet" href="./style.css" />
    ${renderSwitchCss(targets)}
  </head>
  <body>
    <input type="checkbox" id="target-toggle" class="target-toggle" />
    ${renderHelpToggle()}
    <main>
      ${renderHero(targets)}
      ${renderPanes(targets)}
    </main>
    ${renderHelpDialog()}
  </body>
</html>
`;
}

export function renderSite(data: DataFile): RenderedPage[] {
  if (!Object.keys(data.targets).length) throw new Error("no targets to render");
  return [{ path: "index.html", html: renderPage(data) }];
}
