# AGENTS.md

## Cursor Cloud specific instructions

This repository (`main` branch) is a **Manifest V3 Chrome extension** with **no package manager, no build tooling, no test framework, and no linter configured**. `jszip.min.js` is vendored (committed), so there are no dependencies to install. Do not expect `npm install`/`pnpm install` to do anything on `main` — there is no `package.json` here.

### Running the extension (development)
There is no dev server. "Running" means loading the unpacked extension into Chrome:
1. Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the repository root (the folder containing `manifest.json`).
2. After editing files, click **Reload** on the extension card to pick up changes.
Google Chrome is preinstalled on the VM (`google-chrome`). See `README.md` ("How to use") for the same steps.

### Building the store package
Run `./scripts/package-for-store.sh` (requires the `zip` CLI, which is preinstalled). It produces `x-bookmark-to-md-<version>-store.zip` with `manifest.json` at the **archive root** (required by the Chrome Web Store). The zip is gitignored.

### Testing / linting
No automated tests or lint config exist on `main`. Verification is manual: load unpacked, open the popup, and exercise the UI. The popup version string, cap slider, and Full/Incremental toggle are backed by `chrome.storage.local`, so settings persistence (close/reopen popup) is a good smoke test that does not require an X account.

### Non-obvious caveat: full export needs a logged-in X session
The core export flow (scroll + scrape `x.com/i/bookmarks` → Markdown → ZIP) only runs on `https://x.com/i/bookmarks` while **logged into X with existing bookmarks**. The popup keeps the **Export** button disabled on any other page. Without X credentials you can only demonstrate the popup UI, settings persistence, and the packaging build — not a real scrape.

### The "automated improvement cycle" lives on another branch
The daily GitHub Actions automation (issue/report/auto-PR cycle) is **not on `main`**. It lives on the `feat/automated-improvement-cycle` branch (`.github/workflows/daily-report.yml`, `scripts/daily-report/*`, `package.json`, `pnpm-lock.yaml`, `docs/automation.md`) and is unmerged, so it does not run for `main`.
