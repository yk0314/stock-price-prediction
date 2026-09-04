import { config } from "./config.js";

/**
 * 特徴量の配列から、まず「スクリーニングプール」を作る（数値だけでの絞り込み）。
 *
 * 重要: 「大きく動いた銘柄=上がりそうな銘柄」と決めつけないこと。
 * ここでの絞り込みは「Geminiに分析させる価値がある銘柄を選ぶ」段階であり、
 * 上昇・下落どちらの値動きも対象に含める。最終判断はGeminiの分析結果と
 * 表示の両方を見てユーザーが行う。
 *
 * このロジックはPhase 1の仮実装であり、config.SCREENING を変更するか
 * この関数自体を差し替えるだけで、後から自由に条件を変更できる。
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

  filtered.sort((a, b) => Math.abs(b.priceChange5d) - Math.abs(a.priceChange5d));

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
