// パイプライン全体の設定ファイル。
// スクリーニング条件・対象銘柄・AI分析数などは、ここを変更するだけで調整できるようにしている
// （数値ロジックをコードの奥に埋め込まず、後から容易に変更できることを優先）。

export const config = {
  // --- 対象銘柄ユニバース ---
  // "phase1_subset": STOCK_UNIVERSE に列挙した銘柄だけを対象にする（初期テスト用）。
  // "all": J-Quants から取得した全銘柄を対象にする（将来の本番運用時。実装は jquants.js 側で対応済み、
  //        フィルタを外すだけで有効化できる）。
  UNIVERSE_MODE: "phase1_subset",

  STOCK_UNIVERSE: [
    "7203", // トヨタ自動車
    "6758", // ソニーグループ
    "9984", // ソフトバンクグループ
    "8306", // 三菱UFJフィナンシャル・グループ
    "6501", // 日立製作所
    "9432", // 日本電信電話
    "4063", // 信越化学工業
    "6098", // リクルートホールディングス
    "8035", // 東京エレクトロン
    "6367", // ダイキン工業
  ],

  // --- J-Quants Free プランのデータ遅延（日数）---
  // Freeプランは常に「実行日 - JQUANTS_DELAY_DAYS」より新しいデータを取得できない。
  // 実際の遅延(12週間=84日)より安全側に余裕を持たせている。
  JQUANTS_DELAY_DAYS: 90,

  // --- J-Quants レートリミット対策（Freeプラン: 公称5req/分だが、実測で余裕を持たせる） ---
  JQUANTS_RATE_LIMIT_PER_MIN: 5,
  JQUANTS_REQUEST_INTERVAL_MS: 15000, // 12秒に1回のペースに、実測の429発生を踏まえてさらに余裕を持たせて15秒
  // 429(レートリミット)発生時、待機してから再試行する回数と待機時間。
  // これは無料APIへの節度あるリトライであり、課金や有料モデルへの切替とは無関係。
  // ここでも解消しなければ JQuantsApiError としてパイプラインを失敗させる。
  JQUANTS_RETRY: {
    maxRetriesOn429: 3,
    retryBackoffMs: 20000, // 1回目20秒, 2回目40秒, 3回目60秒待機
  },

  // --- 日付ベース一括取得の対象期間 ---
  // 「cutoffDateから何暦日遡って取得するか」。
  // 土日・祝日を含むため、実際の営業日数(FEATURE_LOOKBACK_TRADING_DAYS+1)より多めに設定する。
  FETCH_LOOKBACK_CALENDAR_DAYS: 32,
  // 特徴量の「Xd」比較で使う最大の営業日数（例: 20 なら 1d/5d/20d を計算する）。
  // 実際にfeatures.jsが要求するデータ点数は「この値+1」（最新日を含めて20営業日前と比較するため）。
  // この日数分のデータが揃わない銘柄は特徴量計算をスキップする。
  FEATURE_LOOKBACK_TRADING_DAYS: 20,

  // --- 数値スクリーニング ---
  SCREENING: {
    // J-Quants取得・特徴量計算は全銘柄（またはSTOCK_UNIVERSE）に対して行うが、
    // Geminiに渡す「候補プール」はここでまず絞り込む。
    // 将来の全銘柄運用時は 100〜200 程度を想定。
    poolSize: 150,
    // 出来高変化率が極端すぎる銘柄（データ異常の可能性）は除外
    maxAbsVolumeChangePct: 500,
    // 価格変化率がこの範囲内の銘柄を「動きのある銘柄」として優先
    minAbsPriceChangePct5d: 1.0,
  },

  // --- Gemini API 設定 ---
  GEMINI: {
    // 明示的なモデル名を指定する（エイリアスは将来的な仕様変更で挙動が変わる可能性があるため避ける）。
    // 2026年9月時点でGA(正式提供)されている無料利用可能なFlash系モデル。
    // gemini-2.0系・gemini-2.5系は2026年中に順次シャットダウン予定のため使用しない。
    // 実装直前に https://aistudio.google.com/ の Rate Limits 画面で
    // このモデルの無料枠(RPM/RPD/TPM)を必ず確認すること。
    model: "gemini-3.5-flash",

    // スクリーニングプール(poolSize件)の中から、実際にGeminiへ渡す件数。
    // 初期テストでは10件程度に抑える。将来的に無料枠の実測を見ながら拡大する。
    candidateCount: 10,

    // Gemini呼び出し1回あたりのタイムアウト(ms)
    timeoutMs: 30000,

    // 429 (quota exceeded) が発生した場合、リトライは一切行わない（課金リトライ・モデル切替は禁止）。
    // この設定値は将来的な一時的ネットワークエラー用の再試行回数の上限であり、
    // 429/RESOURCE_EXHAUSTED系のエラーには適用しない（gemini.js側で明示的に分岐している）。
    maxRetriesOnTransientError: 0,
  },

  // --- 最終ランキングに残す銘柄数 ---
  FINAL_RANKING_SIZE: 20,

  // --- バックテスト用設定（Phase 1では評価は未実行。将来のevaluationスクリプト用） ---
  BACKTEST: {
    horizonTradingDays: 30,
    hitThresholdPct: 5, // 30営業日後 +5% 以上で hit=true
  },

  // --- 中間データ(JSON)の保存先ディレクトリ ---
  ARTIFACTS_DIR: "./data",
};
