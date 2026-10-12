# GA4イベント・パラメータ一覧

この拡張機能が `analytics.js` 経由でGA4 Measurement Protocolに送出している
イベントと、`export_error`に付与される`stage`/`reason`パラメータの内訳を
整理したものです。GA4に送るのは匿名の集計イベントのみで、ブックマーク本文・
URL・ユーザー名などは一切含みません(詳細は
[`PRIVACY_POLICY.md`](../PRIVACY_POLICY.md))。

このドキュメントは既存の計測ロジックを変更するものではなく、
`popup.js` / `background.js` に実装済みのイベント送出を後から棚卸しした
リファレンスです。

## イベント一覧

| イベント名 | 送出元 | 主なパラメータ |
|---|---|---|
| `extension_installed` | `background.js`(`onInstalled`, `reason === 'install'`) | `version` |
| `extension_updated` | `background.js`(`onInstalled`, `reason === 'update'`) | `version` |
| `export_completed` | `popup.js` | `mode`(`full`/`incremental`), `count`, `cap` |
| `export_empty` | `popup.js`(フルモードでブックマーク0件) | `mode`, `cap` |
| `export_canceled` | `popup.js`(ユーザーがキャンセル) | なし |
| `export_error` | `popup.js` / `background.js` | `stage`, `reason` |

## `export_error` の `stage` 内訳

`stage`はエクスポートのどの段階で失敗したかを示します。値は`popup.js`と
`background.js`に既存実装済みで、今回新規に追加したものはありません。

| `stage` | 送出元 | 意味 |
|---|---|---|
| `popup_closed` | `popup.js`(`pagehide`) | 抽出・変換が終わる前にポップアップが閉じられた |
| `connect` | `popup.js`(`startExport`のcatch, `runExportFlow`) | タブへの`ping`送信・接続に失敗 |
| `connection` | `popup.js`(`handleSendMessageError`) | `Receiving end does not exist`(コンテンツスクリプト未応答) |
| `message_timeout` | `popup.js`(`sendTabMessage`のタイムアウト/`message port closed`) | `chrome.tabs.sendMessage`が応答なし、または途中でポートが閉じた |
| `extract` | `popup.js`(`runExportFlow`, `handleSendMessageError`のデフォルト) | ブックマークページからの抽出処理そのものの失敗 |
| `convert` | `popup.js`(`handleExportSuccess`) | 抽出結果をMarkdownへ変換する際の失敗 |
| `zip` | `popup.js`(ZIPハンドオフ) / `background.js`(既定値) | ポップアップ→バックグラウンドへのZIP引き渡し、またはZIP生成 |
| `download` | `background.js`(`openDownloadPage`失敗, ダウンロードのタイムアウト/中断の既定値) | ダウンロードウィンドウの起動・保存に失敗 |
| `download_<CHROME_REASON>` | `background.js`(`pendingDownloadResult`, `USER_CANCELED`以外) | Chromeのダウンロード中断理由(`NETWORK_FAILED`など`chrome.downloads`のerrorコード)をそのまま連結した値 |
| `unknown` | `popup.js`(`showError`の既定値) | 上記に当たらない予期しない失敗 |

`stage`が`unexpected_failed`ではなく`err.stage`または`unknown`になる点に注意
してください(`unexpected_failed`は`reason`側の値です)。

## `export_error` の `reason` 内訳

| `reason` | 意味 |
|---|---|
| `popup_closed` | ポップアップが処理中に閉じられた |
| `connection_failed` | タブへの`ping`が失敗 |
| `receiving_end_missing` | コンテンツスクリプトが存在しない/応答しない |
| `message_timeout` | メッセージ応答タイムアウト |
| `message_port_closed` | メッセージポートが途中で閉じた |
| `runtime_error` | `chrome.runtime.lastError`のその他のエラー |
| `scrape_failed` | ページからの抽出が失敗 |
| `convert_failed` | Markdown変換が失敗 |
| `zip_handoff_failed` | バックグラウンドへのZIP引き渡しが失敗 |
| `unexpected_failed` | `runExportFlow`内の想定外の例外 |
| `zip_download_failed` | ZIP作成またはダウンロードの汎用失敗(既定値) |
| `zip_failed` | JSZipによるZIP生成そのものの失敗 |
| `zip_generation_large` | ZIP生成が`ZIP_GENERATION_SLOW_MS`(15秒)以上かかった上での失敗 |
| `download_interrupted` | Chromeのダウンロードが中断(`USER_CANCELED`以外) |

## GA4でstage/reasonを集計する手順(カスタムディメンション登録)

Measurement Protocolで送るイベントパラメータ(`stage`, `reason`)は、GA4の
標準レポートには自動で表示されません。探索レポートやレポートで使うには、
イベントパラメータを**カスタムディメンション**として登録する必要があります。

1. GA4管理画面(左下の歯車アイコン) → **プロパティ** 列の
   **カスタム定義** を開く
2. **カスタムディメンションを作成** をクリック
3. 以下の内容でそれぞれ作成する(2回実施):
   - ディメンション名: `Export error stage`(任意)/ スコープ: **イベント** /
     イベントパラメータ: `stage`
   - ディメンション名: `Export error reason`(任意)/ スコープ: **イベント** /
     イベントパラメータ: `reason`
4. 登録は**それ以降に収集されるイベント**からのみ有効になります
   (過去分には遡って適用されません)。登録直後は反映まで数時間かかる場合が
   あります。
5. **探索** → 空白のレポート等で、ディメンションに上で作成した
   `Export error stage` / `Export error reason` を、指標に「イベント数」を
   置き、フィルタでイベント名を`export_error`に絞ると、stage別・reason別の
   件数内訳が確認できます。

これで次回の日次メトリクス収集以降、`export_error`のうちどの`stage`が
支配的かを経験的に確認できるようになります(拡張機能側のコードは今回
変更していません)。
