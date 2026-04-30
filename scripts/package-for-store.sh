#!/usr/bin/env bash
# Build a ZIP valid for Chrome Web Store upload:
# manifest.json and all assets MUST be at the top level of the archive
# (not inside a parent folder like x-bookmark-to-md/manifest.json).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)"
OUT="${ROOT}/x-bookmark-to-md-${VERSION}-store.zip"

rm -f "$OUT"
zip -r "$OUT" \
  manifest.json \
  background.js \
  content.js \
  popup.html \
  popup.css \
  popup.js \
  url-utils.js \
  jszip.min.js \
  icons \
  PRIVACY_POLICY.md \
  -x "*.DS_Store"

echo "Created: $OUT"
echo "First entries (manifest must be at root):"
unzip -l "$OUT" | head -18
