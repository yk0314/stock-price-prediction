import { D1Client } from "./d1.js";
import {
  saveStocksToD1,
  saveStockPricesToD1,
  saveFinancialsToD1,
  saveAiEvaluationToD1,
} from "./d1Repository.js";

/**
 * Gemini分析結果1件を、D1保存用のai_evaluationsレコード形式に変換する。
 * evaluation_date: AIが評価を行った日（実行日）
 * data_as_of_date: 評価に使った市場データの基準日（cutoffDate）
 * generated_at:    実際に評価を生成した日時
 * 保有銘柄の再評価で追加された銘柄(通常のスクリーニング候補ではない)はsource="holding"、
 * それ以外(通常候補。保有中かどうかは問わない)は従来通りsource="pipeline"で区別する。
 */
export function buildEvaluationRecord(meta, r, heldExtraCodes) {
  const evaluationDate = meta.predictionExecutedAt.slice(0, 10);
  return {
    code: r.code,
    evaluationDate,
    dataAsOfDate: r.dataAsOf ?? meta.cutoffDate,
    generatedAt: meta.predictionExecutedAt,
    score: r.score ?? null,
    rating: r.rating ?? null,
    risk: r.risk ?? null,
    upsideProbability: r.upsideProbability ?? null,
    downsideRisk: r.downsideRisk ?? null,
    expectedReturn: r.expectedReturn ?? null,
    expectedHoldingDays: r.expectedHoldingDays ?? null,
    confidence: r.confidence ?? null,
    reasoning: r.reasoning ?? null,
    summary: r.summary ?? null,
    positiveFactors: r.positiveFactors ?? [],
    negativeFactors: r.negativeFactors ?? [],
    usedFeatures: r.usedFeatures ?? {},
    source: heldExtraCodes?.has(r.code) ? "holding" : "pipeline",
    priceAtEvaluation: r.price ?? null,
  };
}

/**
 * Gemini分析が1銘柄成功するたびに、その場でD1のai_evaluationsへ保存する（追記専用・常にINSERT）。
 * 150銘柄すべての分析が終わるまでメモリ上だけに結果を貯めておく設計は避け、
 * 1件ごとに確定的にD1へ書き込むことで、GitHub Actionsが途中で停止しても
 * そこまで成功した分析結果が失われないようにする。
 * @returns {Promise<number>} 保存されたレコードのid
 */
export async function saveEvaluationIncremental(d1, meta, analysisResult, heldExtraCodes) {
  const record = buildEvaluationRecord(meta, analysisResult, heldExtraCodes);
  return saveAiEvaluationToD1(d1, record);
}

/**
 * パイプラインの結果(stocks/stock_prices/financials)をD1へ保存する。
 * 各テーブルの保存は独立してtry/catchし、1つが失敗しても他の保存は継続する。
 *
 * 【設計変更】ai_evaluationsはこの関数ではもう保存しない。Gemini分析が1銘柄成功するたびに
 * saveEvaluationIncremental()でその場で即時保存する方式に変更したため
 * （150銘柄分をメモリに貯めてから最後に一括保存すると、GitHub Actions途中停止時に
 *  それまでの成功分析が全て失われてしまうため）。呼び出し側(pipeline.js)は、
 * 個別に集計したai_evaluationsの保存件数・失敗を、この関数が返すsummaryにマージすること。
 *
 * @returns {Promise<object>} 保存件数と失敗内容のサマリー（ai_evaluationsは含まない。呼び出し側でマージする）
 */
export async function saveToD1(meta, { stocks, pricesByCode, financialsByCode }) {
  const summary = {
    enabled: false,
    stocks: 0,
    stockPrices: 0,
    financials: 0,
    failures: [],
  };

  if (!process.env.CF_D1_DATABASE_ID) {
    console.warn(
      "[pipeline] CF_D1_DATABASE_IDが未設定のため、D1保存をスキップします（KVへの保存は完了済み）"
    );
    return summary;
  }

  let d1;
  try {
    d1 = new D1Client({
      accountId: process.env.CF_ACCOUNT_ID,
      databaseId: process.env.CF_D1_DATABASE_ID,
      apiToken: process.env.CF_API_TOKEN,
    });
    summary.enabled = true;
  } catch (err) {
    console.warn(`[pipeline] D1クライアントの初期化に失敗したためD1保存をスキップ: ${err.message}`);
    summary.failures.push({ stage: "init", error: err.message });
    return summary;
  }

  // 銘柄マスタ。name/marketはStep6でjquants.fetchListedInfo()の結果をpipeline.js側で
  // stocksに付与するようになったため、渡されたものをそのまま保存する
  // （未取得の場合はs.name/s.marketがundefinedのままなのでnullとして保存される）。
  try {
    summary.stocks = await saveStocksToD1(
      d1,
      stocks.map((s) => ({ code: s.code, name: s.name ?? null, market: s.market ?? null }))
    );
  } catch (err) {
    console.warn(`[pipeline] D1: stocks保存に失敗: ${err.message}`);
    summary.failures.push({ stage: "stocks", error: err.message });
  }

  // 株価履歴。pricesByCodeは呼び出し側(pipeline.js)からMapとして渡される契約になっている。
  // 【過去のバグ】以前はここで new Map(Object.entries(pricesByCode)) と二重変換していたため、
  // 呼び出し側がMapを渡すよう変更された後もこの変換が残っており、
  // Object.entries(Mapインスタンス) が常に空配列を返すことで stock_prices が常に0件保存になっていた
  // （実データ検証で発覚）。pricesByCodeは常にMapとして扱い、ここでは変換しない。
  try {
    summary.stockPrices = await saveStockPricesToD1(d1, pricesByCode);
  } catch (err) {
    console.warn(`[pipeline] D1: stock_prices保存に失敗: ${err.message}`);
    summary.failures.push({ stage: "stock_prices", error: err.message });
  }

  // 財務データ（cutoffDate時点で開示済みのもののみ。financials.js側でフィルタ済み）
  try {
    summary.financials = await saveFinancialsToD1(d1, financialsByCode);
  } catch (err) {
    console.warn(`[pipeline] D1: financials保存に失敗: ${err.message}`);
    summary.failures.push({ stage: "financials", error: err.message });
  }

  console.log(
    `[pipeline] D1保存完了(stocks/stock_prices/financials): stocks=${summary.stocks}, stock_prices=${summary.stockPrices}, financials=${summary.financials}, 失敗=${summary.failures.length}件`
  );
  return summary;
}
