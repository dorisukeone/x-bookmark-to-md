import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectGa4Metrics, type Ga4Metrics } from "./ga4.js";
import {
  DATA_DIR,
  DAILY_LABEL,
  ROOT,
  daysAgo,
  ghJson,
  readJson,
  repository,
  run,
  todayJst,
  writeJson,
} from "./shared.js";

export interface Metrics {
  date: string;
  collectedAt: string;
  github: {
    stars: number;
    openIssues: number;
    forks: number;
    watchers: number;
    latestRelease: string | null;
    latestReleaseAgeDays: number | null;
  };
  extension: {
    manifestVersion: number;
    version: string;
    permissions: string[];
    hostPermissions: string[];
    permissionCount: number;
    xSelectorCount: number;
    jsLines: Record<string, number>;
    totalJsLines: number;
    jszipVersion: string | null;
  };
  ga4: Ga4Metrics;
}

interface RepoResponse {
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
}

interface ReleaseResponse {
  tag_name: string;
  published_at: string;
}

function lines(path: string): number {
  return readFileSync(path, "utf8").split(/\r?\n/u).length;
}

function release(): ReleaseResponse | null {
  const raw = run("gh", ["api", `repos/${repository()}/releases/latest`], {
    allowFailure: true,
  });
  return raw ? (JSON.parse(raw) as ReleaseResponse) : null;
}

function userOpenIssueCount(repositoryName: string): number {
  const output = run("gh", [
    "issue",
    "list",
    "--repo",
    repositoryName,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "labels",
  ]);
  const issues = JSON.parse(output) as Array<{ labels: Array<{ name: string }> }>;
  return issues.filter((issue) => !issue.labels.some((label) => label.name === DAILY_LABEL)).length;
}

export async function collectMetrics(date = todayJst()): Promise<Metrics> {
  const repositoryName = repository();
  const repo = ghJson<RepoResponse>(`repos/${repositoryName}`);
  const openIssues = userOpenIssueCount(repositoryName);
  const latest = release();
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8")) as {
    manifest_version: number;
    version: string;
    permissions?: string[];
    host_permissions?: string[];
  };
  const content = readFileSync(resolve(ROOT, "content.js"), "utf8");
  const jszip = readFileSync(resolve(ROOT, "jszip.min.js"), "utf8");
  const jsFiles = ["background.js", "content.js", "popup.js", "url-utils.js", "jszip.min.js"];
  const jsLines = Object.fromEntries(jsFiles.map((file) => [file, lines(resolve(ROOT, file))]));
  const releaseAge =
    latest === null
      ? null
      : Math.floor((Date.now() - new Date(latest.published_at).getTime()) / 86_400_000);
  const ga4 = await collectGa4Metrics();

  return {
    date,
    collectedAt: new Date().toISOString(),
    github: {
      stars: repo.stargazers_count,
      openIssues,
      forks: repo.forks_count,
      watchers: repo.subscribers_count,
      latestRelease: latest?.tag_name ?? null,
      latestReleaseAgeDays: releaseAge,
    },
    extension: {
      manifestVersion: manifest.manifest_version,
      version: manifest.version,
      permissions: [...(manifest.permissions ?? [])].sort(),
      hostPermissions: [...(manifest.host_permissions ?? [])].sort(),
      permissionCount:
        (manifest.permissions?.length ?? 0) + (manifest.host_permissions?.length ?? 0),
      xSelectorCount: [
        ...content.matchAll(/\.(?:querySelector|querySelectorAll|closest)\(\s*(['"`])/gu),
      ].length,
      jsLines,
      totalJsLines: Object.values(jsLines).reduce((sum, count) => sum + count, 0),
      jszipVersion: jszip.match(/JSZip v(\d+\.\d+\.\d+)/u)?.[1] ?? null,
    },
    ga4,
  };
}

export function saveMetrics(metrics: Metrics): void {
  writeJson(resolve(DATA_DIR, `${metrics.date}.json`), metrics);
}

export function loadMetrics(date: string): Metrics | null {
  return readJson<Metrics | null>(resolve(DATA_DIR, `${date}.json`), null);
}

export function deltas(current: Metrics): {
  previous: Metrics | null;
  weekAgo: Metrics | null;
  anomalies: string[];
} {
  const previous = loadMetrics(daysAgo(current.date, 1));
  const weekAgo = loadMetrics(daysAgo(current.date, 7));
  const anomalies: string[] = [];

  if (previous) {
    if (current.github.stars < previous.github.stars) anomalies.push("Star count decreased");
    if (current.github.openIssues - previous.github.openIssues >= 5) {
      anomalies.push("Open issue count increased by at least 5");
    }
    if (
      JSON.stringify(current.extension.permissions) !==
        JSON.stringify(previous.extension.permissions) ||
      JSON.stringify(current.extension.hostPermissions) !==
        JSON.stringify(previous.extension.hostPermissions)
    ) {
      anomalies.push("Extension permissions changed");
    }
    if (current.extension.xSelectorCount !== previous.extension.xSelectorCount) {
      anomalies.push("X DOM selector count changed");
    }
  }
  if (
    current.github.latestReleaseAgeDays !== null &&
    current.github.latestReleaseAgeDays >= 180
  ) {
    anomalies.push("Latest GitHub release is at least 180 days old");
  }
  if (!current.extension.jszipVersion) anomalies.push("Vendored JSZip version was not detected");

  if (current.ga4.enabled) {
    const completed = current.ga4.eventCounts7d.export_completed ?? 0;
    const errors = current.ga4.eventCounts7d.export_error ?? 0;
    if (completed + errors >= 5 && errors / (completed + errors) >= 0.2) {
      anomalies.push("GA4: export error rate over the last 7 days is at least 20%");
    }
    const { activeUsers7d, activeUsers7dPrevious } = current.ga4;
    if (
      activeUsers7d !== null &&
      activeUsers7dPrevious !== null &&
      activeUsers7dPrevious >= 5 &&
      activeUsers7d <= activeUsers7dPrevious * 0.7
    ) {
      anomalies.push("GA4: active users (7d) dropped by at least 30% week-over-week");
    }
  }

  return { previous, weekAgo, anomalies };
}
