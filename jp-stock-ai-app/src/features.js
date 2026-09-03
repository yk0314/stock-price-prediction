import { config } from "./config.js";

function pctChange(newValue, oldValue) {
  if (oldValue === undefined || oldValue === null || Number(oldValue) === 0) {
    return null;
  }
  return ((Number(newValue) - Number(oldValue)) / Number(oldValue)) * 100;
}

/**
 * 1銘柄分の正規化済み日足データ（normalize.js の groupByCode() で得られる、日付昇順の配列）
 * から特徴量を計算する。
 *
 * cutoffDate以前のデータだけがここに渡ってくることを前提とする
 * （フィルタは jquants.js / cutoff.js 側で既に行われている）。
 *
 * @param {string} code
 * @param {Array<{date, close, volume}>} rowsSortedAsc
 * @returns {object|null} 特徴量。データ不足の場合は null
 */
export function computeFeatures(code, rowsSortedAsc) {
  const rows = rowsSortedAsc.slice(-config.FEATURE_LOOKBACK_TRADING_DAYS);

  if (rows.length < config.FEATURE_LOOKBACK_TRADING_DAYS) {
    // 特徴量の計算に必要な営業日数が揃っていない銘柄はスキップする
    return null;
  }

  const latest = rows[rows.length - 1];
  const prev1d = rows[rows.length - 2];
  const prev5d = rows[rows.length - 6] || rows[0];
  const prev20d = rows[0];

  const volumes = rows
    .map((r) => r.volume)
    .filter((v) => Number.isFinite(v));
  const avgVolume = volumes.length
    ? volumes.reduce((sum, v) => sum + v, 0) / volumes.length
    : null;

  return {
    code,
    dataAsOf: latest.date,
    price: latest.close,
    priceChange1d: pctChange(latest.close, prev1d.close),
    priceChange5d: pctChange(latest.close, prev5d.close),
    priceChange20d: pctChange(latest.close, prev20d.close),
    volumeChange20d: avgVolume ? pctChange(latest.volume, avgVolume) : null,
  };
}

/**
 * 銘柄コード -> 正規化済みデータ配列 の Map から、全銘柄分の特徴量配列を計算する。
 * @param {Map<string, Array<{date, close, volume}>>} groupedByCode
 * @returns {Array<object>} null を除いた特徴量の配列
 */
export function computeFeaturesForAll(groupedByCode) {
  const features = [];
  for (const [code, rows] of groupedByCode.entries()) {
    const f = computeFeatures(code, rows);
    if (f) features.push(f);
  }
  return features;
}
