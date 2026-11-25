// 決算データの検証(決算またぎ / 決算後の動き / 業績の物差し)。
// ネットワーク・DBには一切触れない純粋な計算モジュール。
// 取得は scripts/analyze-earnings-jquants.js が行い、ここには整形済みのデータを渡す。
//
// 前提(リーク防止):
//  - 決算の開示日(DiscDate)より後の最初の営業日の「始値」で買う(夜か朝に注文して寄り付きで約定する使い方)。
//  - 売りは h 営業日後の始値。往復コスト costPct を差し引く。
//  - 業績の値は開示日の翌営業日以降にだけ使う。
//  - 流動性は「買う日より前の20営業日」の売買代金だけで判定する。

export const SIGNALS = ['opYoY', 'epsYoY', 'salesYoY', 'guideOP', 'revOP'];
export const SIGNAL_LABELS = {
  opYoY: '営業利益の前年同期比',
  epsYoY: 'EPSの前年同期比',
  salesYoY: '売上の前年同期比',
  guideOP: 'FY決算の翌期営業利益予想(対当期実績)',
  revOP: '会社予想(営業利益)の修正率',
};

export const DEFAULTS = {
  holds: [1, 3, 5, 10, 20],
  costPct: 0.3,
  exploreEnd: '2024-06-30',
  minVa: 50_000_000, // 買う日より前20営業日の平均売買代金(円)
  vaWindow: 20,
  minGroup: 20, // 決算またぎ: 1日あたり各群の最小銘柄数
  minIcN: 30, // 毎日の順位相関: 1日あたり最小銘柄数
  minEventIcN: 15, // 決算後の動き: 1日あたり最小イベント数
  freshDays: 20, // 開示から何営業日までを「決算直後」とみなすか
  staleMax: 130, // それ以降は値を使わない(次の決算で置き換わる想定)
};

// ---------------------------------------------------------------- 基本統計
export function mean(a) {
  let s = 0;
  let n = 0;
  for (const v of a) {
    if (Number.isFinite(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : NaN;
}

export function stdev(a) {
  const m = mean(a);
  let s = 0;
  let n = 0;
  for (const v of a) {
    if (Number.isFinite(v)) {
      s += (v - m) ** 2;
      n++;
    }
  }
  return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
}

export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function rankAvg(vals) {
  const n = vals.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => vals[a] - vals[b]);
  const r = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && vals[idx[j + 1]] === vals[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(x, y) {
  if (x.length !== y.length || x.length < 3) return NaN;
  return pearson(rankAvg(x), rankAvg(y));
}

// 平均の95%区間。保有期間が重なる系列の自己相関を Newey-West で補正する。
export function neweyWestMean(series, lag = 1) {
  const d = [];
  for (const v of series) if (Number.isFinite(v)) d.push(v);
  const n = d.length;
  if (n < 2) return { n, mean: n ? d[0] : NaN, se: NaN, lo: NaN, hi: NaN, t: NaN };
  const m = mean(d);
  const L = Math.max(0, Math.min(Math.floor(lag), n - 1));
  let v = 0;
  for (let t = 0; t < n; t++) v += (d[t] - m) ** 2;
  v /= n;
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let t = l; t < n; t++) g += (d[t] - m) * (d[t - l] - m);
    g /= n;
    v += 2 * (1 - l / (L + 1)) * g;
  }
  const se = Math.sqrt(Math.max(v, 0) / n);
  return { n, mean: m, se, lo: m - 1.96 * se, hi: m + 1.96 * se, t: se > 0 ? m / se : NaN };
}

// 同じ日に入るイベントをまとめて(クラスタ)標準誤差を出す平均の95%区間。
export function clusterMean(values, clusters) {
  const n = values.length;
  if (n < 2) return { n, mean: n ? values[0] : NaN, se: NaN, lo: NaN, hi: NaN, t: NaN };
  const m = mean(values);
  const sums = new Map();
  for (let i = 0; i < n; i++) {
    sums.set(clusters[i], (sums.get(clusters[i]) ?? 0) + (values[i] - m));
  }
  let ss = 0;
  for (const s of sums.values()) ss += s * s;
  const se = Math.sqrt(ss) / n;
  return { n, mean: m, se, lo: m - 1.96 * se, hi: m + 1.96 * se, t: se > 0 ? m / se : NaN };
}

// ---------------------------------------------------------------- 日付・コード
export function toIsoDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

export function toShortCode(code) {
  const s = String(code ?? '').trim();
  return s.length === 5 && s.endsWith('0') ? s.slice(0, 4) : s;
}

// days[idx] > dateStr となる最初の idx(無ければ days.length)
export function firstIndexAfter(days, dateStr) {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] > dateStr) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function dayDiff(a, b) {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}

// ---------------------------------------------------------------- 決算イベントの組み立て
export function classifyDocType(docType) {
  const s = String(docType ?? '');
  if (/EarnForecastRevision/i.test(s)) return 'REV'; // 業績予想の修正
  if (/FinancialStatements/i.test(s)) return 'FS'; // 決算短信
  return null;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function growth(cur, prev) {
  if (cur === null || prev === null || prev === 0) return null;
  const g = (cur - prev) / Math.abs(prev);
  return Math.max(-5, Math.min(5, g)); // 極端値は±500%で丸める
}

function sortKey(r) {
  return `${r.date} ${r.time}`;
}

// fins/summary の生の行 → 決算イベント(シグナル付き)
export function buildEvents(rows) {
  const items = [];
  for (const r of rows) {
    const cls = classifyDocType(r.DocType);
    if (!cls) continue;
    const date = toIsoDate(r.DiscDate);
    if (!date) continue;
    items.push({
      code: toShortCode(r.Code),
      date,
      time: String(r.DiscTime ?? ''),
      cls,
      perType: String(r.CurPerType ?? ''),
      perEnd: toIsoDate(r.CurPerEn),
      fyEnd: toIsoDate(r.CurFYEn),
      nextFyEnd: toIsoDate(r.NxtFYEn),
      sales: num(r.Sales),
      op: num(r.OP),
      eps: num(r.EPS),
      fop: num(r.FOP),
      nxfop: num(r.NxFOP ?? r.NxtFOP),
      consolidated: /Consolidated/i.test(String(r.DocType)) && !/NonConsolidated/i.test(String(r.DocType)),
    });
  }

  // 同じ(銘柄, 期間種別, 期末)の決算短信は最初の開示だけを採用(同日なら連結を優先)
  const fsMap = new Map();
  for (const it of items) {
    if (it.cls !== 'FS') continue;
    const key = `${it.code}|${it.perType}|${it.perEnd}`;
    const cur = fsMap.get(key);
    if (
      !cur ||
      sortKey(it) < sortKey(cur) ||
      (it.date === cur.date && it.consolidated && !cur.consolidated)
    ) {
      fsMap.set(key, it);
    }
  }
  const fs = [...fsMap.values()];
  const rev = items.filter((x) => x.cls === 'REV');

  // 決算期ごとの「その開示で示された通期の営業利益予想」
  const withForecast = (it) => {
    if (it.cls === 'FS' && it.perType === 'FY') return { fcOP: it.nxfop, fcFY: it.nextFyEnd };
    return { fcOP: it.fop, fcFY: it.fyEnd };
  };

  const byCode = new Map();
  for (const it of [...fs, ...rev]) {
    if (!byCode.has(it.code)) byCode.set(it.code, []);
    byCode.get(it.code).push(it);
  }
  const fsByCodeType = new Map();
  for (const it of fs) {
    const k = `${it.code}|${it.perType}`;
    if (!fsByCodeType.has(k)) fsByCodeType.set(k, []);
    fsByCodeType.get(k).push(it);
  }

  const events = [];
  for (const [code, list] of byCode) {
    list.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    for (let k = 0; k < list.length; k++) {
      const it = list[k];
      const sig = { opYoY: null, epsYoY: null, salesYoY: null, guideOP: null, revOP: null };

      if (it.cls === 'FS') {
        // 前年同期: 同じ期間種別で期末が約1年前
        const cands = fsByCodeType.get(`${code}|${it.perType}`) ?? [];
        let prev = null;
        let best = Infinity;
        for (const c of cands) {
          if (c === it || !c.perEnd || !it.perEnd) continue;
          const gap = dayDiff(it.perEnd, c.perEnd);
          if (gap >= 350 && gap <= 380 && Math.abs(gap - 365) < best) {
            best = Math.abs(gap - 365);
            prev = c;
          }
        }
        if (prev) {
          sig.opYoY = growth(it.op, prev.op);
          sig.epsYoY = growth(it.eps, prev.eps);
          sig.salesYoY = growth(it.sales, prev.sales);
        }
        if (it.perType === 'FY') sig.guideOP = growth(it.nxfop, it.op);
      }

      // 予想修正: 同じ決算期の直前の予想との差
      const cur = withForecast(it);
      if (cur.fcOP !== null && cur.fcFY) {
        for (let j = k - 1; j >= 0; j--) {
          const p = withForecast(list[j]);
          if (p.fcFY === cur.fcFY && p.fcOP !== null) {
            sig.revOP = growth(cur.fcOP, p.fcOP);
            break;
          }
        }
      }

      events.push({ code, date: it.date, time: it.time, cls: it.cls, perType: it.perType, signals: sig });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

// ---------------------------------------------------------------- 検証本体
function summarizePool(arr, cost) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const net = new Float64Array(n);
  let abs = 0;
  let win = 0;
  for (let i = 0; i < n; i++) {
    net[i] = arr[i] - cost;
    abs += Math.abs(arr[i]);
    if (net[i] > 0) win++;
  }
  const sorted = Float64Array.from(net).sort();
  return {
    n,
    mean: mean(net),
    median: quantileSorted(sorted, 0.5),
    std: stdev(net),
    p5: quantileSorted(sorted, 0.05),
    win: win / n,
    meanAbs: abs / n,
  };
}

function splitByPeriod(series, isExploreFn) {
  const ex = [];
  const cf = [];
  for (const s of series) (isExploreFn(s.i) ? ex : cf).push(s);
  return { explore: ex, confirm: cf };
}

function summarizeIc(series, days, isExploreFn, lag) {
  const parts = splitByPeriod(series, isExploreFn);
  const ex = neweyWestMean(parts.explore.map((s) => s.v), lag);
  const cf = neweyWestMean(parts.confirm.map((s) => s.v), lag);
  const byYear = new Map();
  for (const s of series) {
    const y = days[s.i].slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s.v);
  }
  const all = mean(series.map((s) => s.v));
  let same = 0;
  let total = 0;
  for (const arr of byYear.values()) {
    if (arr.length < 20) continue;
    total++;
    if (Math.sign(mean(arr)) === Math.sign(all)) same++;
  }
  const pass =
    ex.n >= 20 &&
    cf.n >= 20 &&
    ((ex.lo > 0 && cf.lo > 0) || (ex.hi < 0 && cf.hi < 0));
  return { explore: ex, confirm: cf, years: { same, total }, pass };
}

export function runStudy(dataset, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { days, stocks, events } = dataset;
  const T = days.length;
  const S = stocks.length;
  const holds = o.holds;
  const H = holds.length;
  const cost = o.costPct / 100;
  const isExplore = (i) => days[i] <= o.exploreEnd;

  // --- 流動性(買う日より前の vaWindow 営業日の平均売買代金)
  const liq = new Uint8Array(S * T);
  for (let s = 0; s < S; s++) {
    const va = stocks[s].va;
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < T; i++) {
      liq[s * T + i] = cnt >= Math.ceil(o.vaWindow / 2) && sum / cnt >= o.minVa ? 1 : 0;
      const v = va[i];
      if (Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
      const j = i - o.vaWindow;
      if (j >= 0) {
        const vv = va[j];
        if (Number.isFinite(vv)) {
          sum -= vv;
          cnt--;
        }
      }
    }
  }

  // --- イベントを銘柄・日付に結びつける
  const codeIdx = new Map();
  stocks.forEach((st, s) => codeIdx.set(st.code, s));
  const evs = [];
  const evCount = { FS: 0, REV: 0, dropped: 0 };
  for (const e of events) {
    const s = codeIdx.get(e.code);
    if (s === undefined) {
      evCount.dropped++;
      continue;
    }
    const entry = firstIndexAfter(days, e.date);
    if (entry >= T) {
      evCount.dropped++;
      continue;
    }
    evCount[e.cls]++;
    evs.push({ ...e, s, entry });
  }
  const fsDaysByStock = new Map();
  for (const e of evs) {
    if (e.cls !== 'FS' || e.entry - 1 < 0) continue;
    if (!fsDaysByStock.has(e.s)) fsDaysByStock.set(e.s, []);
    fsDaysByStock.get(e.s).push(e.entry - 1);
  }

  // =========================================================== パスA: 全体平均 + 決算またぎ
  const mk = () => holds.map(() => new Float64Array(T));
  const mkI = () => holds.map(() => new Int32Array(T));
  const allSum = mk();
  const allCnt = mkI();
  const gSum = [mk(), mk()];
  const gAbs = [mk(), mk()];
  const gCnt = [mkI(), mkI()];
  const pooled = holds.map(() => ({ explore: [[], []], confirm: [[], []] }));
  const pre = new Int32Array(T + 1);

  for (let s = 0; s < S; s++) {
    const open = stocks[s].open;
    const fsDays = fsDaysByStock.get(s);
    pre.fill(0);
    if (fsDays) {
      const mark = new Uint8Array(T);
      for (const d of fsDays) if (d < T) mark[d] = 1;
      for (let k = 0; k < T; k++) pre[k + 1] = pre[k] + mark[k];
    }
    for (let hi = 0; hi < H; hi++) {
      const h = holds[hi];
      for (let i = 0; i + h < T; i++) {
        if (!liq[s * T + i]) continue;
        const o0 = open[i];
        const o1 = open[i + h];
        if (!(o0 > 0 && o1 > 0)) continue;
        const ret = o1 / o0 - 1;
        allSum[hi][i] += ret;
        allCnt[hi][i]++;
        const g = fsDays && pre[i + h] - pre[i] > 0 ? 1 : 0;
        gSum[g][hi][i] += ret;
        gAbs[g][hi][i] += Math.abs(ret);
        gCnt[g][hi][i]++;
        if (i % h === 0) pooled[hi][isExplore(i) ? 'explore' : 'confirm'][g].push(ret);
      }
    }
  }
  const allMean = holds.map((_, hi) => {
    const a = new Float64Array(T).fill(NaN);
    for (let i = 0; i < T; i++) if (allCnt[hi][i] >= 50) a[i] = allSum[hi][i] / allCnt[hi][i];
    return a;
  });

  const crossing = {};
  for (let hi = 0; hi < H; hi++) {
    const h = holds[hi];
    const diff = [];
    const diffAbs = [];
    for (let i = 0; i + h < T; i++) {
      if (gCnt[1][hi][i] >= o.minGroup && gCnt[0][hi][i] >= o.minGroup) {
        const m1 = gSum[1][hi][i] / gCnt[1][hi][i];
        const m0 = gSum[0][hi][i] / gCnt[0][hi][i];
        const a1 = gAbs[1][hi][i] / gCnt[1][hi][i];
        const a0 = gAbs[0][hi][i] / gCnt[0][hi][i];
        diff.push({ i, v: m1 - m0 });
        diffAbs.push({ i, v: a1 - a0 });
      }
    }
    const d = splitByPeriod(diff, isExplore);
    const da = splitByPeriod(diffAbs, isExplore);
    crossing[h] = {};
    for (const p of ['explore', 'confirm']) {
      crossing[h][p] = {
        cross: summarizePool(pooled[hi][p][1], cost),
        non: summarizePool(pooled[hi][p][0], cost),
        diffMean: neweyWestMean(d[p].map((x) => x.v), h),
        diffAbs: neweyWestMean(da[p].map((x) => x.v), h),
      };
    }
  }

  // =========================================================== パスB: 決算後の動き(PEAD)
  const pead = {};
  const baseline = {};
  const recs = holds.map(() => []);
  for (const e of evs) {
    for (let hi = 0; hi < H; hi++) {
      const h = holds[hi];
      if (e.entry + h >= T) continue;
      if (!liq[e.s * T + e.entry]) continue;
      const open = stocks[e.s].open;
      const o0 = open[e.entry];
      const o1 = open[e.entry + h];
      if (!(o0 > 0 && o1 > 0)) continue;
      const m = allMean[hi][e.entry];
      if (!Number.isFinite(m)) continue;
      const ret = o1 / o0 - 1;
      recs[hi].push({ e, ret, ex: ret - m });
    }
  }

  for (let hi = 0; hi < H; hi++) {
    const h = holds[hi];
    baseline[h] = {};
    for (const p of ['explore', 'confirm']) {
      const rows = recs[hi].filter((r) => r.e.cls === 'FS' && isExplore(r.e.entry) === (p === 'explore'));
      baseline[h][p] = clusterMean(
        rows.map((r) => r.ex),
        rows.map((r) => r.e.entry),
      );
    }
  }

  for (const sig of SIGNALS) {
    // 区切り値は探索期間のイベントだけから決める(確認期間に情報を漏らさない)
    const exploreVals = [];
    for (const e of evs) {
      const v = e.signals[sig];
      if (v !== null && isExplore(e.entry)) exploreVals.push(v);
    }
    exploreVals.sort((a, b) => a - b);
    const cuts =
      exploreVals.length >= 100 ? [0.2, 0.4, 0.6, 0.8].map((q) => quantileSorted(exploreVals, q)) : null;
    const bucketOf = (v) => (v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : v <= cuts[3] ? 3 : 4);

    pead[sig] = { cuts, byHold: {} };
    for (let hi = 0; hi < H; hi++) {
      const h = holds[hi];
      const rows = recs[hi].filter((r) => r.e.signals[sig] !== null);
      // 毎日の順位相関(その日に入るイベント同士)
      const byDay = new Map();
      for (const r of rows) {
        if (!byDay.has(r.e.entry)) byDay.set(r.e.entry, { x: [], y: [] });
        const b = byDay.get(r.e.entry);
        b.x.push(r.e.signals[sig]);
        b.y.push(r.ex);
      }
      const series = [];
      for (const i of [...byDay.keys()].sort((a, b) => a - b)) {
        const b = byDay.get(i);
        if (b.x.length >= o.minEventIcN) {
          const ic = spearman(b.x, b.y);
          if (Number.isFinite(ic)) series.push({ i, v: ic });
        }
      }
      const ic = summarizeIc(series, days, isExplore, h);

      let buckets = null;
      let spread = null;
      if (cuts) {
        buckets = { explore: [], confirm: [] };
        spread = {};
        for (const p of ['explore', 'confirm']) {
          const sel = rows.filter((r) => isExplore(r.e.entry) === (p === 'explore'));
          const per = [0, 1, 2, 3, 4].map((b) => {
            const rr = sel.filter((r) => bucketOf(r.e.signals[sig]) === b);
            return {
              ex: clusterMean(
                rr.map((r) => r.ex),
                rr.map((r) => r.e.entry),
              ),
              net: mean(rr.map((r) => r.ret - cost)),
              n: rr.length,
            };
          });
          buckets[p] = per;
          const se = Math.sqrt((per[4].ex.se ?? NaN) ** 2 + (per[0].ex.se ?? NaN) ** 2);
          const d = per[4].ex.mean - per[0].ex.mean;
          spread[p] = { mean: d, se, lo: d - 1.96 * se, hi: d + 1.96 * se };
        }
      }
      pead[sig].byHold[h] = { ic, buckets, spread };
    }
  }

  // =========================================================== パスC: 毎日の順位づけ(直後 / それ以降)
  const NS = SIGNALS.length;
  const evBySig = SIGNALS.map(() => new Map());
  for (const e of evs) {
    SIGNALS.forEach((sig, k) => {
      const v = e.signals[sig];
      if (v === null) return;
      const m = evBySig[k];
      if (!m.has(e.s)) m.set(e.s, []);
      m.get(e.s).push({ entry: e.entry, v });
    });
  }
  for (const m of evBySig) for (const list of m.values()) list.sort((a, b) => a.entry - b.entry);
  const cur = new Int32Array(S * NS).fill(-1);

  const GROUPS = ['fresh', 'stale'];
  const icSeries = {};
  for (const sig of SIGNALS) {
    icSeries[sig] = {};
    for (const g of GROUPS) {
      icSeries[sig][g] = {};
      for (const h of holds) icSeries[sig][g][h] = [];
    }
  }
  const Y = holds.map(() => new Float64Array(S));

  for (let i = 0; i + 1 < T; i++) {
    // その日に有効なシグナルを持つ銘柄を群ごとに集める
    const lists = SIGNALS.map(() => ({ fresh: { s: [], x: [] }, stale: { s: [], x: [] } }));
    for (let s = 0; s < S; s++) {
      if (!liq[s * T + i]) continue;
      for (let k = 0; k < NS; k++) {
        const list = evBySig[k].get(s);
        if (!list) continue;
        let c = cur[s * NS + k];
        while (c + 1 < list.length && list[c + 1].entry <= i) c++;
        cur[s * NS + k] = c;
        if (c < 0) continue;
        const age = i - list[c].entry;
        if (age > o.staleMax) continue;
        const grp = age <= o.freshDays ? lists[k].fresh : lists[k].stale;
        grp.s.push(s);
        grp.x.push(list[c].v);
      }
    }
    for (let hi = 0; hi < H; hi++) {
      const h = holds[hi];
      if (i + h >= T || !Number.isFinite(allMean[hi][i])) continue;
      const y = Y[hi];
      y.fill(NaN);
      const need = new Set();
      for (let k = 0; k < NS; k++) {
        for (const g of GROUPS) for (const s of lists[k][g].s) need.add(s);
      }
      for (const s of need) {
        const open = stocks[s].open;
        const o0 = open[i];
        const o1 = open[i + h];
        if (o0 > 0 && o1 > 0) y[s] = o1 / o0 - 1 - allMean[hi][i];
      }
      for (let k = 0; k < NS; k++) {
        for (const g of GROUPS) {
          const L = lists[k][g];
          const xs = [];
          const ys = [];
          for (let q = 0; q < L.s.length; q++) {
            const yy = y[L.s[q]];
            if (Number.isFinite(yy)) {
              xs.push(L.x[q]);
              ys.push(yy);
            }
          }
          if (xs.length >= o.minIcN) {
            const ic = spearman(xs, ys);
            if (Number.isFinite(ic)) icSeries[SIGNALS[k]][g][h].push({ i, v: ic });
          }
        }
      }
    }
  }
  const ranking = {};
  for (const sig of SIGNALS) {
    ranking[sig] = {};
    for (const g of GROUPS) {
      ranking[sig][g] = {};
      for (const h of holds) ranking[sig][g][h] = summarizeIc(icSeries[sig][g][h], days, isExplore, h);
    }
  }

  return {
    meta: {
      firstDay: days[0],
      lastDay: days[T - 1],
      days: T,
      stocks: S,
      events: evCount,
      options: o,
    },
    crossing,
    baseline,
    pead,
    ranking,
  };
}

// ---------------------------------------------------------------- 表示
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '  n/a');
const ic3 = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}` : ' n/a');
const nwIc = (r) => (r && r.n ? `${ic3(r.mean)}[${ic3(r.lo)},${ic3(r.hi)}]` : 'n/a');
const nwPct = (r) => (r && r.n ? `${pct(r.mean)}[${pct(r.lo)},${pct(r.hi)}]` : 'n/a');

export function formatReport(res) {
  const L = [];
  const m = res.meta;
  const o = m.options;
  L.push('=== 決算データ検証 ===');
  L.push(
    `期間 ${m.firstDay} 〜 ${m.lastDay} / ${m.days}営業日 / ${m.stocks}銘柄 / 決算短信イベント${m.events.FS}件・予想修正${m.events.REV}件(銘柄・日付が合わず除外${m.events.dropped}件)`,
  );
  L.push(
    `探索期間 〜${o.exploreEnd} / 確認期間 それ以降 / 買い=開示の翌営業日の始値 / 往復コスト${o.costPct}% / 流動性 直前${o.vaWindow}日の平均売買代金≥${(o.minVa / 1e6).toFixed(0)}百万円`,
  );
  L.push('「通過」= 探索・確認の両期間で95%区間が0を含まず同じ向き(重なる保有期間はNewey-West補正)');
  L.push('');

  L.push('--- 1. 決算またぎ(保有期間中に決算短信の開示が入るか) ---');
  L.push('各行: n / 平均(コスト控除後) / 中央値 / 下位5% / 勝率 / σ 。差=またぎ−非またぎの日次平均差');
  for (const h of o.holds) {
    for (const p of ['explore', 'confirm']) {
      const c = res.crossing[h][p];
      const row = (g) =>
        g.n
          ? `n=${g.n} 平均${pct(g.mean)} 中央${pct(g.median)} 下5%${pct(g.p5)} 勝率${(g.win * 100).toFixed(1)}% σ${(g.std * 100).toFixed(2)}%`
          : 'n=0';
      L.push(`[${h}日 ${p === 'explore' ? '探索' : '確認'}] またぎ: ${row(c.cross)}`);
      L.push(`           非またぎ: ${row(c.non)}`);
      L.push(`           差(平均) ${nwPct(c.diffMean)} / 値幅(|リターン|)の差 ${nwPct(c.diffAbs)}`);
    }
  }
  L.push('');

  L.push('--- 2. 決算後の動き(PEAD): 開示の翌営業日の始値で買い、h日後の始値で売る ---');
  L.push('基準: 全決算短信イベントの平均超過リターン(市場平均との差)');
  for (const h of o.holds) {
    L.push(
      `  ${h}日: 探索 ${nwPct(res.baseline[h].explore)} / 確認 ${nwPct(res.baseline[h].confirm)}`,
    );
  }
  L.push('各シグナル: IC(同じ日に入るイベント内の順位相関) / 上位20%−下位20%の超過リターン差 / 上位20%を買った場合(コスト控除後の平均)');
  for (const sig of SIGNALS) {
    L.push(`# ${SIGNAL_LABELS[sig]} (${sig})`);
    for (const h of o.holds) {
      const r = res.pead[sig].byHold[h];
      const mark = r.ic.pass ? '★通過' : '  -  ';
      let tail = '';
      if (r.spread) {
        const cf = r.spread.confirm;
        const q5 = r.buckets.confirm[4];
        tail = ` | 確認 上位−下位 ${pct(cf.mean)}[${pct(cf.lo)},${pct(cf.hi)}] 上位買い${pct(q5.net)}(n=${q5.n})`;
      }
      L.push(
        `  ${h}日 ${mark} IC 探索${nwIc(r.ic.explore)} 確認${nwIc(r.ic.confirm)} 年${r.ic.years.same}/${r.ic.years.total}${tail}`,
      );
    }
  }
  L.push('');

  L.push(`--- 3. 毎日の順位づけ(直近の業績を日々のランキング材料にした場合。直後=開示から${o.freshDays}営業日以内 / それ以降) ---`);
  for (const sig of SIGNALS) {
    L.push(`# ${SIGNAL_LABELS[sig]} (${sig})`);
    for (const g of ['fresh', 'stale']) {
      for (const h of o.holds) {
        const r = res.ranking[sig][g][h];
        const mark = r.pass ? '★通過' : '  -  ';
        L.push(
          `  ${g === 'fresh' ? '直後' : 'それ以降'} ${h}日 ${mark} IC 探索${nwIc(r.explore)} 確認${nwIc(r.confirm)} 年${r.years.same}/${r.years.total}`,
        );
      }
    }
  }
  L.push('');
  L.push('注意: 通過は「統計的に0でない」ことだけを示し、利益を保証しない。シグナル5つ×保有5通り×(複数の見方)を見ているため、偶然の通過が混じる。');
  return L.join('\n');
}
