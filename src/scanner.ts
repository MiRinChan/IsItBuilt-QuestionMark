#!/usr/bin/env bun
/** Query Hydra for the build progress of nixos-unstable / nixpkgs-unstable commits. */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { renderSite } from "./render.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_VERSION = 1;
const USER_AGENT =
  "isitbuilt-scanner/1.0 (+https://github.com/MiRinChan/IsItBuilt-QuestionMark)";

const FULL_REV_RE = /copyToClipboard\('([0-9a-f]{40})'/;
const SHORT_REV_RE = /<tt>([0-9a-f]+)<\/tt>/;
const DATETIME_RE = /<time[^>]*datetime="([^"]+)"/;
const EVAL_ID_RE = /\/eval\/(\d+)/;
const BADGE_SUCCESS_RE = /badge-success">(\d+)/g;
const BADGE_DANGER_RE = /badge-danger">(\d+)/g;
const BADGE_SECONDARY_RE = /badge-secondary">(\d+)/g;
const BADGE_WARNING_RE = /badge-warning">([^<]+)</g;
const DELTA_RE = /<strong>([+-]\d+)<\/strong>/g;
const ROW_RE = /<tr[^>]*>(.*?)<\/tr>/gs;

export interface EvalRow {
  eval: number;
  rev: string;
  timestamp: string | null;
  succeeded: number;
  failed: number;
  queued: number;
  delta: string | null;
  status: string | null;
}

export interface TargetMeta {
  id: string;
  label: string;
  jobset: string;
  repository: string;
  repositoryUrl: string;
  branch: string;
}

export interface TargetData {
  meta: TargetMeta;
  generatedAt: string;
  lastAttemptAt: string;
  rows: EvalRow[];
}

export interface DataFile {
  schemaVersion: number;
  generatedAt: string | null;
  targets: Record<string, TargetData>;
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function eprint(message: string): void {
  console.error(message);
}

function firstMatch(re: RegExp, text: string): string | null {
  const match = re.exec(text);
  return match ? match[1] : null;
}

function allMatches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) matches.push(match[1]);
  re.lastIndex = 0;
  return matches;
}

async function httpGet(
  url: string,
  timeoutMs: number,
  retries: number,
  backoffSeconds: number,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, backoffSeconds * 2 ** (attempt - 1) * 1000),
      );
    }
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`GET ${url} failed after ${retries + 1} attempts: ${lastError}`);
}

export function parseEvalRow(block: string): EvalRow | null {
  const evalMatch = EVAL_ID_RE.exec(block);
  if (!evalMatch) return null;
  const fullRev = FULL_REV_RE.exec(block);
  const shortRev = SHORT_REV_RE.exec(block);
  const rev = fullRev?.[1] ?? shortRev?.[1];
  if (!rev) return null;
  const succeeded = allMatches(BADGE_SUCCESS_RE, block);
  const failed = allMatches(BADGE_DANGER_RE, block);
  const queued = allMatches(BADGE_SECONDARY_RE, block);
  const delta = allMatches(DELTA_RE, block);
  const status = allMatches(BADGE_WARNING_RE, block);
  return {
    eval: Number(evalMatch[1]),
    rev,
    timestamp: firstMatch(DATETIME_RE, block),
    succeeded: succeeded.length ? Number(succeeded[0]) : 0,
    failed: failed.length ? Number(failed[0]) : 0,
    queued: queued.length ? Number(queued[0]) : 0,
    delta: delta.length ? delta[0] : null,
    status: status.length ? status[0] : null,
  };
}

export function parseEvalsPage(markup: string): EvalRow[] {
  const body = /<tbody>(.*?)<\/tbody>/s.exec(markup);
  if (!body) {
    throw new Error("could not find a <tbody> with evaluation rows in the evals page");
  }
  const rows: EvalRow[] = [];
  for (const match of body[1].matchAll(ROW_RE)) {
    const row = parseEvalRow(match[1]);
    if (row) rows.push(row);
  }
  if (!rows.length) {
    throw new Error("the evals page contained no parseable evaluation rows");
  }
  rows.sort((left, right) => right.eval - left.eval);
  return rows;
}

export function validateRows(rows: EvalRow[]): void {
  const seen = new Set<number>();
  let previous = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!Number.isInteger(row.eval) || row.eval <= 0) {
      throw new Error(`invalid eval id ${row.eval}`);
    }
    if (!/^[0-9a-f]{7,40}$/.test(row.rev)) {
      throw new Error(`invalid revision ${row.rev}`);
    }
    for (const key of ["succeeded", "failed", "queued"] as const) {
      if (!Number.isInteger(row[key]) || row[key] < 0) {
        throw new Error(`invalid ${key} ${row[key]}`);
      }
    }
    if (seen.has(row.eval)) throw new Error(`duplicate eval ${row.eval} in rows`);
    seen.add(row.eval);
    if (row.eval > previous) {
      throw new Error("rows must be sorted newest first");
    }
    previous = row.eval;
  }
}

export function mergeRows(previous: EvalRow[], fresh: EvalRow[], limit: number): EvalRow[] {
  const byEval = new Map<number, EvalRow>();
  for (const row of [...previous, ...fresh]) byEval.set(row.eval, row);
  return [...byEval.values()]
    .sort((left, right) => right.eval - left.eval)
    .slice(0, limit);
}

export async function loadExisting(path: string): Promise<DataFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: null, targets: {} };
  }
  const data = await file.json();
  if (!data || typeof data !== "object" || !data.targets || typeof data.targets !== "object") {
    throw new Error(`${path} is not a valid data file`);
  }
  return data as DataFile;
}

export function atomicWrite(path: string, data: DataFile): void {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true });
  const tempPath = `${directory}/.state.${crypto.randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tempPath, path);
}

export function loadConfig(path: string): any {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config || typeof config !== "object" || !Array.isArray(config.targets)) {
    throw new Error(`${path} is not a valid config: expected 'targets' list`);
  }
  return config;
}

export async function scanTarget(
  target: any,
  config: any,
): Promise<Omit<TargetData, "rows"> & { rows: EvalRow[] }> {
  const url = `${String(config.hydraUrl).replace(/\/$/, "")}/jobset/${target.jobset}/evals`;
  eprint(`scanning ${target.id} (${target.jobset}): ${url}`);
  const markup = await httpGet(
    url,
    config.http.requestTimeoutSeconds * 1000,
    config.http.retries,
    config.http.retryBackoffSeconds,
  );
  const rows = parseEvalsPage(markup);
  validateRows(rows);
  return {
    meta: {
      id: target.id,
      label: target.label ?? target.id,
      jobset: target.jobset,
      repository: target.repository,
      repositoryUrl: target.repositoryUrl,
      branch: target.branch,
    },
    generatedAt: utcNow(),
    lastAttemptAt: utcNow(),
    rows,
  };
}

export async function run(configPath: string, dataPath: string): Promise<number> {
  const config = loadConfig(configPath);
  const existing = await loadExisting(dataPath);
  const previous = existing.targets;
  const limit = Number(config.historyLimit ?? 30);

  const targets: Record<string, TargetData> = {};
  let succeeded = 0;
  for (const target of config.targets) {
    const targetId = target.id;
    const prior = previous[targetId];
    const priorRows = prior?.rows ?? [];
    let fresh: Awaited<ReturnType<typeof scanTarget>>;
    try {
      fresh = await scanTarget(target, config);
    } catch (error) {
      eprint(`error scanning ${targetId}: ${error}`);
      if (prior) {
        targets[targetId] = { ...prior, lastAttemptAt: utcNow() };
      }
      continue;
    }
    const rows = mergeRows(priorRows, fresh.rows, limit);
    validateRows(rows);
    targets[targetId] = {
      meta: fresh.meta,
      generatedAt: fresh.generatedAt,
      lastAttemptAt: fresh.lastAttemptAt,
      rows,
    };
    succeeded++;
  }

  if (!succeeded) {
    if (Object.keys(targets).length) {
      eprint("every target failed to refresh; keeping previous data");
      return 0;
    }
    throw new Error("no target could be scanned and no previous data exists");
  }

  const data: DataFile = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: utcNow(),
    targets,
  };
  atomicWrite(dataPath, data);
  eprint(
    `wrote ${dataPath} (${succeeded} target(s) refreshed, ${Object.keys(targets).length} target(s) total)`,
  );
  for (const page of renderSite(data)) {
    writeFileSync(`${ROOT}site/${page.path}`, page.html, "utf8");
    eprint(`wrote site/${page.path}`);
  }
  return 0;
}

if (import.meta.main) {
  let configPath = `${ROOT}config.json`;
  let dataPath = `${ROOT}site/state.json`;
  const argv = Bun.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--config") configPath = argv[++index];
    else if (argv[index] === "--data") dataPath = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  try {
    process.exitCode = await run(configPath, dataPath);
  } catch (error) {
    eprint(`${error}`);
    process.exitCode = 1;
  }
}
