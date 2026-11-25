import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mean,
  spearman,
  rankAvg,
  neweyWestMean,
  clusterMean,
  classifyDocType,
  toShortCode,
  toIsoDate,
  firstIndexAfter,
  buildEvents,
  runStudy,
  formatReport,
} from '../src/earningsStudy.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

test('基本: 順位・順位相関・コード・日付', () => {
  assert.deepEqual(Array.from(rankAvg([10, 20, 20, 5])), [2, 3.5, 3.5, 1]);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 9]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [9, 8, 7, 6, 5]) + 1) < 1e-12);
  assert.equal(toShortCode('13010'), '1301');
  assert.equal(toShortCode('135A0'), '135A');
  assert.equal(toShortCode('86974'), '86974');
  assert.equal(toIsoDate('20240701'), '2024-07-01');
  assert.equal(toIsoDate('2024-07-01'), '2024-07-01');
  const days = ['2024-07-01', '2024-07-02', '2024-07-03'];
  assert.equal(firstIndexAfter(days, '2024-06-30'), 0);
  assert.equal(firstIndexAfter(days, '2024-07-01'), 1); // 当日は含まない(翌営業日)
  assert.equal(firstIndexAfter(days, '2024-07-02'), 2);
  assert.equal(firstIndexAfter(days, '2024-07-03'), 3);
  assert.equal(firstIndexAfter(days, '2024-07-06'), 3); // 休日開示 → 次の営業日
});

test('区間: 定数系列は幅0、ばらつきのある系列は幅>0、クラスタ', () => {
  const c = neweyWestMean([0.1, 0.1, 0.1, 0.1], 2);
  assert.equal(c.se, 0);
  const r = rng(1);
  const x = Array.from({ length: 400 }, () => 0.5 + gauss(r));
  const nw = neweyWestMean(x, 3);
  assert.ok(nw.lo > 0 && nw.hi < 1);
  const cl = clusterMean([1, 1, 3, 3], ['a', 'a', 'b', 'b']);
  assert.equal(cl.mean, 2);
  assert.ok(cl.se > 0);
});

test('決算種別の判定', () => {
  assert.equal(classifyDocType('FYFinancialStatements_Consolidated_JP'), 'FS');
  assert.equal(classifyDocType('1QFinancialStatements_Consolidated_JP'), 'FS');
  assert.equal(classifyDocType('EarnForecastRevision'), 'REV');
  assert.equal(classifyDocType('DividendForecastRevision'), null);
  assert.equal(classifyDocType('REITForecastRevision'), null);
  assert.equal(classifyDocType(undefined), null);
});

test('イベント組み立て: 前年同期比・翌期予想・予想修正', () => {
  const rows = [
    // 前年のFY(2023-03期)
    { Code: '12340', DiscDate: '2023-05-10', DiscTime: '15:00:00', DocType: 'FYFinancialStatements_Consolidated_JP', CurPerType: 'FY', CurPerEn: '2023-03-31', CurFYEn: '2023-03-31', NxtFYEn: '2024-03-31', Sales: '1000', OP: '100', EPS: '50', NxFOP: '110' },
    // 当年の1Q(2024-06末)は前年の1Qが無いので前年同期比は null
    { Code: '12340', DiscDate: '2023-08-08', DiscTime: '15:00:00', DocType: '1QFinancialStatements_Consolidated_JP', CurPerType: '1Q', CurPerEn: '2023-06-30', CurFYEn: '2024-03-31', NxtFYEn: '2025-03-31', Sales: '260', OP: '20', EPS: '10', FOP: '110' },
    // 予想修正(110 → 132 = +20%)
    { Code: '12340', DiscDate: '2023-10-20', DiscTime: '13:00:00', DocType: 'EarnForecastRevision', CurPerType: '2Q', CurPerEn: '2023-09-30', CurFYEn: '2024-03-31', NxtFYEn: '2025-03-31', FOP: '132' },
    // FY(2024-03期): 前年比 OP 100→150 = +50%, 翌期予想 165 → 当期実績比 +10%
    { Code: '12340', DiscDate: '2024-05-10', DiscTime: '15:00:00', DocType: 'FYFinancialStatements_Consolidated_JP', CurPerType: 'FY', CurPerEn: '2024-03-31', CurFYEn: '2024-03-31', NxtFYEn: '2025-03-31', Sales: '1200', OP: '150', EPS: '75', NxFOP: '165' },
    // 対象外の書類
    { Code: '12340', DiscDate: '2024-05-10', DocType: 'DividendForecastRevision', CurPerType: 'FY', CurPerEn: '2024-03-31' },
  ];
  const ev = buildEvents(rows);
  assert.equal(ev.length, 4);
  assert.ok(ev.every((e) => e.code === '1234'));
  const fy24 = ev.find((e) => e.date === '2024-05-10');
  assert.ok(Math.abs(fy24.signals.opYoY - 0.5) < 1e-9);
  assert.ok(Math.abs(fy24.signals.epsYoY - 0.5) < 1e-9);
  assert.ok(Math.abs(fy24.signals.salesYoY - 0.2) < 1e-9);
  assert.ok(Math.abs(fy24.signals.guideOP - 0.1) < 1e-9);
  const rev = ev.find((e) => e.cls === 'REV');
  assert.ok(Math.abs(rev.signals.revOP - 0.2) < 1e-9);
  const q1 = ev.find((e) => e.perType === '1Q');
  assert.equal(q1.signals.opYoY, null);
  // 未来の情報を使わない: 2023-05-10 の決算の前年同期は無いので null
  const fy23 = ev.find((e) => e.date === '2023-05-10');
  assert.equal(fy23.signals.opYoY, null);
});

// ---- 合成データ ------------------------------------------------------------
// 営業日 360 日。決算は「シーズン」(30営業日ごと、5営業日の幅)にまとめて入る。
function weekdays(startIso, n) {
  const out = [];
  const d = new Date(`${startIso}T00:00:00Z`);
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function makeDataset({ plantDrift, plantEntryJump, plantEventVol, seed = 7 }) {
  const r = rng(seed);
  const T = 360;
  const days = weekdays('2023-01-02', T);
  const S = 220;
  const stocks = [];
  const events = [];
  const seasonStarts = [];
  for (let k = 20; k + 6 < T; k += 30) seasonStarts.push(k);
  for (let s = 0; s < S; s++) {
    const code = String(1000 + s);
    const open = new Float64Array(T);
    const va = new Float64Array(T).fill(1e9);
    // この銘柄の決算イベント(開示日のインデックス)
    const evIdx = seasonStarts.map((k) => k + Math.floor(r() * 5));
    const evSig = evIdx.map(() => (r() < 0.5 ? -1 : 1) * (0.1 + r() * 0.4));
    const dailyShock = new Float64Array(T);
    for (let t = 0; t < T; t++) dailyShock[t] = 0.012 * gauss(r);
    evIdx.forEach((d, q) => {
      const entry = d + 1;
      if (entry + 6 >= T) return;
      if (plantEntryJump) dailyShock[entry] += 0.06 * Math.sign(evSig[q]); // 開示後の最初の始値(買い値より前)で動く
      if (plantDrift) for (let t = entry; t < entry + 5; t++) dailyShock[t + 1] += 0.004 * Math.sign(evSig[q]);
      if (plantEventVol) for (let t = d; t <= d + 1; t++) dailyShock[t] += 0.03 * gauss(r); // 決算またぎで値幅が大きくなる
    });
    let p = 1000;
    for (let t = 0; t < T; t++) {
      p *= Math.exp(dailyShock[t]);
      open[t] = p;
    }
    stocks.push({ code, open, va });
    evIdx.forEach((d, q) => {
      if (d >= T) return;
      events.push({
        code,
        date: days[d],
        time: '15:00:00',
        cls: 'FS',
        perType: 'Q',
        signals: { opYoY: evSig[q], epsYoY: evSig[q] * 0.9, salesYoY: null, guideOP: null, revOP: null },
      });
    });
  }
  return { days, stocks, events };
}

test('合成データ(効果なし): 決算後の動きは「通過」しない', () => {
  const ds = makeDataset({});
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [1, 5], minEventIcN: 15 });
  assert.equal(res.pead.opYoY.byHold[5].ic.pass, false);
  assert.equal(res.pead.opYoY.byHold[1].ic.pass, false);
});

function days180(ds) {
  return ds.days[180];
}

test('合成データ(決算後に5日ドリフト): 順位相関が両期間で正になり通過する', () => {
  const ds = makeDataset({ plantDrift: true });
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [1, 5], minEventIcN: 15 });
  const r5 = res.pead.opYoY.byHold[5];
  assert.ok(r5.ic.explore.mean > 0.05, `explore ic ${r5.ic.explore.mean}`);
  assert.ok(r5.ic.confirm.mean > 0.05, `confirm ic ${r5.ic.confirm.mean}`);
  assert.equal(r5.ic.pass, true);
  assert.ok(r5.spread.confirm.mean > 0);
});

test('合成データ(買い値より前の窓口だけで動く): 買い値より前の動きは取り込まない', () => {
  // 開示直後の最初の始値で6%動く。買うのはその始値なので、その動きは成績に入ってはならない。
  const ds = makeDataset({ plantEntryJump: true });
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [5], minEventIcN: 15 });
  const r5 = res.pead.opYoY.byHold[5];
  assert.equal(r5.ic.pass, false);
  assert.ok(Math.abs(r5.ic.confirm.mean) < 0.1, `ic ${r5.ic.confirm.mean}`);
  // 一方、決算またぎでは「買い値より前」ではなく保有中に入るため、またぎ(開示日が窓内)の値幅が大きく出る
});

test('合成データ(決算日に値幅): またぎは非またぎより値幅が大きい', () => {
  const ds = makeDataset({ plantEventVol: true });
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [3], minGroup: 20 });
  const c = res.crossing[3].confirm;
  assert.ok(c.cross.n > 100 && c.non.n > 100);
  assert.ok(c.cross.meanAbs > c.non.meanAbs, `${c.cross.meanAbs} vs ${c.non.meanAbs}`);
  assert.ok(c.diffAbs.mean > 0);
  assert.ok(c.cross.std > c.non.std);
});

test('毎日の順位づけ: 決算直後に効く効果は「直後」で正、「それ以降」では通過しない', () => {
  const ds = makeDataset({ plantDrift: true });
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [5], minIcN: 30 });
  const fresh = res.ranking.opYoY.fresh[5];
  const stale = res.ranking.opYoY.stale[5];
  assert.ok(fresh.explore.mean > 0 && fresh.confirm.mean > 0, `fresh ${fresh.explore.mean}/${fresh.confirm.mean}`);
  assert.ok(fresh.explore.mean > stale.explore.mean);
  assert.equal(stale.pass, false);
});

test('流動性が足りない銘柄は対象外', () => {
  const ds = makeDataset({});
  for (const st of ds.stocks) st.va.fill(1e6);
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [1], minVa: 5e7 });
  assert.equal(res.crossing[1].confirm.cross.n, 0);
  assert.equal(res.crossing[1].confirm.non.n, 0);
});

test('レポートが文字列で出る', () => {
  const ds = makeDataset({ plantDrift: true });
  const res = runStudy(ds, { exploreEnd: days180(ds), holds: [1, 5] });
  const txt = formatReport(res);
  assert.ok(txt.includes('1. 決算またぎ'));
  assert.ok(txt.includes('2. 決算後の動き'));
  assert.ok(txt.includes('3. 毎日の順位づけ'));
  assert.ok(mean([1, 2, 3]) === 2);
});
