import { config } from "./config.js";

function pctChange(newValue, oldValue) {
  if (oldValue === undefined || oldValue === null || Number(oldValue) === 0) {
    return null;
  }
  return ((Number(newValue) - Number(oldValue)) / Number(oldValue)) * 100;
}

/**
 * 日付昇順の配列 rows に対して、「最新の要素から n 営業日前」の要素を返す。
 * 例: n=0 は最新そのもの、n=1 は1営業日前、n=20 は20営業日前。
 * データが足りない場合は null を返す。
 *
 * この関数を経由することで、「Xd」というラベルと実際の比較対象日のズレ（オフバイワン）を防ぐ。
 * 例えば「20営業日前」と比較するには、最新を含めて21個のデータ点が必要になる
 * （20個しかない配列の先頭要素は、最新から数えて19営業日前でしかない）。
 */
function nTradingDaysAgo(rowsSortedAsc, n) {
  const idx = rowsSortedAsc.length - 1 - n;
  return idx >= 0 ? rowsSortedAsc[idx] : null;
}

/**
 * 1銘柄分の正規化済み日足データ（normalize.js の groupByCode() で得られる、日付昇順の配列）
 * から特徴量を計算する。
 *
 * cutoffDate以前のデータだけがここに渡ってくることを前提とする
 * （フィルタは jquants.js / cutoff.js 側で既に行われている）。
 *
 * 「Xd」の特徴量は、必ず「最新の営業日からX営業日前の営業日」との比較であることを
 * nTradingDaysAgo() で保証している（カレンダー日数ではなく営業日数ベース）。
 *
 * @param {string} code
 * @param {Array<{date, close, volume}>} rowsSortedAscFull - cutoffDate以前の全期間データ（日付昇順）
 * @returns {object|null} 特徴量。データ不足の場合は null
 */
export function computeFeatures(code, rowsSortedAscFull) {
  // 20営業日前と比較するには、最新を含めて21個のデータ点が必要
  // （config.FEATURE_LOOKBACK_TRADING_DAYS が比較対象の「Nd」の最大値N）。
  const requiredPoints = config.FEATURE_LOOKBACK_TRADING_DAYS + 1;
  const rows = rowsSortedAscFull.slice(-requiredPoints);

  if (rows.length < requiredPoints) {
    // 特徴量の計算に必要な営業日数が揃っていない銘柄はスキップする
    return null;
  }

  const latest = nTradingDaysAgo(rows, 0);
  const d1 = nTradingDaysAgo(rows, 1);
  const d5 = nTradingDaysAgo(rows, 5);
  const d20 = nTradingDaysAgo(rows, config.FEATURE_LOOKBACK_TRADING_DAYS);

  const volumes = rows.map((r) => r.volume).filter((v) => Number.isFinite(v));
  const avgVolume = volumes.length
    ? volumes.reduce((sum, v) => sum + v, 0) / volumes.length
    : null;

  return {
    code,
    dataAsOf: latest.date,
    price: latest.close,
    priceChange1d: d1 ? pctChange(latest.close, d1.close) : null,
    priceChange5d: d5 ? pctChange(latest.close, d5.close) : null,
    priceChange20d: d20 ? pctChange(latest.close, d20.close) : null,
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
