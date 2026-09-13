import { config } from "./config.js";
import { JQuantsClient } from "./jquants.js";
import { normalizeRawRows, groupByCode } from "./normalize.js";
import { computeFeatures } from "./features.js";
import { computeScreeningScore } from "./screening.js";
import { evaluatePrediction } from "./backtest.js";
import {
  pearsonCorrelation,
  computeQuantileBands,
  summarizeByBand,
  topNByDate,
} from "./analysis.js";
import { writeArtifact } from "./artifacts.js";

/**
 * 「スクリーニング複合スコアが、本当に将来の株価上昇と関係しているのか」を
 * 過去の複数時点で検証するための専用スクリプト（Phase「スクリーニングスコア妥当性検証」）。
 *
 * 通常の予測パイプライン(pipeline.js)・バックテスト評価(backtest-run.js)とは完全に独立しており、
 * - Gemini APIは一切呼び出さない（無料枠を消費しない）
 * - Cloudflare KVへの書き込みも行わない（分析専用、結果はartifactとログ出力のみ）
 *
 * 【無料枠への配慮】
 * 各銘柄コードについて「from/to範囲指定の1リクエスト」で全期間分の株価をまとめて取得し、
 * 複数のcutoffDateについてはその取得済みデータをメモリ上でスライスして再利用する。
 * つまりcutoffDateの数を増やしても、J-Quantsへのリクエスト数は
 * STOCK_UNIVERSEの銘柄数（現在10件）のまま変わらない。
 *
 * 【未来情報リーク防止】
 * 各cutoffDate = T について、computeFeatures()に渡すのは
 * 「T以前の日付の行だけを抽出した配列」であり、Tより後のデータは一切含まれない。
 * screeningScoreの計算にはこのfeatureオブジェクトしか使わないため、
 * リークの入り込む余地がない。評価用の未来データ（T+30営業日）は
 * 別の変数(futureRows)として明確に分離して扱う。
 */

// 検証に使う過去cutoffDate。J-Quants Freeの2年分データ保持期間内かつ、
// 今日から30営業日以上前（＝将来データが既に存在する）であることが必須。
// 環境変数 CUTOFF_DATES（カンマ区切り）で上書き可能。
const DEFAULT_CUTOFF_DATES = [
  "2025-09-01",
  "2025-11-03",
  "2026-01-05",
  "2026-03-02",
  "2026-04-15",
];

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const cutoffDates = (process.env.CUTOFF_DATES
    ? process.env.CUTOFF_DATES.split(",").map((s) => s.trim())
    : DEFAULT_CUTOFF_DATES
  ).sort();

  console.log(`[screening-backtest] 開始。対象cutoffDate: ${cutoffDates.join(", ")}`);
  console.log(`[screening-backtest] 対象銘柄: ${config.STOCK_UNIVERSE.join(", ")}`);
  console.log("[screening-backtest] Geminiは呼び出しません。");

  const jquants = new JQuantsClient(process.env.JQUANTS_API_KEY);

  // 最も古いcutoffDateの特徴量計算に必要な期間(FETCH_LOOKBACK_CALENDAR_DAYS)を遡った日付から、
  // 「今日」ではなく「J-Quants Freeプランが実際にデータを提供する上限（今日から約90日前）」までを取得する。
  // 【実データで判明】"to"に今日の日付をそのまま指定すると、Freeプランのデータ提供期間を
  // 超えているとして400エラーになる（実際の提供上限は今日から約84日前だった。安全マージンを見て90日前を使う）。
  const earliestNeeded = addDaysUTC(cutoffDates[0], -config.FETCH_LOOKBACK_CALENDAR_DAYS);
  const latestAvailable = addDaysUTC(
    new Date().toISOString().slice(0, 10),
    -config.JQUANTS_DELAY_DAYS
  );

  console.log(`[screening-backtest] 取得期間: ${earliestNeeded} 〜 ${latestAvailable}（銘柄ごとに1リクエスト）`);

  const seriesByCode = new Map();
  for (const code of config.STOCK_UNIVERSE) {
    try {
      const rawRows = await jquants.fetchDailyQuotesForCodeRange(
        code,
        earliestNeeded.replaceAll("-", ""),
        latestAvailable.replaceAll("-", "")
      );
      const normalized = normalizeRawRows(rawRows).filter((r) => r.code === code);
      const rows = groupByCode(normalized).get(code) || [];
      seriesByCode.set(code, rows);
      console.log(`[screening-backtest] ${code}: ${rows.length}件取得`);
    } catch (err) {
      console.warn(`[screening-backtest] ${code} の取得に失敗: ${err.message}`);
      seriesByCode.set(code, []);
    }
  }

  // --- 各cutoffDateについて、T以前のデータだけでfeatures+screeningScoreを計算 ---
  const samples = [];
  for (const cutoffDate of cutoffDates) {
    for (const code of config.STOCK_UNIVERSE) {
      const fullSeries = seriesByCode.get(code) || [];

      // 【リーク防止の核心】cutoffDate以前の行だけを抽出してから特徴量計算に渡す
      const pastRows = fullSeries.filter((r) => r.date <= cutoffDate);
      const feature = computeFeatures(code, pastRows);
      if (!feature) {
        console.log(`[screening-backtest] ${cutoffDate} ${code}: データ不足のためスキップ`);
        continue;
      }
      // TOPIXはFreeプランで取得不可のため、本番同様にnullのまま
      // （production同様、screeningScoreへの寄与は常に0になる）。
      feature.relativeStrength20d = null;

      const screeningScore = computeScreeningScore(feature);

      // 評価用の未来データ（Tより後の行のみ）。予測ロジック側には一切渡さない。
      const futureRows = fullSeries.filter((r) => r.date > cutoffDate);
      const evaluation = evaluatePrediction(
        { code, cutoffDate, price: feature.price },
        futureRows
      );

      if (!evaluation) {
        console.log(
          `[screening-backtest] ${cutoffDate} ${code}: 30営業日後のデータ不足のため評価対象外`
        );
        continue;
      }

      samples.push({
        code,
        cutoffDate,
        score: screeningScore,
        priceChange5d: feature.priceChange5d,
        priceChange20d: feature.priceChange20d,
        rsi14: feature.rsi14,
        volumeChange20d: feature.volumeChange20d,
        relativeStrength20d: feature.relativeStrength20d,
        futureReturn30d: evaluation.futureReturn30d,
        hit: evaluation.hit,
      });
    }
  }

  console.log(`[screening-backtest] 評価可能サンプル数: ${samples.length}`);

  if (samples.length < 5) {
    console.error(
      "[screening-backtest] サンプル数が少なすぎるため、統計的な分析は意味を持ちません。処理を中断します。"
    );
    await writeArtifact("screening-validation.json", { samples, note: "サンプル不足" });
    return;
  }

  // --- スコア帯別の集計（サンプル数に応じて動的に3分位で区切る） ---
  const numBands = samples.length >= 30 ? 4 : 3;
  const bands = computeQuantileBands(samples.map((s) => s.score), numBands);
  const bandSummary = summarizeByBand(samples, bands);

  // --- cutoffDateごとのTop N ---
  const topN = topNByDate(samples, [1, 3, 5, 10]);

  // --- 各指標(符号付き)と将来リターンの相関 ---
  const indicatorCorrelations = {
    screeningScore_vs_return: pearsonCorrelation(
      samples.map((s) => s.score),
      samples.map((s) => s.futureReturn30d)
    ),
    priceChange5d_vs_return: pearsonCorrelation(
      samples.map((s) => s.priceChange5d),
      samples.map((s) => s.futureReturn30d)
    ),
    priceChange20d_vs_return: pearsonCorrelation(
      samples.map((s) => s.priceChange20d),
      samples.map((s) => s.futureReturn30d)
    ),
    rsi14_vs_return: pearsonCorrelation(
      samples.map((s) => s.rsi14),
      samples.map((s) => s.futureReturn30d)
    ),
    volumeChange20d_vs_return: pearsonCorrelation(
      samples.map((s) => s.volumeChange20d),
      samples.map((s) => s.futureReturn30d)
    ),
  };

  const overallHitRate =
    (samples.filter((s) => s.hit).length / samples.length) * 100;
  const overallAvgReturn =
    samples.reduce((sum, s) => sum + s.futureReturn30d, 0) / samples.length;

  const report = {
    generatedAt: new Date().toISOString(),
    cutoffDatesUsed: cutoffDates,
    universeSize: config.STOCK_UNIVERSE.length,
    sampleCount: samples.length,
    note:
      samples.length < 50
        ? "サンプル数が少ないため（10銘柄構成）、統計的に十分ではありません。傾向の参考値としてのみ扱ってください。"
        : undefined,
    overallHitRatePct: overallHitRate,
    overallAvgReturnPct: overallAvgReturn,
    scoreBandSummary: bandSummary,
    topNByDate: topN,
    indicatorCorrelations,
    rawSamples: samples,
  };

  console.log("[screening-backtest] === 分析結果 ===");
  console.log(JSON.stringify({ ...report, rawSamples: undefined }, null, 2));

  await writeArtifact("screening-validation.json", report);
  console.log("[screening-backtest] 完了。data/screening-validation.json に保存しました。");
}

main().catch((err) => {
  console.error(`[screening-backtest] 致命的エラー: ${err.stack || err.message}`);
  process.exitCode = 1;
});
