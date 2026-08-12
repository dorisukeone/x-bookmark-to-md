import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { ROOT } from "./daily-report/shared.js";

interface Manifest {
  version?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

let manifest: Manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8")) as Manifest;
} catch (error) {
  fail(`manifest.json is invalid JSON: ${String(error)}`);
}

const manifestVersion = manifest.version;
if (!manifestVersion || !/^\d+\.\d+\.\d+$/u.test(manifestVersion)) {
  fail("manifest.json version must be a semantic x.y.z version");
}

const VERSION_LABEL_PATTERNS = [
  /\*{0,2}Current version:\*{0,2}\s*v?(\d+\.\d+\.\d+)/giu,
  /現在のバージョン[:：]?\s*v?(\d+\.\d+\.\d+)/giu,
];

function collectTargetFiles(): string[] {
  const files = [resolve(ROOT, "README.md")];
  const storeDir = resolve(ROOT, "store");
  if (existsSync(storeDir) && statSync(storeDir).isDirectory()) {
    for (const entry of readdirSync(storeDir)) {
      const filePath = resolve(storeDir, entry);
      if (statSync(filePath).isFile() && [".md", ".txt"].includes(extname(entry))) {
        files.push(filePath);
      }
    }
  }
  return files.filter((file) => existsSync(file));
}

const mismatches: string[] = [];
let labeledVersionsFound = 0;

for (const filePath of collectTargetFiles()) {
  const text = readFileSync(filePath, "utf8");
  for (const pattern of VERSION_LABEL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const found = match[1] ?? "";
      labeledVersionsFound += 1;
      if (found !== manifestVersion) {
        mismatches.push(`${filePath}: states version ${found}, but manifest.json is ${manifestVersion}`);
      }
    }
  }
}

if (labeledVersionsFound === 0) {
  fail('No version label (e.g. "Current version:") found in README.md/store files to verify');
}

if (mismatches.length > 0) {
  fail(`Version mismatch detected:\n${mismatches.join("\n")}`);
}

console.log(
  `Version check passed: manifest.json version ${manifestVersion} matches ${labeledVersionsFound} label(s).`,
);
