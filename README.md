# x-bookmark-to-md

Chrome extension that exports your **X (Twitter) bookmarks** as individual Markdown files inside a single **ZIP** archive. Scraping runs entirely in the browser from the bookmarks page DOM (no official X API).

**Current version:** 1.1.6 · Manifest V3

## Features

- **Export** — On [x.com/i/bookmarks](https://x.com/i/bookmarks), scrolls the timeline and collects each visible tweet card.
- **Markdown** — One `.md` per bookmark: author, handle, tweet time, canonical status URL, text, image URLs (`pbs.twimg.com`), and `t.co` links.
- **ZIP + `index.md`** — Each download lists all files in that archive.
- **Cap slider** — Stops after: **∞**, **50**, **100**, **200**, **500**, or **1000+** tweets (only these steps are stored; older numeric prefs snap to the nearest step).
- **Full vs Incremental** — See [Incremental mode](#incremental-mode) below.
- **History** — Last run time and count of remembered URLs; **trash** button clears stored history for this Chrome profile.

## UI

- Popup shows **Export** (slider + **Full All** / **Incremental New**) and a **status strip** (e.g. *Ready*, *Working…*, *Saving…*) — there is **no** separate progress bar or “Fetching…” line.
- Version in the header comes from `manifest.json`.

## Incremental mode

Incremental uses **tweet status URLs** (normalized via `url-utils.js`: `x.com`, no query string) as the id, **not** “when you bookmarked”.

| | **Full All** | **Incremental New** |
|---|--------------|---------------------|
| **Collection** | Gathers tweets up to the cap (or until the feed stops loading). | Same scrolling, but tweets whose URL is already in local history are **skipped** (not added to the ZIP). |
| **`chrome.storage.local` after success** | **`exportedTweetUrls`** is **replaced** by the URLs in this ZIP only. | New URLs from this run are **merged** into the existing list (deduped). |
| **Empty history** | N/A | No URLs to skip yet → first successful run behaves like a **full** scan; history is written after at least one bookmark is exported. |

Details:

- **Storage** — `exportedTweetUrls` (max **8000** URLs; excess drops from the oldest side) and `lastExportAt` (ISO string, mainly for display). **This profile only**; not synced across devices.
- **Full + cap** — Only URLs that made it into that ZIP are remembered. If you need a “complete” skip-list for incremental, run **Full** once with **∞** (or accept a partial list after a capped export).
- **8000 cap** — Very old URLs may fall off the list and could appear as “new” again in a later incremental run.
- **Incremental ZIP filename** — `x-bookmarks-YYYY-MM-DD-incremental.zip`; `index.md` notes incremental exports.

## How to use

1. **Install** — Clone or download this repo. In Chrome: `chrome://extensions/` → **Developer mode** → **Load unpacked** → select the folder that contains `manifest.json`.
2. **Update** — After `git pull`, open `chrome://extensions/` and click **Reload** on this extension.
3. **Export** — Open `https://x.com/i/bookmarks` (logged in), click the toolbar icon, choose **Full** or **Incremental**, set the cap if needed, then **Export Bookmarks**. When processing finishes, save the ZIP from the download dialog.

## Caveats

- **DOM dependence** — If X changes markup or `data-testid`s, extraction may need code updates.
- **Privacy** — Data stays on your machine; the extension does not send bookmarks to a custom backend.

## ZIP layout

- `Bookmark @username_001.md`, …
- `index.md` — links to each file in **that** archive

## Project layout

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions |
| `popup.html` / `popup.js` / `popup.css` | Popup UI, ZIP build, download |
| `content.js` | Bookmarks page scroll + scrape |
| `url-utils.js` | Shared URL normalization |
| `background.js` | Service worker (install) |
| `jszip.min.js` | ZIP generation |

## Chrome Web Store（パッケージのアップロード）

ストアは **ZIP の直下に `manifest.json` がある**こと必須です。  
フォルダごと圧縮すると `あなたのフォルダ名/manifest.json` になり **拒否**されます。

- **推奨:** リポジトリルートで次を実行すると、バージョン付きのストア用 ZIP が作られます。

```bash
chmod +x scripts/package-for-store.sh
./scripts/package-for-store.sh
```

生成物: `x-bookmark-to-md-<version>-store.zip`（例: ルートに `manifest.json`、`icons/` など）

- **手動の場合:** プロジェクト**中身**を選んで ZIP 化するか、`cd` してから上記スクリプトと同じファイルだけを `zip` に含めてください。**親フォルダを1段多く入れない**でください。

## Contributing

## License

MIT License.
