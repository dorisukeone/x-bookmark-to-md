# x-bookmark-to-md

Chrome extension that exports your **X (Twitter) bookmarks** as individual Markdown files inside a single **ZIP** archive. Scraping runs entirely in the browser from the bookmarks page DOM (no official X API).

**Current version:** 1.2.8 · Manifest V3

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
- **ZIP filename** — `x-bookmarks-YYYY-MM-DD-HHmmss.zip` (incremental: `…-HHmmss-incremental.zip`); `index.md` notes incremental exports.

## How to use

1. **Install** — Clone or download this repo. In Chrome: `chrome://extensions/` → **Developer mode** → **Load unpacked** → select the folder that contains `manifest.json`.
2. **Update** — After `git pull`, open `chrome://extensions/` and click **Reload** on this extension.
3. **Export** — Open `https://x.com/i/bookmarks` (logged in), click the toolbar icon, choose **Full** or **Incremental**, set the cap if needed, then **Export Bookmarks**. When processing finishes, save the ZIP from the download dialog.

## Caveats

- **DOM dependence** — If X changes markup or `data-testid`s, extraction may need code updates.
- **Privacy** — Data stays on your machine; the extension does not send bookmarks to a custom backend. It does send anonymous, aggregate usage events (install/export counts, no bookmark content) to Google Analytics 4 — see [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).

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
| `analytics.js` / `analytics-config.js` | Anonymous GA4 usage analytics (see [GA4 setup](docs/ga4-setup.md)) |
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

`npm run validate`（`scripts/validate-extension.ts`）は生成された ZIP に `node_modules/` に加え、開発専用の `reports/`・`scripts/` ディレクトリが含まれていないことも検証し、混入時は非ゼロ終了コードで失敗します。

- **手動の場合:** プロジェクト**中身**を選んで ZIP 化するか、`cd` してから上記スクリプトと同じファイルだけを `zip` に含めてください。**親フォルダを1段多く入れない**でください。

### プライバシーへの取り組み（権限の理由文・例）

ストアの **[プライバシーへの取り組み]** で、**`storage`** の理由を求められたときの例です（必要に応じて編集してください）。

**日本語（`storage`）:**

> 端末内（Chrome のローカル領域）にのみ保存します。用途は (1) ポップアップの設定（取得件数の上限・フル／増分モード）、(2) 増分エクスポート利用時に、すでに書き出したツイートの URL を覚えておき、次回以降のエクスポートで重複を省くこと（最大 8,000 件まで。ユーザーが拡張のポップアップからいつでも消去可能）、(3) 匿名の利用状況分析用にローカルで生成したランダムな識別子（`gaClientId`）の保持、(4) 直近のエクスポート失敗時に、失敗した段階名と定型の一般化されたエラーメッセージのみをキャッシュし次回ポップアップ表示時に通知すること（ブックマーク本文やURLは含みません。表示後または次回成功時に消去）です。いずれも開発者のサーバーへ送信しません。

**English (`storage`):**

> Stored only on your device via `chrome.storage.local`. Used to save (1) popup settings (export cap and full vs incremental mode), (2) if you use incremental export, a list of tweet URLs already exported so duplicates can be skipped (up to 8,000 URLs; you can clear this from the popup), (3) a random locally-generated identifier (`gaClientId`) for anonymous usage analytics, and (4) a cache of the most recent export failure (stage name and a fixed, generic error message only — never bookmark text or URLs) so it can be shown as a notice next time the popup opens; cleared once shown or after the next successful export. Nothing is sent to the developer's servers.

v1.1.7 より **`scripting` 権限は削除済み**です（宣言型の content scripts のみ使用）。新しい ZIP を再アップロードすると、`scripting` の説明入力は求められなくなります。

v1.2.0 で **host permission `https://www.google-analytics.com/*` を追加**しました。ストアの **[プライバシーへの取り組み]** で理由を求められたときの例です。

**日本語（host permission: `www.google-analytics.com`）:**

> 匿名の利用状況（インストール・アップデート・エクスポート実行回数とモード・エラー発生の種類と発生段階。ポップアップを処理中に閉じた場合も区別可能な値として送信）を GA4 の Measurement Protocol で送信するために使用します。ブックマークの本文・URL・ユーザー名などは一切送信しません。詳細は本リポジトリの `PRIVACY_POLICY.md` を参照してください。

**English (host permission: `www.google-analytics.com`):**

> Used to send anonymous, aggregate usage events (install/update, export run count and mode, error type and stage — including a distinct value if the popup is closed mid-export) to GA4 via the Measurement Protocol. No bookmark text, URLs, or usernames are ever sent. See `PRIVACY_POLICY.md` in this repository for details.

「データ使用状況」の開示では、収集項目として「使用状況に関する分析情報（Analytics）」に該当する旨をチェックし、プライバシーポリシーのURLに `PRIVACY_POLICY.md` を指定してください。

## Contributing

Issues and pull requests are welcome.

## Automation

日次メトリクス、依存関係監査、改善Issue、自動実装PRの仕組みは
[自動改善サイクルのドキュメント](docs/automation.md)を参照してください。

## License

MIT License.
