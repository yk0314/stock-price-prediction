import { config } from "./config.js";
import { resolveCutoffDate } from "./cutoff.js";
import { JQuantsClient } from "./jquants.js";
import { normalizeRawRows, groupByCode } from "./normalize.js";
import { computeFeaturesForAll } from "./features.js";
import { screenToPool, selectGeminiCandidates } from "./screening.js";
import { analyzeCandidates } from "./gemini.js";
import { CloudflareKV, saveResultsToKV } from "./kv.js";
import { writeArtifact } from "./artifacts.js";
import { fetchTopixForRange, computeMarketFeatures, computeRelativeStrength } from "./market.js";
import { buildAvailableFinancialsByCode } from "./financials.js";

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 対象銘柄ユニバースを適用する。
 * UNIVERSE_MODE = "phase1_subset" の場合は config.STOCK_UNIVERSE の銘柄だけに絞り込む。
 * UNIVERSE_MODE = "all" の場合は絞り込みを行わない（全銘柄運用時）。
 * データ取得自体は常に日付ベースの一括取得で行っており、
 * このフィルタは「取得後にどこまでを分析対象にするか」を制御するだけである。
 */
function applyUniverseFilter(groupedByCode) {
  if (config.UNIVERSE_MODE === "all") {
    return groupedByCode;
  }
  const universe = new Set(config.STOCK_UNIVERSE);
  const filtered = new Map();
  for (const [code, rows] of groupedByCode.entries()) {
    if (universe.has(code)) filtered.set(code, rows);
  }
  return filtered;
}

async function main() {
  const startedAt = new Date();
  const predictionExecutedAt = startedAt.toISOString();
  console.log(`[pipeline] 開始: ${predictionExecutedAt}`);

  // --- Stage 0: cutoffDate の決定（手動指定 or 自動計算） ---
  const manualCutoff = process.env.CUTOFF_DATE || undefined;
  const { cutoffDate, source } = resolveCutoffDate(manualCutoff);
  console.log(`[pipeline] cutoffDate = ${cutoffDate} (source: ${source})`);

  const fetchStartDate = addDaysUTC(cutoffDate, -config.FETCH_LOOKBACK_CALENDAR_DAYS);

  // --- Stage 1: raw data — J-Quants から日付ベースで一括取得（1銘柄ずつのループは行わない） ---
  const jquants = new JQuantsClient(process.env.JQUANTS_API_KEY);
  const rawRows = await jquants.fetchDailyQuotesBulkForDateRange(
    fetchStartDate,
    cutoffDate
  );
  console.log(`[pipeline] raw data: ${rawRows.length}件（全銘柄・複数日分）`);
  await writeArtifact("raw-data.json", {
    cutoffDate,
    fetchStartDate,
    count: rawRows.length,
    rows: rawRows,
  });

  if (rawRows.length === 0) {
    console.error(
      "[pipeline] raw dataが0件でした。J-Quantsのレスポンス形式・APIキー・cutoffDateを確認してください。処理を中断します。"
    );
    process.exitCode = 1;
    return;
  }

  // --- Stage 2: normalized data — 共通スキーマへの正規化 + 銘柄コードごとにグルーピング ---
  const normalizedRows = normalizeRawRows(rawRows);
  const groupedAll = groupByCode(normalizedRows);
  console.log(`[pipeline] normalized data: ${normalizedRows.length}件 / ${groupedAll.size}銘柄`);
  await writeArtifact("normalized-data.json", {
    count: normalizedRows.length,
    codeCount: groupedAll.size,
  });

  // --- ユニバースフィルタ（Phase1: STOCK_UNIVERSE のみ / 将来: 全銘柄） ---
  const grouped = applyUniverseFilter(groupedAll);
  console.log(
    `[pipeline] ユニバースフィルタ後: ${grouped.size}銘柄 (mode=${config.UNIVERSE_MODE})`
  );

  // --- Stage 3: features — 特徴量計算（対象は grouped = フィルタ後のユニバース） ---
  const featureList = computeFeaturesForAll(grouped);
  console.log(`[pipeline] features: ${featureList.length}銘柄で計算成功`);

  if (featureList.length === 0) {
    await writeArtifact("features.json", featureList);
    console.error("[pipeline] 特徴量が1件も計算できませんでした。処理を中断します。");
    process.exitCode = 1;
    return;
  }

  // --- Stage 3.5: 市場データ(TOPIX) — 専用の軽量エンドポイントで取得し、相対強度を計算 ---
  // 日付ループではなくfrom/to範囲指定の1回（〜数回のページング）で取得できるため、
  // 無料枠への影響はごく小さい。
  const relativeStrengthDays = config.MARKET.relativeStrengthTradingDays;
  let topixChangeNd = null;
  try {
    const topixRows = await fetchTopixForRange(jquants, fetchStartDate, cutoffDate, cutoffDate);
    const marketFeatures = computeMarketFeatures(topixRows, relativeStrengthDays);
    topixChangeNd = marketFeatures.topixChangeNd;
    console.log(
      `[pipeline] market(TOPIX): ${topixRows.length}件取得 / ${relativeStrengthDays}営業日騰落率=${topixChangeNd}`
    );
  } catch (err) {
    // 市場データは補助的な特徴量であり、取得できなくてもパイプライン全体は継続できるようにする
    // （財務・株価と異なりTOPIXが無くても既存の特徴量だけで分析は成立するため）。
    console.warn(`[pipeline] TOPIX取得に失敗したため、relativeStrengthはnullのまま続行: ${err.message}`);
  }
  for (const f of featureList) {
    f.relativeStrength20d = computeRelativeStrength(f.priceChange20d, topixChangeNd);
  }
  await writeArtifact("features.json", featureList);

  // --- Stage 3.6: 財務データ — STOCK_UNIVERSE銘柄のみ、銘柄コード指定で取得（全銘柄対応は将来課題） ---
  // 開示日(discDate)がcutoffDateより厳密に前のものだけを採用し、未来情報の混入を防ぐ。
  const financialsByCode = new Map();
  if (config.FINANCIALS.enabled && config.UNIVERSE_MODE === "phase1_subset") {
    const rawFinancialsByCode = new Map();
    for (const code of config.STOCK_UNIVERSE) {
      try {
        const rows = await jquants.fetchFinancialsForCode(code);
        rawFinancialsByCode.set(code, rows);
      } catch (err) {
        // 財務データはあくまで補助的な特徴量。1銘柄の取得失敗でパイプライン全体を止めない。
        console.warn(`[pipeline] 財務情報取得に失敗 code=${code}: ${err.message}`);
        rawFinancialsByCode.set(code, []);
      }
    }
    const available = buildAvailableFinancialsByCode(rawFinancialsByCode, cutoffDate);
    for (const [code, fin] of available.entries()) {
      financialsByCode.set(code, fin);
    }
    console.log(
      `[pipeline] financials: ${config.STOCK_UNIVERSE.length}銘柄中 ${available.size}銘柄で利用可能な開示情報あり`
    );
    await writeArtifact("financials.json", Object.fromEntries(available));
  } else {
    console.log("[pipeline] financials: UNIVERSE_MODEが'all'のため今回はスキップ（Phase3以降の課題）");
  }
  for (const f of featureList) {
    f.financials = financialsByCode.get(f.code) ?? null;
  }

  // --- Stage 4: screened — 数値スクリーニングでプールを作成 → Gemini対象を選定 ---
  const pool = screenToPool(featureList);
  const geminiCandidates = selectGeminiCandidates(pool);
  console.log(
    `[pipeline] screening: pool=${pool.length}件 / Gemini対象=${geminiCandidates.length}件`
  );
  await writeArtifact("screened.json", { pool, geminiCandidates });

  // --- Stage 5: gemini — AI分析（候補銘柄のみ。無料枠超過時は自動スキップ・リトライなし） ---
  const analysisResults = await analyzeCandidates(
    process.env.GEMINI_API_KEY,
    geminiCandidates,
    { cutoffDate, predictionExecutedAt }
  );
  console.log(
    `[pipeline] gemini: ${analysisResults.length}/${geminiCandidates.length}件で分析成功`
  );
  await writeArtifact("gemini-results.json", analysisResults);

  // --- Stage 6: ranking — 上位ランキングの作成 ---
  const ranking = [...analysisResults]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, config.FINAL_RANKING_SIZE);
  await writeArtifact("ranking.json", ranking);

  const analysisByCode = {};
  for (const result of analysisResults) {
    analysisByCode[result.code] = result;
  }

  // 銘柄一覧・簡易株価（プールに関わらず特徴量が計算できた全銘柄分）
  const stocks = featureList.map((f) => ({
    code: f.code,
    price: f.price,
    dataAsOf: f.dataAsOf,
  }));
  const pricesByCode = {};
  for (const [code, rows] of grouped.entries()) {
    // features.js が実際に参照するウィンドウ（最新+N営業日前まで）と一致させる
    pricesByCode[code] = rows.slice(-(config.FEATURE_LOOKBACK_TRADING_DAYS + 1));
  }

  const finishedAt = new Date();
  const meta = {
    cutoffDate,
    cutoffSource: source,
    predictionExecutedAt,
    finishedAt: finishedAt.toISOString(),
    universeMode: config.UNIVERSE_MODE,
    fetchedCodeCount: groupedAll.size,
    universeCodeCount: grouped.size,
    featureCount: featureList.length,
    poolCount: pool.length,
    geminiCandidateCount: geminiCandidates.length,
    analyzedCount: analysisResults.length,
    topixChangeNd,
    financialsAvailableCount: financialsByCode.size,
  };

  // --- Stage 7: Cloudflare KV へ保存（表示用データ + バックテスト用の追記履歴） ---
  const kv = new CloudflareKV({
    accountId: process.env.CF_ACCOUNT_ID,
    namespaceId: process.env.CF_KV_NAMESPACE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });
  await saveResultsToKV(kv, { meta, ranking, analysisByCode, stocks, pricesByCode });

  console.log("[pipeline] 完了。KVへの保存まで正常終了しました。");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error(`[pipeline] 致命的エラー: ${err.stack || err.message}`);
  process.exitCode = 1;
});
