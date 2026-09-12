# 日本株AI予測Webアプリ Phase 1（最小構成）

「完全無料・課金ゼロ・無料枠超過時は自動停止（エラー）」を最優先にした、
J-Quants → 特徴量 → 数値スクリーニング → Gemini分析 → Cloudflare KV → Workers API → Pages
という一連のパイプラインの最小実装です。

まずは **少数銘柄（デフォルト設定ファイルで指定した数十銘柄程度）** で
パイプライン全体が正しく動くことを確認するのがゴールです。
全銘柄（約4,400銘柄）対応は、この最小構成が安定してから段階的に拡張してください。

---

## 0. 前提として確認した無料枠・課金条件（2026年9月時点）

実装前の確認結果をまとめます。**必ずご自身でも最新のダッシュボード表示を確認してください**（プラン条件は変更されることがあります）。

### J-Quants API（Free プラン）

- クレジットカード登録: 個人情報（メールアドレス・氏名・住所）の登録は必要ですが、支払い方法の登録は不要です（Freeプランは無料のまま）。
- データ遅延: **12週間遅延**。取得可能なのは常に「今日から84日以上前」のデータです。
- データ格納期間: 直近2年分（遅延を加味した2年分）
- レートリミット: **5リクエスト/分**（超過時は429エラー。自動課金にはなりません）
- 認証: V2 APIキー方式。ダッシュボードで発行したキーを `x-api-key` ヘッダーで送信
- ベースURL: `https://api.jquants.com/v2/`
- 主なエンドポイント（V2）:
  - 株価四本値: `GET /v2/equities/bars/daily`（`code`または`date`のいずれか必須。`date`のみ指定でその日の全銘柄分を取得可能。大量データ時は`pagination_key`でページング）
  - 上場銘柄一覧: `GET /v2/equities/master`
  - 財務情報: `GET /v2/fins/summary`
  - 財務諸表詳細: `GET /v2/fins/details`
  - 取引カレンダー: `GET /v2/markets/calendar`
- ⚠️ Bulk API（`/v2/bulk/list`, `/v2/bulk/get`によるCSV一括ダウンロード）はFreeプランで使えない可能性があります（情報源により記載が異なるため、ダッシュボードで確認してください）。本実装では通常のAPIエンドポイント（`date`指定の一括取得）のみを使用し、Bulk APIは使っていません。

**課金リスク**: 支払い方法自体を登録しないため、レート制限超過時はAPIが429エラーを返して止まるだけで、自動課金は発生しません。

### Gemini API（Free tier）

- **必ず Google AI Studio （https://aistudio.google.com/）経由で、「新しいプロジェクトでAPIキーを作成」を選んでAPIキーを発行してください。**
  既存のGoogle Cloudプロジェクト（特に支払い設定＝課金アカウントが紐付いたプロジェクト）を選んでAPIキーを発行すると、無料枠を超えた時点で自動的に課金される可能性があります。
- AI Studio経由で新規プロジェクトを作った場合はクレジットカード登録は不要で、無料枠を使い切ると単純にAPIがエラーを返して止まります（自動課金なし）。
- Flash系モデルを使用してください（Pro系は無料枠が1日25〜50件程度と非常に少なく、Phase 1の候補銘柄数と相性が悪いです）。
- 無料枠の入力データはGoogleのモデル改善に利用される場合があります。本アプリで扱うのは公開されている株価・財務データのみのため、Phase 1では大きな問題にはなりませんが、認識しておいてください。
- 具体的なレート制限（RPM/RPD/TPM）はモデルごとに変わるため、実装直前に https://aistudio.google.com/ のRate Limits表示で確認してください。

### Cloudflare（Workers / Pages / KV）

- Workers/Pagesは、`workers.dev`サブドメインでの公開であればクレジットカード登録なしで利用できます。
- Free プランの制限（リクエスト数、CPU時間、KV読み書き回数など）を超えた場合、**自動的に有料プランへ移行することはなく、429エラーでブロックされるだけ**です（手動でプランをアップグレードしない限り課金されません）。
- Workers Free の CPU時間制限（10ms/リクエスト）はかなり厳しいため、**重い処理（全銘柄データ取得・特徴量計算・スクリーニング・Gemini呼び出し）はCloudflare Workersでは行わず、GitHub Actions側で実行**します。Cloudflare Workersは「KVから読み出してJSONを返すだけ」の軽量なAPI層として使うため、CPU時間制限にはほぼ抵触しません。

### GitHub Actions

- 本プロジェクトは、**支払い方法（クレジットカード）を一切登録しない**ことを前提としています。
- 支払い方法未登録のGitHubアカウントでは、無料枠（プライベートリポジトリで月2,000分、パブリックリポジトリは無制限）を使い切ると、ワークフローの実行が単純に失敗するだけで、自動課金は発生しません。
- **さらに安全に倒すなら、このリポジトリをパブリックリポジトリにすることを推奨します。** パブリックリポジトリならActionsの実行時間は無条件で無料・無制限になります（本コードには非公開にすべき情報は含まれておらず、APIキー等はすべてGitHub Secretsで管理するため、リポジトリ自体を公開してもキーが漏れることはありません）。
- 最初は `workflow_dispatch`（手動実行）のみとし、安定してから日次の`schedule`トリガーを追加してください（このリポジトリの`.github/workflows/pipeline.yml`にコメントで追加方法を記載しています）。

---

## 1. 必要な GitHub Secrets

リポジトリの Settings → Secrets and variables → Actions で以下を登録してください。

| Secret名 | 内容 |
|---|---|
| `JQUANTS_API_KEY` | J-Quantsダッシュボードで発行したAPIキー |
| `GEMINI_API_KEY` | Google AI Studio（新規プロジェクト・課金アカウント紐付けなし）で発行したAPIキー |
| `CF_ACCOUNT_ID` | CloudflareアカウントID |
| `CF_API_TOKEN` | Cloudflare APIトークン（Workers KVの編集権限のみを付与したスコープ限定トークンを推奨） |
| `CF_KV_NAMESPACE_ID` | 結果を保存するCloudflare KV NamespaceのID |

## 2. ディレクトリ構成

```
jp-stock-ai-app/
├── .github/workflows/pipeline.yml   # GitHub Actions (手動実行 + 中間データartifactアップロード)
├── src/
│   ├── config.js         # 銘柄ユニバース・スクリーニング閾値・Geminiモデル名などの設定
│   ├── cutoff.js         # cutoffDate計算（手動指定 / 自動計算の両対応）
│   ├── jquants.js        # J-Quants APIクライアント（日付ベース一括取得＋pagination＋レート制御）
│   ├── normalize.js      # 生データ→共通スキーマへの正規化・銘柄コードごとのグルーピング
│   ├── features.js       # 正規化済みデータからの特徴量計算
│   ├── screening.js      # 数値スクリーニング（プール作成 → Gemini対象の選定を分離）
│   ├── gemini.js          # Gemini API呼び出し・JSON安全パース・429時は即スキップ（リトライなし）
│   ├── kv.js               # Cloudflare KVへの書き込み（表示用データ＋バックテスト用の追記履歴）
│   ├── backtest.js         # 【将来用】30営業日後の実績と予測を突き合わせる評価ロジック（未組み込み）
│   ├── artifacts.js        # 各段階の中間データ(JSON)をdata/に保存・読込するユーティリティ
│   └── pipeline.js         # 全体のオーケストレーション（エントリーポイント）
├── worker/
│   ├── wrangler.toml
│   └── src/index.js       # Cloudflare Workers API（/api/stocks, /api/ranking, /api/meta 等。KV読み出しのみ）
├── public/                 # Cloudflare Pages 用の最小フロントエンド
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/
│   └── unit.test.js        # 外部ネットワーク不要な範囲の単体テスト（`npm test`）
└── package.json
```

外部npmパッケージは一切使用していません（Node.js 18+ の標準`fetch`のみ使用）。GitHub Actionsの標準ランナー（Node 20系）でそのまま動作します。

## 3. パイプラインの処理段階（raw → normalized → features → screened → gemini → ranking）

`src/pipeline.js`は以下の順に処理し、各段階の結果を`data/`配下にJSONとして保存します（GitHub Actions上ではworkflow artifactとしてもアップロードされます）。

1. **raw-data.json**: J-Quantsから`cutoffDate`までの期間を**日付ベースで一括取得**（1銘柄ずつのループはしない。`pagination_key`を最後まで処理）
2. **normalized-data.json**: カラム名を共通スキーマ`{code, date, close, volume}`に正規化し、銘柄コードごとにグルーピング
3. ユニバースフィルタ（`config.UNIVERSE_MODE`）: Phase 1では`STOCK_UNIVERSE`の銘柄だけに絞り込み。将来`"all"`に変更するだけで全銘柄対応に切り替えられる
4. **features.json**: 特徴量計算（対象は上記フィルタ後のユニバース）
5. **screened.json**: `screenToPool()`でプール（`config.SCREENING.poolSize`件）を作成し、`selectGeminiCandidates()`でGemini対象（`config.GEMINI.candidateCount`件、初期値10）を選定
6. **gemini-results.json**: Gemini分析（対象は上記candidateCount件のみ）
7. **ranking.json**: スコア順に並べた最終ランキング

J-Quants取得・特徴量計算の対象数と、Geminiに分析させる対象数は明確に別の設定値（`SCREENING.poolSize`と`GEMINI.candidateCount`）で制御されます。

## 4. ローカル/Actions上での実行方法

```bash
npm test              # 単体テスト（ネットワーク不要）
node src/pipeline.js  # パイプライン本体（要: 環境変数 / Secrets）
```

`workflow_dispatch`の入力欄から`cutoffDate`を手動指定できます（未指定の場合は「実行日 − 90日」を自動計算して使用します）。

## 5. 動作確認の進め方

1. `npm test`で単体テストが通ることを確認する
2. GitHub Actionsの「Run workflow」を手動実行し、各ステップのログとworkflow artifact（`data/`配下のJSON）を確認する
   - 特に`raw-data.json`が0件でないか、`normalized-data.json`のカラムが正しく取れているかを確認する
   - 想定と異なる場合は`src/normalize.js`の`CANDIDATE_KEYS`を実際のレスポンスに合わせて修正する
3. Cloudflare KVに`meta` / `ranking` / `stocks` / `analysis:{code}` / `prices:{code}` / `history:{cutoffDate}:{code}`が書き込まれることを確認する
4. Cloudflare Workers（`worker/`をデプロイ）経由で`/api/meta`, `/api/ranking`, `/api/stocks`, `/api/stocks/:code`, `/api/stocks/:code/prices`, `/api/stocks/:code/analysis`が正しくJSONを返すことを確認する
5. `public/`をCloudflare Pagesにデプロイし、ブラウザから確認する（cutoffDate・dataAsOf・predictionExecutedAtが画面に表示されることを確認）
6. 問題なければ`STOCK_UNIVERSE`を段階的に拡大し、最終的に`UNIVERSE_MODE: "all"`への切り替えを検討する

## 6. データリーク防止の実装ポイント

- `src/cutoff.js`が計算する`cutoffDate`より新しい日付のデータは、`src/jquants.js`の取得結果から除外されます（`fetchDailyQuotesForDate`内でも多重にフィルタ）。
- 保存する予測結果（`src/kv.js`経由、`analysis:{code}`および`history:{cutoffDate}:{code}`）には、銘柄ごとに`cutoffDate`・`predictionExecutedAt`（実行日時）・`dataAsOf`（実際に使用した最新データの日付）をセットで記録します（**meta情報だけでなく、予測レコード自体に個別付与**）。
- `history:{cutoffDate}:{code}`はcutoffDateとcodeの組み合わせをキーにしているため、異なる時点の予測は別キーとして蓄積され、過去の予測を上書きすることはありません。
- 財務情報を将来利用する際は、決算期ではなく「市場に公開された日付」でcutoffDateとの比較を行うこと（現時点では財務特徴量は未実装のため、この原則はコードコメントとして記録するに留めています）。
- `src/backtest.js`は、予測生成に使ったデータ（cutoffDate以前）とは明確に別の「評価用の未来データ」を使って`hit`判定を行います。この2つのデータフローが混ざらないよう、モジュールを分離しています。

## 7. Phase 1残作業（未着手のもの）

- 日次自動実行（`schedule`トリガー）— 手動実行が安定してから追加
- 株価チャートのフロントエンド表示 — API(`/api/stocks/:code/prices`)は用意済みだがUI未実装
- 全銘柄（約4,400銘柄）対応 — `UNIVERSE_MODE: "all"`への切り替え（株価データ取得ロジック自体は対応済み。財務データは別途対応が必要、8章参照）
- Cloudflare D1導入による予測履歴の本格的な永続化（現状はKVの`history:`キーで代用）

## 8. Phase 2-A・2-B（予測精度向上）で追加したもの

### Phase 2-A: テクニカル指標

`src/indicators.js`でSMA5/20, EMA12/26, RSI14, MACD(12,26,9), ボリンジャーバンド(20,2), ATR14, 出来高SMA20, ボラティリティ20, 高値/安値からの乖離率を計算し、`features.js`に統合しています。全て既存の価格データ（取得済みのHigh/Low含む）から計算するため、それ自体は追加のAPI呼び出しを必要としません。

### Phase 2-B: 市場相対強度・財務データ・スクリーニング改善・バックテスト評価

- **市場相対強度**（`src/market.js`）: TOPIX専用エンドポイント(`/v2/indices/bars/daily/topix`)をfrom/to範囲指定で取得し、個別銘柄の20営業日騰落率との差分（相対強度）を計算する設計です。**⚠️ 実データ検証の結果、`/indices`系APIはStandard/Premiumプラン限定で、Freeプランでは403エラー（利用不可）でした。** 完全無料方針のため、現状はこの機能を有効化できず、`relativeStrength20d`は常にnullになります（コードは将来の有料プラン移行や無料化に備えて残していますが、Freeプランで運用する限り実質的に機能しません）。スクリーニングの複合スコアでは、この重みが常に0として計算されます。
- **財務データ**（`src/financials.js`）: `/v2/fins/summary`から銘柄コード指定で取得。**開示日(discDate)がcutoffDateより厳密に前のものだけ**を採用し、未来情報の混入を防ぎます。**全銘柄対応は未実装**です（8-1章参照）。**フィールド名は未検証**です（8-2章参照）。
- **取得期間の拡大**: MACD(12,26,9)の計算に最低35営業日分必要なため、`FETCH_LOOKBACK_CALENDAR_DAYS`を32→62、`FEATURE_LOOKBACK_TRADING_DAYS`を20→40に拡大しました。これにより日々のJ-Quantsリクエスト数（株価取得ステージ）が比例して増加します。
- **スクリーニングの複合スコア化**（`src/screening.js`）: `computeScreeningScore()`でモメンタム・市場相対強度・RSIの極端さ・出来高変化を重み付き合成したスコアでソートするようにしました。重みは`config.SCREENING.scoreWeights`で調整可能です。
- **Geminiへの入力・出力の拡張**: テクニカル指標・財務情報・市場相対強度を渡し、出力に`reasoning`（判断理由）フィールドを追加しました。各予測結果には`usedFeatures`として実際にGeminiへ渡した入力データのスナップショットを保存し、「どの時点で、どんな情報を使って、何を予測したのか」を後から再現できます。
- **バックテスト評価**: `.github/workflows/backtest.yml`（手動実行専用、予測パイプラインとは別ワークフロー）で`node src/backtest-run.js`を実行します。KVの`history:{cutoffDate}:{code}`を全て読み出し、各予測についてcutoffDateから30営業日後の実績リターンを計算し、+5%以上ならhit=trueとします。総予測数・評価可能数・Hit数・Miss数・Hit率・平均/中央値リターン・最大/最小リターン・スコア帯別Hit率を集計し、`backtest-summary`キーに保存します（`/api/backtest`から取得可能）。**現時点ではまだ実行しても意味のある結果は出ません**（予測実行からまだ30営業日経過していないため）。

### 8-1. スコープ外にしたもの

**財務データの全銘柄対応**: 決算発表は年4回程度と頻度が低く、日付ベースの一括取得に向かないため、現状は`STOCK_UNIVERSE`（少数銘柄）に対する銘柄コード指定取得のみ実装しています。全銘柄対応は`/v2/equities/earnings-calendar`（決算発表予定日）で対象日を絞り込む方式への切り替えが必要です（Phase 3以降の課題）。

### 8-2. 実データでの検証状況

**財務データのフィールド名を実データで検証済みです。** J-Quants V2 `/fins/summary`は、V1やEDINET XBRLの一般的な命名（`NetSales`等）とは全く異なる**独自の超短縮キー名**（`Sales`, `OP`=営業利益, `OdP`=経常利益, `NP`=純利益, `EqAR`=自己資本比率 等）を使用していることが判明しました。当初の実装では一部の項目（`operatingProfit`等）がこれに対応しておらず常にnullになっていましたが、実データでの検証を経て修正済みです。開示日(`discDate`)と決算期関連フィールド（`CurPerEn`等）が明確に別のフィールドであることも確認し、リーク対策のロジックに問題がないことも確認しました。

### 8-3. 今後追加予定の投資管理機能との干渉回避

KVキーの命名は`meta` `ranking` `stocks` `analysis:` `prices:` `history:` `backtest-summary`を使用済みです。将来の売買履歴機能は`trade:`等の別プレフィックスを使う想定で、現時点では実装していません。

## 9. スクリーニングスコアの妥当性検証

`src/screening-backtest.js`（+ `.github/workflows/screening-backtest.yml`、手動実行専用）で、`computeScreeningScore()`が過去データに対して実際に意味のある順位付けをしているかを検証できます。

**重要**: このスクリプトはGeminiを一切呼び出しません（無料枠消費ゼロ）。J-Quantsのみ使用し、`STOCK_UNIVERSE`の各銘柄について`from/to`範囲指定の1リクエストで全期間データを取得し、複数のcutoffDateについてはメモリ上でスライスして再利用します（cutoffDateを増やしてもリクエスト数は増えません）。

### 実行方法

```bash
node src/screening-backtest.js
```

`CUTOFF_DATES`環境変数（カンマ区切り）でcutoffDateを上書きできます。デフォルトは2025-09〜2026-04の5時点です。結果は`data/screening-validation.json`に保存され、コンソールにも出力されます。

### コード解析で判明した設計上の注意点（実データ検証前の所見）

`computeScreeningScore()`は全項目に`Math.abs()`を使っており、**「大きく動いた銘柄（方向不問）」を検出するスコアであり、「上昇しそうな銘柄」を予測するスコアではありません**（`screenToPool()`のコメントに明記された意図的な設計）。そのため、このスコアと将来の株価上昇の間に強い相関がないこと自体は、バグではなく設計上自然な結果である可能性があります。実データでの検証結果を踏まえて判断してください。

また、TOPIX相対強度（ウェイト1.0）はFreeプランで常にnullのため常に0点になり、重み総和のうち約30%が現在は機能していません（全銘柄に一律の影響のため、現在の10銘柄内での相対順位は歪めていません）。
