import { D1Client } from "./d1.js";
import {
  saveStocksToD1,
  saveStockPricesToD1,
  saveFinancialsToD1,
  saveAiEvaluationsToD1,
} from "./d1Repository.js";

/**
 * パイプラインの結果をD1へ保存する。
 * 各テーブルの保存は独立してtry/catchし、1つが失敗しても他の保存は継続する。
 * @returns {Promise<object>} 保存件数と失敗内容のサマリー
 */
export async function saveToD1(meta, { stocks, pricesByCode, financialsByCode, analysisResults }) {
  const summary = {
    enabled: false,
    stocks: 0,
    stockPrices: 0,
    financials: 0,
    aiEvaluations: 0,
    savedEvaluationIds: [],
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
    const stocksToSave = stocks.map((s) => ({ code: s.code, name: s.name ?? null, market: s.market ?? null }));
    // ▼▼▼ 一時デバッグ（原因特定用。確認後に削除すること） ▼▼▼
    console.log(`[DEBUG-D1] saveToD1が受け取ったstocks.length = ${stocks.length}`);
    console.log(`[DEBUG-D1] saveToD1が受け取ったstocks先頭3件 =`, stocks.slice(0, 3));
    console.log(`[DEBUG-D1] saveStocksToD1へ渡すstocksToSave先頭3件 =`, stocksToSave.slice(0, 3));
    // ▲▲▲ 一時デバッグここまで ▲▲▲
    summary.stocks = await saveStocksToD1(d1, stocksToSave);
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

  // AI評価（常にINSERT。過去の評価を上書きしない）
  // evaluation_date: AIが評価を行った日（実行日）
  // data_as_of_date: 評価に使った市場データの基準日（cutoffDate）
  // generated_at:    実際に評価を生成した日時
  try {
    const evaluationDate = meta.predictionExecutedAt.slice(0, 10);
    const evaluations = analysisResults.map((r) => ({
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
      source: "pipeline",
      priceAtEvaluation: r.price ?? null,
    }));

    const { savedIds, failures } = await saveAiEvaluationsToD1(d1, evaluations);
    summary.aiEvaluations = savedIds.length;
    summary.savedEvaluationIds = savedIds;
    if (failures.length > 0) {
      for (const f of failures) {
        console.warn(`[pipeline] D1: ai_evaluations保存に失敗 code=${f.code}: ${f.error}`);
        summary.failures.push({ stage: "ai_evaluations", code: f.code, error: f.error });
      }
    }
  } catch (err) {
    console.warn(`[pipeline] D1: ai_evaluations保存で予期しないエラー: ${err.message}`);
    summary.failures.push({ stage: "ai_evaluations", error: err.message });
  }

  console.log(
    `[pipeline] D1保存完了: stocks=${summary.stocks}, stock_prices=${summary.stockPrices}, financials=${summary.financials}, ai_evaluations=${summary.aiEvaluations}, 失敗=${summary.failures.length}件`
  );
  return summary;
}
