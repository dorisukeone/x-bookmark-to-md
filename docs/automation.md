# 自動改善サイクル

毎日 08:00 JST（または手動実行）に、GitHub Actions の
`.github/workflows/daily-report.yml` が次を実行します。

1. vendored `jszip.min.js` を OSV で監査し、脆弱性 Issue を同期
2. GitHub・拡張機能の指標を `reports/data/YYYY-MM-DD.json` に保存
3. 前日・7日前との差分と異常を分析し、`reports/YYYY-MM-DD.md` を生成
4. Claude Code の構造化出力から、重複しない改善 Issue を最大5件作成
5. 未試行の改善 Issue を優先度順に最大3件検討し、安全に検証できた最初の1件だけPR化
6. 試行結果を `reports/data/implementation-attempts.json` に保存

## 必要な設定

- Repository secret `CLAUDE_CODE_OAUTH_TOKEN` を登録してください。
- `GH_TOKEN` は Actions 組み込みの `github.token` を使うため、追加Secretは不要です。
- GitHub の **Settings → Actions → General → Workflow permissions** で
  **Allow GitHub Actions to create and approve pull requests** を有効にしてください。
  無効な場合、レポートとIssueは作成できても自動PR作成は失敗します。

ワークフローの権限は `contents: write`、`issues: write`、
`pull-requests: write` に限定しています。自動実装は `main` へ直接pushせず、
`auto/issue-N` ブランチを通常pushします。force pushは行いません。

## ローカル実行

```bash
pnpm install
pnpm validate
pnpm typecheck
pnpm security:issues
pnpm report:daily
pnpm auto-implement
```

GitHubを変更する最後の3コマンドには、対象リポジトリへの権限を持つ
`gh auth` と、Claudeを使うコマンドには `CLAUDE_CODE_OAUTH_TOKEN` が必要です。

## 安全制約

- ブックマークデータを外部送信しない
- manifestの権限・host permissionsを自動変更しない
- `eval`、`new Function`、inline scriptを禁止
- 既存DOM selectorは削除・置換せず、フォールバック追加のみ
- `manual-review` Issueは自動実装しない
- ユーザー向け変更とvendored JSZip更新はmanifest versionを更新
- 配布ZIPへ`node_modules`を含めない

自動実装はClaudeにGit・シェル・ネットワークツールを許可せず、編集後に
差分の安全検査と`pnpm validate`の両方が成功した場合だけcommit・push・PR作成します。

vendored JSZipの更新は上流配布物の真正性確認が必要なため、セキュリティIssueへ
`manual-review`を自動付与します。検出・Issue化・優先度管理・解消確認は自動ですが、
ファイル差し替えだけは人が行います。

## GA4(拡張機能の利用状況)

拡張機能はインストール・エクスポート実行・エラー発生を匿名でGA4に送信します
(ブックマーク本文は送信しません)。設定手順は
[`docs/ga4-setup.md`](ga4-setup.md) を、送出済みイベント/パラメータ一覧と
`export_error`のstage別内訳の集計手順は[`docs/analytics.md`](analytics.md)
を参照してください。

`GA4_PROPERTY_ID` / `GA4_SERVICE_ACCOUNT_EMAIL` /
`GA4_SERVICE_ACCOUNT_PRIVATE_KEY` を設定すると、日次レポートに過去7日の
アクティブユーザー数とイベント数(イベント名別)が追加されます。エクスポート
エラー率が高い、アクティブユーザーが週次で大きく減少、といった異常も
自動検知の対象に含まれ、改善Issue生成のプロンプトにも渡されます。未設定の
場合はこの節がスキップされるだけで、他の処理には影響しません。
