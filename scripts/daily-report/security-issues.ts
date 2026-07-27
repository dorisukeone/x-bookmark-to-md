import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DATA_DIR,
  DAILY_LABEL,
  MANUAL_LABEL,
  ROOT,
  SECURITY_LABEL,
  ensureLabel,
  markerValue,
  readJson,
  repository,
  run,
  writeJson,
} from "./shared.js";

interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  references?: Array<{ type: string; url: string }>;
}

interface OsvResponse {
  vulns?: OsvVulnerability[];
}

interface SecurityIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
}

interface Attempt {
  issue: number;
}

function clearImplementationAttempt(issueNumber: number): void {
  const path = resolve(DATA_DIR, "implementation-attempts.json");
  const attempts = readJson<Attempt[]>(path, []);
  writeJson(
    path,
    attempts.filter((attempt) => attempt.issue !== issueNumber),
  );
}

function severity(vulnerability: OsvVulnerability): string {
  const databaseSeverity = vulnerability.database_specific?.severity?.toUpperCase();
  if (databaseSeverity) return databaseSeverity === "MODERATE" ? "MEDIUM" : databaseSeverity;
  const numeric = vulnerability.severity
    ?.map((entry) => Number(entry.score))
    .find((score) => Number.isFinite(score));
  if (numeric === undefined) return "UNKNOWN";
  if (numeric >= 9) return "CRITICAL";
  if (numeric >= 7) return "HIGH";
  if (numeric >= 4) return "MEDIUM";
  return "LOW";
}

function priority(level: string): number {
  return { CRITICAL: 100, HIGH: 85, MEDIUM: 65, LOW: 35, UNKNOWN: 50 }[level] ?? 50;
}

function listSecurityIssues(): SecurityIssue[] {
  return JSON.parse(
    run("gh", [
      "issue",
      "list",
      "--repo",
      repository(),
      "--state",
      "all",
      "--label",
      SECURITY_LABEL,
      "--limit",
      "500",
      "--json",
      "number,title,body,state",
    ]),
  ) as SecurityIssue[];
}

const source = readFileSync(resolve(ROOT, "jszip.min.js"), "utf8");
const version = source.match(/JSZip v(\d+\.\d+\.\d+)/u)?.[1];
if (!version) throw new Error("Could not detect vendored JSZip version");

const response = await fetch("https://api.osv.dev/v1/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ package: { ecosystem: "npm", name: "jszip" }, version }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`OSV query failed: ${response.status} ${response.statusText}`);
const osv = (await response.json()) as OsvResponse;

ensureLabel(DAILY_LABEL, "1D76DB", "Automated daily maintenance report");
ensureLabel(SECURITY_LABEL, "B60205", "Vendored dependency vulnerability");
ensureLabel(MANUAL_LABEL, "D93F0B", "Requires human review and is excluded from automation");
const existing = listSecurityIssues();
const activeFingerprints = new Set<string>();

for (const vulnerability of osv.vulns ?? []) {
  const fingerprint = `jszip@${version}:${vulnerability.id}`;
  activeFingerprints.add(fingerprint);
  const current = existing.find(
    (issue) => markerValue(issue.body, "security-fingerprint") === fingerprint,
  );
  const level = severity(vulnerability);
  const score = priority(level);
  const references = (vulnerability.references ?? [])
    .slice(0, 10)
    .map((reference) => `- ${reference.url}`)
    .join("\n");
  const body = `<!-- security-fingerprint:${fingerprint} -->
<!-- priority-score:${score} -->

## Vendored dependency vulnerability

- Package: \`jszip\`
- Detected version: \`${version}\`
- OSV ID: \`${vulnerability.id}\`
- Severity: **${level}**
- Aliases: ${(vulnerability.aliases ?? []).join(", ") || "none"}

${vulnerability.details ?? vulnerability.summary ?? "No details supplied by OSV."}

## References

${references || `- https://osv.dev/vulnerability/${vulnerability.id}`}

_Synchronized from OSV at ${new Date().toISOString()}._`;
  const title = `[Security][${level}] ${vulnerability.id}: ${vulnerability.summary ?? "JSZip vulnerability"}`;

  if (current) {
    run("gh", [
      "issue",
      "edit",
      String(current.number),
      "--repo",
      repository(),
      "--title",
      title,
      "--body",
      body,
      "--add-label",
      DAILY_LABEL,
      "--add-label",
      SECURITY_LABEL,
      "--add-label",
      MANUAL_LABEL,
    ]);
    if (current.state === "CLOSED") {
      run("gh", ["issue", "reopen", String(current.number), "--repo", repository()]);
      clearImplementationAttempt(current.number);
    }
  } else {
    run("gh", [
      "issue",
      "create",
      "--repo",
      repository(),
      "--title",
      title,
      "--body",
      body,
      "--label",
      DAILY_LABEL,
      "--label",
      SECURITY_LABEL,
      "--label",
      MANUAL_LABEL,
    ]);
  }
}

for (const issue of existing) {
  const fingerprint = markerValue(issue.body, "security-fingerprint");
  if (issue.state === "OPEN" && fingerprint && !activeFingerprints.has(fingerprint)) {
    run("gh", [
      "issue",
      "comment",
      String(issue.number),
      "--repo",
      repository(),
      "--body",
      `OSV no longer reports this fingerprint for the vendored JSZip version (${version}); closing automatically.`,
    ]);
    run("gh", ["issue", "close", String(issue.number), "--repo", repository()]);
  }
}

console.log(`OSV synchronization complete: ${osv.vulns?.length ?? 0} active vulnerability(s).`);
