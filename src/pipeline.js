import { config } from "./config.js";
import { resolveCutoffDate } from "./cutoff.js";
import { JQuantsClient } from "./jquants.js";
import { normalizeRawRows, groupByCode } from "./normalize.js";
import { computeFeaturesForAll } from "./features.js";
import { screenToPool, selectGeminiCandidates } from "./screening.js";
import { analyzeCandidates } from "./gemini.js";
import { CloudflareKV, saveResultsToKV } from "./kv.js";
import { saveToD1 } from "./pipelineD1.js";
import { writeArtifact } from "./artifacts.js";
import { fetchTopixForRange, computeMarketFeatures, computeRelativeStrength } from "./market.js";
import { buildAvailableFinancialsByCode } from "./financials.js";
import { buildListedInfoByCode } from "./listedInfo.js";
import { D1Client } from "./d1.js";
import { fetchHeldCodes } from "./d1Repository.js";

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
 *
 * UNIVERSE_MODEは config.js の既定値のほか、環境変数 UNIVERSE_MODE でも上書きできる
 * （workflow_dispatchの入力から、コードを変更せずに検証できるようにするため）。
 */
function getUniverseMode() {
  return process.env.UNIVERSE_MODE || config.UNIVERSE_MODE;
}

function applyUniverseFilter(groupedByCode, universeMode) {
  if (universeMode === "all") {
    return groupedByCode;
  }
  const universe = new Set(config.STOCK_UNIVERSE);
  const filtered = new Map();
  for (const [code, rows] of groupedByCode.entries()) {
    if (universe.has(code)) filtered.set(code, rows);
  }
  return filtered;
}

/**
 * 保有銘柄(heldCodes)のうち、通常のGemini候補(normalCandidateCodes)に既に含まれていない銘柄を
 * 「保有銘柄の再評価対象」として選び出す純粋関数。
 * - 通常候補と重複する銘柄はGeminiへの重複送信を避けるため除外する(duplicateCountとして数える)
 * - 当日の特徴量が無い(featureByCodeに存在しない)銘柄は評価不能なのでスキップする(missingFeatureCodes)
 * - heldCodesが空配列なら、当然heldExtraCandidatesも空配列になる(保有銘柄0件時の正常系)
 * pipeline.js本体から切り出しているのは、D1アクセスを伴わない部分だけを単体テスト可能にするため。
 */
export function selectHeldExtraCandidates(heldCodes, normalCandidateCodes, featureByCode) {
  const heldExtraCandidates = [];
  const missingFeatureCodes = [];
  let duplicateCount = 0;

  for (const code of heldCodes) {
    if (normalCandidateCodes.has(code)) {
      duplicateCount++;
      continue;
    }
    const feature = featureByCode.get(code);
    if (!feature) {
      missingFeatureCodes.push(code);
      continue;
    }
    heldExtraCandidates.push(feature);
  }

  return { heldExtraCandidates, missingFeatureCodes, duplicateCount };
}

async function main() {
  const startedAt = new Date();
  const predictionExecutedAt = startedAt.toISOString();
  const universeMode = getUniverseMode();
  console.log(`[pipeline] 開始: ${predictionExecutedAt} (UNIVERSE_MODE=${universeMode})`);

  // API呼び出し中に発生したエラー件数を種類別に集計する（検証項目「APIエラー数」用）。
  const apiErrorCounts = { jquantsFinancials: 0, topix: 0, gemini429OrError: 0, listedInfo: 0, heldCodesFetch: 0 };

  // --- Stage 0: cutoffDate の決定（手動指定 or 自動計算） ---
  const manualCutoff = process.env.CUTOFF_DATE || undefined;
  const { cutoffDate, source } = resolveCutoffDate(manualCutoff);
  console.log(`[pipeline] cutoffDate = ${cutoffDate} (source: ${source})`);

  const fetchStartDate = addDaysUTC(cutoffDate, -config.FETCH_LOOKBACK_CALENDAR_DAYS);

  // --- Stage 1: raw data — J-Quants から日付ベースで一括取得（1銘柄ずつのループは行わない） ---
  // 全銘柄運用時もこの取得自体は変わらない（元々常に全銘柄分を取得しているため）。
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

  // --- Stage 1.5: 銘柄マスタ(名称・市場区分) — /v2/equities/master を1回だけ呼ぶ ---
  // 日付ベースの株価取得とは独立したエンドポイントで、銘柄ごとにループしない。
  // 取得できなくても銘柄名が付かないだけで、パイプライン全体は継続できるようにする
  // （ランキング等の中核機能はcode単位で成立するため、nameは補助的な表示用情報）。
  let listedInfoByCode = new Map();
  try {
    const listedInfoRows = await jquants.fetchListedInfo();
    listedInfoByCode = buildListedInfoByCode(listedInfoRows);
    console.log(`[pipeline] listedInfo(銘柄マスタ): ${listedInfoByCode.size}銘柄分の名称・市場区分を取得`);
    await writeArtifact("listed-info.json", listedInfoRows.slice(0, 5));
  } catch (err) {
    apiErrorCounts.listedInfo++;
    console.warn(`[pipeline] 銘柄マスタ取得に失敗したため、銘柄名は付与されないまま続行: ${err.message}`);
  }

  // --- Stage 2: normalized data — 共通スキーマへの正規化 + 銘柄コードごとにグルーピング ---
  const normalizedRows = normalizeRawRows(rawRows);
  const groupedAll = groupByCode(normalizedRows);
  console.log(`[pipeline] normalized data: ${normalizedRows.length}件 / ${groupedAll.size}銘柄（取得銘柄数）`);
  await writeArtifact("normalized-data.json", {
    count: normalizedRows.length,
    codeCount: groupedAll.size,
  });

  // --- ユニバースフィルタ（phase1_subset: 10銘柄 / all: 全銘柄） ---
  const grouped = applyUniverseFilter(groupedAll, universeMode);
  console.log(
    `[pipeline] ユニバースフィルタ後: ${grouped.size}銘柄 (mode=${universeMode})`
  );

  // --- Stage 3: features — 特徴量計算（対象は grouped = フィルタ後のユニバース） ---
  const featureList = computeFeaturesForAll(grouped);
  console.log(`[pipeline] features: ${featureList.length}銘柄で計算成功（スクリーニング前銘柄数）`);

  if (featureList.length === 0) {
    await writeArtifact("features.json", featureList);
    console.error("[pipeline] 特徴量が1件も計算できませんでした。処理を中断します。");
    process.exitCode = 1;
    return;
  }

  // --- Stage 3.5: 市場データ(TOPIX) — 専用の軽量エンドポイントで取得し、相対強度を計算 ---
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
    // 市場データは補助的な特徴量であり、取得できなくてもパイプライン全体は継続できるようにする。
    apiErrorCounts.topix++;
    console.warn(`[pipeline] TOPIX取得に失敗したため、relativeStrengthはnullのまま続行: ${err.message}`);
  }
  for (const f of featureList) {
    f.relativeStrength20d = computeRelativeStrength(f.priceChange20d, topixChangeNd);
  }
  await writeArtifact("features.json", featureList);

  // --- Stage 4: screened — 数値スクリーニング(流動性フィルタ含む)でプールを作成 → Gemini対象を選定 ---
  // 財務データはこの後、Gemini対象銘柄にのみ取得する（全銘柄・プール全体には取得しない）。
  const pool = screenToPool(featureList);
  const excludedCount = featureList.length - pool.length;
  const geminiCandidates = selectGeminiCandidates(pool);
  console.log(
    `[pipeline] screening: 通過前${featureList.length}件 → 除外${excludedCount}件 → プール${pool.length}件 → Gemini対象${geminiCandidates.length}件`
  );
  await writeArtifact("screened.json", { pool, geminiCandidates });

  // --- Stage 4.6: 保有銘柄の再評価対象追加 ---
  // 通常のスクリーニング結果に関わらず、現在保有中(数量>0)の銘柄は必ず当日のGemini評価対象に含める。
  // 「たまたまスクリーニング上位に入った日だけ評価される」現状を、
  // 「保有している限り毎日評価される」状態にするための追加ロジック。
  // 既にgeminiCandidatesに含まれている銘柄(通常候補と保有銘柄が重複するケース)は
  // 二重にGeminiへ送らないよう除外する（Geminiへのリクエスト数を必要以上に増やさないため）。
  // 保有銘柄が0件、またはD1未接続・取得失敗時は、再評価処理自体をスキップして通常通り続行する
  // （他のAPI取得失敗時と同じ「補助的な処理は失敗してもパイプライン全体を止めない」方針を踏襲）。
  const normalCandidateCodes = new Set(geminiCandidates.map((c) => c.code));
  const featureByCode = new Map(featureList.map((f) => [f.code, f]));
  let heldExtraCandidates = [];
  if (process.env.CF_D1_DATABASE_ID) {
    try {
      const heldD1 = new D1Client({
        accountId: process.env.CF_ACCOUNT_ID,
        databaseId: process.env.CF_D1_DATABASE_ID,
        apiToken: process.env.CF_API_TOKEN,
      });
      const heldCodes = await fetchHeldCodes(heldD1);
      const selection = selectHeldExtraCandidates(heldCodes, normalCandidateCodes, featureByCode);
      heldExtraCandidates = selection.heldExtraCandidates;
      console.log(
        `[pipeline] 保有銘柄の再評価対象: 保有${heldCodes.length}銘柄中、通常候補と重複${selection.duplicateCount}件を除き、追加${heldExtraCandidates.length}件をGemini対象に追加` +
          (selection.missingFeatureCodes.length > 0
            ? `（特徴量計算不可のためスキップ: ${selection.missingFeatureCodes.join(", ")}）`
            : "")
      );
    } catch (err) {
      apiErrorCounts.heldCodesFetch++;
      console.warn(`[pipeline] 保有銘柄の取得に失敗したため、保有銘柄の再評価はスキップして続行: ${err.message}`);
    }
  } else {
    console.log("[pipeline] CF_D1_DATABASE_ID未設定のため、保有銘柄の再評価はスキップ");
  }
  const heldExtraCodes = new Set(heldExtraCandidates.map((c) => c.code));
  // 財務データ取得・Gemini分析はこのcombinedCandidatesに対して行う。
  // geminiCandidates自体（通常候補選定ロジック・件数）は一切変更していないことに注意。
  const combinedCandidates = [...geminiCandidates, ...heldExtraCandidates];

  // --- Stage 4.5: 財務データ — Gemini対象銘柄(通常候補+保有銘柄追加分)にのみ、銘柄コード指定で取得 ---
  // 全銘柄(数千件)やスクリーニングプール(百件超)に対して行うと非現実的なため、
  // 実際にGeminiへ渡す少数の候補にのみ取得する。これはUNIVERSE_MODEに関わらず同じロジック。
  // 開示日(discDate)がcutoffDateより厳密に前のものだけを採用し、未来情報の混入を防ぐ。
  const financialsByCode = new Map();
  if (config.FINANCIALS.enabled) {
    const rawFinancialsByCode = new Map();
    for (const candidate of combinedCandidates) {
      try {
        const rows = await jquants.fetchFinancialsForCode(candidate.code);
        rawFinancialsByCode.set(candidate.code, rows);
      } catch (err) {
        // 財務データはあくまで補助的な特徴量。1銘柄の取得失敗でパイプライン全体を止めない。
        apiErrorCounts.jquantsFinancials++;
        console.warn(`[pipeline] 財務情報取得に失敗 code=${candidate.code}: ${err.message}`);
        rawFinancialsByCode.set(candidate.code, []);
      }
    }
    const available = buildAvailableFinancialsByCode(rawFinancialsByCode, cutoffDate);
    for (const [code, fin] of available.entries()) {
      financialsByCode.set(code, fin);
    }
    console.log(
      `[pipeline] financials: Gemini対象${combinedCandidates.length}銘柄中 ${available.size}銘柄で利用可能な開示情報あり`
    );
    await writeArtifact("financials.json", Object.fromEntries(available));
  } else {
    console.log("[pipeline] financials: config.FINANCIALS.enabled=falseのためスキップ");
  }
  for (const candidate of combinedCandidates) {
    candidate.financials = financialsByCode.get(candidate.code) ?? null;
  }

  // --- Stage 5: gemini — AI分析（通常候補+保有銘柄追加分。無料枠超過時は自動スキップ・リトライなし） ---
  const analysisResults = await analyzeCandidates(
    process.env.GEMINI_API_KEY,
    combinedCandidates,
    { cutoffDate, predictionExecutedAt }
  );
  apiErrorCounts.gemini429OrError = combinedCandidates.length - analysisResults.length;
  console.log(
    `[pipeline] gemini: ${analysisResults.length}/${combinedCandidates.length}件で分析成功（失敗/スキップ=${apiErrorCounts.gemini429OrError}件、うち保有銘柄追加分=${heldExtraCandidates.length}件）`
  );
  await writeArtifact("gemini-results.json", analysisResults);

  // --- Stage 6: ranking — 上位ランキングの作成 ---
  // 公開ランキング(KVの"ranking")は、保有銘柄の追加によって挙動が変わらないよう、
  // 従来通り通常候補(geminiCandidates)由来の結果のみを対象にする。
  // 保有銘柄追加分の評価結果自体は、後段でanalysisByCode/D1のai_evaluationsには含める
  // （/api/holdingsのlatestEvaluation等で使うため）。
  const rankingSourceResults = analysisResults.filter((r) => normalCandidateCodes.has(r.code));
  const ranking = [...rankingSourceResults]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, config.FINAL_RANKING_SIZE);
  await writeArtifact("ranking.json", ranking);

  const analysisByCode = {};
  for (const result of analysisResults) {
    analysisByCode[result.code] = result;
  }

  // 銘柄一覧（KV向け。1件のJSON blobとして保存するため、プールに関わらず
  // 特徴量が計算できた全銘柄分を含めてよい。全銘柄運用時は数千件になりうるが、
  // KVの1バリューあたりの上限(25MB)には収まる想定で、書き込み回数も1回のまま増えない）。
  const stocks = featureList.map((f) => {
    const info = listedInfoByCode.get(f.code);
    return {
      code: f.code,
      price: f.price,
      dataAsOf: f.dataAsOf,
      name: info?.name ?? null,
      market: info?.market ?? null,
    };
  });


  // 簡易株価(prices:{code})はコードごとに個別キーとして書き込むため、
  // 全銘柄分(grouped)を書き込むとKV無料枠の1日1,000書き込み上限を超過してしまう
  // （全銘柄モードでは実際に約3,900件書き込もうとして429エラーが発生した）。
  // D1向け保存(Stage 8)と同じ方針で、スクリーニングプール(pool)に残った銘柄のみに限定する。
  // poolCodesはStage 8のD1向けフィルタでも再利用する。
  const poolCodes = new Set(pool.map((p) => p.code));
  const pricesByCode = {};
  for (const code of poolCodes) {
    const rows = grouped.get(code);
    if (!rows) continue;
    // features.js が実際に参照するウィンドウ（最新+N営業日前まで）と一致させる
    pricesByCode[code] = rows.slice(-(config.FEATURE_LOOKBACK_TRADING_DAYS + 1));
  }

  const finishedAt = new Date();
  const processingTimeMs = finishedAt.getTime() - startedAt.getTime();
  const meta = {
    cutoffDate,
    cutoffSource: source,
    predictionExecutedAt,
    finishedAt: finishedAt.toISOString(),
    processingTimeMs,
    universeMode,
    fetchedCodeCount: groupedAll.size,
    universeCodeCount: grouped.size,
    featureCount: featureList.length,
    excludedByScreeningCount: excludedCount,
    poolCount: pool.length,
    geminiCandidateCount: geminiCandidates.length,
    heldExtraCandidateCount: heldExtraCandidates.length,
    analyzedCount: analysisResults.length,
    financialsFetchedCount: financialsByCode.size,
    listedInfoCount: listedInfoByCode.size,
    topixChangeNd,
    apiErrorCounts,
  };

  // --- Stage 7: Cloudflare KV へ保存（表示用データ + バックテスト用の追記履歴） ---
  const kv = new CloudflareKV({
    accountId: process.env.CF_ACCOUNT_ID,
    namespaceId: process.env.CF_KV_NAMESPACE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });
  await saveResultsToKV(kv, { meta, ranking, analysisByCode, stocks, pricesByCode });

  console.log("[pipeline] KVへの保存が正常終了しました。");

  // --- Stage 8: Cloudflare D1 へ保存（Phase2で追加。KVへの保存は上で完了済み） ---
  // 【重要・全銘柄運用時の設計】D1へのstock_prices/stocksの書き込みは、
  // 全銘柄(数千件)ではなく「スクリーニングプール(pool)に残った銘柄」のみに限定する。
  // 理由: D1は1クエリあたり100バインド変数までという制約があり、全銘柄×約41日分の
  // 生データをそのまま書き込もうとすると数万行規模になり、書き込みリクエスト数・
  // 処理時間の両面で非現実的になるため。プール銘柄程度の規模であれば無理なく収まる。
  // KVのprices:{code}もStage 7で同じくプール限定に修正済み（KV無料枠1日1,000書き込み対策）。
  // stocks（銘柄一覧のサマリ）だけは1件のJSON blobとして保存するため、全銘柄分を含めてよい。
  // poolCodesはStage 7で定義済み。pricesByCodeも既にプール限定で作成済みなのでそのままMap化する。
  const pricesByCodeForD1 = new Map(Object.entries(pricesByCode));
  const stocksForD1 = stocks.filter((s) => poolCodes.has(s.code));

  const d1Summary = await saveToD1(meta, {
    stocks: stocksForD1,
    pricesByCode: pricesByCodeForD1,
    financialsByCode,
    analysisResults,
    heldExtraCodes,
  });

  console.log(
    `[pipeline] 完了。処理時間: ${(processingTimeMs / 1000 / 60).toFixed(1)}分`
  );
  console.log(JSON.stringify({ ...meta, d1: d1Summary }, null, 2));
}

// このファイルが `node src/pipeline.js` として直接実行された場合のみmain()を起動する。
// import.meta.url チェックにより、テストコードから selectHeldExtraCandidates 等を
// import した際に誤ってパイプライン全体が起動してしまうことを防ぐ（実行時の挙動は変えない）。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[pipeline] 致命的エラー: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
