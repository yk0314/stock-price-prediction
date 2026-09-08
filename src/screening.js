import { config } from "./config.js";

/**
 * モメンタム・出来高・市場相対強度・RSIの極端さを総合したスクリーニングスコアを計算する。
 * 単純な「値動きの大きさ」だけで判断しないための複合指標。
 * 重みは config.SCREENING.scoreWeights から取得し、後から容易に調整できる。
 *
 * このスコアはあくまでスクリーニング（Geminiに渡す前の絞り込み）専用であり、
 * Geminiが返す最終的な "score" とは別物。
 */
export function computeScreeningScore(feature) {
  const w = config.SCREENING.scoreWeights;
  let score = 0;

  if (feature.priceChange5d !== null && feature.priceChange5d !== undefined) {
    score += w.momentum5d * Math.abs(feature.priceChange5d);
  }
  if (feature.priceChange20d !== null && feature.priceChange20d !== undefined) {
    score += w.momentum20d * Math.abs(feature.priceChange20d);
  }
  if (feature.relativeStrength20d !== null && feature.relativeStrength20d !== undefined) {
    score += w.relativeStrength * Math.abs(feature.relativeStrength20d);
  }
  if (feature.rsi14 !== null && feature.rsi14 !== undefined) {
    score += w.rsiExtremity * Math.abs(feature.rsi14 - 50);
  }
  if (feature.volumeChange20d !== null && feature.volumeChange20d !== undefined) {
    score += w.volumeChange * Math.abs(feature.volumeChange20d);
  }

  return score;
}

/**
 * 特徴量の配列から、まず「スクリーニングプール」を作る（数値だけでの絞り込み）。
 *
 * 重要: 「大きく動いた銘柄=上がりそうな銘柄」と決めつけないこと。
 * ここでの絞り込みは「Geminiに分析させる価値がある銘柄を選ぶ」段階であり、
 * 上昇・下落どちらの値動きも対象に含める。最終判断はGeminiの分析結果と
 * 表示の両方を見てユーザーが行う。
 *
 * モメンタム・出来高・市場相対強度・RSIの極端さを組み合わせた複合スコア
 * (computeScreeningScore)でソートすることで、単純な値動きの大きさだけに
 * 偏らないようにしている。
 *
 * @param {Array<object>} featureList - features.js の computeFeatures() の結果配列
 * @returns {Array<object>} スクリーニングプール（config.SCREENING.poolSize 件まで）
 */
export function screenToPool(featureList) {
  const { maxAbsVolumeChangePct, minAbsPriceChangePct5d, poolSize } =
    config.SCREENING;

  const valid = featureList.filter((f) => f !== null);

  const filtered = valid.filter((f) => {
    if (f.priceChange5d === null) return false;
    if (Math.abs(f.priceChange5d) < minAbsPriceChangePct5d) return false;
    if (
      f.volumeChange20d !== null &&
      Math.abs(f.volumeChange20d) > maxAbsVolumeChangePct
    ) {
      // 出来高が異常値レベルで変化している銘柄はデータ異常の可能性があるため除外
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => computeScreeningScore(b) - computeScreeningScore(a));

  return filtered.slice(0, poolSize);
}

/**
 * スクリーニングプールの中から、実際にGeminiへ渡す銘柄を選ぶ。
 *
 * J-Quantsから取得・特徴量計算する対象数（全銘柄 or STOCK_UNIVERSE）と、
 * Geminiに分析させる対象数（config.GEMINI.candidateCount）を明確に分離するための関数。
 * Geminiの無料枠を守るため、この件数は必ず config.GEMINI.candidateCount 経由でのみ変更すること。
 *
 * @param {Array<object>} pool - screenToPool() の結果
 * @returns {Array<object>} Geminiに渡す候補（config.GEMINI.candidateCount 件まで）
 */
export function selectGeminiCandidates(pool) {
  return pool.slice(0, config.GEMINI.candidateCount);
}
