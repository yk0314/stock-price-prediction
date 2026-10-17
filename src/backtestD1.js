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

function groupSummary(rows) {
  return {
    n: rows.length,
    meanNet: mean(rows.map((r) => r.netPct)),
    medianNet: median(rows.map((r) => r.netPct)),
    winRateNet: winRate(rows.map((r) => r.netPct)),
    meanExcessNet: mean(rows.map((r) => (r.excessPct === null ? NaN : r.excessPct - (r.retPct - r.netPct)))),
  };
}

/**
 * 保有日数1通り分の行を集計する。
 *  - overall: 全体の平均・中央値・勝率(コスト控除後)
 *  - byBand: スコア順に件数が等しくなるよう分けた帯ごとの成績
 *  - byRating: BUY/HOLD/SELLごとの成績
 *  - daily / topN: 毎日の「スコア上位N件」と「その日に評価した全件の平均」の差(AIの順位付けが、プール全体の平均より良いか)
 *  - ic: 毎日の、スコアと成績の順位相関(スピアマン)
 * 平均の差と相関には、日を単位にしたブートストラップの95%信頼区間を付ける(日数が少ないと幅が広い)。
 */
export function summarizeBacktest(rows, { topN = 10, bands = 3, iterations = 2000, seed = 12345 } = {}) {
  const n = rows.length;
  if (n === 0) return { n: 0 };

  const sorted = [...rows].sort((a, b) => a.score - b.score || (a.code < b.code ? -1 : 1));
  const bandCount = Math.max(1, Math.min(bands, n));
  const byBand = [];
  for (let b = 0; b < bandCount; b++) {
    const from = Math.floor((b * n) / bandCount);
    const to = Math.floor(((b + 1) * n) / bandCount);
    const slice = sorted.slice(from, to);
    byBand.push({ band: b + 1, scoreMin: slice[0].score, scoreMax: slice[slice.length - 1].score, ...groupSummary(slice) });
  }

  const byRating = {};
  for (const r of rows) {
    const key = r.rating ?? "不明";
    (byRating[key] ??= []).push(r);
  }
  for (const key of Object.keys(byRating)) byRating[key] = groupSummary(byRating[key]);

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.signalDate)) byDay.set(r.signalDate, []);
    byDay.get(r.signalDate).push(r);
  }
  const daily = [];
  for (const [signalDate, list] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const poolMean = mean(list.map((r) => r.netPct));
    const ranked = [...list].sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
    const topNMean = list.length >= topN ? mean(ranked.slice(0, topN).map((r) => r.netPct)) : null;
    daily.push({
      signalDate,
      n: list.length,
      poolMean,
      topNMean,
      diff: topNMean === null ? null : topNMean - poolMean,
      ic: list.length >= 10 ? spearman(list.map((r) => r.score), list.map((r) => r.netPct)) : null,
    });
  }

  const diffs = daily.filter((d) => d.diff !== null).map((d) => d.diff);
  const ics = daily.filter((d) => d.ic !== null).map((d) => d.ic);
  const mk = (arr) => ({ days: arr.length, mean: mean(arr), ci: bootstrapMeanCI(arr, { iterations, seed }) });

  return {
    n,
    days: byDay.size,
    overall: {
      meanGross: mean(rows.map((r) => r.retPct)),
      meanNet: mean(rows.map((r) => r.netPct)),
      medianNet: median(rows.map((r) => r.netPct)),
      stdevNet: stdev(rows.map((r) => r.netPct)),
      winRateNet: winRate(rows.map((r) => r.netPct)),
      meanRefPct: mean(rows.map((r) => (r.refPct === null ? NaN : r.refPct))),
      meanExcessNet: groupSummary(rows).meanExcessNet,
      excessN: rows.filter((r) => r.excessPct !== null).length,
    },
    byBand,
    byRating,
    daily,
    topN: {
      topN,
      ...mk(diffs),
      meanTopN: mean(daily.filter((d) => d.diff !== null).map((d) => d.topNMean)),
      meanPool: mean(daily.filter((d) => d.diff !== null).map((d) => d.poolMean)),
    },
    ic: mk(ics),
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
  if (meta.maxStaleDays !== undefined && meta.maxStaleDays !== null) {
    lines.push(`- 評価の基準日が、生成された日より${meta.maxStaleDays}日より前のものは、古い情報に基づくため除外`);
  }
  lines.push("- **注意**: 期間が短く、相場環境が限られています。結果は将来の利益を保証しません。信頼区間が0をまたぐ差は、差があるとは言えません。");
  lines.push("- 「買う価値なし」と判定された銘柄はD1に保存されないため、その判定は測れません。");

  for (const h of Object.keys(results)) {
    const { summary, skipped, delayedEntry } = results[h];
    lines.push("");
    lines.push(`## 保有 ${h} 営業日`);
    lines.push(
      `対象 ${summary.n}件 / 基準日が古すぎて除外 ${skipped.staleBasis} / 未経過 ${skipped.notElapsed} / 株価なし ${skipped.noPrice} / 営業日カレンダーに無い基準日 ${skipped.noCalendar} / スコアなし ${skipped.noScore} / 寄り付きに間に合わず買う日をずらした ${delayedEntry}`
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
    lines.push(`| 中央値(%、控除後) | ${f2(o.medianNet)} |`);
    lines.push(`| 標準偏差(%、控除後) | ${f2(o.stdevNet)} |`);
    lines.push(`| 勝率(控除後 > 0) | ${pct1(o.winRateNet)} |`);
    lines.push(`| TOPIXとの差の平均(%、控除後。${o.excessN}件) | ${f2(o.meanExcessNet)} |`);
    lines.push(`| 参考: 評価日の終値で買えた場合の平均(%) | ${f2(o.meanRefPct)} |`);

    lines.push("");
    lines.push("**スコア帯(件数が等しくなるよう分割。帯1が低スコア)**");
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

    lines.push("");
    lines.push(`**毎日のスコア上位${summary.topN.topN}件 − その日の評価全件の平均(平均リターン、%)**`);
    lines.push("");
    lines.push(`- 比較できた日数: ${summary.topN.days} / 上位の平均 ${f2(summary.topN.meanTopN)} / 全件の平均 ${f2(summary.topN.meanPool)} / 差の平均 ${f2(summary.topN.mean)} / 95%信頼区間 ${ci(summary.topN.ci)}`);
    lines.push(`- スコアと成績の順位相関(日ごと、10件以上の日): 日数 ${summary.ic.days} / 平均 ${f2(summary.ic.mean)} / 95%信頼区間 ${ci(summary.ic.ci)}`);
    lines.push("");
    lines.push("| 基準日 | 件数 | 全件の平均(%) | 上位の平均(%) | 差 | 順位相関 |");
    lines.push("|---|---|---|---|---|---|");
    for (const d of summary.daily) {
      lines.push(`| ${d.signalDate} | ${d.n} | ${f2(d.poolMean)} | ${f2(d.topNMean)} | ${f2(d.diff)} | ${f2(d.ic)} |`);
    }
  }
  return lines.join("\n");
}
