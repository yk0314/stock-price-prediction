# 10銘柄 疎通テスト 実行手順書

このドキュメントは、Phase 1の最小構成（10銘柄）で
`J-Quants → raw → normalized → features → screening → Gemini → ranking → KV → Workers API → Pages`
のデータフローが実際に動くことを確認するための手順です。

**この手順はお手元（ローカルPCまたはGitHub上）で実行してください。** APIキーやCloudflareの認証情報を私（Claude）に共有する必要はありません。実行結果（件数・ログ・エラーメッセージなど、キーを含まない情報）を教えていただければ、内容を確認します。

---

## 事前準備（まだの場合）

1. J-Quantsダッシュボードで **Free** プランのAPIキーを発行
2. Google AI Studio（https://aistudio.google.com/）で、**新しいプロジェクト**を選んでAPIキーを発行
   （既存の課金アカウント紐付きプロジェクトは絶対に選ばないこと）
3. Cloudflareアカウントを用意し、以下を取得
   - Account ID
   - Workers KVの編集権限のみを持つAPIトークン
4. Cloudflare KV Namespaceを作成
   ```bash
   npx wrangler login
   npx wrangler kv namespace create STOCK_KV
   ```
   出力される `id` を `worker/wrangler.toml` の `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` に反映してください。

---

## 5. GitHubへpush

```bash
cd jp-stock-ai-app
git remote add origin <あなたのリポジトリURL>
git branch -M main
git push -u origin main
```

その後、GitHubリポジトリの **Settings → Secrets and variables → Actions** で以下を登録してください（値は入力するだけで、どこにも表示・ログ出力されません）。

- `JQUANTS_API_KEY`
- `GEMINI_API_KEY`
- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`
- `CF_KV_NAMESPACE_ID`

**確認事項**: pushが成功したこと（コミットハッシュ・ブランチ名）。

---

## 6. Cloudflare Workersをデプロイ

```bash
cd worker
npx wrangler deploy
```

成功すると `https://jp-stock-ai-app-api.<あなたのサブドメイン>.workers.dev` のようなURLが出力されます。

**確認事項**: デプロイ成功メッセージと発行されたWorkers URL。

---

## 7. Cloudflare Pagesをデプロイ

`public/app.js` の `API_BASE` を、手順6で得たWorkers URLに書き換えてから:

```bash
cd public
npx wrangler pages deploy . --project-name=jp-stock-ai-app
```

**確認事項**: デプロイ成功メッセージと発行されたPages URL。

---

## 8. GitHub Actionsのworkflow_dispatchを実行

GitHubリポジトリの **Actions → JP Stock AI Pipeline → Run workflow** から手動実行してください。
`cutoffDate` は空欄のままでOKです（自動計算されます）。

実行中、以下のログが出力されます（抜粋）。

```
[pipeline] cutoffDate = YYYY-MM-DD (source: auto)
[jquants] YYYY-MM-DD: N件取得
[jquants] 取得完了: 対象X日中 Y日が0件（休日等） / 合計Z件
[pipeline] raw data: Z件（全銘柄・複数日分）
[pipeline] normalized data: N件 / M銘柄
[pipeline] ユニバースフィルタ後: 10銘柄 (mode=phase1_subset)
[pipeline] features: N銘柄で計算成功
[pipeline] screening: pool=N件 / Gemini対象=N件
[pipeline] gemini: N/M件で分析成功
[pipeline] 完了。KVへの保存まで正常終了しました。
```

**確認事項**:
- ジョブが成功（緑）か失敗（赤）か
- 上記ログの各件数（J-Quants取得件数・normalized件数・features件数・screening件数・Gemini成功/失敗件数）
- workflow artifact（`pipeline-data-<run_id>`）内の `raw-data.json` を1件だけ確認し、
  実際のカラム名が `src/normalize.js` の `CANDIDATE_KEYS` の想定と一致しているか
  （一致していない場合は教えてください。`normalize.js` を実レスポンスに合わせて修正します）
- Gemini呼び出しで429が発生した場合、その銘柄がリトライされずスキップされていること（ログに
  `無料枠上限/レート制限 (429)` と出ていればOK。有料モデルへの切替は一切発生しません）

---

## 9〜12. データフロー・KV・Workers API・Frontendの確認

### KVの確認

```bash
npx wrangler kv key list --namespace-id=<CF_KV_NAMESPACE_ID>
npx wrangler kv key get "meta" --namespace-id=<CF_KV_NAMESPACE_ID>
```

`meta`の中身に `cutoffDate` / `predictionExecutedAt` が入っていることを確認してください。
また `analysis:<code>` のいずれか1件を取得し、`cutoffDate` / `dataAsOf` / `predictionExecutedAt` が
銘柄ごとに保存されていることを確認してください（12番の確認事項）。

### Workers APIの確認

```bash
curl https://jp-stock-ai-app-api.<サブドメイン>.workers.dev/api/meta
curl https://jp-stock-ai-app-api.<サブドメイン>.workers.dev/api/ranking
curl https://jp-stock-ai-app-api.<サブドメイン>.workers.dev/api/stocks
curl https://jp-stock-ai-app-api.<サブドメイン>.workers.dev/api/stocks/7203
curl https://jp-stock-ai-app-api.<サブドメイン>.workers.dev/api/stocks/7203/prices
curl https://jp-stock-ai-app-api.<サブドメイン>.workers.dev/api/stocks/7203/analysis
```

6つ全てが200かつ空でないJSONを返すか確認してください（`analysis`はスクリーニングで候補に
選ばれなかった銘柄の場合404が正常です）。

### Frontendの確認

Pages URLをブラウザで開き、
- 上部にcutoffDate等のメタ情報が表示されるか
- ランキングセクションに銘柄が表示されるか
- 銘柄コード検索で詳細が表示されるか
- 各カードに `cutoffDate` / `dataAsOf` / `predictionExecutedAt` と、確率が定性評価である旨の注記が
  表示されているか

を確認してください。

---

## 13. Geminiの厳守事項の確認

Actionsのログで以下を確認してください。

- 呼び出しモデル名が `src/config.js` の `GEMINI.model`（`gemini-3.5-flash`）のみであること
  （ログにモデル名は出力していませんが、コード上他のモデルへは切り替わりません）
- 429が発生した銘柄について `リトライしません` という文言がログに出ており、実際に複数回呼ばれていないこと
- 有料プランへの切り替えを促すエラー（課金設定を求めるメッセージ）が出ていないこと

---

## 報告していただきたい内容

このドキュメントの各ステップを実行後、以下を（**キーを含めずに**）教えてください。

- 5〜8: push結果 / Workersデプロイ結果 / Pagesデプロイ結果 / Actions実行結果（成功/失敗）
- J-Quants取得件数・normalized件数・features件数・screening件数・Gemini成功/429/失敗件数
- KV保存結果（`meta`の中身、`analysis:<code>`のサンプル1件）
- Workers APIの6エンドポイントの応答結果
- Pagesでの表示確認結果
- 発生したエラーがあればそのメッセージ全文（キー部分は伏せてください）
