// 値動き・出来高などの「数字そのもの」に、その後の成績(や上昇余地)を順位づける力があるかを、長い日足で測る検証(読み取り専用)。
// 計算だけを行う純粋関数。D1の読み込みと出力は scripts/analyze-features.js が行う。売買・AIの評価・画面には影響しない。
//
// 考え方:
//  - 毎日、流動性のある全銘柄を並べ、各数字(特徴量)と「その後の成績」の順位相関(IC)を日ごとに求め、平均と信頼区間を出す。
//  - 約定の仮定は、既存のバックテストと同じ: 基準日の翌営業日の始値で買い、h営業日後の始値で売る。往復コストを引く。
//  - 先読みをしない: 特徴量は基準日(t)までの値だけから作り、成績は t+1 日以降の値だけから作る。欠けた日がある窓は、推測せず除外する。
//  - 探索期間(固定日より前)と確認期間(固定日以降)に分ける。探索期間と確認期間の両方で、同じ向きに、信頼区間が0を含まないものだけを「通過」とする。
//  - 信頼区間は、日ごとのICが前後の日と似ている(保有期間が重なる・特徴量が緩やかに変わる)ことを考慮し、ブロック・ブートストラップで求める。
import { mean, median, mulberry32 } from "./backtestD1.js";

export const FEATURES = [
  ["ret5", "直近5日の騰落率"],
  ["ret20", "直近20日の騰落率"],
  ["range10", "過去10日の値幅(高値−安値)"],
  ["atr14", "過去14日の1日の値幅の平均(ATR)"],
  ["volSurge", "出来高の急増(直近5日平均÷その前の20日平均)"],
  ["ma25dev", "25日移動平均からの乖離"],
  ["distHigh60", "60日高値からの距離"],
  ["distLow60", "60日安値からの距離"],
  ["gap", "当日の寄り付きのギャップ"],
];
export const FEATURE_KEYS = FEATURES.map(([k]) => k);
export const MIN_HISTORY = 59; // 特徴量に必要な最小の位置(60日高値・安値のため、t-59 まで遡る)

export const DEFAULTS = {
  horizons: [1, 3, 5],
  costPct: 0.3,
  minTurnoverYen: 100_000_000, // 直近20日の平均売買代金(終値×出来高)の下限。流動性の足切り
  minStocks: 200, // その日に比べられる銘柄がこれ未満なら、その日は使わない
  decile: 0.1, // 上位・下位グループの割合
  blockLen: 10, // ブロック・ブートストラップのブロック長(営業日)
  iterations: 2000,
  seed: 20261114,
  holdoutFrom: "2026-03-02", // 確認期間の開始日(これより前が探索期間)
  aiFrom: "2026-10-05", // AI評価のある期間(AIのICと同じ期間で比べる)
  aiTo: "2026-11-02",
  quintileHorizon: 5,
  quintileFeatures: ["range10", "atr14"],
  upThresholds: [3, 5],
  flatPct: 3,
  minDaysForVerdict: 20,
};

const FIELDS = ["open", "high", "low", "close", "volume"];
const num = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// ---------------------------------------------------------------------------------------------
// 日足の表(銘柄 × 営業日)
// ---------------------------------------------------------------------------------------------

/** tradingDays: 昇順の営業日。銘柄ごとに、営業日の位置に対応する配列を持つ。値が無い日は NaN。 */
export function createPanel(tradingDays) {
  return {
    tradingDays,
    D: tradingDays.length,
    dayIndex: new Map(tradingDays.map((d, i) => [d, i])),
    codes: [],
    codeIndex: new Map(),
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
  };
}

/** D1の行({code, date, open, high, low, close, volume})を表に入れる。営業日に無い日付の行は無視する。株価が0以下・欠けは NaN。 */
export function addRows(panel, rows) {
  for (const r of rows) {
    const di = panel.dayIndex.get(r.date);
    if (di === undefined) continue;
    let ci = panel.codeIndex.get(r.code);
    if (ci === undefined) {
      ci = panel.codes.length;
      panel.codeIndex.set(r.code, ci);
      panel.codes.push(r.code);
      for (const f of FIELDS) panel[f].push(new Float64Array(panel.D).fill(NaN));
    }
    for (const f of FIELDS) {
      const v = num(r[f]);
      panel[f][ci][di] = f === "volume" ? (v >= 0 ? v : NaN) : v > 0 ? v : NaN;
    }
  }
}

/**
 * 読み込んだ日足の「日付ごとの件数」から、営業日を決める。
 * 件数が、中央値の minShare 倍に満たない日(蓄積が途中の日・一部の銘柄だけの日)は、全銘柄を比べる検証が歪むので、除く。
 * 戻り値: { days: 昇順の営業日, dropped: [{date, count}], medianCount }
 */
export function deriveTradingDays(countsByDate, { minShare = 0.5 } = {}) {
  const entries = [...countsByDate.entries()].filter(([, n]) => n > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (entries.length === 0) return { days: [], dropped: [], medianCount: 0 };
  const medianCount = median(entries.map(([, n]) => n));
  const days = [];
  const dropped = [];
  for (const [date, count] of entries) {
    if (count >= medianCount * minShare) days.push(date);
    else dropped.push({ date, count });
  }
  return { days, dropped, medianCount };
}

// ---------------------------------------------------------------------------------------------
// 特徴量・成績
// ---------------------------------------------------------------------------------------------

/** 基準日 t(その日の終値まで)の値だけから作る特徴量。必要な日が欠けていれば null。 */
export function featuresAt(panel, c, t) {
  if (t < MIN_HISTORY) return null;
  const H = panel.high[c];
  const L = panel.low[c];
  const C = panel.close[c];
  const V = panel.volume[c];
  const O = panel.open[c];
  const c0 = C[t];
  if (!(c0 > 0)) return null;

  const c5 = C[t - 5];
  const c20 = C[t - 20];
  if (!(c5 > 0) || !(c20 > 0)) return null;

  // 過去10日の値幅
  let mh = -Infinity;
  let ml = Infinity;
  for (let i = t - 9; i <= t; i++) {
    const h = H[i];
    const l = L[i];
    if (!(h > 0) || !(l > 0)) return null;
    if (h > mh) mh = h;
    if (l < ml) ml = l;
  }
  const range10 = ((mh - ml) / c0) * 100;

  // ATR(過去14日の、真の値幅の平均)
  let trSum = 0;
  for (let i = t - 13; i <= t; i++) {
    const h = H[i];
    const l = L[i];
    const pc = C[i - 1];
    if (!(h > 0) || !(l > 0) || !(pc > 0)) return null;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const atr14 = (trSum / 14 / c0) * 100;

  // 出来高の急増
  let vRecent = 0;
  for (let i = t - 4; i <= t; i++) {
    if (!(V[i] >= 0)) return null;
    vRecent += V[i];
  }
  let vBase = 0;
  for (let i = t - 24; i <= t - 5; i++) {
    if (!(V[i] >= 0)) return null;
    vBase += V[i];
  }
  if (!(vBase > 0)) return null;
  const volSurge = vRecent / 5 / (vBase / 20);

  // 25日移動平均からの乖離
  let cSum = 0;
  for (let i = t - 24; i <= t; i++) {
    if (!(C[i] > 0)) return null;
    cSum += C[i];
  }
  const ma25dev = (c0 / (cSum / 25) - 1) * 100;

  // 60日高値・安値からの距離
  let h60 = -Infinity;
  let l60 = Infinity;
  for (let i = t - 59; i <= t; i++) {
    const h = H[i];
    const l = L[i];
    if (!(h > 0) || !(l > 0)) return null;
    if (h > h60) h60 = h;
    if (l < l60) l60 = l;
  }

  const o0 = O[t];
  const pc0 = C[t - 1];
  if (!(o0 > 0) || !(pc0 > 0)) return null;

  return {
    ret5: (c0 / c5 - 1) * 100,
    ret20: (c0 / c20 - 1) * 100,
    range10,
    atr14,
    volSurge,
    ma25dev,
    distHigh60: (c0 / h60 - 1) * 100,
    distLow60: (c0 / l60 - 1) * 100,
    gap: (o0 / pc0 - 1) * 100,
  };
}

/** 直近20日の平均売買代金(終値×出来高。円)。1日でも欠ければ NaN。 */
export function turnover20At(panel, c, t) {
  if (t < 19) return NaN;
  const C = panel.close[c];
  const V = panel.volume[c];
  let sum = 0;
  for (let i = t - 19; i <= t; i++) {
    if (!(C[i] > 0) || !(V[i] >= 0)) return NaN;
    sum += C[i] * V[i];
  }
  return sum / 20;
}

/**
 * 基準日 t の後の成績。翌営業日(t+1)の始値で買い、h営業日後(t+1+h)の始値で売る(既存のバックテストと同じ約定の仮定)。
 *  - ret: 往復コストを引いた騰落率(%)
 *  - up: 保有中(t+1〜t+h)の高値の最大の、買値に対する%(= 上昇余地。実際に取れるとは限らない上限)
 *  - range: 保有中の(高値の最大 − 安値の最小)÷ 買値(%)(= どれだけ動いたか)
 * 必要な日が欠けていれば null。
 */
export function targetsAt(panel, c, t, h, costPct = DEFAULTS.costPct) {
  if (t + 1 + h > panel.D - 1) return null;
  const O = panel.open[c];
  const H = panel.high[c];
  const L = panel.low[c];
  const entry = O[t + 1];
  const exit = O[t + 1 + h];
  if (!(entry > 0) || !(exit > 0)) return null;
  let mh = -Infinity;
  let ml = Infinity;
  for (let i = t + 1; i <= t + h; i++) {
    const hi = H[i];
    const lo = L[i];
    if (!(hi > 0) || !(lo > 0)) return null;
    if (hi > mh) mh = hi;
    if (lo < ml) ml = lo;
  }
  return { ret: (exit / entry - 1) * 100 - costPct, up: (mh / entry - 1) * 100, range: ((mh - ml) / entry) * 100 };
}

// ---------------------------------------------------------------------------------------------
// 順位・相関(型付き配列向け)
// ---------------------------------------------------------------------------------------------

/** 昇順の並び(order)と、同じ値は平均順位にした順位(1始まり)。 */
export function rankOrder(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Float64Array(n);
  let k = 0;
  while (k < n) {
    let end = k;
    while (end + 1 < n && values[order[end + 1]] === values[order[k]]) end++;
    const avg = (k + end) / 2 + 1;
    for (let j = k; j <= end; j++) ranks[order[j]] = avg;
    k = end + 1;
  }
  return { order, ranks };
}

/** 順位どうしのピアソン相関(= スピアマンの順位相関)。どちらかが全て同じ値ならNaN。 */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let num2 = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num2 += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : num2 / Math.sqrt(dx * dy);
}

/** 平均の信頼区間。前後の日が似ていることを考慮し、連続したブロックを選び直す(円環)ブートストラップ。 */
export function blockBootstrapMeanCI(values, { blockLen = DEFAULTS.blockLen, iterations = DEFAULTS.iterations, seed = DEFAULTS.seed } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n: 0, mean: null, lo: null, hi: null };
  if (n < 2) return { n, mean: v[0], lo: null, hi: null };
  const L = Math.min(blockLen, n);
  const blocks = Math.ceil(n / L);
  const rand = mulberry32(seed);
  const means = new Float64Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    let count = 0;
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rand() * n);
      for (let j = 0; j < L && count < n; j++) {
        sum += v[(start + j) % n];
        count++;
      }
    }
    means[it] = sum / n;
  }
  means.sort();
  const at = (p) => means[Math.min(iterations - 1, Math.max(0, Math.floor(p * (iterations - 1))))];
  return { n, mean: mean(v), lo: at(0.025), hi: at(0.975) };
}

// ---------------------------------------------------------------------------------------------
// 1日分の検証
// ---------------------------------------------------------------------------------------------

/**
 * 基準日 t の1日分: 流動性のある銘柄を並べ、各特徴量と成績の順位相関(IC)・上位/下位グループの差を求める。
 * 戻り値: { date, t, n: {h: 比べた銘柄数}, ic: {特徴量: {h: {ret, up, range}}}, spread: {特徴量: {h: {top, bottom}}} } (その日の h が使えなければ、その h は無い)
 * quintileAcc を渡すと、quintileHorizon の「過去の値動きの区分別の、その後の上昇余地・値幅」を積み上げる。
 */
export function studyDay(panel, t, cfg = DEFAULTS, quintileAcc = null) {
  const eligible = [];
  for (let c = 0; c < panel.codes.length; c++) {
    const f = featuresAt(panel, c, t);
    if (!f) continue;
    if (!(turnover20At(panel, c, t) >= cfg.minTurnoverYen)) continue;
    eligible.push({ c, f });
  }
  const day = { date: panel.tradingDays[t], t, n: {}, ic: {}, spread: {} };
  for (const k of FEATURE_KEYS) {
    day.ic[k] = {};
    day.spread[k] = {};
  }

  for (const h of cfg.horizons) {
    const items = [];
    const targets = [];
    for (const e of eligible) {
      const tg = targetsAt(panel, e.c, t, h, cfg.costPct);
      if (tg) {
        items.push(e);
        targets.push(tg);
      }
    }
    const n = items.length;
    if (n < cfg.minStocks) continue;
    day.n[h] = n;

    const tRet = Float64Array.from(targets, (x) => x.ret);
    const tUp = Float64Array.from(targets, (x) => x.up);
    const tRange = Float64Array.from(targets, (x) => x.range);
    const rRet = rankOrder(tRet).ranks;
    const rUp = rankOrder(tUp).ranks;
    const rRange = rankOrder(tRange).ranks;
    const poolMean = mean(Array.from(tRet));
    const k = Math.max(1, Math.floor(n * cfg.decile));

    for (const key of FEATURE_KEYS) {
      const fv = Float64Array.from(items, (e) => e.f[key]);
      const { order, ranks } = rankOrder(fv);
      day.ic[key][h] = { ret: pearson(ranks, rRet), up: pearson(ranks, rUp), range: pearson(ranks, rRange) };
      let top = 0;
      let bottom = 0;
      for (let j = 0; j < k; j++) {
        top += tRet[order[n - 1 - j]];
        bottom += tRet[order[j]];
      }
      day.spread[key][h] = { top: top / k - poolMean, bottom: bottom / k - poolMean };

      if (quintileAcc && h === cfg.quintileHorizon && cfg.quintileFeatures.includes(key)) {
        const bins = (quintileAcc[key] ??= Array.from({ length: 5 }, () => ({ up: [], range: [] })));
        for (let i = 0; i < n; i++) {
          const b = Math.min(4, Math.floor(((ranks[i] - 1) / n) * 5));
          bins[b].up.push(tUp[i]);
          bins[b].range.push(tRange[i]);
        }
      }
    }
  }
  return day;
}

/** 全日を走らせる。戻り値: { days, quintiles, coverage } */
export function runStudy(panel, cfg = DEFAULTS) {
  const quintiles = {};
  const days = [];
  const maxH = Math.min(...cfg.horizons);
  for (let t = MIN_HISTORY; t + 1 + maxH <= panel.D - 1; t++) {
    const d = studyDay(panel, t, cfg, quintiles);
    if (Object.keys(d.n).length > 0) days.push(d);
  }
  return { days, quintiles, coverage: coverageOf(panel) };
}

/** 日足の範囲の目安。途中で終わる銘柄が1つも無ければ、上場廃止の銘柄が含まれていない(生存者バイアス)可能性がある。 */
export function coverageOf(panel) {
  let activeAtEnd = 0;
  let endedEarly = 0;
  let startedLate = 0;
  for (let c = 0; c < panel.codes.length; c++) {
    const C = panel.close[c];
    let first = -1;
    let last = -1;
    for (let i = 0; i < panel.D; i++) {
      if (C[i] > 0) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (last < 0) continue;
    if (last === panel.D - 1) activeAtEnd++;
    else if (last < panel.D - 6) endedEarly++;
    if (first > 5) startedLate++;
  }
  return { codes: panel.codes.length, days: panel.D, activeAtEnd, endedEarly, startedLate };
}

// ---------------------------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------------------------

/** 探索期間と確認期間の両方で、同じ向きに、信頼区間が0を含まなければ「通過」。 */
export function verdict(explore, holdout, { minDays = DEFAULTS.minDaysForVerdict } = {}) {
  if (!explore || !holdout || explore.n < minDays || holdout.n < minDays || explore.lo === null || holdout.lo === null) return "データ不足";
  const sig = (s) => s.lo > 0 || s.hi < 0;
  const exSig = sig(explore);
  const hoSig = sig(holdout);
  if (exSig && hoSig) return Math.sign(explore.mean) === Math.sign(holdout.mean) ? "通過" : "逆転";
  if (exSig) return "探索のみ(確認で消えた)";
  if (hoSig) return "確認のみ(探索では有意でない)";
  return "なし";
}

const pick = (days, fn) => days.map(fn).filter((x) => Number.isFinite(x));

export function summarizeStudy(study, cfg = DEFAULTS) {
  const { days } = study;
  const explore = days.filter((d) => d.date < cfg.holdoutFrom);
  const holdout = days.filter((d) => d.date >= cfg.holdoutFrom);
  const ai = days.filter((d) => d.date >= cfg.aiFrom && d.date <= cfg.aiTo);
  let seedOffset = 0;
  const ci = (values) => blockBootstrapMeanCI(values, { blockLen: cfg.blockLen, iterations: cfg.iterations, seed: cfg.seed + seedOffset++ });

  const rows = [];
  for (const [feature, label] of FEATURES) {
    for (const h of cfg.horizons) {
      const exIc = ci(pick(explore, (d) => d.ic[feature][h]?.ret));
      const hoIc = ci(pick(holdout, (d) => d.ic[feature][h]?.ret));
      const hoTop = ci(pick(holdout, (d) => d.spread[feature][h]?.top));
      const hoBottom = ci(pick(holdout, (d) => d.spread[feature][h]?.bottom));
      const aiVals = pick(ai, (d) => d.ic[feature][h]?.ret);
      rows.push({
        feature,
        label,
        h,
        explore: exIc,
        holdout: hoIc,
        holdoutTop: hoTop,
        holdoutBottom: hoBottom,
        ai: { n: aiVals.length, mean: aiVals.length ? mean(aiVals) : null },
        verdict: verdict(exIc, hoIc, { minDays: cfg.minDaysForVerdict }),
      });
    }
  }

  // 上昇余地・値幅(どれだけ動いたか)との相関。保有期間は quintileHorizon
  const h = cfg.quintileHorizon;
  const movement = FEATURES.map(([feature, label]) => ({
    feature,
    label,
    upExplore: ci(pick(explore, (d) => d.ic[feature][h]?.up)),
    upHoldout: ci(pick(holdout, (d) => d.ic[feature][h]?.up)),
    rangeExplore: ci(pick(explore, (d) => d.ic[feature][h]?.range)),
    rangeHoldout: ci(pick(holdout, (d) => d.ic[feature][h]?.range)),
  }));

  // 過去の値動きの区分別(その日の中での5等分。小さい順)の、その後の上昇余地・値幅
  const quintiles = {};
  for (const [feature, bins] of Object.entries(study.quintiles)) {
    quintiles[feature] = bins.map((b, i) => ({
      band: i + 1,
      n: b.up.length,
      medianUp: median(b.up),
      medianRange: median(b.range),
      shareUp: Object.fromEntries(cfg.upThresholds.map((u) => [u, b.up.length ? b.up.filter((x) => x >= u).length / b.up.length : null])),
      shareFlat: b.range.length ? b.range.filter((x) => x < cfg.flatPct).length / b.range.length : null,
    }));
  }

  return {
    periods: {
      exploreDays: explore.length,
      holdoutDays: holdout.length,
      aiDays: ai.length,
      exploreFrom: explore[0]?.date ?? null,
      exploreTo: explore[explore.length - 1]?.date ?? null,
      holdoutFrom: holdout[0]?.date ?? null,
      holdoutTo: holdout[holdout.length - 1]?.date ?? null,
      avgStocks: days.length ? mean(days.map((d) => Object.values(d.n)[0])) : null,
    },
    rows,
    movement,
    quintiles,
  };
}

// ---------------------------------------------------------------------------------------------
// レポート
// ---------------------------------------------------------------------------------------------

const f2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}`);
const f2s = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const f1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`);
const pc = (v) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(0)}%`);
const ciText = (s, fmt = f2) => (s.mean === null ? "-" : s.lo === null ? `${fmt(s.mean)}` : `${fmt(s.mean)} [${fmt(s.lo)}, ${fmt(s.hi)}]`);

export function formatFeatureReport({ meta, summary }) {
  const p = summary.periods;
  const L = [];
  L.push(`# 値動き・出来高の数字そのものの、順位づけの力の検証(読み取り専用)`);
  L.push(
    `日足: ${meta.firstDay} 〜 ${meta.lastDay}(${meta.coverage.days}営業日・${meta.coverage.codes}銘柄) / 流動性の足切り: 直近20日の平均売買代金 ${(meta.minTurnoverYen / 100_000_000).toFixed(1)}億円以上 / 1日に比べた銘柄数(平均) ${p.avgStocks === null ? "-" : Math.round(p.avgStocks)}`
  );
  if (meta.droppedDays?.length) {
    L.push(
      `銘柄数が少ない日を除外: ${meta.droppedDays.length}日(${meta.droppedDays.slice(0, 5).map((d) => `${d.date}:${d.count}件`).join("、")}${meta.droppedDays.length > 5 ? " ほか" : ""})`
    );
  }
  if (meta.masterCodes) L.push(`銘柄の一覧は stocks マスタ(${meta.masterCodes}件)から取得。日足のある銘柄は ${meta.coverage.codes}件。`);
  L.push(
    `探索期間 ${p.exploreFrom ?? "-"} 〜 ${p.exploreTo ?? "-"}(${p.exploreDays}日) / 確認期間 ${p.holdoutFrom ?? "-"} 〜 ${p.holdoutTo ?? "-"}(${p.holdoutDays}日) / 往復コスト ${meta.costPct}% / 約定: 基準日の翌営業日の始値で買い、保有日数後の始値で売る`
  );
  L.push(
    `日足の範囲: 最終日に値がある銘柄 ${meta.coverage.activeAtEnd} / 途中で終わった銘柄 ${meta.coverage.endedEarly} / 途中から始まった銘柄 ${meta.coverage.startedLate}` +
      (meta.coverage.endedEarly === 0 ? " ← 途中で終わった銘柄が無いため、上場廃止の銘柄が含まれていない(生存者バイアスで、結果が良く見える)可能性があります。" : "")
  );
  L.push(`※ IC = 毎日の、特徴量とその後の成績の順位相関(+1に近いほど「高い銘柄ほど、その後の成績が良い」、-1に近いほど逆)。[ ]は95%信頼区間(ブロック・ブートストラップ)。`);
  L.push(`※ 通過 = 探索期間と確認期間の両方で、同じ向きに、信頼区間が0を含まない。調べた数(特徴量×保有日数)が多いため、偶然の通過が混じる可能性があります。`);

  L.push("", `## 成績(コスト控除後の騰落率)との順位相関`);
  L.push(`| 特徴量 | 保有 | 探索期間のIC | 確認期間のIC | 確認期間: 上位${"10%"}−全体(%) | 確認期間: 下位10%−全体(%) | AI評価の期間のIC | 判定 |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of summary.rows) {
    L.push(
      `| ${r.label} | ${r.h}日 | ${ciText(r.explore)} | ${ciText(r.holdout)} | ${ciText(r.holdoutTop, f2s)} | ${ciText(r.holdoutBottom, f2s)} | ${r.ai.n ? f2(r.ai.mean) : "-"} | ${r.verdict} |`
    );
  }

  L.push("", `## どれだけ動いたか(上昇余地・値幅)との順位相関(保有期間 ${meta.quintileHorizon}営業日)`);
  L.push(`| 特徴量 | 上昇余地: 探索 | 上昇余地: 確認 | 値幅: 探索 | 値幅: 確認 |`);
  L.push(`|---|---|---|---|---|`);
  for (const m of summary.movement) {
    L.push(`| ${m.label} | ${ciText(m.upExplore)} | ${ciText(m.upHoldout)} | ${ciText(m.rangeExplore)} | ${ciText(m.rangeHoldout)} |`);
  }
  L.push(`※ 上昇余地 = 買値に対する、保有期間中の高値の最大(%)。値幅 = 保有期間中の(高値の最大 − 安値の最小)÷買値(%)。`);

  for (const [feature, bins] of Object.entries(summary.quintiles)) {
    const label = FEATURES.find(([k]) => k === feature)?.[1] ?? feature;
    L.push("", `## 「${label}」が小さい銘柄は、その後も動かないか(その日の中で5等分。区分1が小さい。全期間・全日を合算)`);
    L.push(`| 区分 | 件数 | その後の上昇余地(中央値) | ${meta.upThresholds.map((u) => `上昇余地≥${u}%`).join(" | ")} | ほぼ動かない(値幅<${meta.flatPct}%) | その後の値幅(中央値) |`);
    L.push(`|---|---|---|${meta.upThresholds.map(() => "---|").join("")}---|---|`);
    for (const b of bins) {
      L.push(`| ${b.band} | ${b.n} | ${f1(b.medianUp)}% | ${meta.upThresholds.map((u) => pc(b.shareUp[u])).join(" | ")} | ${pc(b.shareFlat)} | ${f1(b.medianRange)}% |`);
    }
  }
  return L.join("\n");
}
