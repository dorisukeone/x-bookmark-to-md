# Privacy Policy

**Last updated: April 2026**

## Overview

x-bookmark-to-md ("the Extension") runs entirely in your browser. This policy describes what data the extension can access and how it is handled.

## Data the extension accesses

On **https://x.com/i/bookmarks** (and the equivalent Twitter domain), when you start an export:

- Text, author, time, and URL of bookmarked tweets visible on the page
- Image and link URLs shown in those tweets

## How data is used

- Processing is **local** in Chrome (no extension backend receives your bookmarks).
- The ZIP / Markdown download is saved **only where you choose** on your device.

## Local storage (`chrome.storage.local`)

The extension may store **on your device only**:

- **Preferences**: Bookmark count cap and “full” vs “incremental” mode.
- **Incremental export** (optional): Normalized tweet URLs you have already exported, so the extension can skip them next time—**up to 8,000 URLs**. You can clear this from the popup at any time.

Nothing in storage is sent to our servers; we do not operate a collection server for this extension.

## Anonymous usage analytics (Google Analytics 4)

The extension sends a small number of anonymous, aggregate usage events to Google Analytics 4 via the Measurement Protocol:

- `extension_installed` / `extension_updated` — extension version only.
- `export_completed` — export mode (full/incremental), bookmark count, and cap setting.
- `export_empty` — export mode and cap setting, sent when a full export finds zero bookmarks.
- `export_error` — a fixed error-reason code (e.g. `connection_failed`, `zip_download_failed`) and a fixed export-stage code (e.g. `connect`, `extract`, `convert`, `zip`, `download`); never the raw error text.

These events **never include bookmark text, tweet URLs, usernames, or any page content**. Each browser profile is identified only by a random ID generated locally (`gaClientId` in `chrome.storage.local`), not by your Google account, X account, or IP-linked identity beyond what Google's infrastructure retains for any web request. This is enabled by default and has no opt-out toggle in the UI; you can disable it by removing `analytics-config.js`'s values or blocking `www.google-analytics.com` yourself. See [`docs/ga4-setup.md`](docs/ga4-setup.md) for how this is configured.

## Permissions (summary)

| Permission | Why |
|------------|-----|
| **activeTab** | Talk to the tab that is open when you use the popup (bookmarks page). |
| **downloads** | Save the generated ZIP file when you export. |
| **storage** | Save optional preferences and incremental URL list locally, as described above. |
| **Host access (x.com / twitter.com)** | Run only on X/Twitter where bookmarks appear. |
| **Host access (www.google-analytics.com)** | Send the anonymous usage events described above. |

**Note:** Content scripts are declared in the extension manifest; the extension does **not** use the `scripting` API to inject code dynamically.

## Changes

We may update this document; the latest version lives in this repository.

## Contact

Questions: open an issue in this repository.
