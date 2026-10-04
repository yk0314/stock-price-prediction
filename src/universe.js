// 銘柄ユニバース(分析対象にする銘柄の範囲)の絞り込み。
//
// 【用語の整理】
//   ユニバース  : J-Quantsから取得した銘柄のうち、特徴量計算・スクリーニングの対象にする範囲
//                 (UNIVERSE_MODE=all のときは、下の市場区分フィルタを通った全銘柄)
//   候補プール  : スクリーニングで絞り込んだ上位N件(SCREENING.poolSize / 環境変数 SCREENING_POOL_SIZE)
//   AI評価対象  : プールのうちGeminiに渡す件数(GEMINI.candidateCount / 環境変数 GEMINI_MAX_STOCKS)。
//                 Geminiへは1リクエスト=1銘柄で送る(「バッチ」ではなく、1回の実行で評価する件数の上限)
// この3つは独立した設定で、「150」のような同じ数字が偶然3か所に出てきても互いに連動しない。

/**
 * 上場市場区分(MktNm: プライム/スタンダード/グロース/TOKYO PRO MARKET/その他)でユニバースを絞り込む。
 * 「その他」にはETF・REIT等が含まれ、TOKYO PRO MARKETはプロ投資家向けのため、
 * 個人が数日〜1週間の短期売買をする本アプリの対象外として既定では除外する(config.UNIVERSE_MARKETS)。
 *
 * - allowedMarkets が null(UNIVERSE_MARKETS=ALL)なら絞り込まない。
 * - 銘柄マスタを取得できていない(空)ときは、誤って全銘柄を除外しないよう、絞り込みをスキップして警告する。
 * - 銘柄マスタに存在しない銘柄は、市場区分を確認できないため除外する(件数を summary に出す)。
 *
 * @param {Map<string, Array>} groupedByCode 銘柄コード -> 株価データ
 * @param {Map<string, {code, name, market}>} listedInfoByCode listedInfo.js の buildListedInfoByCode() の結果
 * @param {string[]|null} allowedMarkets
 * @returns {{grouped: Map, summary: object}}
 */
export function filterByListedMarket(groupedByCode, listedInfoByCode, allowedMarkets) {
  if (!allowedMarkets) {
    return { grouped: groupedByCode, summary: { skipped: "all-markets" } };
  }
  if (!listedInfoByCode || listedInfoByCode.size === 0) {
    return { grouped: groupedByCode, summary: { skipped: "master-unavailable" } };
  }

  const allowed = new Set(allowedMarkets);
  const kept = new Map();
  const removedByMarket = {};
  for (const [code, rows] of groupedByCode.entries()) {
    const info = listedInfoByCode.get(code);
    if (!info) {
      removedByMarket["(銘柄マスタに無い)"] = (removedByMarket["(銘柄マスタに無い)"] ?? 0) + 1;
      continue;
    }
    if (allowed.has(info.market)) {
      kept.set(code, rows);
    } else {
      const key = info.market ?? "(市場区分なし)";
      removedByMarket[key] = (removedByMarket[key] ?? 0) + 1;
    }
  }
  return {
    grouped: kept,
    summary: { skipped: null, allowedMarkets, kept: kept.size, removedByMarket },
  };
}
