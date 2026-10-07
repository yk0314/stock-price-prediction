import { config } from "./config.js";
import { resolveLatestAvailableDate, jstDateString } from "./cutoff.js";
import { JQuantsClient } from "./jquants.js";
import { addDays, parseTradingCalendar, tradingDaysBetween, weekdayDates } from "./tradingCalendar.js";
import { filterByListedMarket } from "./universe.js";
import { buildPriceRow, filterUnsyncedPriceRows, loadSyncedDates, syncStocksMaster, upsertPriceRows } from "./d1Sync.js";
import { readWrittenToday, recordWrittenToday, shouldSkipNonEssentialWrites, utcDay } from "./d1Budget.js";
import { normalizeRawRows, groupByCode } from "./normalize.js";
import { computeFeaturesForAll } from "./features.js";
import { screenToPool, selectGeminiCandidates } from "./screening.js";
import { analyzeCandidates } from "./gemini.js";
import { CloudflareKV, saveResultsToKV, saveMarketDataToKV } from "./kv.js";
import { saveToD1, saveEvaluationIncremental } from "./pipelineD1.js";
import { writeArtifact } from "./artifacts.js";
import { fetchTopixForRange, computeMarketFeatures, computeRelativeStrength } from "./market.js";
import { buildAvailableFinancialsByCode } from "./financials.js";
import { buildListedInfoByCode } from "./listedInfo.js";
import { D1Client } from "./d1.js";
import { fetchHeldCodes, logErrorToD1 } from "./d1Repository.js";

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

/**
 * Gemini処理順は「①保有銘柄 → ②新規候補」。保有銘柄は既存仕様どおり必ず再評価対象にし、
 * 通常候補と重複する銘柄(=元々geminiCandidatesに含まれていた保有銘柄)は二重に送らない
 * （heldExtraCandidatesは元々selectHeldExtraCandidates()で重複を除いた「追加分」のみなので、
 *  単純に前後を入れ替えて連結するだけでよい）。
 * 各候補には isHeld フラグを付与する。heldExtraCandidatesだけでなく、通常候補の中に
 * 元々保有銘柄が含まれていた場合(重複ケース)も正しくisHeld=trueにするため、
 * allHeldCodes(保有銘柄の全量)との突き合わせで判定する
 * （Geminiプロンプトの出し分け=買う価値判定の要否に使う）。
 * 渡された候補オブジェクトを直接書き換える(mutate)点に注意。
 */
export function buildCombinedCandidates(heldExtraCandidates, geminiCandidates, allHeldCodes) {
  const combined = [...heldExtraCandidates, ...geminiCandidates];
  for (const candidate of combined) {
    candidate.isHeld = allHeldCodes.has(candidate.code);
  }
  return combined;
}

async function main() {
  const startedAt = new Date();
  const predictionExecutedAt = startedAt.toISOString();
  const universeMode = getUniverseMode();
  console.log(`[pipeline] 開始: ${predictionExecutedAt} (UNIVERSE_MODE=${universeMode})`);

  // API呼び出し中に発生したエラー件数を種類別に集計する（検証項目「APIエラー数」用）。
  const apiErrorCounts = { jquantsFinancials: 0, topix: 0, gemini429OrError: 0, listedInfo: 0, heldCodesFetch: 0 };

  // D1クライアントは先頭で1つだけ生成し、J-Quantsの再試行・失敗の記録、保有銘柄の取得、
  // Gemini結果の即時保存、エラーログ記録の各所で使い回す
  // (Stage 8のsaveToD1は従来通り独自にクライアントを生成する)。
  const d1 = process.env.CF_D1_DATABASE_ID
    ? new D1Client({
        accountId: process.env.CF_ACCOUNT_ID,
        databaseId: process.env.CF_D1_DATABASE_ID,
        apiToken: process.env.CF_API_TOKEN,
      })
    : null;

  // D1の今日(UTC)の書き込み量(全ジョブの合計)。Cloudflare D1の無料枠(1日10万行)の残りが少ないときは、
  // 必須ではない書き込み(銘柄マスタの同期・プール銘柄の株価)を省略し、AI評価・財務・エラーログに残りを回す。
  // 台帳(d1_write_ledger)が読めない(migration 0005未適用など)ときは、省略せず従来どおり動く。
  const ledgerDay = utcDay(startedAt);
  const writtenToday = d1 ? await readWrittenToday(d1, ledgerDay) : null;
  const skipNonEssentialD1 = shouldSkipNonEssentialWrites({
    usedToday: writtenToday,
    dailyTotal: config.D1_WRITE.dailyTotalBudget,
    minRemaining: config.D1_WRITE.pipelineMinRemaining,
  });
  if (writtenToday !== null) {
    console.log(`[pipeline] D1の今日(UTC ${ledgerDay})の書き込み: 実行前の合計 ${writtenToday}行 / 予算 ${config.D1_WRITE.dailyTotalBudget}行`);
  }
  if (skipNonEssentialD1) {
    console.warn("[pipeline] D1の今日の書き込みの残りが少ないため、銘柄マスタの同期・プール銘柄の株価の保存を省略します（AI評価・財務は保存します）");
  }

  // J-Quants APIの再試行(429/5xx/ネットワーク/タイムアウト)と失敗を溜めておき、あとでerror_logsへ記録する
  // (クライアントのコールバックは同期のため、ここでは配列に積むだけにする)。
  const jquantsEvents = [];
  const flushJquantsEvents = async () => {
    if (!d1 || jquantsEvents.length === 0) return;
    const events = jquantsEvents.splice(0, jquantsEvents.length).slice(0, 50); // 1回の実行で記録するのは最大50件
    for (const ev of events) {
      try {
        await logErrorToD1(d1, {
          source: "jquants",
          errorType: `${ev.type}_${ev.kind ?? "unknown"}`,
          message: ev.message ?? "",
          context: { path: ev.path, status: ev.status, attempt: ev.attempt, waitMs: ev.waitMs },
        });
      } catch {
        // エラーログの記録自体が失敗しても、パイプライン全体は継続する
      }
    }
  };

  const jquants = new JQuantsClient(process.env.JQUANTS_API_KEY, {
    onEvent: (ev) => jquantsEvents.push(ev),
  });

  // --- Stage 0: データ基準日(cutoffDate)の決定 ---
  // 手動指定(CUTOFF_DATE)があればそれを使う。無ければ、J-Quantsから実際に取得できた「最新の取引日」を
  // 動的に判定する(無料プランの「実行日-84日」のような固定値は使わない)。
  // 取引日は取引カレンダー(/markets/calendar)で判定し、取得できなければ平日のみで判定する。
  const manualCutoff = process.env.CUTOFF_DATE || undefined;
  const todayJst = jstDateString(startedAt);
  let tradingDays = [];
  try {
    const calendarRows = await jquants.fetchTradingCalendar(addDays(todayJst, -(config.FETCH_LOOKBACK_CALENDAR_DAYS + 40)), todayJst);
    tradingDays = parseTradingCalendar(calendarRows);
    console.log(`[pipeline] 取引カレンダー: 取引日${tradingDays.length}日分を取得`);
  } catch (err) {
    console.warn(`[pipeline] 取引カレンダーの取得に失敗したため、平日のみで取引日を判定します: ${err.message}`);
  }

  let resolved;
  try {
    resolved = await resolveLatestAvailableDate(jquants, { manualCutoffDate: manualCutoff, now: startedAt, tradingDays });
  } catch (err) {
    await flushJquantsEvents();
    throw err;
  }
  const { cutoffDate, source } = resolved;
  console.log(`[pipeline] cutoffDate(データ基準日) = ${cutoffDate} (source: ${source}${resolved.probes.length ? `, 確認した日付: ${resolved.probes.map((p) => `${p.date}=${p.outcome}`).join(" / ")}` : ""})`);

  const fetchStartDate = addDaysUTC(cutoffDate, -config.FETCH_LOOKBACK_CALENDAR_DAYS);

  // --- Stage 1: raw data — J-Quants から日付ベースで一括取得（1銘柄ずつのループは行わない） ---
  // 取引日(祝日を除く)だけを対象にし、最新日の判定で取得済みのデータは再取得せず使い回す。
  const windowDates = tradingDays.length > 0
    ? tradingDaysBetween(tradingDays, fetchStartDate, cutoffDate)
    : weekdayDates(fetchStartDate, cutoffDate);
  let rawRows;
  try {
    rawRows = await jquants.fetchDailyQuotesForDates(windowDates, cutoffDate, {
      prefetched: resolved.rows ? { [cutoffDate]: resolved.rows } : {},
    });
  } catch (err) {
    await flushJquantsEvents();
    throw err;
  }
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

  // 銘柄マスタ(全銘柄)をD1のstocksへ同期する。新規・変更があった銘柄だけを書き込むため、日々の書き込みはほぼ0。
  // (以前はスクリーニングプールの銘柄だけがD1に入っていた。ユニバース全体のマスタを持つことで、
  //  バックテストや銘柄検索でプール外の銘柄も参照できる)
  if (d1 && listedInfoByCode.size > 0 && !skipNonEssentialD1) {
    try {
      const masterResult = await syncStocksMaster({ d1, listedInfoByCode });
      console.log(`[pipeline] D1 銘柄マスタ同期: 全${masterResult.total}銘柄中、新規・変更${masterResult.written}件を書き込み`);
    } catch (err) {
      console.warn(`[pipeline] D1への銘柄マスタ同期に失敗(続行): ${err.message}`);
    }
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
  let grouped = applyUniverseFilter(groupedAll, universeMode);
  let marketFilterSummary = null;
  if (universeMode === "all") {
    // 「全銘柄」でも、ETF・REIT・TOKYO PRO MARKET等(市場区分: その他/TOKYO PRO MARKET)は
    // 短期売買の対象外のため除外する(config.UNIVERSE_MARKETS / 環境変数 UNIVERSE_MARKETS で変更可能)
    const marketFiltered = filterByListedMarket(grouped, listedInfoByCode, config.UNIVERSE_MARKETS);
    grouped = marketFiltered.grouped;
    marketFilterSummary = marketFiltered.summary;
    console.log(`[pipeline] 市場区分フィルタ: ${JSON.stringify(marketFilterSummary)}`);
  }
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
    // 市場環境データのD1(index_prices)への蓄積は、始値・高値・安値を含む生データを使う scripts/sync-prices.js が行う
    // (ここの topixRows は終値のみの正規化済みデータのため、保存すると始値等が欠けた行で上書きしてしまう)
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
  let allHeldCodes = new Set();
  let heldOnlyFeatures = []; // ユニバースの外にある保有銘柄の特徴量(スクリーニングの対象には加えない)
  if (d1) {
    try {
      const heldCodes = await fetchHeldCodes(d1);
      allHeldCodes = new Set(heldCodes);

      // 保有銘柄は、ユニバースの外(phase1_subsetの10銘柄・全銘柄モードの市場区分フィルタで除外された銘柄など)にあっても
      // 毎日再評価できるよう、株価データ(groupedAll)があれば、特徴量をここで別途計算する。
      // (計算できないと「特徴量計算不可のためスキップ」になり、保有しているのに再評価されなくなる)
      const outsideHeld = heldCodes.filter((code) => !featureByCode.has(code) && groupedAll.has(code));
      if (outsideHeld.length > 0) {
        heldOnlyFeatures = computeFeaturesForAll(new Map(outsideHeld.map((code) => [code, groupedAll.get(code)])));
        for (const f of heldOnlyFeatures) {
          f.relativeStrength20d = computeRelativeStrength(f.priceChange20d, topixChangeNd);
          featureByCode.set(f.code, f);
        }
        console.log(
          `[pipeline] ユニバース外の保有銘柄${outsideHeld.length}件の特徴量を別途計算: ${heldOnlyFeatures.length}件で計算成功`
        );
      }
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
  const combinedCandidates = buildCombinedCandidates(heldExtraCandidates, geminiCandidates, allHeldCodes);

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
    // Geminiプロンプトに企業名を渡し、出力される企業名との突き合わせ(明らかな矛盾の検知)に使う。
    // 取得できていない場合はnullのままでよい(gemini.js側はnameが無ければ突き合わせをスキップする)。
    candidate.name = listedInfoByCode.get(candidate.code)?.name ?? null;
  }

  // --- Stage 4.9: Gemini評価に依存しないデータの保存（Gemini処理より前に実行する） ---
  // Gemini処理は2時間以上かかるため、途中終了(timeout等)しても現在価格・銘柄名・株価履歴・財務データは
  // 更新済みになるよう、Gemini処理(Stage 5)より前に保存する。
  // ranking / analysis / history / meta は従来どおりGemini完了後(Stage 7)に保存する。
  // ここでの保存に失敗しても警告にとどめ、Gemini処理は続行する（補助的な保存で全体を止めない）。

  // 銘柄一覧（KV向け。1件のJSON blobとして保存するため、プールに関わらず
  // 特徴量が計算できた全銘柄分を含めてよい。全銘柄運用時は数千件になりうるが、
  // KVの1バリューあたりの上限(25MB)には収まる想定で、書き込み回数も1回のまま増えない）。
  // 保有銘柄(ユニバース外のものを含む)も含める。保有銘柄画面の現在価格・銘柄名がこの一覧に依存するため。
  const stocks = [...featureList, ...heldOnlyFeatures].map((f) => {
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
  // D1向け保存と同じ方針で、スクリーニングプール(pool)に残った銘柄のみに限定する。
  const poolCodes = new Set(pool.map((p) => p.code));
  const pricesByCode = {};
  for (const code of poolCodes) {
    const rows = grouped.get(code);
    if (!rows) continue;
    // features.js が実際に参照するウィンドウ（最新+N営業日前まで）と一致させる
    pricesByCode[code] = rows.slice(-(config.FEATURE_LOOKBACK_TRADING_DAYS + 1));
  }

  let kvClient = null;
  try {
    kvClient = new CloudflareKV({
      accountId: process.env.CF_ACCOUNT_ID,
      namespaceId: process.env.CF_KV_NAMESPACE_ID,
      apiToken: process.env.CF_API_TOKEN,
    });
    await saveMarketDataToKV(kvClient, { stocks, pricesByCode });
    console.log("[pipeline] KV: stocks / prices を保存しました（Gemini処理の前）");
  } catch (err) {
    console.warn(`[pipeline] KV: stocks / prices の事前保存に失敗（Gemini処理は続行）: ${err.message}`);
  }

  // D1: stocks / stock_prices / financials（プール銘柄のみ。全銘柄保存はしない）。
  // 【重要・全銘柄運用時の設計】D1は1クエリあたり100バインド変数までという制約があり、
  // 全銘柄×約41日分の生データをそのまま書き込むと数万行規模になり非現実的なため、
  // 「スクリーニングプール(pool)に残った銘柄」のみに限定する。
  // saveToD1()の第1引数metaは関数内で使われていないため、最小限の値だけ渡す。
  // stock_pricesは、全銘柄の蓄積(scripts/sync-prices.js)と同じ形式(始値・調整係数・売買代金を含む行)で、
  // J-Quantsの生データからプール銘柄分を保存する(saveToD1には株価を渡さない)。
  const stocksForD1 = stocks.filter((s) => poolCodes.has(s.code));
  let d1Summary;
  try {
    d1Summary = await saveToD1(
      { cutoffDate, predictionExecutedAt },
      { stocks: stocksForD1, pricesByCode: new Map(), financialsByCode }
    );
    if (d1 && !skipNonEssentialD1) {
      const fetchedAtIso = new Date().toISOString();
      const poolRowsAll = rawRows
        .map((r) => buildPriceRow(r, fetchedAtIso))
        .filter((row) => row && poolCodes.has(row[0]));
      // 全銘柄の蓄積(sync-prices.js)が完了している日付は、そちらが保存済みのため二重に書き込まない(D1の書き込み行数の節約)。
      // 蓄積済みの日付を取得できなければ、従来どおり全件を書き込む。
      let syncedDates = new Set();
      try {
        syncedDates = await loadSyncedDates(d1);
      } catch (syncErr) {
        console.warn(`[pipeline] D1 price_sync_dates を読めないため、プール銘柄の株価は全件書き込みます: ${syncErr.message}`);
      }
      const poolPriceRows = filterUnsyncedPriceRows(poolRowsAll, syncedDates);
      await upsertPriceRows(d1, poolPriceRows, { rowsPerRequest: config.PRICE_SYNC.rowsPerRequest });
      d1Summary.stockPrices = poolPriceRows.length;
      console.log(
        `[pipeline] D1 stock_prices(プール${poolCodes.size}銘柄): ${poolPriceRows.length}行を保存` +
          `（蓄積済みの日付の${poolRowsAll.length - poolPriceRows.length}行は省略）`
      );
    }
  } catch (err) {
    console.warn(`[pipeline] D1: stocks / stock_prices / financials の事前保存に失敗（Gemini処理は続行）: ${err.message}`);
    // saveToD1が成功した後の処理(プール株価など)で失敗した場合は、saveToD1の結果(保存済みの件数)を残して失敗だけを追記する
    d1Summary = d1Summary ?? { enabled: false, stocks: 0, stockPrices: 0, financials: 0, failures: [] };
    d1Summary.failures.push({ stage: "pre_gemini_save", error: err.message });
  }

  // --- Stage 5: gemini — AI分析（通常候補+保有銘柄追加分。1リクエスト=1銘柄。429/503は設定回数までリトライ） ---
  // 1銘柄成功するたびにD1のai_evaluationsへ即時保存する（150銘柄分をメモリに貯めてから
  // 最後に一括保存すると、GitHub Actionsが途中で停止した際にそれまでの成功分が全て失われるため）。
  // metaForEval は Stage 7 で組み立てる本物の meta より前に必要なため、ここでは
  // buildEvaluationRecord()が実際に使うフィールド(predictionExecutedAt/cutoffDate)だけを持つ
  // 最小限のオブジェクトとして渡す。
  const metaForEval = { predictionExecutedAt, cutoffDate };
  let aiEvaluationsSavedCount = 0;
  const savedEvaluationIds = [];
  const aiEvaluationFailures = [];

  const analysisResults = await analyzeCandidates(
    process.env.GEMINI_API_KEY,
    combinedCandidates,
    { cutoffDate, predictionExecutedAt },
    {
      onCandidateComplete: async (outcome) => {
        if (!d1) return; // D1未接続時は即時保存もエラーログ記録もできないため何もしない
        if (outcome.excluded) {
          // 新規候補が「買う価値なし」と判定されただけであり、エラーではない。
          // 正常評価としてD1に保存する必要はなく、error_logsに記録する必要もない。
          return;
        }
        if (outcome.success) {
          try {
            const id = await saveEvaluationIncremental(d1, metaForEval, outcome.result, heldExtraCodes);
            savedEvaluationIds.push(id);
            aiEvaluationsSavedCount++;
          } catch (err) {
            console.warn(`[pipeline] D1: ai_evaluations即時保存に失敗 code=${outcome.code}: ${err.message}`);
            aiEvaluationFailures.push({ code: outcome.code, error: err.message, result: outcome.result });
          }
        } else {
          try {
            await logErrorToD1(d1, {
              source: "gemini",
              errorType: outcome.lastError?.status ? `http_${outcome.lastError.status}` : "analysis_failed",
              message: outcome.lastError?.message ?? outcome.validationErrors.join(" / ") ?? "unknown error",
              context: {
                code: outcome.code,
                attempts: outcome.attempts,
                statusCounts: outcome.statusCounts,
                validationErrors: outcome.validationErrors,
              },
            });
          } catch (err) {
            // エラーログの記録自体が失敗しても、パイプライン全体は継続する
            console.warn(`[pipeline] D1: error_logsへの記録に失敗 code=${outcome.code}: ${err.message}`);
          }
        }
      },
    }
  );
  apiErrorCounts.gemini429OrError = combinedCandidates.length - analysisResults.length;
  console.log(
    `[pipeline] gemini: ${analysisResults.length}/${combinedCandidates.length}件で分析成功（失敗/スキップ=${apiErrorCounts.gemini429OrError}件、うち保有銘柄追加分=${heldExtraCandidates.length}件）`
  );
  await writeArtifact("gemini-results.json", analysisResults);

  // D1への保存に失敗したAI評価は、書き込み上限(無料枠)が原因でなければ、最後に1回だけ再試行する。
  // 上限が原因のときは、再試行しても失敗するため行わない(評価の内容はKVの history:{cutoffDate}:{code} に保存される)。
  if (d1 && aiEvaluationFailures.length > 0) {
    if (d1.stats.quotaExceeded) {
      console.warn(
        `[pipeline] D1の書き込み上限に達したため、${aiEvaluationFailures.length}件のAI評価をD1に保存できませんでした` +
          `（評価内容はKVのhistory:*と、artifactのgemini-results.jsonに残っています。UTCの0時=日本時間9時以降に再保存が必要です）`
      );
    } else {
      const stillFailing = [];
      for (const f of aiEvaluationFailures) {
        try {
          savedEvaluationIds.push(await saveEvaluationIncremental(d1, metaForEval, f.result, heldExtraCodes));
          aiEvaluationsSavedCount++;
        } catch (retryErr) {
          stillFailing.push({ ...f, error: retryErr.message });
        }
      }
      console.log(`[pipeline] D1へのAI評価の保存を再試行: ${aiEvaluationFailures.length - stillFailing.length}/${aiEvaluationFailures.length}件が成功`);
      aiEvaluationFailures.length = 0;
      aiEvaluationFailures.push(...stillFailing);
    }
  }

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
    // J-Quants有料化後に追加した情報(データ基準日の判定結果・取得量・使用プラン)
    jquantsPlan: config.JQUANTS_PLAN,
    latestDateProbes: resolved.probes,
    tradingDayCountInWindow: windowDates.length,
    marketFilter: marketFilterSummary,
    jquantsStats: { ...jquants.stats },
    d1WrittenTodayBeforeRun: writtenToday,
    d1SkippedNonEssentialWrites: skipNonEssentialD1,
    d1QuotaExceeded: d1 ? d1.stats.quotaExceeded : false,
  };

  // --- Stage 7: Cloudflare KV へ保存（ranking / analysis / history / meta） ---
  // stocks と prices:{code} は Stage 4.9 で保存済みのため、ここでは渡さない
  // （saveResultsToKV は stocks / pricesByCode が未指定なら書き込まない）。
  const kv =
    kvClient ??
    new CloudflareKV({
      accountId: process.env.CF_ACCOUNT_ID,
      namespaceId: process.env.CF_KV_NAMESPACE_ID,
      apiToken: process.env.CF_API_TOKEN,
    });
  await saveResultsToKV(kv, { meta, ranking, analysisByCode });

  console.log("[pipeline] KVへの保存が正常終了しました。");

  // --- Stage 8: Cloudflare D1 ---
  // stocks / stock_prices / financials は Stage 4.9（Gemini処理の前）で保存済み。
  // ai_evaluationsは Stage 5 で1銘柄ずつ即時保存済みのため、ここでは
  // その集計結果をsaveToD1()の戻り値(stocks/stock_prices/financialsのみ)にマージするだけでよい。
  d1Summary.aiEvaluations = aiEvaluationsSavedCount;
  d1Summary.savedEvaluationIds = savedEvaluationIds;
  if (aiEvaluationFailures.length > 0) {
    d1Summary.failures.push(
      ...aiEvaluationFailures.map((f) => ({ stage: "ai_evaluations", code: f.code, error: f.error }))
    );
  }

  await flushJquantsEvents(); // J-Quantsの再試行・失敗(あれば)をerror_logsへ記録

  // この実行のD1の書き込み行数を台帳に加算する(次のジョブが、今日(UTC)の残りから予算を決めるため)。
  // saveToD1は別のクライアントを使うため、その分(stocks・financials)は1行あたり3行分として見積もって加える。
  if (d1) {
    const estimatedRows = d1.stats.rowsWritten + ((d1Summary.stocks ?? 0) + (d1Summary.financials ?? 0)) * 3;
    await recordWrittenToday(d1, { day: ledgerDay, job: "pipeline", rows: estimatedRows });
  }

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
