# 日本株AI予測Webアプリ

日本株の株価・テクニカル指標・市場環境(TOPIX)・財務情報から、Gemini が銘柄ごとに評価(スコア・期待リターン・リスク)を出し、
ランキング・保有銘柄の再評価・売買履歴と損益の管理までを一つにしたWebアプリです。
数日〜1週間程度の保有を想定した、短期売買の**判断支援ツール**です。

> **重要**: AIの評価やバックテストの成績は、実運用での利益を保証しません。
> このアプリは自動売買をしません。「SBI発注補助」は注文内容のコピー用テキストを作るだけで、証券口座への接続や注文の実行は一切行いません。
> 売買手数料・スリッページ・約定タイミングの影響は、現時点の検証には含まれていません。

---

## 1. 全体構成

```
J-Quants API ─┐
              ├─▶ GitHub Actions ──▶ Cloudflare D1  (株価・銘柄マスタ・TOPIX・AI評価・財務・売買履歴・書き込み台帳)
Gemini API ───┘     │            └─▶ Cloudflare KV  (表示用データ: meta / ranking / stocks / analysis:* / prices:* / history:*)
                    │
                    ├─ pipeline.yml      平日 17:00 JST   特徴量 → スクリーニング → Gemini評価 → ランキング
                    ├─ sync-prices.yml   毎日 18:30 JST   全銘柄の日足・TOPIX・銘柄マスタをD1へ差分で蓄積
                    ├─ screening-backtest.yml  手動実行のみ  スクリーニングスコアの検証(Geminiは使わない)
                    └─ backtest-d1.yml  手動実行のみ  D1のAI評価と株価から、評価後の値動きを測る(D1は読み取りのみ)

Cloudflare Workers (worker/) : D1とKVを読むAPI + 売買履歴の登録・編集・取消API
public/ (Cloudflare Pages)   : ホーム / ランキング / 保有銘柄 / 売買履歴(株価チャート・SBI発注補助を含む)
```

| 要素 | 役割 |
|---|---|
| J-Quants API(有料プラン) | 銘柄マスタ・日足・取引カレンダー・TOPIX・財務情報。設定上の既定プランは `light`(`JQUANTS_PLAN`で変更可) |
| Gemini API | 1銘柄=1リクエストでAI評価。モデルは `src/config.js` の `GEMINI.model` |
| GitHub Actions | 重い処理(取得・特徴量計算・スクリーニング・Gemini呼び出し・D1への蓄積)はすべてここで実行 |
| Cloudflare D1 | 永続データ(`migrations/` 参照)。Actionsからは REST API、Workers からはバインディング(`DB`)で使う |
| Cloudflare KV | 画面表示用のデータとバックテスト用の履歴。Workers はバインディング `STOCK_KV` で読む |
| Cloudflare Workers | 軽量なAPI層(`worker/`)。CPU時間制限があるため、重い処理は持たない |

## 2. ディレクトリ構成

```
.github/workflows/   pipeline.yml / sync-prices.yml / screening-backtest.yml
migrations/          D1のスキーマ(0001〜0005)
scripts/
  sync-prices.js     株価・銘柄マスタ・TOPIXをD1へ蓄積するジョブ(sync-prices.yml が実行)
  backtest-d1.js     D1のAI評価と全銘柄の日足から、評価後の値動きを測る読み取り専用のバックテスト(backtest-d1.yml が実行)
  probe-jquants.mjs  契約プランで使えるAPI・データ範囲を調べる読み取り専用スクリプト
  update-unit-tests.mjs  test/unit.test.js を更新した際の一回限りのパッチ(通常は使わない)
src/
  pipeline.js        日次パイプライン本体(エントリーポイント)
  config.js          すべての設定値(閾値・予算・Gemini設定など)。環境変数で上書きできるものもある
  jquants.js / cutoff.js / tradingCalendar.js / marketDataService.js   J-Quants取得・データ基準日の判定
  normalize.js / listedInfo.js / universe.js   正規化・銘柄マスタ・対象銘柄(ユニバース)の絞り込み
  features.js / indicators.js / market.js / financials.js / screening.js   特徴量・スクリーニング
  gemini.js          Gemini呼び出し(リトライ・出力検証・レート制限対策)
  d1.js / d1Sync.js / d1Repository.js / d1Budget.js / pipelineD1.js   D1への読み書き・差分蓄積・書き込み予算
  kv.js / artifacts.js   KVへの保存・中間データ(data/)の保存
  backtest.js / analysis.js / backtest-run.js / screening-backtest.js   バックテスト・分析(KVの履歴・30営業日後が前提の旧来のもの)
  backtestD1.js      D1のデータで評価後の値動きを測る純粋関数群(1・3・5営業日。scripts/backtest-d1.js から使う)
  orderAssist.js     発注補助の計算(株数・注文内容のテキスト)
worker/              Cloudflare Workers の API(wrangler.toml / src/index.js / src/tradeLogic.mjs)
public/              フロントエンド(index.html / app.js / style.css)
test/                テスト(`npm test`)
TESTING.md           Phase 1 当時の疎通確認の手順書(Freeプラン・10銘柄が前提で、現状とは異なる部分がある)
```

外部のnpmパッケージは使っていません(Node.js 標準の `fetch` など)。

## 3. 日次パイプライン(`src/pipeline.js`)

実行すると次の順に処理し、各段階の中間データを `data/` にJSONで保存します(Actionsでは artifact として14日間保存)。

1. 取引カレンダーと、J-Quantsで実際に取得できる**最新の取引日(データ基準日 = cutoffDate)**を判定する。固定の遅延日数は使わない。
2. 基準日までの約2か月分(約41営業日)の日足を、**日付ベースで一括取得**する(銘柄ごとのループはしない)。
3. 上場銘柄一覧(銘柄名・市場区分)を取得し、D1の `stocks` に差分同期する(今日のD1の残り書き込みが少ないときは省略)。
4. 正規化し、ユニバースを絞り込む(次章)。
5. 特徴量(テクニカル指標・TOPIXに対する相対強度)を計算する。
6. 数値スクリーニングで**候補プール**(既定150件)を作る。
7. 保有銘柄(D1の売買履歴から算出)のうち、候補に入っていないものを再評価対象として追加する。
8. 財務情報を、Gemini対象の銘柄にだけ取得する(全銘柄分は取得しない)。
9. KV と D1 に、Gemini処理の**前に**銘柄・株価・財務を保存する。
10. Gemini で**1銘柄=1リクエスト**の評価を行い、成功した評価を銘柄ごとに即時にD1へ保存する。保有銘柄は、通常候補と重複するものも含めて先頭にまとめて評価する(途中で打ち切られても、保有銘柄の再評価が漏れにくいようにするため)。
11. スコア順の最終ランキング(`FINAL_RANKING_SIZE` 件)を作り、KV に保存する。
12. 終了時に、この実行の書き込み行数をD1の台帳に加算する。

ログの最後のGemini集計行(`[pipeline] gemini: 送信N件 → 成功 / 除外(買う価値なし) / 失敗 / 未処理`)で、結果の内訳が分かります。
成功・除外・失敗・未処理の合計は、常に送信数と一致します。

### 評価件数が候補数(150件)に届かない理由

Gemini が新規候補を「買う価値なし」(`tradeable=false`)と判定した銘柄は、**エラーではなく「除外」**として扱われ、D1には保存されません。
そのため、毎日の保存件数は、送った件数より少なくなります(保有銘柄の再評価は除外されません)。
失敗(429・503・出力検証エラーなど)と未処理(1回の実行のリクエスト上限や、429の連続による安全停止)は、除外とは別に数えます。

## 4. 全銘柄モードと対象銘柄

| 用語 | 意味 | 設定 |
|---|---|---|
| ユニバース | 特徴量計算・スクリーニングの対象にする範囲 | `UNIVERSE_MODE`、`UNIVERSE_MARKETS` |
| 候補プール | スクリーニングで残す上位N件 | `SCREENING_POOL_SIZE`(既定150) |
| AI評価対象 | プールのうちGeminiに渡す件数(+保有銘柄の追加分) | `GEMINI_MAX_STOCKS`(既定150) |

この3つは独立した設定で、同じ数字(150)が並んでいても連動しません。

- `UNIVERSE_MODE=all`(全銘柄): J-Quantsの全銘柄のうち、`UNIVERSE_MARKETS`(既定: プライム・スタンダード・グロース)に該当するものが対象です。ETF・REIT等(その他)や TOKYO PRO MARKET は除外されます。`UNIVERSE_MARKETS=ALL` で絞り込みなしにできます。
- `UNIVERSE_MODE=phase1_subset`: `src/config.js` の `STOCK_UNIVERSE`(10銘柄)だけが対象です(開発・テスト用)。
- GitHub Actions では、**定時実行(schedule)は `all`**、手動実行の `universeMode` の既定は `phase1_subset` です。手動で全銘柄を動かすときは `all` を選んでください。
- 銘柄コードは、英字を含む新しいコード(例: `135A`)も、株価・銘柄マスタ・財務で同じ4桁形式(`toShortCode`)に揃えて扱います。

## 5. 株価・銘柄マスタ・TOPIXの同期(`scripts/sync-prices.js`)

バックテスト用に、全銘柄の日足・TOPIX・銘柄マスタをD1へ**差分**で蓄積します(パイプラインの動作には必須ではありません)。

1. 取引カレンダーと最新の取引日を判定する。
2. 銘柄マスタ(全銘柄)を `stocks` に同期する(新規・名称や市場区分の変更があった銘柄だけ書く)。
3. 未蓄積の取引日だけを、新しい日付から `stock_prices` に書く。全銘柄分の書き込みが終わった日付だけを `price_sync_dates` に記録するため、途中で止まっても再開でき、重複しません。初回の過去分(既定730日)は、予算の範囲で数日〜数十日かけて埋まります。
4. 直近に株式分割等(調整係数が1以外)があった銘柄は、履歴を再取得して調整後株価の基準を揃える。
5. TOPIXを `index_prices` に蓄積する。

- 書き込み予算が足りないときは、**古い日付から予算内の行だけ**を書き、残りは次回に回します(株価もTOPIXも同じ考え方)。
- D1の書き込み上限(`D1QuotaError`)に達したときは、銘柄マスタ・株価・TOPIXのどの段階でも、「続行」せずにそこで安全に終了します(蓄積済みの分は保存され、残りは次回以降。ジョブは失敗扱いにしません)。それ以外の取得失敗(403・一時的なエラーなど)は、従来どおり警告を出して続行します。

## 6. D1の書き込み予算の管理

Cloudflare D1 の無料枠は「アカウント全体で書き込み1日10万行」で、**UTCの0時(日本時間9時)にリセット**されます。上限ぎりぎりまで使うと保存に失敗するため、余裕を持たせた予算で管理します。

- 各ジョブ(pipeline・sync-prices・手動実行)は、終了時に自分の書き込み行数を `d1_write_ledger` に加算します。次のジョブは、今日(UTC)の使用量を台帳から読んで予算を決めます。台帳が読めない(migration未適用など)ときは、設定値だけで動き、ジョブは止まりません。
- 書き込み行数は、D1が返す `meta.rows_written`(索引の更新を含む)の積算です。
- 台帳の日付は、ジョブの**開始時刻**のUTC日で決まります。UTC 0時をまたぐ長い実行では、0時以降の書き込みも開始日の分として数えられます。

| 設定(環境変数) | 既定 | 意味 |
|---|---|---|
| `D1_DAILY_WRITE_TOTAL` | 85000 | 1日(UTC)に使ってよい書き込み行数の合計 |
| `D1_DAILY_WRITE_BUDGET` | 60000 | sync-prices が1回の実行で使える行数の上限 |
| `D1_RESERVE_FOR_PIPELINE` | 10000 | sync-prices の実行後も、pipeline のために残しておく行数 |
| `D1_PIPELINE_MIN_REMAINING` | 15000 | 今日の残りがこれを下回ると、pipeline は必須ではない書き込み(銘柄マスタ同期・プール銘柄の株価)を省略する |

ワークフローに配線されているのは `D1_DAILY_WRITE_BUDGET` だけです(7章)。他の3つは、Variables に登録しても反映されず、`src/config.js` の既定値で動きます(変える場合は、`config.js` を編集するか、ワークフローの `env:` に配線します)。

sync-prices の予算 = `min(D1_DAILY_WRITE_BUDGET, D1_DAILY_WRITE_TOTAL − 今日の使用量 − D1_RESERVE_FOR_PIPELINE)`。
このうち、銘柄マスタで使った分と、後続(株式分割の再取得・TOPIX)のための余裕3,000行(コード内の定数)を引いた残りを株価に使います。

## 7. GitHub Actions の設定

**Settings → Secrets and variables → Actions** に登録します。

### Secrets

| Secret | 用途 |
|---|---|
| `JQUANTS_API_KEY` | J-Quants APIキー |
| `GEMINI_API_KEY` | Gemini APIキー(Google AI Studio で発行) |
| `CF_ACCOUNT_ID` | CloudflareのアカウントID |
| `CF_API_TOKEN` | Cloudflare APIトークン(KVとD1の編集権限が必要。コードが両方のREST APIを使う) |
| `CF_KV_NAMESPACE_ID` | 結果を保存するKV NamespaceのID |
| `CF_D1_DATABASE_ID` | D1データベースのID |

### Variables(任意。未設定なら `src/config.js` の既定値)

**ワークフローの `env:` に配線されている変数だけが実行時に反映されます。** 下表以外の環境変数は、`config.js` が読んでいても、Variables に登録しただけでは反映されません(反映するには `.github/workflows/*.yml` に配線が必要です)。

| Variable | 使うワークフロー | 意味 |
|---|---|---|
| `JQUANTS_PLAN` | pipeline / sync-prices | `free` / `light` / `standard` / `premium`(既定 `light`)。プランごとのリクエスト間隔になる |
| `UNIVERSE_MARKETS` | pipeline | 全銘柄モードの対象市場(カンマ区切り。`ALL`で絞り込みなし) |
| `SCREENING_POOL_SIZE` | pipeline | 候補プールの件数(既定150) |
| `GEMINI_MAX_STOCKS` | pipeline | Geminiで評価する件数(既定150) |
| `GEMINI_REQUEST_INTERVAL_MS` | pipeline | 1銘柄ごとの待機時間(既定30000)。0や空は既定に戻る |
| `GEMINI_MAX_RETRIES` | pipeline | 429・503のリトライ回数(既定2) |
| `GEMINI_RETRY_BACKOFF_BASE_MS` | pipeline | 503のバックオフの基準(既定15000。指数で伸びる) |
| `GEMINI_429_BACKOFF_MS` | pipeline | 429の待機時間(既定45000。`Retry-After` があればそちらを優先) |
| `GEMINI_CONSECUTIVE_429_LIMIT` | pipeline | 429が連続したらGemini処理を安全停止する回数(既定5) |
| `GEMINI_DAILY_REQUEST_LIMIT` | pipeline | **1回の実行あたり**のGeminiリクエスト上限(既定300。名前は daily だが、実行ごとに数える) |
| `PRICE_SYNC_LOOKBACK_DAYS` | sync-prices | 何暦日前から蓄積するか(既定730) |
| `D1_DAILY_WRITE_BUDGET` | sync-prices | 1回の実行で使うD1書き込み行数の上限(既定60000) |

### 実行方法

- **pipeline.yml**(JP Stock AI Pipeline): 平日 17:00 JST(08:00 UTC)に自動実行。手動は Actions → Run workflow。入力: `cutoffDate`(空欄なら最新の取引日を自動判定)、`universeMode`(`phase1_subset` / `all`)。タイムアウト240分。1回の実行は、Gemini の待機時間(既定30秒 × 約155銘柄)のため、約90分かかります。
- **sync-prices.yml**(Sync Prices): 毎日 18:30 JST(09:30 UTC)に自動実行。手動の入力: `lookbackDays`、`writeBudget`。タイムアウト60分。
- **backtest-d1.yml**(JP Stock AI Backtest (D1)): 手動のみ。入力: `from`(この基準日以降の評価だけを使う)、`horizons`(保有日数。既定 1,3,5)、`costPct`(往復コスト%。既定0)、`top`(毎日の上位N件。既定10)、`maxStaleDays`(評価の基準日が、生成された日よりこの日数より前のものは除外。既定5)、`scoreCuts`(スコアの水準を分ける区切り。既定 62,68,72)、`exitAt`(売る価格。`open` が既定、`close` は比較用)。D1には読み取りだけを行い、結果は実行サマリと artifact(`data/backtest-d1.json`)に出る。
- **screening-backtest.yml**: 手動のみ。`node test/unit.test.js` と `node src/screening-backtest.js` を実行する(J-Quantsだけを使い、Gemini・Cloudflareは使わない)。
- pipeline と sync-prices は同じ `concurrency` グループで、同時には走りません(D1への書き込みが重ならないようにするため)。待機中の後続は、実行中のものを中断せず順番に実行されます。
- Actionsのランナーは Node 20 です。

### 公開リポジトリでの運用上の注意

このリポジトリは公開設定です。Actionsのログと、`data/` の artifact(14日保持)は、第三者から閲覧できます。
ログにはGeminiに送った銘柄コードが出ます(保有銘柄の再評価では `isHeld=true`)。APIキー等は Secrets で管理され、ログではマスクされます。

## 8. データベースのマイグレーション(Cloudflare D1)

`migrations/` を**番号順に、各ファイルを1回だけ**適用します。

| ファイル | 内容 |
|---|---|
| `0001_init.sql` | `stocks` / `stock_prices` / `financials` / `ai_evaluations` / `trades` / `error_logs` |
| `0002_add_risk_and_holding_days.sql` | `ai_evaluations` に `risk`・`expected_holding_days` を追加 |
| `0003_add_trades_canceled_at.sql` | `trades` に `canceled_at` を追加(取引の取消用) |
| `0004_jquants_paid_data_foundation.sql` | `stock_prices` に `adj_factor`・`turnover` を追加、冗長な索引の削除、`price_sync_dates`・`index_prices` の作成。**sync-prices の前提** |
| `0005_d1_write_ledger.sql` | `d1_write_ledger`(書き込み台帳)の作成。未適用でもジョブは動くが、ジョブをまたいだ予算管理は効かない |

```bash
# 本番(リモート)のD1に適用する例。ファイルごとに1回だけ実行する
npx wrangler d1 execute jp-stock-ai-app-db --remote --file=./migrations/0005_d1_write_ledger.sql
```

**注意**:
- `--remote` を付けると、本番のデータベースが対象です。付けないとローカルの開発用DBが対象になります。
- `0002`〜`0004` は `ALTER TABLE ... ADD COLUMN` を含み、**再実行するとエラー**になります(`0004` には `DROP INDEX` も含まれます)。適用済みかどうかを確認してから実行してください。
- 実行前に、バックアップを取ることを推奨します: `npx wrangler d1 export jp-stock-ai-app-db --remote --output=backup.sql`。出力される `.sql` はリポジトリにコミットしないでください。
- データベース名・バインディングは `worker/wrangler.toml`(`DB`)で確認できます。

## 9. Workers API とフロントエンド

Workers(`worker/`)のデプロイ: `cd worker && npx wrangler deploy`
フロント(`public/`): `public/app.js` の `API_BASE` をWorkersのURLに合わせ、`cd public && npx wrangler pages deploy . --project-name=<プロジェクト名>`(手順は `TESTING.md` の6・7章も参照)

| エンドポイント | 内容 |
|---|---|
| `GET /api/meta` | 直近の実行のメタ情報(cutoffDate・実行日時など) |
| `GET /api/ranking` | 「今日のランキング日」の最新の実行のAI評価を、score降順で返す(D1。`?limit=`、上限100)。ランキング日は日本時間17:00で切り替わる |
| `GET /api/stocks` / `/api/stocks/:code` / `/prices` / `/analysis` / `/evaluations` | 銘柄一覧・詳細・株価・最新のAI評価・評価履歴 |
| `POST /api/trades` / `PUT /api/trades/:id` / `POST /api/trades/:id/cancel` | 売買の登録・編集・取消 |
| `GET /api/trades` / `/api/trades/summary` / `/api/holdings` | 売買履歴(移動平均法の損益)・通算成績・保有銘柄 |
| `GET /api/backtest` | KVの `backtest-summary`(未生成なら空) |
| `GET /api/diagnostics/d1` | D1の疎通確認(自己完結の書き込みテストを含む。本番データは汚さない) |

画面は、ホーム・ランキング・保有銘柄・売買履歴で、株価チャートとSBI発注補助(購入株数・注文内容のコピー用テキスト)を含みます。

## 10. テスト

```bash
npm test
```

`node test/unit.test.js`(独自ランナー)と、`node --test` による次のテストを実行します: `trade-logic` / `order-assist` / `frontend-wiring` / `jquants-paid` / `d1-sync` / `worker-d1-fallback` / `d1-budget`。
外部ネットワークと本番データには触れません。D1はSQLiteで模擬します。

- D1を模擬するテストは `node:sqlite` を使うため、**Node 22.5以上**が必要です。それ未満では該当のテストはスキップされます。
- `package.json` のテストコマンドが正です。テストファイルを増やすときは `package.json` の `test` にも追加してください。

## 11. 実装状況

### 実装済み

- J-Quantsからの取得(最新取引日の動的判定・429/5xxのリトライ)、全銘柄の日足・TOPIX・銘柄マスタのD1への差分蓄積と、株式分割後の履歴の補正
- 全銘柄モード(市場区分によるユニバース絞り込み)、数値スクリーニング、Geminiによる1銘柄=1リクエストの評価(出力検証・429/503のリトライ・連続429での安全停止)
- 保有銘柄の毎日の再評価、ランキング、評価履歴(`ai_evaluations` は追記専用)
- 売買履歴の登録・編集・取消、移動平均法による損益・通算成績、SBI発注補助(コピー用テキスト)
- D1書き込み予算の台帳管理と、上限到達時の安全な停止

### 未実装・未完成

- **バックテスト**: D1のAI評価と全銘柄の日足を使う `backtest-d1.yml` があります(基準日の翌営業日の始値で買い、保有日数(1・3・5営業日)後の始値で売る。日中に取引できず、夜か朝に注文して寄り付きで約定する使い方に合わせた既定で、`exitAt` を `close` にすると、保有日数目の終値で売る場合も測れる。往復コストを指定すると、控除後の成績も出る)。有料プランへ移行する前に生成された評価は、約3か月前のデータに基づいていたため、`maxStaleDays` で除外します。出力は、スコアの水準別(固定の区切り。最上位の水準 − それ以外)・スコア帯別・rating別・TOPIXとの差と、毎日のスコア上位N件 − 全件平均です。Geminiのスコアは特定の値に集中して同点が多いため、上位N件の境目の同点は無作為に選んだ期待値で計算し、中央値・外れ値を丸めた平均・値動きの大きさ(直近20日の実現ボラティリティ)をそろえた無作為なN件との差・全件から無作為にN件選んだ場合との比較(p値)を併記します。スコアと成績の順位相関は、上昇確率・期待リターン・確信度・下落リスクについても出します(95%信頼区間は日を単位にしたブートストラップ)。**対象は、有料プランへ移行した後(10月5日以降)の評価で、期間が短く相場環境が限られるため、結果は参考値です**(件数が増えるごとに再計測します)。「買う価値なし」と判定された銘柄は、D1に保存されないため、その判定は測れません。従来の `backtest.js`・`backtest-run.js`(KVの履歴から30営業日後の実績を計算)を動かすワークフローは、現在のリポジトリにありません。手数料・スリッページは、利用者が指定する値(既定0%)で、実際の約定は確認していません。
- AI評価の精度が改善したという根拠は、まだありません(バックテストで検証してから判断する)。
- 「買う価値なし」と判定された銘柄の記録は残りません(D1に保存しない仕様)。
- 失敗や障害を知らせる、アプリ独自の通知機能はありません。
- 財務情報はGemini対象の銘柄にだけ取得します(全銘柄分は取得しません)。
- 証券口座との連携・自動売買はありません。

## 12. 運用時の注意

- Geminiの無料枠のレート制限(RPM・RPD)はモデルごとに異なります。`GEMINI_REQUEST_INTERVAL_MS` を短くする前に、Google AI Studio の Rate Limits で確認してください。短縮後は、Geminiの集計行の `429=` が増えていないかを見ます。
- D1の無料枠を超えると、書き込みが止まります。`D1_DAILY_WRITE_TOTAL` の既定(85000)を引き上げるのは、Cloudflareの契約を変更したときだけにしてください。
- J-Quantsの契約プランは `scripts/probe-jquants.mjs` で、使えるAPIとデータ範囲を確認できます(読み取り専用。`JQUANTS_API_KEY` を環境変数に設定して実行します)。
