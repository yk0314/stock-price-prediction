// スクリーニングスコアの妥当性検証用の分析ユーティリティ。
// 既存の src/backtest.js（Gemini予測の的中率評価）とは目的を分けて新規ファイルにしている
// （既存のバックテスト機能に影響を与えないため）。

/**
 * ピアソンの積率相関係数を計算する。
 * 「この指標が高いほど、本当に将来リターンが高いのか」を定量的に見るために使う。
 * @returns {number|null} -1〜1。データ不足時はnull
 */
export function pearsonCorrelation(xs, ys) {
  const pairs = xs
    .map((x, i) => [x, ys[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) return null;

  const xsF = pairs.map((p) => p[0]);
  const ysF = pairs.map((p) => p[1]);
  const meanX = xsF.reduce((s, v) => s + v, 0) / n;
  const meanY = ysF.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xsF[i] - meanX;
    const dy = ysF[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * スコアの分布から、サンプル数に応じた分位(quantile)バンドを作る。
 * computeScreeningScore()は0-100に正規化されていない開放的なスコアのため、
 * Geminiのスコア(0-100)向けの固定バンドとは別に、実際の分布に応じて動的に区切る。
 */
export function computeQuantileBands(scores, numBands = 3) {
  const sorted = [...scores].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i < numBands; i++) {
    const lo = sorted[Math.floor((i / numBands) * sorted.length)];
    const hiIdx = Math.floor(((i + 1) / numBands) * sorted.length) - 1;
    const hi = sorted[Math.min(hiIdx, sorted.length - 1)];
    bands.push([lo, hi]);
  }
  return bands;
}

/**
 * サンプル(スコア・将来リターンを含む)を、指定したバンドごとに集計する。
 * @param {Array<{score:number, futureReturn30d:number, hit:boolean}>} samples
 * @param {Array<[number,number]>} bands
 */
export function summarizeByBand(samples, bands) {
  return bands.map(([lo, hi], i) => {
    const inBand = samples.filter((s) => s.score >= lo && s.score <= hi);
    const returns = inBand.map((s) => s.futureReturn30d);
    const hits = inBand.filter((s) => s.hit).length;
    return {
      band: `${lo.toFixed(2)}〜${hi.toFixed(2)}`,
      bandIndex: i,
      count: inBand.length,
      hitRatePct: inBand.length ? (hits / inBand.length) * 100 : null,
      avgReturnPct: returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : null,
      medianReturnPct: median(returns),
    };
  });
}

/**
 * 各cutoffDateごとに、スコア上位N件の将来リターンを取得する。
 * @param {Array<{code, cutoffDate, score, futureReturn30d}>} samples
 * @param {Array<number>} topNList
 */
export function topNByDate(samples, topNList = [1, 3, 5, 10]) {
  const byDate = new Map();
  for (const s of samples) {
    if (!byDate.has(s.cutoffDate)) byDate.set(s.cutoffDate, []);
    byDate.get(s.cutoffDate).push(s);
  }

  const result = {};
  for (const [date, group] of byDate.entries()) {
    const sorted = [...group].sort((a, b) => b.score - a.score);
    result[date] = {};
    for (const n of topNList) {
      const top = sorted.slice(0, n);
      const returns = top.map((s) => s.futureReturn30d).filter((v) => v !== null && v !== undefined);
      result[date][`top${n}`] = {
        codes: top.map((s) => s.code),
        avgReturnPct: returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : null,
      };
    }
  }
  return result;
}
