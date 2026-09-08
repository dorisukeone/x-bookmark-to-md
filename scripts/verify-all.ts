import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT } from "./daily-report/shared.js";

const checks = [
  { name: "verify-package", candidates: ["scripts/verify-package.ts", "scripts/verify-package.js"] },
  { name: "verify-version", candidates: ["scripts/verify-version.ts", "scripts/verify-version.js"] },
  { name: "verify-release", candidates: ["scripts/verify-release.ts", "scripts/verify-release.js"] },
];

let missing = false;

for (const check of checks) {
  const found = check.candidates.find((candidate) => existsSync(resolve(ROOT, candidate)));
  if (!found) {
    console.log(`[verify:all] ${check.name}: not implemented yet, skipping.`);
    missing = true;
    continue;
  }
  console.log(`[verify:all] Running ${found}...`);
  const runner = found.endsWith(".ts")
    ? [resolve(ROOT, "node_modules/.bin/tsx"), resolve(ROOT, found)]
    : [process.execPath, resolve(ROOT, found)];
  execFileSync(runner[0], runner.slice(1), { cwd: ROOT, stdio: "inherit" });
}

if (missing) {
  console.log("[verify:all] Done. Some verification scripts are not implemented yet — see messages above.");
} else {
  console.log("[verify:all] All verification scripts passed.");
}
