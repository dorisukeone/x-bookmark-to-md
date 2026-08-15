#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message) {
  console.error(`verify-icons: ${message}`);
  process.exitCode = 1;
}

function readPngDimensions(path) {
  const buffer = readFileSync(path);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a valid PNG file");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function collectIconEntries(manifest) {
  const entries = [];
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    entries.push({ label: `icons["${size}"]`, path, size: Number(size) });
  }
  const defaultIcon = manifest.action?.default_icon;
  if (typeof defaultIcon === "string") {
    entries.push({ label: "action.default_icon", path: defaultIcon, size: null });
  } else if (defaultIcon && typeof defaultIcon === "object") {
    for (const [size, path] of Object.entries(defaultIcon)) {
      entries.push({ label: `action.default_icon["${size}"]`, path, size: Number(size) });
    }
  }
  return entries;
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8"));
const entries = collectIconEntries(manifest);

if (entries.length === 0) {
  fail("manifest.json declares no icons to verify");
}

for (const entry of entries) {
  const filePath = resolve(ROOT, entry.path);
  if (!existsSync(filePath)) {
    fail(`${entry.label}: file not found at "${entry.path}"`);
    continue;
  }
  let dimensions;
  try {
    dimensions = readPngDimensions(filePath);
  } catch (error) {
    fail(`${entry.label}: could not read PNG dimensions from "${entry.path}" (${error.message})`);
    continue;
  }
  if (entry.size !== null && (dimensions.width !== entry.size || dimensions.height !== entry.size)) {
    fail(
      `${entry.label}: declared size ${entry.size}x${entry.size} does not match actual ${dimensions.width}x${dimensions.height} for "${entry.path}"`,
    );
    continue;
  }
  console.log(`OK ${entry.label} -> ${entry.path} (${dimensions.width}x${dimensions.height})`);
}

if (process.exitCode) {
  console.error("verify-icons: FAILED");
} else {
  console.log("verify-icons: all icon files match manifest.json declarations.");
}
