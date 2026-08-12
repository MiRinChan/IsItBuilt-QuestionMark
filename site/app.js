const state = {
  data: null,
  target: "nixos-unstable",
};

export function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "unavailable";
}

export function rowProgress(row) {
  const total = row.succeeded + row.failed + row.queued;
  return total > 0 ? (row.succeeded / total) * 100 : null;
}

export function isFinished(row) {
  return row.queued === 0;
}

function timestamp(row) {
  return row.timestamp ? Date.parse(row.timestamp) || 0 : 0;
}

export function formatDate(row) {
  const value = timestamp(row);
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function newestFirst(rows) {
  const sorted = [...rows];
  sorted.sort((left, right) =>
    (right.eval - left.eval) || timestamp(right) - timestamp(left)
  );
  return sorted;
}

export function currentRows(data) {
  const target = data?.targets?.[state.target];
  return newestFirst(target?.rows || []);
}

export function nextTargetId(data, current) {
  const targets = Object.keys(data?.targets || {});
  if (!targets.length) return null;
  const index = targets.indexOf(current);
  return targets[(index + 1 + targets.length) % targets.length];
}

export function lockCommandFor(meta) {
  return [
    `nix flake lock --override-input nixpkgs \\`,
    `  github:${meta.repository}/<commit hash>`,
  ].join("\n");
}

function fallbackCopy(value, documentObject = globalThis.document) {
  if (!documentObject?.body || typeof documentObject.execCommand !== "function") return false;
  const field = documentObject.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  documentObject.body.append(field);
  field.select();
  const copied = documentObject.execCommand("copy");
  field.remove();
  return copied;
}

export async function copyRevision(
  revision,
  clipboard = globalThis.navigator?.clipboard,
  documentObject = globalThis.document,
) {
  if (clipboard?.writeText) {
    await clipboard.writeText(revision);
    return true;
  }
  return fallbackCopy(revision, documentObject);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function barWidth(value) {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped >= 100) return 100;
  return 100 * (1 - Math.log10(101 - clamped) / Math.log10(101));
}

function barClass(row) {
  if (isFinished(row) && row.failed === 0) return "ready";
  const value = rowProgress(row);
  if (value >= 90) return "high";
  if (value >= 70) return "medium";
  return "low";
}

function subText(row) {
  const parts = [];
  if (row.queued > 0) {
    parts.push(`${row.queued.toLocaleString()} queued`);
  } else {
    parts.push("fully built");
  }
  if (row.failed > 0) parts.push(`${row.failed.toLocaleString()} failed`);
  return parts.join(" · ");
}

function metricTooltip(row) {
  return [
    `eval ${row.eval}`,
    `${row.succeeded.toLocaleString()} succeeded`,
    `${row.failed.toLocaleString()} failed`,
    `${row.queued.toLocaleString()} queued`,
    row.delta ? `${row.delta} new vs previous` : null,
    row.status || null,
  ].filter(Boolean).join("\n");
}

function makeDetails(row, target) {
  const details = element("div", "details");
  for (const [label, value] of [
    ["succeeded", row.succeeded],
    ["failed", row.failed],
    ["queued", row.queued],
    ["new vs previous", row.delta ?? "—"],
    ["evaluation", row.eval],
  ]) {
    const item = element("section", "count-detail");
    item.append(
      element("p", "count-name", label),
      element(
        "p",
        "count-value",
        typeof value === "number" ? value.toLocaleString() : value,
      ),
    );
    details.append(item);
  }
  if (row.status) {
    details.append(element("p", "quality-note", `Hydra reports: ${row.status}.`));
  }
  const hydra = element("a", "hydra-link", `Open Hydra evaluation ${row.eval} ↗`);
  hydra.href = `https://hydra.nixos.org/eval/${row.eval}`;
  hydra.target = "_blank";
  hydra.rel = "noreferrer";
  details.append(hydra);
  return details;
}

function makeRow(row, target) {
  const wrapper = element("details", "result");
  const summary = element("summary", "result-summary");
  const progress = rowProgress(row);
  const width = isFinished(row) ? 100 : barWidth(progress);
  const rowBar = element("span", `row-bar ${barClass(row)}`);
  rowBar.style.width = `${width}%`;

  const commitCell = element("span", "cell commit-cell");
  const copyButton = element("button", "copy-commit", row.rev.slice(0, 12));
  copyButton.type = "button";
  copyButton.title = `Copy ${row.rev}`;
  copyButton.setAttribute("aria-label", `Copy full commit ${row.rev}`);
  copyButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const feedback = document.querySelector("#feedback");
    try {
      const copied = await copyRevision(row.rev);
      feedback.textContent = copied ? `Copied ${row.rev}` : "Clipboard access is unavailable.";
    } catch {
      feedback.textContent = "Could not copy the commit SHA.";
    }
  });
  const evalLink = element("a", "commit-link", "⚙");
  evalLink.href = `https://hydra.nixos.org/eval/${row.eval}`;
  evalLink.target = "_blank";
  evalLink.rel = "noreferrer";
  evalLink.title = `Open Hydra evaluation ${row.eval}`;
  evalLink.setAttribute("aria-label", `Open Hydra evaluation ${row.eval}`);
  evalLink.addEventListener("click", (event) => event.stopPropagation());
  const commitLink = element("a", "commit-link", "↗");
  commitLink.href = `${target.meta.repositoryUrl}/commit/${encodeURIComponent(row.rev)}`;
  commitLink.target = "_blank";
  commitLink.rel = "noreferrer";
  commitLink.title = `Open ${target.meta.repository} commit`;
  commitLink.setAttribute("aria-label", `Open commit ${row.rev} on GitHub`);
  commitLink.addEventListener("click", (event) => event.stopPropagation());
  commitCell.append(copyButton, element("span", "commit-date", formatDate(row)), commitLink, evalLink);

  const progressCell = element("span", "cell rate-cell");
  progressCell.title = metricTooltip(row);
  const metricSpan = element(
    "span",
    "metric-text",
    progress === null ? "no builds" : formatPercent(progress),
  );
  progressCell.append(metricSpan, element("span", "metric-sub", subText(row)));

  summary.append(rowBar, commitCell, progressCell);
  wrapper.append(summary, makeDetails(row, target));
  return wrapper;
}

function renderRows(target) {
  const container = document.querySelector("#rows");
  const rows = currentRows(state.data);
  container.replaceChildren();
  if (!rows.length) {
    container.append(
      element(
        "p",
        "empty",
        "No measurements yet. The scheduled scanner will populate this page.",
      )
    );
    return;
  }
  for (const row of rows) {
    container.append(makeRow(row, target));
  }
}

function formatUpdated(value) {
  if (!value) return "not yet measured";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderTarget() {
  const targets = state.data?.targets || {};
  if (!targets[state.target]) state.target = Object.keys(targets)[0];
  const target = targets[state.target];
  if (!target) {
    document.querySelector("#updated").textContent = "Last updated: not yet measured";
    document.querySelector("#rows").replaceChildren(
      element("p", "empty", "No measurement targets are available yet."),
    );
    return;
  }

  const next = targets[nextTargetId(state.data, state.target)];
  document.querySelector("#target-label").textContent = target.meta.label;
  document.querySelector("#target-switch").title = `Switch to ${next?.meta?.label || target.meta.label}`;
  document.querySelector("#updated").textContent = `Last updated: ${formatUpdated(target.generatedAt)}`;
  document.querySelector("#help-target").textContent = target.meta.label;
  document.querySelector("#lock-command").textContent = lockCommandFor(target.meta);
  document.querySelector("#jobset-link").href = `https://hydra.nixos.org/jobset/${target.meta.jobset}`;
  document.title = `Is ${target.meta.label} built on Hydra yet?`;
  document.querySelector("#feedback").textContent = "";
  renderRows(target);
}

function installHelp() {
  const dialog = document.querySelector("#help-dialog");
  document.querySelector("#help-open").addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });
}

function installTargetSwitch() {
  document.querySelector("#target-switch").addEventListener("click", () => {
    if (!state.data) return;
    state.target = nextTargetId(state.data, state.target);
    renderTarget();
  });
}

async function start() {
  installHelp();
  installTargetSwitch();
  try {
    const response = await fetch("./data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    renderTarget();
  } catch (error) {
    document.querySelector("#updated").textContent = "Last updated: unavailable";
    document.querySelector("#rows").replaceChildren(
      element("p", "empty", `Could not load data.json: ${error.message}`),
    );
  }
}

if (typeof document !== "undefined") {
  start();
}
