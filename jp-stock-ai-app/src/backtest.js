import { config } from "./config.js";

// このモジュールは Phase 1 のメインパイプラインには組み込まれていない。
// 「予測時点(T)から30営業日経過した後」に別途実行する評価バッチ用のロジックを
// 先行して用意しておくためのスキャフォールドである。
//
// 想定する将来のフロー:
//   1. 保存済みの予測（KVの history:{cutoffDate}:{code} など）を取得する
//   2. その銘柄について、T+30営業日時点までの実績株価をJ-Quantsから取得する
//      （このときも、取得する実績データの対象日 <= 評価実行日、という当たり前の制約だけを守ればよく、
//        予測生成時に使ったcutoffDateより過去のデータを再利用してはいけない、という制約はない
//        ＝評価用の未来データ取得と、予測生成用のcutoffDateフィルタ済み取得は明確に別処理として扱う）
//   3. evaluatePrediction() で hit 判定する
//   4. 結果を予測レコードに追記して保存する（既存の予測レコード自体は上書きせず、
//      evaluation用のレコードを別キーで追加保存することを推奨する）

/**
 * 1件の予測について、30営業日後の実績株価から評価を計算する。
 *
 * @param {object} prediction - { code, cutoffDate, price（予測時点の終値）, ... } を含む予測レコード
 * @param {Array<{date: string, close: number}>} futureQuotesSortedAsc
 *        cutoffDateより後の日付の日足データ（日付昇順）。ここには当然ながら
 *        「予測生成には使っていない」未来データが含まれるが、これは評価目的でのみ使用し、
 *        予測ロジック側には絶対に渡さないこと。
 * @returns {object|null} 評価結果。30営業日後のデータがまだ存在しない場合は null（評価対象外）
 */
export function evaluatePrediction(prediction, futureQuotesSortedAsc) {
  const horizon = config.BACKTEST.horizonTradingDays;
  const threshold = config.BACKTEST.hitThresholdPct;

  if (!prediction || prediction.price === undefined || prediction.price === null) {
    return null;
  }

  const futureRows = (futureQuotesSortedAsc || []).filter(
    (r) => r.date > prediction.cutoffDate
  );

  if (futureRows.length < horizon) {
    // まだ30営業日経過していない、またはデータが不足している場合は評価対象外
    return null;
  }

  const target = futureRows[horizon - 1]; // T+horizon営業日目の終値
  const futureReturn30d =
    ((target.close - prediction.price) / prediction.price) * 100;

  return {
    code: prediction.code,
    cutoffDate: prediction.cutoffDate,
    evaluationDate: target.date,
    futurePrice30d: target.close,
    futureReturn30d,
    hit: futureReturn30d >= threshold,
  };
}

/**
 * 複数の予測をまとめて評価する。
 * @param {Array<object>} predictions
 * @param {Map<string, Array<{date, close}>>} futureQuotesByCode
 * @returns {Array<object>} null を除いた評価結果の配列
 */
export function evaluatePredictions(predictions, futureQuotesByCode) {
  const results = [];
  for (const prediction of predictions) {
    const futureQuotes = futureQuotesByCode.get(prediction.code) || [];
    const evaluation = evaluatePrediction(prediction, futureQuotes);
    if (evaluation) results.push(evaluation);
  }
  return results;
}

/**
 * スコア帯ごとの的中率を集計する（将来的な「スコアが高いほど当たりやすいか」の検証用）。
 * @param {Array<object>} predictionsWithScore - { score, hit } を含む配列（evaluatePredictions結果とscoreをjoinしたもの）
 * @param {Array<[number, number]>} bands - 例: [[80,100],[70,79],[60,69]]
 */
export function summarizeHitRateByScoreBand(predictionsWithScore, bands) {
  return bands.map(([min, max]) => {
    const inBand = predictionsWithScore.filter(
      (p) => p.score >= min && p.score <= max
    );
    const hits = inBand.filter((p) => p.hit).length;
    return {
      band: `${min}-${max}`,
      count: inBand.length,
      hitRate: inBand.length ? (hits / inBand.length) * 100 : null,
    };
  });
}
