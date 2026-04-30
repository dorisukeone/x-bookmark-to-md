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

## Permissions (summary)

| Permission | Why |
|------------|-----|
| **activeTab** | Talk to the tab that is open when you use the popup (bookmarks page). |
| **downloads** | Save the generated ZIP file when you export. |
| **storage** | Save optional preferences and incremental URL list locally, as described above. |
| **Host access (x.com / twitter.com)** | Run only on X/Twitter where bookmarks appear. |

**Note:** Content scripts are declared in the extension manifest; the extension does **not** use the `scripting` API to inject code dynamically.

## Changes

We may update this document; the latest version lives in this repository.

## Contact

Questions: open an issue in this repository.
