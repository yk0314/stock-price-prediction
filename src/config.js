// パイプライン全体の設定ファイル。
// スクリーニング条件・対象銘柄・AI分析数などは、ここを変更するだけで調整できるようにしている
// （数値ロジックをコードの奥に埋め込まず、後から容易に変更できることを優先）。

// --- 環境変数の読み取りヘルパー ---
// 未設定・空文字・数値でない値のときは fallback を使う。0以下は不正値として fallback に戻す(allowZero=trueなら0を許可)。
function envNumber(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
}

// --- J-Quants 契約プラン ---
// JQUANTS_PLAN(free / light / standard / premium)で、レート制限に合わせた取得間隔が決まる。
// 公式のレート制限(リクエスト/分): Free=5 / Light=60 / Standard=120 / Premium=500。
// 財務情報(/fins/summary)は、プランによらず60回/分(Freeは5回/分)。
// 実測(2026-10-03)では、現在の契約はLight相当(過去5年分・TOPIXあり・遅延なし)。
// 間隔は「60秒 ÷ 上限回数」にさらに25%の余裕を持たせた値にしている(Freeの場合は従来どおり15秒)。
const JQUANTS_PLAN_LIMITS = {
  free: { perMin: 5, finsPerMin: 5, historyYears: 2 },
  light: { perMin: 60, finsPerMin: 60, historyYears: 5 },
  standard: { perMin: 120, finsPerMin: 60, historyYears: 10 },
  premium: { perMin: 500, finsPerMin: 60, historyYears: 20 },
};
const planName = String(process.env.JQUANTS_PLAN || "light").toLowerCase();
const JQUANTS_PLAN = JQUANTS_PLAN_LIMITS[planName] ? planName : "light";
const planLimits = JQUANTS_PLAN_LIMITS[JQUANTS_PLAN];
const intervalForPerMin = (perMin) => Math.ceil((60000 / perMin) * 1.25);

export const config = {
  // --- 対象銘柄ユニバース ---
  // "phase1_subset": STOCK_UNIVERSE に列挙した銘柄だけを対象にする（開発・テスト用）。
  // "all": J-Quantsから取得した全銘柄のうち、UNIVERSE_MARKETS(下記)に該当する銘柄を対象にする（本番用）。
  //        「全銘柄」でも、ETF・REIT・TOKYO PRO Market等の個人が売買しにくい/対象外の区分は
  //        UNIVERSE_MARKETSで除外する。
  // ※ UNIVERSE_MODEは環境変数UNIVERSE_MODEで上書きされる(pipeline.jsのgetUniverseMode参照)。
  UNIVERSE_MODE: "phase1_subset",

  // UNIVERSE_MODE="all" のときに対象とする市場区分(上場銘柄一覧のMktNm)。
  // 実測(2026-10-03)の内訳: プライム1,553 / スタンダード1,555 / グロース595 / TOKYO PRO MARKET191 / その他548(ETF・REIT等)。
  // 環境変数 UNIVERSE_MARKETS(カンマ区切り)で上書きできる。"ALL" を指定すると市場区分での絞り込みをしない。
  UNIVERSE_MARKETS: parseMarkets(process.env.UNIVERSE_MARKETS),

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

  // --- J-Quants 契約プラン ---
  JQUANTS_PLAN,
  JQUANTS_PLAN_LIMITS: planLimits,

  // 【後方互換のためのキー】無料プランの12週間遅延を前提にした「実行日 - N日」の日数。
  // 通常運用(有料プラン)では 0 であり、パイプラインは使わない。
  // データ基準日は、J-Quantsから実際に取得できた最新の取引日を動的に判定する(cutoff.js の resolveLatestAvailableDate)。
  // Freeプランで運用する場合も、プランの契約期間エラー("Your subscription covers the following dates")から
  // 最新日を判定するため、この値を設定する必要はない。
  JQUANTS_DELAY_DAYS: envNumber("JQUANTS_DELAY_DAYS", 0, { allowZero: true }),

  // --- J-Quants レートリミット対策 ---
  JQUANTS_RATE_LIMIT_PER_MIN: planLimits.perMin,
  // 通常のAPI(株価・銘柄マスタ・TOPIX・カレンダー)のリクエスト間隔(ms)。JQUANTS_REQUEST_INTERVAL_MSで上書き可
  JQUANTS_REQUEST_INTERVAL_MS: envNumber("JQUANTS_REQUEST_INTERVAL_MS", intervalForPerMin(planLimits.perMin)),
  // 財務情報(/fins/summary)のリクエスト間隔(ms)。JQUANTS_FINS_INTERVAL_MSで上書き可
  JQUANTS_FINS_INTERVAL_MS: envNumber("JQUANTS_FINS_INTERVAL_MS", intervalForPerMin(planLimits.finsPerMin)),

  // --- J-Quants リトライ ---
  // いずれも「上限回数つき」で、無制限には再試行しない。上限に達したら JQuantsApiError として呼び出し側へ伝える。
  // これは同一の契約済みAPIへの再試行のみで、課金や別サービスへの切り替えとは無関係。
  JQUANTS_RETRY: {
    // 429(レートリミット)。Retry-Afterヘッダがあればそれを優先する。
    maxRetriesOn429: 3,
    retryBackoffMs: JQUANTS_PLAN === "free" ? 20000 : 5000, // 1回目5秒, 2回目10秒, 3回目15秒(Freeは20秒単位)
    // 5xx・ネットワークエラー・タイムアウト。指数バックオフ(2秒→4秒→8秒、上限30秒)
    maxRetriesOnTransient: 3,
    transientBackoffMs: 2000,
    maxBackoffMs: 30000,
    // 1リクエストのタイムアウト(ms)
    requestTimeoutMs: 60000,
  },

  // --- データ基準日(取得可能な最新取引日)の判定 ---
  LATEST_DATE: {
    // 今日から何暦日さかのぼって「データがある日」を探すか。祝日・連休・更新前を吸収するための上限。
    maxLookbackDays: 14,
    // 全銘柄の株価が揃っているとみなす最小件数。これ未満の日は更新途中(不完全)とみなして1つ前の取引日に戻る。
    // 実測では1日あたり約4,400件。
    minRowsForCompleteDay: 1000,
  },

  // --- 日付ベース一括取得の対象期間 ---
  // 「cutoffDateから何暦日遡って取得するか」。
  // MACD(12,26,9)の計算に最低35営業日分必要なため、62暦日(取引カレンダーで祝日を除くと約42営業日)を取得する。
  FETCH_LOOKBACK_CALENDAR_DAYS: 62,
  // 特徴量の「Xd」比較・テクニカル指標の計算に使う最大の営業日数。
  // 実際にfeatures.jsが要求するデータ点数は「この値+1」。
  // この日数分のデータが揃わない銘柄は特徴量計算をスキップする。
  FEATURE_LOOKBACK_TRADING_DAYS: 40,

  // --- 市場全体(TOPIX)データ ---
  // 個別銘柄との相対強度を計算するために使う。専用エンドポイントで軽量に取得できる(Light以上のプラン)。
  // 取得に失敗(契約外の403等)した場合は、従来どおり relativeStrength20d=null のまま続行する。
  MARKET: {
    relativeStrengthTradingDays: 20,
    // D1(index_prices)に保存する指数のコード。バックテスト・将来の市場環境特徴量用
    indexCode: "TOPIX",
  },

  // --- 財務データ ---
  FINANCIALS: {
    enabled: true,
    // 財務データは銘柄コード指定でしか取得できないため、全銘柄(約3,700)に対して毎回行うと非現実的。
    // Gemini分析対象に選ばれた候補銘柄（config.GEMINI.candidateCount件）にのみ取得する。
    // これはUNIVERSE_MODEに関わらず同じロジックで動作する。
  },

  // --- 数値スクリーニング ---
  SCREENING: {
    // J-Quants取得・特徴量計算は全銘柄（またはSTOCK_UNIVERSE）に対して行うが、
    // Geminiに渡す「候補プール」はここでまず絞り込む。
    // 「ユニバースの大きさ」「候補プールの大きさ(poolSize)」「Geminiに渡す件数(GEMINI.candidateCount)」は
    // それぞれ独立した設定。環境変数 SCREENING_POOL_SIZE で上書きできる。
    poolSize: envNumber("SCREENING_POOL_SIZE", 150),
    // 出来高変化率が極端すぎる銘柄（データ異常の可能性）は除外
    maxAbsVolumeChangePct: 500,
    // 価格変化率がこの範囲内の銘柄を「動きのある銘柄」として優先
    minAbsPriceChangePct5d: 1.0,
    // 【短期売買向けの流動性フィルタ】以下の値は仮の設定であり、統計的に最適化されたものではない。
    // 実データでの検証結果を見ながら調整することを前提とした「設定可能な値」として置いている。
    // 20日平均売買代金（終値×20日平均出来高、円）がこれ未満の銘柄は、数日〜1週間の短期売買では
    // 約定しにくい・スプレッドが大きい等のリスクがあるため候補から除外する。
    minAvgTradingValueYen: 50_000_000, // 目安: 1日あたり5,000万円
    // 株価がこれ未満の銘柄（超低位株）は値動きが不安定になりやすいため除外する。
    minPrice: 100,
    // 総合スコアの重み（モメンタム・出来高・市場相対強度・RSIの極端さを総合評価）。
    // 単純な値動きの大きさだけで絞り込まないための重み付け。後から自由に調整できる。
    scoreWeights: {
      momentum5d: 1.0,
      momentum20d: 0.5,
      relativeStrength: 1.0,
      rsiExtremity: 0.5,
      volumeChange: 0.3,
    },
  },

  // --- Gemini API 設定 ---
  // 1リクエスト=1銘柄が絶対条件（複数銘柄を同一コンテキストに混ぜない）。
  // 以下の値はすべて環境変数で上書きできる。環境変数が無ければデフォルト値を使う。
  GEMINI: {
    // 明示的なモデル名を指定する（エイリアスは将来的な仕様変更で挙動が変わる可能性があるため避ける）。
    // 2026年9月時点でGA(正式提供)されている無料利用可能なFlash系モデル。
    // gemini-2.0系・gemini-2.5系は2026年中に順次シャットダウン予定のため使用しない。
    // 実装直前に https://aistudio.google.com/ の Rate Limits 画面で
    // このモデルの無料枠(RPM/RPD/TPM)を必ず確認すること。
    model: "gemini-3.5-flash-lite",

    // スクリーニングプール(poolSize件)の中から、実際にGeminiへ渡す件数(=1回の実行で評価する銘柄数の上限)。
    // 既定値はプールサイズと同じ150(=プール全件を分析)。GEMINI_MAX_STOCKS で上書き可能。
    // 注意: Geminiへは1リクエスト=1銘柄で送る。ここは「バッチサイズ」ではなく「1回の実行で評価する件数」。
    candidateCount: Number(process.env.GEMINI_MAX_STOCKS) || 150,

    // Gemini呼び出し1回あたりのタイムアウト(ms)
    timeoutMs: 30000,

    // 過去の設定値（後方互換のため残置。現在は下のmaxRetriesがリトライ回数を制御する）。
    maxRetriesOnTransientError: 0,

    // 1銘柄処理後、次の銘柄に移るまでの待機時間(ms)。GEMINI_REQUEST_INTERVAL_MS で上書き可能。
    // Gemini Free Tierでの安全運用のため、既定は30秒間隔。
    requestIntervalMs: Number(process.env.GEMINI_REQUEST_INTERVAL_MS) || 30000,

    // 429(Too Many Requests)・503(Service Unavailable)等の一時的エラー発生時のリトライ上限回数。
    // GEMINI_MAX_RETRIES で上書き可能。0にすればリトライ無し(従来の挙動)。無限リトライはしない。
    maxRetries: Number(process.env.GEMINI_MAX_RETRIES) || 2,

    // リトライ時の基本バックオフ時間(ms)。実際の待機時間は 試行回数 に応じて指数的に増える
    // （かつAPIレスポンスにRetry-Afterが含まれていればそちらを優先する）。
    retryBackoffBaseMs:
      Number(process.env.GEMINI_RETRY_BACKOFF_BASE_MS) || 15000,

    // 1回のパイプライン実行あたりのGemini APIリクエスト上限（通常分析+リトライの合計）。
    // GEMINI_DAILY_REQUEST_LIMIT で上書き可能。既定値はcandidateCount(既定150)に
    // リトライ分の余裕(平均2倍程度)を見込んだ値。上限に達したら、その回の残り銘柄の分析は
    // 安全側にスキップして処理を打ち切る（パイプライン自体は継続する）。
    dailyRequestLimit: Number(process.env.GEMINI_DAILY_REQUEST_LIMIT) || 300,

    // 429(レート制限)専用のバックオフ時間(ms)。503の指数バックオフ(retryBackoffBaseMs)とは別扱いにする。
    // Retry-Afterヘッダがあれば常にそちらを優先し、この値はRetry-Afterが無い場合のみ使う。
    // GEMINI_429_BACKOFF_MS で上書き可能。
    backoff429Ms: Number(process.env.GEMINI_429_BACKOFF_MS) || 45000,

    // 429が何回連続したら、その日のGemini処理を安全停止するか。
    // 単発の429では停止しない(通常のリトライで吸収する)。成功した銘柄があれば連続カウントは0に戻る。
    // GEMINI_CONSECUTIVE_429_LIMIT で上書き可能。
    consecutive429Limit: Number(process.env.GEMINI_CONSECUTIVE_429_LIMIT) || 5,
  },

  // --- D1への株価の蓄積(scripts/sync-prices.js) ---
  // バックテスト用に、全銘柄の日足をD1(stock_prices)へ差分で蓄積する。
  // Cloudflare D1の無料枠は「書き込み1日10万行」。stock_pricesは1行の書き込みで主キーの索引も更新されるため、
  // 1日分(約4,400行)で約8,800行分の書き込みになる。1日の書き込みの予算(行数)を決めて、その範囲で古い日付から
  // 段階的に取り込む(初回の過去分は数日〜数十日かけて自動的に埋まる)。有料プランなら予算を上げれば一度に取り込める。
  PRICE_SYNC: {
    // 何暦日さかのぼった日付から蓄積するか(既定730日=約2年)。J-Quantsの契約期間(Lightは5年)の範囲内であること。
    lookbackDays: envNumber("PRICE_SYNC_LOOKBACK_DAYS", 730),
    // sync-prices.js が1回の実行で使ってよいD1の書き込み行数の上限。他の処理(pipeline.js)の分を残すため、無料枠の6割に設定。
    dailyWriteBudget: envNumber("D1_DAILY_WRITE_BUDGET", 60000),
    // 1リクエストで書き込む行数(JSON一括upsert)
    rowsPerRequest: envNumber("D1_ROWS_PER_REQUEST", 200),
    // 株式分割等(AdjFactor≠1)で過去の調整後株価が変わった銘柄を、1回の実行で再取得する銘柄数の上限
    maxSplitRepairCodes: envNumber("PRICE_SYNC_MAX_SPLIT_REPAIR", 20),
  },

  // --- 最終ランキングに残す銘柄数 ---
  FINAL_RANKING_SIZE: 20,

  // --- バックテスト用設定 ---
  BACKTEST: {
    horizonTradingDays: 30,
    hitThresholdPct: 5, // 30営業日後 +5% 以上で hit=true
    scoreBands: [
      [90, 100],
      [80, 89],
      [70, 79],
      [60, 69],
      [0, 59],
    ],
  },

  // --- 中間データ(JSON)の保存先ディレクトリ ---
  ARTIFACTS_DIR: "./data",
};

/**
 * UNIVERSE_MARKETS(カンマ区切り)を配列にする。未設定なら既定の3市場、"ALL"なら絞り込みなし(null)。
 * 市場区分名は上場銘柄一覧のMktNm(例: "プライム")と一致させる。
 */
function parseMarkets(raw) {
  const DEFAULT = ["プライム", "スタンダード", "グロース"];
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT;
  const trimmed = String(raw).trim();
  if (trimmed.toUpperCase() === "ALL") return null;
  const list = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT;
}
