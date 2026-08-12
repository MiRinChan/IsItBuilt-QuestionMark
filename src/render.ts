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

  const statusNote = row.status
    ? `<p class="quality-note">Hydra reports: ${escapeHtml(row.status)}.</p>`
    : "";

  return `<details class="result">
  <summary class="result-summary">
    <span class="row-bar ${barClass(row)}" style="width: ${width}%"></span>
    <span class="cell commit-cell">
      <code class="commit-hash">${escapeHtml(row.rev.slice(0, 12))}</code>
      <span class="commit-date">${escapeHtml(formatDate(row.timestamp))}</span>
      <a class="commit-link" href="${commitUrl}" title="Open commit on GitHub" target="_blank" rel="noreferrer">↗</a>
      <a class="commit-link" href="${evalUrl}" title="Open Hydra evaluation ${row.eval}" target="_blank" rel="noreferrer">⚙</a>
    </span>
    <span class="cell rate-cell">
      <span class="metric-text">${escapeHtml(percent)}</span>
      <span class="metric-sub">${escapeHtml(subText(row))}</span>
    </span>
  </summary>
  <div class="details">
    ${counts}
    <section class="count-detail"><p class="count-name">revision</p><p class="count-value"><code>${escapeHtml(row.rev)}</code></p></section>
    ${statusNote}
    <a class="hydra-link" href="${evalUrl}" target="_blank" rel="noreferrer">Open Hydra evaluation ${row.eval} ↗</a>
  </div>
</details>`;
}

function renderNav(targets: Record<string, TargetData>, currentId: string): string {
  const indexId = Object.keys(targets)[0];
  const entries = Object.values(targets).map((target) => {
    const id = target.meta.id;
    const href = id === indexId ? "./index.html" : `./${id}.html`;
    const selected = id === currentId ? " class=\"selected\" aria-current=\"page\"" : "";
    return `<a href="${href}"${selected}>${escapeHtml(target.meta.label)}</a>`;
  });
  return `<nav class="targets" aria-label="Channel">${entries.join("")}</nav>`;
}

function renderRows(target: TargetData): string {
  if (!target.rows.length) {
    return `<p class="empty">No measurements yet. The scheduled scanner will populate this page.</p>`;
  }
  return target.rows.map((row) => renderRow(row, target)).join("");
}

function renderHelp(target: TargetData): string {
  const lockCommand = [
    "nix flake lock --override-input nixpkgs \\",
    `  github:${target.meta.repository}/<commit hash>`,
  ].join("\n");
  return `<section class="help" id="help" aria-labelledby="help-title">
  <h2 id="help-title">How to read this page</h2>
  <p>
    Each row is one <code>${escapeHtml(target.meta.label)}</code> channel commit and the Hydra
    evaluation that builds it. The bar shows how much of the channel's package set
    Hydra has compiled:
  </p>
  <pre><code>succeeded / (succeeded + failed + queued)</code></pre>
  <p>
    When <strong>queued</strong> is zero, everything has been built and upgrading to that
    commit downloads binaries from <code>cache.nixos.org</code> — nothing is compiled
    locally. While <strong>queued</strong> is non-zero, upgrading would make your machine
    compile the packages Hydra has not finished yet.
  </p>
  <p>Pin a fully built commit in <code>flake.lock</code> before upgrading:</p>
  <pre><code>${escapeHtml(lockCommand)}</code></pre>
  <p>
    Inspect any evaluation directly at <code>hydra.nixos.org/eval/&lt;id&gt;</code>, or check
    the live jobset on
    <a href="https://hydra.nixos.org/jobset/${encodeURIComponent(target.meta.jobset)}" target="_blank" rel="noreferrer">Hydra</a>.
  </p>
</section>`;
}

export function renderPage(
  target: TargetData,
  targets: Record<string, TargetData>,
): string {
  const label = escapeHtml(target.meta.label);
  const description = `How far has the current ${label} commit been built on Hydra?`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(description)}" />
    <title>Is ${label} built on Hydra yet?</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main>
      <header class="hero">
        <h1>Is<br /><code>${label}</code><br />built on Hydra yet?</h1>
      </header>
      ${renderNav(targets, target.meta.id)}
      <p class="updated">Last updated: ${escapeHtml(formatUpdated(target.generatedAt))}</p>
      <section class="results" aria-labelledby="results-title">
        <h2 id="results-title" class="visually-hidden">Hydra build progress by channel commit</h2>
        <div class="table-head" aria-hidden="true">
          <span>commit</span>
          <span>build progress</span>
        </div>
        <div class="rows">
          ${renderRows(target)}
        </div>
      </section>
      ${renderHelp(target)}
    </main>
  </body>
</html>
`;
}

export function renderSite(data: DataFile): RenderedPage[] {
  const ids = Object.keys(data.targets);
  if (!ids.length) throw new Error("no targets to render");
  const pages: RenderedPage[] = [];
  for (const id of ids) {
    const target = data.targets[id];
    const path = id === ids[0] ? "index.html" : `${id}.html`;
    pages.push({ path, html: renderPage(target, data.targets) });
  }
  return pages;
}
