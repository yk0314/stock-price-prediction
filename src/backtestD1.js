// D1に蓄積した「AI評価(ai_evaluations)」と「全銘柄の日足(stock_prices)」から、評価の後の値動きを測る純粋関数群。
// D1や外部APIには触れない(読み込みと出力は scripts/backtest-d1.js)。
//
// 約定の仮定(実際に取れる行動に近づけるため):
//   - 評価の基準日(data_as_of_date = 評価に使った最後の日足の日)の「翌営業日の始値」で買う。
//     評価の生成時刻が、その翌営業日の寄り付き(日本時間9時 = UTC 0時)より後なら、さらに次の営業日の始値にずらす
//     (寄り付きに間に合わない評価で、始値を使った成績を作らないため)。
//   - 買った日を1日目として、N営業日目(N = 保有日数 horizon)の終値で売る。
//   - 往復の手数料・価格差の合計を costPct(%)として差し引いた「コスト控除後」も計算する。
// 注意:
//   - 評価の基準日が、生成された日より maxStaleDays(既定5)日より前のものは、古い情報に基づく評価なので除外する
//     (有料プランへ移行する前は、約3か月前を基準日にして評価していた。そのような評価の成績は、今の運用を表さない)。
//   - 同じ(銘柄, 基準日)の評価が複数回ある場合(同じ日に複数回実行したとき)は、最も早く生成された1件だけを使う。
//   - 株価は、D1に蓄積した調整後の値(株式分割の影響を受けない)を、同じ系列の中で比べる。
//   - 「買う価値なし」と判定された銘柄はD1に保存されないため、その判定の良し悪しは測れない。
//   - 結果は過去の一時期の観測であり、将来の利益を保証しない。期間が短いほど、偶然の影響が大きい。

export const DEFAULT_HORIZONS = [1, 3, 5];

const toNumber = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

export function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 標本標準偏差(n-1で割る)。2件未満はnull。 */
export function stdev(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** 順位(1始まり)。同じ値は平均順位にする。 */
export function rank(values) {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  let k = 0;
  while (k < indexed.length) {
    let end = k;
    while (end + 1 < indexed.length && indexed[end + 1].v === indexed[k].v) end++;
    const avg = (k + end) / 2 + 1;
    for (let j = k; j <= end; j++) ranks[indexed[j].i] = avg;
    k = end + 1;
  }
  return ranks;
}

/** スピアマンの順位相関。3件未満、またはどちらかが全て同じ値のときはnull。 */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** 再現できる乱数(同じseedなら同じ結果)。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平均値の95%信頼区間(ブートストラップ)。値が2件未満ならnull。 */
export function bootstrapMeanCI(values, { iterations = 2000, seed = 12345 } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const random = mulberry32(seed);
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < v.length; j++) sum += v[Math.floor(random() * v.length)];
    means.push(sum / v.length);
  }
  means.sort((a, b) => a - b);
  const at = (p) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * (means.length - 1))))];
  return { lo: at(0.025), hi: at(0.975) };
}

/** 分位点(線形補間)。値が無ければnull。 */
export function quantile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** 配列の先頭count個が、無作為な標本になるように並べ替える(部分的なフィッシャー–イェーツ)。元の配列は変えない。 */
function sample(array, count, random) {
  const a = array.slice();
  const k = Math.min(count, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

const numOrNull = (v) => {
  const n = toNumber(v);
  return Number.isFinite(n) ? n : null;
};

/** 評価の基準日までの直近20営業日の日次リターン(%)の標準偏差(実現ボラティリティ)。15日分に満たなければnull。 */
export function realizedVolatility(prices, tradingDays, tIdx, { window = 20, minReturns = 15 } = {}) {
  if (!prices || tIdx < 1) return null;
  const returns = [];
  for (let i = Math.max(1, tIdx - window + 1); i <= tIdx; i++) {
    const before = toNumber(prices.get(tradingDays[i - 1])?.close);
    const after = toNumber(prices.get(tradingDays[i])?.close);
    if (before > 0 && after > 0) returns.push((after / before - 1) * 100);
  }
  return returns.length >= minReturns ? stdev(returns) : null;
}

/** 評価の指標(順位相関を見る対象)。 */
export const METRICS = [
  ["score", "スコア"],
  ["upsideProb", "上昇確率(upside_probability)"],
  ["expectedReturn", "期待リターン(expected_return)"],
  ["confidence", "確信度(confidence)"],
  ["downsideRisk", "下落リスク(downside_risk)"],
];

/** 同じ(銘柄, 基準日)の評価は、最も早く生成された1件だけを残す。 */
export function dedupeEvaluations(evaluations) {
  const best = new Map();
  for (const e of evaluations) {
    const key = `${e.code}|${e.data_as_of_date}`;
    const current = best.get(key);
    if (!current || Date.parse(e.generated_at) < Date.parse(current.generated_at)) best.set(key, e);
  }
  return [...best.values()];
}

/**
 * 評価ごとに、保有日数(horizons)別の成績の行を作る。
 *
 * @param {object} p
 * @param {Array<{code:string,data_as_of_date:string,generated_at:string,score:number,rating?:string}>} p.evaluations
 * @param {Map<string, Map<string,{open:number,close:number}>>} p.pricesByCode  銘柄コード → 日付 → 始値・終値
 * @param {string[]} p.tradingDays  全銘柄の蓄積が完了した営業日(昇順)
 * @param {Map<string,{open:number,close:number}>} [p.topixByDate]  TOPIXの日足(省略可)
 * @param {number[]} [p.horizons]  保有日数(営業日)
 * @param {number} [p.costPct]  往復コスト(%)
 * @returns {Record<number, {rows: object[], skipped: object, delayedEntry: number}>}
 */
export function buildBacktestRows({
  evaluations,
  pricesByCode,
  tradingDays,
  topixByDate = new Map(),
  horizons = DEFAULT_HORIZONS,
  costPct = 0,
  maxStaleDays = 5,
}) {
  const dayIndex = new Map(tradingDays.map((d, i) => [d, i]));
  const unique = dedupeEvaluations(evaluations);
  const result = {};
  for (const h of horizons) {
    result[h] = { rows: [], skipped: { noScore: 0, staleBasis: 0, noCalendar: 0, notElapsed: 0, noPrice: 0 }, delayedEntry: 0 };
  }

  for (const e of unique) {
    const score = toNumber(e.score);
    const tIdx = dayIndex.get(e.data_as_of_date);
    const generated = Date.parse(e.generated_at);

    for (const h of horizons) {
      const bucket = result[h];
      if (!Number.isFinite(score)) {
        bucket.skipped.noScore++;
        continue;
      }
      // 基準日が古すぎる評価(生成された日より何日も前のデータに基づく評価)は、今の運用を表さないため除外する
      if (maxStaleDays !== null && Number.isFinite(maxStaleDays) && Number.isFinite(generated)) {
        const staleDays = (generated - Date.parse(`${e.data_as_of_date}T00:00:00Z`)) / 86400000;
        if (staleDays > maxStaleDays) {
          bucket.skipped.staleBasis++;
          continue;
        }
      }
      if (tIdx === undefined) {
        bucket.skipped.noCalendar++;
        continue;
      }
      // 買う日: 基準日の翌営業日。生成が寄り付き(UTC 0時)より後なら、さらに次の営業日
      let entryIdx = tIdx + 1;
      let delayed = false;
      if (Number.isFinite(generated)) {
        while (entryIdx < tradingDays.length && Date.parse(`${tradingDays[entryIdx]}T00:00:00Z`) <= generated) {
          entryIdx++;
          delayed = true;
        }
      }
      const exitIdx = entryIdx + h - 1;
      if (exitIdx >= tradingDays.length) {
        bucket.skipped.notElapsed++;
        continue;
      }
      const entryDate = tradingDays[entryIdx];
      const exitDate = tradingDays[exitIdx];
      const prices = pricesByCode.get(e.code);
      const entryOpen = toNumber(prices?.get(entryDate)?.open);
      const exitClose = toNumber(prices?.get(exitDate)?.close);
      if (!(entryOpen > 0) || !(exitClose > 0)) {
        bucket.skipped.noPrice++;
        continue;
      }

      const retPct = (exitClose / entryOpen - 1) * 100;
      const closeAtSignal = toNumber(prices?.get(e.data_as_of_date)?.close);
      const refPct = closeAtSignal > 0 ? (exitClose / closeAtSignal - 1) * 100 : null; // 参考: 評価日の終値で買えた場合
      const topixOpen = toNumber(topixByDate.get(entryDate)?.open);
      const topixClose = toNumber(topixByDate.get(exitDate)?.close);
      const topixPct = topixOpen > 0 && topixClose > 0 ? (topixClose / topixOpen - 1) * 100 : null;

      if (delayed) bucket.delayedEntry++;
      bucket.rows.push({
        code: e.code,
        signalDate: e.data_as_of_date,
        entryDate,
        exitDate,
        horizon: h,
        score,
        rating: e.rating ?? null,
        upsideProb: numOrNull(e.upside_probability),
        downsideRisk: numOrNull(e.downside_risk),
        expectedReturn: numOrNull(e.expected_return),
        confidence: numOrNull(e.confidence),
        vol20: realizedVolatility(prices, tradingDays, tIdx),
        retPct,
        netPct: retPct - costPct,
        refPct,
        topixPct,
        excessPct: topixPct === null ? null : retPct - topixPct,
      });
    }
  }
  return result;
}

const winRate = (values) => {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length === 0 ? null : v.filter((x) => x > 0).length / v.length;
};

const clamp = (v, lo, hi) => (lo === null || hi === null ? v : Math.min(hi, Math.max(lo, v)));
const positiveDays = (arr) => arr.filter((x) => x > 0).length;

function groupSummary(rows) {
  return {
    n: rows.length,
    meanNet: mean(rows.map((r) => r.netPct)),
    medianNet: median(rows.map((r) => r.netPct)),
    meanWinsorized: mean(rows.map((r) => r.wNet ?? r.netPct)),
    winRateNet: winRate(rows.map((r) => r.netPct)),
    meanExcessNet: mean(rows.map((r) => (r.excessPct === null ? NaN : r.excessPct - (r.retPct - r.netPct)))),
  };
}

/** 日ごとの値動きの大きさ(vol20)を、低・中・高の3つの層に分ける。vol20が無い行は4つ目の層(3)にする。 */
function assignVolStrata(list) {
  const withVol = list.filter((r) => r.vol20 !== null && r.vol20 !== undefined).sort((a, b) => a.vol20 - b.vol20);
  const strata = new Map();
  withVol.forEach((r, i) => strata.set(r, Math.floor((i * 3) / withVol.length)));
  for (const r of list) if (!strata.has(r)) strata.set(r, 3);
  return strata;
}

/**
 * 1日分の「スコア上位N件」を、同点の決め方を無作為にして、simulations回数繰り返した期待値で調べる。
 *  - スコアが同点の銘柄が上位Nの境目にまたがるときは、同点の中から無作為にNに足りない分を選ぶ
 *    (銘柄コード順などの任意の決め方が、結果を左右しないようにするため)。
 *  - useMatchedがtrueなら、同じ回の上位Nと「値動きの大きさ(vol20)の層の構成が同じ」無作為なN件も選び、その平均との差も求める。
 */
function simulateDay(list, { topN, simulations, random, useMatched }) {
  const sorted = [...list].sort((a, b) => b.score - a.score);
  const tiers = [];
  for (const r of sorted) {
    const last = tiers[tiers.length - 1];
    if (last && last[0].score === r.score) last.push(r);
    else tiers.push([r]);
  }
  const strata = useMatched ? assignVolStrata(list) : null;
  const byStratum = new Map();
  if (useMatched) {
    for (const r of list) {
      const k = strata.get(r);
      if (!byStratum.has(k)) byStratum.set(k, []);
      byStratum.get(k).push(r);
    }
  }
  const sums = { top: 0, topW: 0, topMedian: 0, matchedGap: 0 };
  for (let b = 0; b < simulations; b++) {
    const chosen = [];
    let remaining = topN;
    for (const tier of tiers) {
      if (remaining <= 0) break;
      if (tier.length <= remaining) {
        chosen.push(...tier);
        remaining -= tier.length;
      } else {
        chosen.push(...sample(tier, remaining, random));
        remaining = 0;
      }
    }
    const topMean = mean(chosen.map((r) => r.netPct));
    sums.top += topMean;
    sums.topW += mean(chosen.map((r) => r.wNet));
    sums.topMedian += median(chosen.map((r) => r.netPct));
    if (useMatched) {
      const counts = new Map();
      for (const r of chosen) counts.set(strata.get(r), (counts.get(strata.get(r)) ?? 0) + 1);
      const matched = [];
      for (const [k, c] of counts) matched.push(...sample(byStratum.get(k), c, random));
      sums.matchedGap += topMean - mean(matched.map((r) => r.netPct));
    }
  }
  const cutRow = sorted[Math.min(topN, sorted.length) - 1];
  return {
    top: sums.top / simulations,
    topW: sums.topW / simulations,
    topMedian: sums.topMedian / simulations,
    matchedGap: useMatched ? sums.matchedGap / simulations : null,
    cutScore: cutRow.score,
    tieAtCut: list.filter((r) => r.score === cutRow.score).length,
  };
}

/**
 * 保有日数1通り分の行を集計する(行はbuildBacktestRowsの出力)。
 *  - overall / byBand / byRating: 全体・スコア順に件数を等分した帯・ratingごとの成績
 *  - byScoreLevel: 固定のスコアの区切り(scoreCuts)ごとの成績と、最上位の水準 − それ以外(日ごとの平均の差)
 *    (スコアは同点が多く、件数を等分する帯では最上位が埋もれることがあるため)
 *  - topN: 毎日のスコア上位N件 − その日の評価全件の平均。同点は無作為に決めた期待値で、次の見方を併記する:
 *      中央値の差 / 外れ値(上下winsorPct%)を丸めた平均の差 / 値動きの大きさ(vol20の層)をそろえた無作為なN件との差 /
 *      その日の全件から無作為にN件選んだ場合の分布(p値)
 *  - byMetric: スコア・上昇確率・期待リターン・確信度・下落リスクと、成績との順位相関(日ごと)
 * 平均の差と相関には、日を単位にしたブートストラップの95%信頼区間を付ける(日数が少ないと幅が広い)。
 */
export function summarizeBacktest(
  rows,
  { topN = 10, bands = 3, iterations = 2000, seed = 12345, scoreCuts = [62, 68, 72], simulations = 300, randomPicks = 2000, winsorPct = 1 } = {}
) {
  const n = rows.length;
  if (n === 0) return { n: 0 };

  // 外れ値を丸めた成績(全体の分布の下位・上位winsorPct%を、その値に置き換える)
  const allNet = rows.map((r) => r.netPct);
  const lo = winsorPct > 0 ? quantile(allNet, winsorPct / 100) : null;
  const hi = winsorPct > 0 ? quantile(allNet, 1 - winsorPct / 100) : null;
  const data = rows.map((r) => ({ ...r, wNet: clamp(r.netPct, lo, hi) }));

  const sorted = [...data].sort((a, b) => a.score - b.score || (a.code < b.code ? -1 : 1));
  const bandCount = Math.max(1, Math.min(bands, n));
  const byBand = [];
  for (let b = 0; b < bandCount; b++) {
    const from = Math.floor((b * n) / bandCount);
    const to = Math.floor(((b + 1) * n) / bandCount);
    const slice = sorted.slice(from, to);
    byBand.push({ band: b + 1, scoreMin: slice[0].score, scoreMax: slice[slice.length - 1].score, ...groupSummary(slice) });
  }

  const byRating = {};
  for (const r of data) (byRating[r.rating ?? "不明"] ??= []).push(r);
  for (const key of Object.keys(byRating)) byRating[key] = groupSummary(byRating[key]);

  const byDay = new Map();
  for (const r of data) {
    if (!byDay.has(r.signalDate)) byDay.set(r.signalDate, []);
    byDay.get(r.signalDate).push(r);
  }
  const dayList = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const mk = (arr) => ({ days: arr.length, mean: mean(arr), ci: bootstrapMeanCI(arr, { iterations, seed }), positiveDays: positiveDays(arr) });

  // ---- 固定のスコアの区切り ----
  const cuts = [...scoreCuts].sort((a, b) => a - b);
  const levelOf = (score) => {
    let i = 0;
    while (i < cuts.length && score >= cuts[i]) i++;
    return i;
  };
  const levelLabel = (i) => {
    if (cuts.length === 0) return "全体";
    if (i === 0) return `${cuts[0]}未満`;
    if (i === cuts.length) return `${cuts[cuts.length - 1]}以上`;
    return `${cuts[i - 1]}以上〜${cuts[i]}未満`;
  };
  const byScoreLevel = [];
  for (let i = 0; i <= cuts.length; i++) {
    const g = data.filter((r) => levelOf(r.score) === i);
    if (g.length > 0) byScoreLevel.push({ level: i, label: levelLabel(i), days: new Set(g.map((r) => r.signalDate)).size, ...groupSummary(g) });
  }
  let topLevel = null;
  if (cuts.length > 0) {
    const topIdx = cuts.length;
    const diffs = [];
    const wDiffs = [];
    for (const [, list] of dayList) {
      const top = list.filter((r) => levelOf(r.score) === topIdx);
      const rest = list.filter((r) => levelOf(r.score) !== topIdx);
      if (top.length >= 3 && rest.length >= 3) {
        diffs.push(mean(top.map((r) => r.netPct)) - mean(rest.map((r) => r.netPct)));
        wDiffs.push(mean(top.map((r) => r.wNet)) - mean(rest.map((r) => r.wNet)));
      }
    }
    topLevel = { label: levelLabel(topIdx), n: data.filter((r) => levelOf(r.score) === topIdx).length, ...mk(diffs), winsorizedMean: mean(wDiffs) };
  }

  // ---- 毎日のスコア上位N件(同点は無作為の期待値) ----
  const volCoverage = data.filter((r) => r.vol20 !== null && r.vol20 !== undefined).length / n;
  const useMatched = volCoverage >= 0.5;
  const random = mulberry32(seed);
  const daily = [];
  const sim = [];
  for (const [signalDate, list] of dayList) {
    const poolMean = mean(list.map((r) => r.netPct));
    const poolWMean = mean(list.map((r) => r.wNet));
    const poolMedian = median(list.map((r) => r.netPct));
    const row = { signalDate, n: list.length, poolMean, topNMean: null, diff: null, diffMedian: null, diffWinsorized: null, diffMatched: null, cutScore: null, tieAtCut: null, ic: null };
    if (list.length >= topN) {
      const d = simulateDay(list, { topN, simulations, random, useMatched });
      Object.assign(row, {
        topNMean: d.top,
        diff: d.top - poolMean,
        diffMedian: d.topMedian - poolMedian,
        diffWinsorized: d.topW - poolWMean,
        diffMatched: d.matchedGap,
        cutScore: d.cutScore,
        tieAtCut: d.tieAtCut,
      });
      sim.push({ list, poolMean });
    }
    row.ic = list.length >= 10 ? spearman(list.map((r) => r.score), list.map((r) => r.netPct)) : null;
    daily.push(row);
  }
  const used = daily.filter((d) => d.diff !== null);
  const topStats = mk(used.map((d) => d.diff));

  // その日の評価全件から無作為にN件選んだ場合の、平均差の分布(日ごとの差の平均)
  let randomPick = null;
  if (sim.length > 0 && topStats.mean !== null) {
    const means = [];
    for (let r = 0; r < randomPicks; r++) {
      let sum = 0;
      for (const { list, poolMean } of sim) sum += mean(sample(list, topN, random).map((x) => x.netPct)) - poolMean;
      means.push(sum / sim.length);
    }
    means.sort((a, b) => a - b);
    randomPick = {
      lo: means[Math.floor(0.025 * (means.length - 1))],
      hi: means[Math.floor(0.975 * (means.length - 1))],
      p: means.filter((m) => m >= topStats.mean).length / means.length,
    };
  }

  // 上位Nの銘柄の重なり(銘柄コード順の同点処理での、あくまで目安)
  const slotCodes = [];
  for (const [, list] of dayList) {
    if (list.length >= topN) slotCodes.push(...[...list].sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1)).slice(0, topN).map((r) => r.code));
  }

  // ---- 指標別の順位相関(日ごと) ----
  const byMetric = METRICS.map(([key, label]) => {
    const ics = [];
    for (const [, list] of dayList) {
      const valid = list.filter((r) => r[key] !== null && r[key] !== undefined && Number.isFinite(r[key]));
      if (valid.length >= 10) {
        const ic = spearman(valid.map((r) => r[key]), valid.map((r) => r.netPct));
        if (ic !== null) ics.push(ic);
      }
    }
    return { key, label, ...mk(ics) };
  });
  const volCorrs = [];
  for (const [, list] of dayList) {
    const valid = list.filter((r) => r.vol20 !== null && r.vol20 !== undefined);
    if (valid.length >= 10) {
      const c = spearman(valid.map((r) => r.score), valid.map((r) => r.vol20));
      if (c !== null) volCorrs.push(c);
    }
  }

  return {
    n,
    days: byDay.size,
    overall: {
      meanGross: mean(rows.map((r) => r.retPct)),
      meanNet: mean(allNet),
      medianNet: median(allNet),
      meanWinsorized: mean(data.map((r) => r.wNet)),
      stdevNet: stdev(allNet),
      winRateNet: winRate(allNet),
      meanRefPct: mean(rows.map((r) => (r.refPct === null ? NaN : r.refPct))),
      meanExcessNet: groupSummary(data).meanExcessNet,
      excessN: rows.filter((r) => r.excessPct !== null).length,
    },
    byBand,
    byRating,
    byScoreLevel,
    topLevel,
    daily,
    topN: {
      topN,
      ...topStats,
      meanTopN: mean(used.map((d) => d.topNMean)),
      meanPool: mean(used.map((d) => d.poolMean)),
      median: mk(used.map((d) => d.diffMedian)),
      winsorized: { ...mk(used.map((d) => d.diffWinsorized)), pct: winsorPct },
      matched: useMatched ? mk(used.filter((d) => d.diffMatched !== null).map((d) => d.diffMatched)) : null,
      randomPick,
      slots: slotCodes.length,
      uniqueStocks: new Set(slotCodes).size,
    },
    byMetric,
    ic: byMetric.find((m) => m.key === "score"),
    scoreVolCorr: { days: volCorrs.length, mean: mean(volCorrs) },
    volCoverage,
  };
}

const f2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2));
const pct1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const ci = (c) => (c ? `[${f2(c.lo)}, ${f2(c.hi)}]` : "—(日数が足りない)");

/** 集計結果をMarkdownにする(実行ログ・GitHubの実行サマリに出す)。 */
export function formatBacktestReport({ meta, results }) {
  const lines = [];
  lines.push("# AI評価のバックテスト(D1の実データ。読み取りのみ)");
  lines.push("");
  lines.push(`- 評価: ${meta.evaluationsUnique}件(重複除去前 ${meta.evaluationsRaw}件)、基準日 ${meta.signalDateMin}〜${meta.signalDateMax}`);
  lines.push("- 約定の仮定: 基準日の翌営業日の始値で買い、保有日数目の終値で売る(寄り付きに間に合わない評価は、次の営業日の始値)");
  lines.push(`- 往復コスト: ${meta.costPct}%(コスト控除後の成績で集計) / 上位N: ${meta.topN} / スコア帯: ${meta.bands}`);
  if (meta.scoreCuts) lines.push(`- スコアの区切り(固定): ${meta.scoreCuts.join(", ")}`);
  if (meta.maxStaleDays !== undefined && meta.maxStaleDays !== null) {
    lines.push(`- 評価の基準日が、生成された日より${meta.maxStaleDays}日より前のものは、古い情報に基づくため除外`);
  }
  lines.push("- **注意**: 期間が短く、相場環境が限られています。結果は将来の利益を保証しません。信頼区間が0をまたぐ差は、差があるとは言えません。");
  lines.push("- スコアは同点が多く(特定の値に集中する)、上位N件の境目にまたがる同点は無作為に選んだ期待値で計算しています。");
  lines.push("- 「買う価値なし」と判定された銘柄はD1に保存されないため、その判定は測れません。");

  for (const h of Object.keys(results)) {
    const { summary, skipped, delayedEntry } = results[h];
    lines.push("");
    lines.push(`## 保有 ${h} 営業日`);
    lines.push(
      `対象 ${summary.n}件 / 基準日が古すぎて除外 ${skipped.staleBasis ?? 0} / 未経過 ${skipped.notElapsed} / 株価なし ${skipped.noPrice} / 営業日カレンダーに無い基準日 ${skipped.noCalendar} / スコアなし ${skipped.noScore} / 寄り付きに間に合わず買う日をずらした ${delayedEntry}`
    );
    if (summary.n === 0) {
      lines.push("集計できる評価がありません。");
      continue;
    }
    const o = summary.overall;
    lines.push("");
    lines.push("| 指標 | 値 |");
    lines.push("|---|---|");
    lines.push(`| 日数(基準日) | ${summary.days} |`);
    lines.push(`| 平均(%、コスト控除前 / 後) | ${f2(o.meanGross)} / ${f2(o.meanNet)} |`);
    lines.push(`| 平均(%、控除後、外れ値を丸めた) | ${f2(o.meanWinsorized)} |`);
    lines.push(`| 中央値(%、控除後) | ${f2(o.medianNet)} |`);
    lines.push(`| 標準偏差(%、控除後) | ${f2(o.stdevNet)} |`);
    lines.push(`| 勝率(控除後 > 0) | ${pct1(o.winRateNet)} |`);
    lines.push(`| TOPIXとの差の平均(%、控除後。${o.excessN}件) | ${f2(o.meanExcessNet)} |`);
    lines.push(`| 参考: 評価日の終値で買えた場合の平均(%) | ${f2(o.meanRefPct)} |`);

    lines.push("");
    lines.push("**スコアの水準別(固定の区切り)**");
    lines.push("");
    lines.push("| スコア | 件数 | 日数 | 平均(%) | 平均・外れ値を丸めた(%) | 中央値(%) | 勝率 | TOPIXとの差(%) |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const g of summary.byScoreLevel) {
      lines.push(`| ${g.label} | ${g.n} | ${g.days} | ${f2(g.meanNet)} | ${f2(g.meanWinsorized)} | ${f2(g.medianNet)} | ${pct1(g.winRateNet)} | ${f2(g.meanExcessNet)} |`);
    }
    if (summary.topLevel) {
      const t = summary.topLevel;
      lines.push("");
      lines.push(`最上位の水準(${t.label}、${t.n}件)−それ以外(日ごとの平均の差。各3件以上ある日のみ): 日数 ${t.days} / 平均 ${f2(t.mean)} / 95%信頼区間 ${ci(t.ci)} / 正の日 ${t.positiveDays} / 外れ値を丸めた平均 ${f2(t.winsorizedMean)}`);
    }

    lines.push("");
    lines.push("**スコア順に件数を等分した帯(帯1が低スコア。同点が多いと最上位の帯が埋もれる)**");
    lines.push("");
    lines.push("| 帯 | 件数 | スコア | 平均(%) | 中央値(%) | 勝率 | TOPIXとの差(%) |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const b of summary.byBand) {
      lines.push(`| ${b.band} | ${b.n} | ${f2(b.scoreMin)}〜${f2(b.scoreMax)} | ${f2(b.meanNet)} | ${f2(b.medianNet)} | ${pct1(b.winRateNet)} | ${f2(b.meanExcessNet)} |`);
    }

    lines.push("");
    lines.push("**評価(rating)別**");
    lines.push("");
    lines.push("| rating | 件数 | 平均(%) | 中央値(%) | 勝率 |");
    lines.push("|---|---|---|---|---|");
    for (const [key, g] of Object.entries(summary.byRating)) {
      lines.push(`| ${key} | ${g.n} | ${f2(g.meanNet)} | ${f2(g.medianNet)} | ${pct1(g.winRateNet)} |`);
    }

    const t = summary.topN;
    lines.push("");
    lines.push(`**毎日のスコア上位${t.topN}件 − その日の評価全件の平均(平均リターン、%。同点は無作為の期待値)**`);
    lines.push("");
    lines.push(`- 比較できた日数: ${t.days} / 上位の平均 ${f2(t.meanTopN)} / 全件の平均 ${f2(t.meanPool)} / 差の平均 ${f2(t.mean)} / 95%信頼区間 ${ci(t.ci)} / 差が正の日 ${t.positiveDays}`);
    lines.push(`- 中央値の差: 平均 ${f2(t.median.mean)} / 正の日 ${t.median.positiveDays}`);
    lines.push(`- 外れ値(上下${t.winsorized.pct}%)を丸めた差: 平均 ${f2(t.winsorized.mean)} / 95%信頼区間 ${ci(t.winsorized.ci)}`);
    lines.push(
      t.matched
        ? `- 値動きの大きさ(直近20日の実現ボラティリティの層)をそろえた無作為な${t.topN}件との差: 平均 ${f2(t.matched.mean)} / 95%信頼区間 ${ci(t.matched.ci)} / 正の日 ${t.matched.positiveDays}`
        : "- 値動きの大きさをそろえた比較: 株価の履歴が足りず、省略"
    );
    if (t.randomPick) {
      lines.push(`- その日の全件から無作為に${t.topN}件選んだ場合の平均差の95%範囲: [${f2(t.randomPick.lo)}, ${f2(t.randomPick.hi)}] / 実際の差以上になる割合 p=${t.randomPick.p.toFixed(3)}`);
    }
    lines.push(`- 上位${t.topN}の延べ${t.slots}枠は、独立した銘柄 ${t.uniqueStocks}個(銘柄コード順の同点処理での目安)`);
    lines.push("");
    lines.push("| 基準日 | 件数 | 全件の平均(%) | 上位の平均(%) | 差 | 差(中央値) | 差(値動き統制) | 境目のスコア / 同点の件数 | スコアの順位相関 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const d of summary.daily) {
      lines.push(
        `| ${d.signalDate} | ${d.n} | ${f2(d.poolMean)} | ${f2(d.topNMean)} | ${f2(d.diff)} | ${f2(d.diffMedian)} | ${f2(d.diffMatched)} | ${d.cutScore ?? "—"} / ${d.tieAtCut ?? "—"} | ${f2(d.ic)} |`
      );
    }

    lines.push("");
    lines.push("**指標ごとの、成績との順位相関(日ごとに計算し、10件以上ある日を平均)**");
    lines.push("");
    lines.push("| 指標 | 日数 | 平均 | 95%信頼区間 | 正の日 |");
    lines.push("|---|---|---|---|---|");
    for (const m of summary.byMetric) {
      lines.push(`| ${m.label} | ${m.days} | ${f2(m.mean)} | ${ci(m.ci)} | ${m.positiveDays} |`);
    }
    lines.push("");
    lines.push(`参考: スコアと、直近20日の実現ボラティリティの順位相関(日ごとの平均): ${f2(summary.scoreVolCorr.mean)}(日数 ${summary.scoreVolCorr.days} / ボラティリティを計算できた評価 ${pct1(summary.volCoverage)})。正に大きいほど、スコアが高い銘柄は値動きが大きい傾向を表します。`);
  }
  return lines.join("\n");
}
