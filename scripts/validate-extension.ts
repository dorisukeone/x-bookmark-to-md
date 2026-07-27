import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./daily-report/shared.js";

interface Manifest {
  manifest_version?: number;
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  action?: { default_popup?: string };
  background?: { service_worker?: string };
  content_scripts?: Array<{ js?: string[] }>;
  icons?: Record<string, string>;
  web_accessible_resources?: Array<{ resources?: string[] }>;
}

const sourceFiles = ["background.js", "content.js", "popup.js", "url-utils.js"] as const;
const syntaxFiles = [
  "background.js",
  "content.js",
  "popup.js",
  "url-utils.js",
  "jszip.min.js",
] as const;
const allowedPermissions = new Set(["activeTab", "downloads", "storage"]);
const allowedHosts = new Set(["https://x.com/*", "https://twitter.com/*"]);

function fail(message: string): never {
  throw new Error(message);
}

for (const file of syntaxFiles) {
  execFileSync(process.execPath, ["--check", resolve(ROOT, file)], { stdio: "inherit" });
}
for (const file of sourceFiles) {
  const source = readFileSync(resolve(ROOT, file), "utf8");
  if (/\beval\s*\(|\bnew\s+Function\s*\(/u.test(source)) {
    fail(`${file}: eval/new Function is prohibited`);
  }
}

let manifest: Manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8")) as Manifest;
} catch (error) {
  fail(`manifest.json is invalid JSON: ${String(error)}`);
}

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!manifest.version || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  fail("manifest version must be a semantic x.y.z version");
}

const permissions = manifest.permissions ?? [];
const hosts = manifest.host_permissions ?? [];
const extraPermissions = permissions.filter((permission) => !allowedPermissions.has(permission));
const extraHosts = hosts.filter((host) => !allowedHosts.has(host));
if (extraPermissions.length > 0) fail(`Unexpected permissions: ${extraPermissions.join(", ")}`);
if (extraHosts.length > 0) fail(`Unexpected host_permissions: ${extraHosts.join(", ")}`);

const references = new Set<string>();
if (manifest.action?.default_popup) references.add(manifest.action.default_popup);
if (manifest.background?.service_worker) references.add(manifest.background.service_worker);
for (const contentScript of manifest.content_scripts ?? []) {
  for (const file of contentScript.js ?? []) references.add(file);
}
for (const file of Object.values(manifest.icons ?? {})) references.add(file);
for (const resourceGroup of manifest.web_accessible_resources ?? []) {
  for (const file of resourceGroup.resources ?? []) references.add(file);
}
for (const file of references) {
  if (!existsSync(resolve(ROOT, file))) fail(`Manifest references missing file: ${file}`);
}

const popupPath = resolve(ROOT, manifest.action?.default_popup ?? "popup.html");
const popupHtml = readFileSync(popupPath, "utf8");
const scriptTags = [...popupHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
for (const [, attributes = "", body = ""] of scriptTags) {
  if (!/\bsrc\s*=/iu.test(attributes) || body.trim()) {
    fail("Inline scripts are prohibited in extension HTML");
  }
}
for (const match of popupHtml.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/giu)) {
  const file = match[1];
  if (file && !/^(?:https?:|data:|#)/iu.test(file) && !existsSync(resolve(ROOT, file))) {
    fail(`Popup references missing file: ${file}`);
  }
}

const zipPath = resolve(ROOT, `x-bookmark-to-md-${manifest.version}-store.zip`);
try {
  execFileSync("bash", [resolve(ROOT, "scripts/package-for-store.sh")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
  if (!entries.includes("manifest.json")) fail("Package ZIP has no root-level manifest.json");
  if (entries.some((entry) => entry.startsWith("node_modules/") || entry.includes("/node_modules/"))) {
    fail("Package ZIP must not contain node_modules");
  }
} finally {
  rmSync(zipPath, { force: true });
}

console.log("Extension validation passed.");
