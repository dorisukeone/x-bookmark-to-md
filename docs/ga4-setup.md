# GA4 セットアップ

拡張機能は Manifest V3 のため、通常のウェブサイトで使う `gtag.js`
(`googletagmanager.com` から動的にスクリプトを読み込む方式)は使えません
(MV3 はリモートコードの読み込みを禁止しています)。代わりに、拡張機能から
直接 HTTP リクエストを送る **GA4 Measurement Protocol** を使っています。

送信するのは匿名の集計イベントのみです。詳細は
[`PRIVACY_POLICY.md`](../PRIVACY_POLICY.md) の「Anonymous usage analytics」を
参照してください。ブックマーク本文・URL・ユーザー名などは一切送信しません。

送出済みのイベント名・パラメータ(`export_error`の`stage`/`reason`内訳を含む)
の一覧と、GA4管理画面でstage/reasonをカスタムディメンションとして登録し
探索レポートで内訳を確認する手順は
[`docs/analytics.md`](analytics.md) にまとめています。

## 1. GA4 プロパティとデータストリームの作成

すでにお持ちの場合はスキップしてください。

1. [Google Analytics](https://analytics.google.com/) でプロパティを作成
2. データストリームとして「ウェブ」を追加し、ストリーム URL には
   GitHub リポジトリの URL など、任意の識別用URLを設定
3. 発行された **測定ID**(`G-XXXXXXXXXX` の形式)を控える

## 2. Measurement Protocol の API シークレットを発行

1. GA4 管理画面 → **データストリーム** → 対象ストリームを選択
2. 下部の **「Measurement Protocol の API シークレット」** →
   「作成」
3. 発行された **シークレット値**を控える(この画面でしか全体を確認できません)

## 3. ローカルの `analytics-config.js` に設定

`analytics-config.js` はプレースホルダー(空文字)としてコミットされています。
実際の値を書き込んでも **絶対にコミットしない**ように、まず
`git update-index --skip-worktree` を設定してからローカルの値を書き換えます。

```bash
git update-index --skip-worktree analytics-config.js
```

その後、`analytics-config.js` を編集します。

```js
self.__ANALYTICS_CONFIG__ = {
    measurementId: 'G-XXXXXXXXXX',
    apiSecret: 'your-measurement-protocol-secret'
};
```

- `measurementId` / `apiSecret` のどちらかが空文字のままだと、
  `analytics.js` の `sendEvent` は何もしません(送信自体がスキップされる)。
  そのため **`git clone` した直後は誰の環境でも解析は無効**です。
- `skip-worktree` を戻したい場合は
  `git update-index --no-skip-worktree analytics-config.js` を実行してください。

## 4. ストア用ZIPを作成

```bash
./scripts/package-for-store.sh
```

このスクリプトはローカルの `analytics-config.js`(実際の値が入ったもの)を
そのままZIPに含めます。値が空のままだと警告が表示されます。

## 5. 日次自動改善レポートへの取り込み(任意)

`reports/YYYY-MM-DD.md` に、GA4の匿名利用状況(過去7日のアクティブユーザー数・
イベント数)を追加で表示できます。これには GA4 Data API 用の**別の**認証情報
(サービスアカウント)が必要です。Measurement Protocol のAPIシークレットとは
別物です。

1. [Google Cloud Console](https://console.cloud.google.com/) で、GA4プロパティに
   紐づけたい任意のプロジェクトを選択(なければ新規作成)
2. **APIとサービス → ライブラリ** で **Google Analytics Data API** を有効化
3. **APIとサービス → 認証情報 → 認証情報を作成 → サービスアカウント** で作成
4. 作成したサービスアカウントの **キー → 鍵を追加 → 新しい鍵を作成(JSON)** で
   JSON鍵をダウンロード
5. GA4管理画面 → **プロパティのアクセス管理** → 「+」→
   サービスアカウントのメールアドレス(`xxx@yyy.iam.gserviceaccount.com`)を
   **閲覧者** 権限で追加
6. ダウンロードしたJSON鍵から `client_email` と `private_key` を取り出し、
   GA4プロパティの数値ID(`GA4_PROPERTY_ID`。管理画面の「プロパティの詳細」に
   表示される番号。ストリームIDや測定IDとは別物)と合わせて設定:
   - ローカル: `.env` に `GA4_PROPERTY_ID` / `GA4_SERVICE_ACCOUNT_EMAIL` /
     `GA4_SERVICE_ACCOUNT_PRIVATE_KEY`(`private_key`の値をそのまま。改行は
     `\n`のままでも実際の改行でもどちらでも動作します)を設定
   - CI: リポジトリの **Settings → Secrets and variables → Actions** に同名の
     Secretを登録

いずれも未設定の場合、この節は自動的に「Not configured」と表示されるだけで、
他のレポート生成やIssue作成には影響しません。

## 既知の制約

- **APIシークレットはビルド成果物(配布ZIP)に平文で含まれます。**
  MV3拡張機能はサーバーを持たないため、Measurement Protocol を使う限り
  この制約は避けられません。漏えいしても影響はGA4プロパティへの
  スパムイベント送信程度に限られ、ユーザーのブックマークデータや
  個人情報には影響しません。
- **アンインストールイベントは計測していません。** Chrome の
  `chrome.runtime.setUninstallURL` は単純なページ遷移(GET)しかできず、
  GA4 Measurement Protocol が要求するJSON POSTを送れないため、
  バックエンドを持たないこの構成では信頼できる形で実装できません。
- 自動改善サイクル(`docs/automation.md`)は現時点でGA4のデータを
  日次レポートに取り込んでいません。取り込むには GA4 Data API 用の
  サービスアカウントなど別の認証情報が必要になるため、今後の拡張候補と
  してここに記載するに留めます。
