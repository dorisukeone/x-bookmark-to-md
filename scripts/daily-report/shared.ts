import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const DATA_DIR = resolve(ROOT, "reports/data");
export const DAILY_LABEL = "daily-report";
export const SECURITY_LABEL = "dependency-security";
export const MANUAL_LABEL = "manual-review";
export const IMPROVEMENT_MARKER = "<!-- daily-report:improvement -->";
export const BACKLOG_MARKER = "<!-- daily-report:priority-backlog -->";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: Array<{ name: string }>;
}

export function run(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): string {
  try {
    return execFileSync(file, [...args], {
      cwd: options.cwd ?? ROOT,
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
      timeout: options.timeoutMs,
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : String(error);
    throw new Error(`${file} ${args.join(" ")} failed: ${stderr}`);
  }
}

export function runInherited(file: string, args: readonly string[], cwd = ROOT): void {
  const result = spawnSync(file, [...args], { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${file} exited with status ${String(result.status)}`);
  }
}

export function ghJson<T>(endpoint: string, fields: readonly string[] = []): T {
  const args = ["api", endpoint];
  for (const field of fields) args.push("-f", field);
  return JSON.parse(run("gh", args)) as T;
}

export function ghGraphql<T>(query: string, variables: Record<string, string>): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
  return JSON.parse(run("gh", args)) as T;
}

export function repository(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const remote = run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match?.[1]) throw new Error(`GitHub repository could not be derived from ${remote}`);
  return match[1];
}

export function ensureLabel(name: string, color: string, description: string): void {
  run(
    "gh",
    [
      "label",
      "create",
      name,
      "--repo",
      repository(),
      "--color",
      color,
      "--description",
      description,
      "--force",
    ],
  );
}

export function listDailyIssues(state: "open" | "closed" | "all" = "all"): Issue[] {
  const output = run("gh", [
    "issue",
    "list",
    "--repo",
    repository(),
    "--state",
    state,
    "--label",
    DAILY_LABEL,
    "--limit",
    "500",
    "--json",
    "number,title,body,state,labels",
  ]);
  return JSON.parse(output) as Issue[];
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*\[[^\u005d]+\u005d\s*/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();
}

export function priorityFromBody(body: string): number {
  const value = body.match(/<!--\s*priority-score:(\d+)\s*-->/)?.[1];
  return value ? Math.max(0, Math.min(100, Number(value))) : 0;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function daysAgo(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00+09:00`);
  value.setUTCDate(value.getUTCDate() - days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function markerValue(body: string, name: string): string | undefined {
  return body.match(new RegExp(`<!--\\s*${name}:([^>]+?)\\s*-->`))?.[1]?.trim();
}
