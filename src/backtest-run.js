import { config } from "./config.js";
import { CloudflareKV } from "./kv.js";
import { JQuantsClient } from "./jquants.js";
import { normalizeRawRows, groupByCode } from "./normalize.js";
import { evaluatePredictions, summarizeHitRateByScoreBand } from "./backtest.js";
import { writeArtifact } from "./artifacts.js";

/**
 * このスクリプトはメインの予測パイプライン(pipeline.js)とは別に、
 * 手動実行（workflow_dispatch）でのみ動かすことを想定している。
 *
 * 処理内容:
 * 1. KVから "history:{cutoffDate}:{code}" キーを全て取得する（＝過去の予測記録）
 * 2. 予測に登場した銘柄コードについてのみ、J-Quantsから実績株価を取得する
 *    （全銘柄ループではなく、過去に予測した銘柄だけに限定するため無料枠への影響は小さい）
 * 3. 各予測について、cutoffDateから30営業日後の実績リターンを計算し、
 *    +5%以上なら hit=true とする（30営業日分のデータがまだ無ければ評価対象外）
 * 4. 総予測数・評価可能数・Hit率・平均/中央値リターン・スコア帯別Hit率を集計する
 * 5. 結果を KV の "backtest-summary" キーに保存する
 *
 * 【未来情報リーク対策】
 * ここで取得する実績株価は「評価のためだけ」に使うものであり、
 * 予測ロジック（pipeline.js側）には一切渡さない。データフローを明確に分離している。
 */

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  console.log("[backtest] 開始");

  const kv = new CloudflareKV({
    accountId: process.env.CF_ACCOUNT_ID,
    namespaceId: process.env.CF_KV_NAMESPACE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });

  const historyKeys = await kv.listKeys("history:");
  console.log(`[backtest] 予測履歴キー: ${historyKeys.length}件`);

  if (historyKeys.length === 0) {
    console.log("[backtest] 履歴が1件もありません。まだ評価できる予測がないため終了します。");
    return;
  }

  const predictions = [];
  for (const key of historyKeys) {
    const value = await kv.get(key);
    if (value) predictions.push(value);
  }

  const codes = [...new Set(predictions.map((p) => p.code))];
  console.log(`[backtest] 対象銘柄: ${codes.length}銘柄`);

  const jquants = new JQuantsClient(process.env.JQUANTS_API_KEY);
  const earliestCutoff = predictions.reduce(
    (min, p) => (p.cutoffDate < min ? p.cutoffDate : min),
    predictions[0].cutoffDate
  );
  const todayStr = new Date().toISOString().slice(0, 10);

  const futureQuotesByCode = new Map();
  for (const code of codes) {
    try {
      const rows = await jquants.fetchDailyQuotesForCodeRange(
        code,
        earliestCutoff.replaceAll("-", ""),
        todayStr.replaceAll("-", "")
      );
      const normalized = normalizeRawRows(rows).filter((r) => r.code === code);
      const grouped = groupByCode(normalized).get(code) || [];
      futureQuotesByCode.set(code, grouped);
      console.log(`[backtest] ${code}: 実績${grouped.length}件取得`);
    } catch (err) {
      console.warn(`[backtest] ${code} の実績取得に失敗: ${err.message}`);
      futureQuotesByCode.set(code, []);
    }
  }

  const evaluations = evaluatePredictions(predictions, futureQuotesByCode);
  console.log(`[backtest] 評価可能な予測: ${evaluations.length}/${predictions.length}件`);

  const predictionByCodeAndCutoff = new Map(
    predictions.map((p) => [`${p.code}:${p.cutoffDate}`, p])
  );
  const evaluationsWithScore = evaluations.map((e) => {
    const pred = predictionByCodeAndCutoff.get(`${e.code}:${e.cutoffDate}`);
    return { ...e, score: pred?.score ?? null };
  });

  const hits = evaluationsWithScore.filter((e) => e.hit);
  const returns = evaluationsWithScore.map((e) => e.futureReturn30d);

  const summary = {
    generatedAt: new Date().toISOString(),
    totalPredictions: predictions.length,
    evaluablePredictions: evaluationsWithScore.length,
    hitCount: hits.length,
    missCount: evaluationsWithScore.length - hits.length,
    hitRatePct: evaluationsWithScore.length
      ? (hits.length / evaluationsWithScore.length) * 100
      : null,
    avgReturnPct: returns.length
      ? returns.reduce((s, v) => s + v, 0) / returns.length
      : null,
    medianReturnPct: median(returns),
    maxReturnPct: returns.length ? Math.max(...returns) : null,
    minReturnPct: returns.length ? Math.min(...returns) : null,
    scoreBandBreakdown: summarizeHitRateByScoreBand(
      evaluationsWithScore.filter((e) => e.score !== null),
      config.BACKTEST.scoreBands
    ),
  };

  console.log("[backtest] 集計結果:");
  console.log(JSON.stringify(summary, null, 2));

  await writeArtifact("backtest-summary.json", summary);
  await kv.put("backtest-summary", summary);

  console.log("[backtest] 完了。KVに backtest-summary として保存しました。");
}

main().catch((err) => {
  console.error(`[backtest] 致命的エラー: ${err.stack || err.message}`);
  process.exitCode = 1;
});
