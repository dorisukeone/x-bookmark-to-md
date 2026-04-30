# x-bookmark-to-md

Chrome extension that exports your **X (Twitter) bookmarks** as individual Markdown files inside a single **ZIP** archive. Everything runs in the browser; bookmarks are read from the page DOM (no X API).

**Current version:** 1.1.2 (Manifest V3)

## Features

- **Export bookmarks** — Opens [https://x.com/i/bookmarks](https://x.com/i/bookmarks), scrolls the timeline, and collects each tweet card.
- **Markdown** — One `.md` file per bookmark with author, handle, tweet date, canonical URL, text, embedded image URLs, and `t.co` links.
- **ZIP + index** — Download includes `index.md` linking to every file.
- **Max bookmarks** — Optional cap (e.g. `200`); stops after that many items so long lists finish sooner. `0` means no limit.
- **Incremental export** — Remembers exported tweet URLs in `chrome.storage.local` (this Chrome profile only). With *Incremental only* enabled, already-exported URLs are skipped. Full export replaces that history with the URLs in the current ZIP; incremental merges new URLs into history (up to **8000** URLs; oldest entries are dropped when over the cap).
- **Clear history** — Removes stored URLs and last-export timestamp from the popup.

## How to use

1. **Install**
   - Clone or download this repository.
   - Open `chrome://extensions/`, turn on **Developer mode**, click **Load unpacked**, and choose the project folder (the one that contains `manifest.json`).

2. **Update after pulling changes**
   - On `chrome://extensions/`, find **x-bookmark-to-md** and click **Reload** (circular arrow).

3. **Export**
   - Go to `https://x.com/i/bookmarks` (logged in).
   - Click the extension icon → **Export Bookmarks**.
   - Wait for scrolling to finish, then save the ZIP when prompted.
   - Incremental ZIPs are named like `x-bookmarks-YYYY-MM-DD-incremental.zip`.

## Important behavior notes

- **Full export + max count** — Only the URLs actually exported are saved for incremental mode. For a complete “known” list, run once with **no** max (or accept that partial exports define partial history).
- **Incremental, empty history** — The first run behaves like a full collection; URLs are stored after a successful export with at least one bookmark.
- **DOM reliance** — If X changes markup or `data-testid` attributes, extraction may break until the selectors are updated.
- **Privacy** — Bookmark text and metadata stay on your machine; the extension does not send them to a backend.

## ZIP contents example

- `Bookmark @username_001.md` … per bookmark
- `index.md` … list of all files in that download

## Project layout (main files)

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions |
| `popup.html` / `popup.js` / `popup.css` | Toolbar UI, ZIP build, download |
| `content.js` | Bookmark page scrolling and DOM scraping |
| `url-utils.js` | Shared tweet URL normalization for deduplication |
| `background.js` | Service worker (install hook) |
| `jszip.min.js` | ZIP generation |

## Contributing

Contributions are welcome via issues or pull requests.

## License

MIT License.
