// D1ベースのバックテスト(src/backtestD1.js)のテスト。外部通信・D1には触れない(合成データ)。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bootstrapMeanCI,
  buildBacktestRows,
  dedupeEvaluations,
  formatBacktestReport,
  mean,
  median,
  quantile,
  rank,
  realizedVolatility,
  spearman,
  stdev,
  summarizeBacktest,
} from "../src/backtestD1.js";

// 営業日: 10/1(木) 10/2(金) 10/5(月) 10/6(火) 10/7(水) 10/8(木)
const DAYS = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
const px = (entries) => new Map(Object.entries(entries).map(([d, [open, close]]) => [d, { open, close }]));

function baseData() {
  const pricesByCode = new Map([
    // A: 翌営業日(10/2)の始値100 → 10/2終値110, 10/6終値120
    ["A", px({ "2026-10-01": [99, 100], "2026-10-02": [100, 110], "2026-10-05": [110, 115], "2026-10-06": [115, 120] })],
    // B: 始値100 → 10/2終値100, 10/6終値100
    ["B", px({ "2026-10-01": [99, 100], "2026-10-02": [100, 100], "2026-10-05": [100, 100], "2026-10-06": [100, 100] })],
    // C: 始値100 → 10/2終値90, 10/6終値80
    ["C", px({ "2026-10-01": [99, 100], "2026-10-02": [100, 90], "2026-10-05": [90, 85], "2026-10-06": [85, 80] })],
  ]);
  // 評価は10/1の17:00 JST(= 08:00 UTC)に生成 → 翌営業日10/2の寄り付き(10/2 00:00 UTC)に間に合う
  const generated = "2026-10-01T08:00:00.000Z";
  const evaluations = [
    { code: "A", data_as_of_date: "2026-10-01", generated_at: generated, score: 80, rating: "BUY" },
    { code: "B", data_as_of_date: "2026-10-01", generated_at: generated, score: 60, rating: "HOLD" },
    { code: "C", data_as_of_date: "2026-10-01", generated_at: generated, score: 40, rating: "SELL" },
  ];
  return { pricesByCode, evaluations };
}

test("翌営業日の始値で買い、保有日数目の終値で売る。コスト控除後も出る", () => {
  const { pricesByCode, evaluations } = baseData();
  const out = buildBacktestRows({ evaluations, pricesByCode, tradingDays: DAYS, horizons: [1, 3], costPct: 0.2 });
  const h1 = Object.fromEntries(out[1].rows.map((r) => [r.code, r]));
  assert.equal(h1.A.entryDate, "2026-10-02");
  assert.equal(h1.A.exitDate, "2026-10-02"); // 保有1営業日 = 買った日の終値で売る
  assert.ok(Math.abs(h1.A.retPct - 10) < 1e-9);
  assert.ok(Math.abs(h1.A.netPct - 9.8) < 1e-9);
  assert.ok(Math.abs(h1.B.retPct - 0) < 1e-9);
  assert.ok(Math.abs(h1.C.retPct - -10) < 1e-9);
  // 参考: 評価日(10/1)の終値100で買えた場合
  assert.ok(Math.abs(h1.A.refPct - 10) < 1e-9);
  const h3 = Object.fromEntries(out[3].rows.map((r) => [r.code, r]));
  assert.equal(h3.A.exitDate, "2026-10-06"); // 10/2を1日目として3営業日目
  assert.ok(Math.abs(h3.A.retPct - 20) < 1e-9);
  assert.ok(Math.abs(h3.C.retPct - -20) < 1e-9);
});

test("寄り付きに間に合わない評価は、買う日を次の営業日にずらす(未来の始値を使わない)", () => {
  const { pricesByCode, evaluations } = baseData();
  // 10/2 03:00 UTC(= 12:00 JST)に生成 → 10/2の始値はもう過ぎている → 10/5の始値で買う
  const late = evaluations.map((e) => ({ ...e, generated_at: "2026-10-02T03:00:00.000Z" }));
  const out = buildBacktestRows({ evaluations: late, pricesByCode, tradingDays: DAYS, horizons: [1] });
  const a = out[1].rows.find((r) => r.code === "A");
  assert.equal(a.entryDate, "2026-10-05");
  assert.equal(a.exitDate, "2026-10-05");
  assert.ok(Math.abs(a.retPct - ((115 / 110 - 1) * 100)) < 1e-9); // A: 10/5 始値110 → 終値115
  assert.equal(out[1].delayedEntry, 3);
});

test("保有日数が経過していない評価・株価の無い評価・カレンダーに無い基準日は、集計から外して理由を数える", () => {
  const { pricesByCode, evaluations } = baseData();
  const more = [
    ...evaluations,
    { code: "D", data_as_of_date: "2026-10-01", generated_at: "2026-10-01T08:00:00.000Z", score: 70, rating: "BUY" }, // 株価なし
    { code: "A", data_as_of_date: "2026-09-30", generated_at: "2026-09-30T08:00:00.000Z", score: 70, rating: "BUY" }, // 基準日がカレンダーに無い
    { code: "A", data_as_of_date: "2026-10-07", generated_at: "2026-10-07T08:00:00.000Z", score: 70, rating: "BUY" }, // 買う日(10/8)はあるが、5営業日後は無い
    { code: "A", data_as_of_date: "2026-10-05", generated_at: "2026-10-05T08:00:00.000Z", score: null, rating: "BUY" }, // スコアなし
  ];
  const out = buildBacktestRows({ evaluations: more, pricesByCode, tradingDays: DAYS, horizons: [1, 5] });
  assert.equal(out[1].rows.length, 3);
  assert.equal(out[1].skipped.noPrice, 2); // 銘柄D(株価なし)と、銘柄Aの10/8(株価なし)
  assert.equal(out[1].skipped.noCalendar, 1);
  assert.equal(out[1].skipped.noScore, 1);
  assert.equal(out[1].skipped.notElapsed, 0);
  // 5営業日: 10/1基準は10/8まで届くが10/8の株価が無い。10/7基準は10/8で買って5営業日後の日がまだ無い
  assert.equal(out[5].rows.length, 0);
  assert.equal(out[5].skipped.notElapsed, 1);
});

test("基準日が生成された日より何日も前の評価(約3か月前のデータに基づく評価)は、古い情報なので除外する", () => {
  const { pricesByCode, evaluations } = baseData();
  const stale = [
    ...evaluations, // 基準日10/1・生成も10/1(通常の評価)
    // 基準日10/1だが、20日後に生成された評価(有料プラン移行前の、遅延したデータに基づく評価に相当)
    { code: "A", data_as_of_date: "2026-10-01", generated_at: "2026-10-21T08:00:00.000Z", score: 99, rating: "BUY" },
  ];
  const out = buildBacktestRows({ evaluations: stale, pricesByCode, tradingDays: DAYS, horizons: [1] });
  // 同じ(銘柄, 基準日)の評価は、最も早い1件(通常の評価)が使われるので、古い評価は重複として落ちる
  assert.equal(out[1].rows.length, 3);
  assert.equal(out[1].skipped.staleBasis, 0);
  // 古い評価だけがある場合は、除外されて数えられる
  const onlyStale = [{ code: "A", data_as_of_date: "2026-10-01", generated_at: "2026-10-21T08:00:00.000Z", score: 99, rating: "BUY" }];
  const out2 = buildBacktestRows({ evaluations: onlyStale, pricesByCode, tradingDays: DAYS, horizons: [1] });
  assert.equal(out2[1].rows.length, 0);
  assert.equal(out2[1].skipped.staleBasis, 1);
  // 判定を無効にすれば(null)、除外されない(この例では買う日がカレンダーの外になり「未経過」になる)
  const off = buildBacktestRows({ evaluations: onlyStale, pricesByCode, tradingDays: DAYS, horizons: [1], maxStaleDays: null });
  assert.equal(off[1].skipped.staleBasis, 0);
  assert.equal(off[1].skipped.notElapsed, 1);
  // 通常の遅れ(週末をはさんだ3日)は除外されない
  const weekend = [{ code: "A", data_as_of_date: "2026-10-02", generated_at: "2026-10-05T00:30:00.000Z", score: 70, rating: "BUY" }];
  const out3 = buildBacktestRows({ evaluations: weekend, pricesByCode, tradingDays: DAYS, horizons: [1] });
  assert.equal(out3[1].skipped.staleBasis, 0);
});

test("同じ(銘柄, 基準日)の評価が複数あるときは、最も早く生成された1件だけを使う", () => {
  const evals = [
    { code: "A", data_as_of_date: "2026-10-01", generated_at: "2026-10-01T13:00:00.000Z", score: 10 },
    { code: "A", data_as_of_date: "2026-10-01", generated_at: "2026-10-01T08:00:00.000Z", score: 80 },
    { code: "A", data_as_of_date: "2026-10-01", generated_at: "2026-10-01T23:00:00.000Z", score: 20 },
    { code: "B", data_as_of_date: "2026-10-01", generated_at: "2026-10-01T08:00:00.000Z", score: 50 },
  ];
  const unique = dedupeEvaluations(evals);
  assert.equal(unique.length, 2);
  assert.equal(unique.find((e) => e.code === "A").score, 80);
});

test("TOPIXとの差: 買う日の始値から売る日の終値までのTOPIXの変化を引く", () => {
  const { pricesByCode, evaluations } = baseData();
  const topixByDate = new Map([
    ["2026-10-02", { open: 2000, close: 2010 }],
    ["2026-10-06", { open: 2030, close: 2040 }],
  ]);
  const out = buildBacktestRows({ evaluations, pricesByCode, tradingDays: DAYS, topixByDate, horizons: [3], costPct: 0 });
  const a = out[3].rows.find((r) => r.code === "A");
  const topixPct = (2040 / 2000 - 1) * 100; // 10/2始値 → 10/6終値
  assert.ok(Math.abs(a.topixPct - topixPct) < 1e-9);
  assert.ok(Math.abs(a.excessPct - (20 - topixPct)) < 1e-9);
  // TOPIXが無ければ、差はnull(集計から外れる)
  const noTopix = buildBacktestRows({ evaluations, pricesByCode, tradingDays: DAYS, horizons: [3] });
  assert.equal(noTopix[3].rows[0].excessPct, null);
});

test("統計の部品: 平均・中央値・標準偏差・順位(同順位は平均)・スピアマン", () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(median([1, 3, 2, 10]), 2.5);
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935299395) < 1e-9);
  assert.deepEqual(rank([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]) - -1) < 1e-12);
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), null); // 一方が全て同じ値
  assert.equal(spearman([1, 2], [1, 2]), null); // 3件未満
});

test("ブートストラップの信頼区間: 同じseedなら同じ結果。件数が2未満ならnull。平均をはさむ", () => {
  const values = [1.2, -0.4, 0.8, 2.1, -1.0, 0.3, 1.5, 0.9];
  const a = bootstrapMeanCI(values, { iterations: 500, seed: 7 });
  const b = bootstrapMeanCI(values, { iterations: 500, seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= mean(values) && mean(values) <= a.hi);
  assert.equal(bootstrapMeanCI([1], {}), null);
  assert.equal(bootstrapMeanCI([], {}), null);
});

// スコアが高いほど成績が良い合成データ(2日分、各日12件)で、集計を確かめる
function syntheticRows() {
  const rows = [];
  for (const [day, bias] of [["2026-10-01", 0], ["2026-10-02", 1]]) {
    for (let i = 0; i < 12; i++) {
      const score = 50 + i; // 50〜61
      const retPct = (i - 5.5) * 0.5 + bias; // スコアに比例して増える
      rows.push({ code: `${day}-${i}`, signalDate: day, entryDate: day, exitDate: day, horizon: 3, score, rating: i >= 8 ? "BUY" : "HOLD", retPct, netPct: retPct - 0.3, refPct: null, topixPct: 0.2, excessPct: retPct - 0.2 });
    }
  }
  return rows;
}

test("集計: スコア帯・rating別・毎日の上位Nと全件平均の差・順位相関・TOPIXとの差(コスト控除後)", () => {
  const summary = summarizeBacktest(syntheticRows(), { topN: 3, bands: 3, iterations: 300, seed: 1 });
  assert.equal(summary.n, 24);
  assert.equal(summary.days, 2);
  // 3つの帯: 件数は8ずつで、高スコアの帯ほど平均が高い
  assert.deepEqual(summary.byBand.map((b) => b.n), [8, 8, 8]);
  assert.ok(summary.byBand[0].meanNet < summary.byBand[1].meanNet && summary.byBand[1].meanNet < summary.byBand[2].meanNet);
  assert.ok(summary.byBand[0].scoreMax <= summary.byBand[1].scoreMin);
  // rating別
  assert.equal(summary.byRating.BUY.n, 8);
  assert.equal(summary.byRating.HOLD.n, 16);
  assert.ok(summary.byRating.BUY.meanNet > summary.byRating.HOLD.meanNet);
  // 毎日の上位3件 − 全件平均: スコアが成績と比例するので、差は正で、順位相関は1
  assert.equal(summary.topN.days, 2);
  assert.ok(summary.topN.mean > 0);
  for (const d of summary.daily) {
    assert.ok(d.diff > 0);
    assert.ok(Math.abs(d.ic - 1) < 1e-12);
  }
  assert.ok(summary.topN.ci.lo <= summary.topN.mean && summary.topN.mean <= summary.topN.ci.hi);
  // TOPIXとの差(コスト控除後) = 平均(retPct) - 0.2 - 0.3
  const expected = mean(syntheticRows().map((r) => r.retPct)) - 0.2 - 0.3;
  assert.ok(Math.abs(summary.overall.meanExcessNet - expected) < 1e-9);
});

test("集計: 件数がNに満たない日は上位Nの比較から外し、10件に満たない日は順位相関から外す。空なら件数0", () => {
  const rows = syntheticRows().filter((r) => r.signalDate === "2026-10-01").slice(0, 5);
  const summary = summarizeBacktest(rows, { topN: 10 });
  assert.equal(summary.daily[0].diff, null);
  assert.equal(summary.daily[0].ic, null);
  assert.equal(summary.topN.days, 0);
  assert.equal(summary.topN.ci, null);
  assert.deepEqual(summarizeBacktest([], {}), { n: 0 });
});

test("レポート: 注意書き・各保有日数の見出し・表が出る", () => {
  const { pricesByCode, evaluations } = baseData();
  const built = buildBacktestRows({ evaluations, pricesByCode, tradingDays: DAYS, horizons: [1, 3] });
  const results = {};
  for (const h of [1, 3]) results[h] = { summary: summarizeBacktest(built[h].rows, { topN: 2, bands: 3 }), skipped: built[h].skipped, delayedEntry: built[h].delayedEntry };
  const report = formatBacktestReport({
    meta: { evaluationsUnique: 3, evaluationsRaw: 3, signalDateMin: "2026-10-01", signalDateMax: "2026-10-01", costPct: 0, topN: 2, bands: 3 },
    results,
  });
  assert.match(report, /将来の利益を保証しません/);
  assert.match(report, /## 保有 1 営業日/);
  assert.match(report, /## 保有 3 営業日/);
  assert.match(report, /\| 帯 \| 件数 \|/);
  assert.match(report, /信頼区間が0をまたぐ差は、差があるとは言えません/);
});

// ---- ここから: 同点・外れ値・値動きの大きさ・指標別の分析 ----
const mkRow = (day, i, { score = 70, net = 0, vol = null, up = null, down = null, exp = null, conf = null, rating = "BUY" } = {}) => ({
  code: `${day}-${String(i).padStart(3, "0")}`, signalDate: day, entryDate: day, exitDate: day, horizon: 3,
  score, rating, upsideProb: up, downsideRisk: down, expectedReturn: exp, confidence: conf, vol20: vol,
  retPct: net, netPct: net, refPct: null, topixPct: null, excessPct: null,
});

test("分位点・実現ボラティリティ: 日次リターンの標準偏差(直近20営業日)。履歴が足りなければnull", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantile([], 0.5), null);
  // 日次リターンが +2%, -2% を交互に繰り返す21営業日分の終値
  const days = Array.from({ length: 21 }, (_, i) => `D${String(i).padStart(2, "0")}`);
  const closes = new Map();
  let c = 100;
  days.forEach((d, i) => {
    if (i > 0) c *= i % 2 === 1 ? 1.02 : 0.98;
    closes.set(d, { open: c, close: c });
  });
  const vol = realizedVolatility(closes, days, 20);
  assert.ok(Math.abs(vol - Math.sqrt((20 * 4) / 19)) < 0.05, `vol=${vol}`); // 20個の±2%の標本標準偏差
  assert.equal(realizedVolatility(closes, days, 8), null); // 8日分しか無い → null
  assert.equal(realizedVolatility(undefined, days, 20), null);
});

test("上位N件: 同点が境目にまたがるときは無作為に選んだ期待値で計算する(コード順の同点処理の偏りを入れない)", () => {
  // 20件すべて同点(70点)。コード順の先頭10件は +2%、残り10件は −2%(=コード順で選ぶと、見かけ上+2%の差が出てしまう)
  const rows = [];
  for (let d = 1; d <= 10; d++) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    for (let i = 0; i < 20; i++) rows.push(mkRow(day, i, { score: 70, net: i < 10 ? 2 : -2 }));
  }
  const summary = summarizeBacktest(rows, { topN: 10, simulations: 300, randomPicks: 500, seed: 3 });
  assert.ok(Math.abs(summary.topN.mean) < 0.1, `mean=${summary.topN.mean}`); // 期待値はほぼ0
  assert.ok(summary.topN.randomPick.p > 0.2, `p=${summary.topN.randomPick.p}`);
  assert.equal(summary.daily[0].tieAtCut, 20);
  assert.equal(summary.daily[0].cutScore, 70);
});

test("上位N件: 同点がまたがらず、はっきり分かれているときは、その差がそのまま出る(期待値 = 実際)", () => {
  const rows = [];
  for (let d = 1; d <= 3; d++) {
    const day = `2026-10-0${d}`;
    for (let i = 0; i < 10; i++) rows.push(mkRow(day, i, { score: 75, net: 1 }));
    for (let i = 10; i < 12; i++) rows.push(mkRow(day, i, { score: 60, net: -1 }));
  }
  const summary = summarizeBacktest(rows, { topN: 10, simulations: 50, randomPicks: 200 });
  // 上位10件の平均 +1、全件の平均 (10 - 2) / 12
  assert.ok(Math.abs(summary.topN.mean - (1 - 8 / 12)) < 1e-9);
  assert.ok(Math.abs(summary.topN.median.mean - (1 - 1)) < 1e-9); // 中央値: 上位+1、全件(+1が10件, -1が2件)の中央値+1
  assert.equal(summary.topN.positiveDays, 3);
});

test("値動きの大きさをそろえた比較: 上位が値動きの大きい銘柄ばかりで、その層が高い成績なだけなら、そろえた差は0になる", () => {
  const rows = [];
  for (let d = 1; d <= 3; d++) {
    const day = `2026-10-0${d}`;
    for (let i = 0; i < 10; i++) rows.push(mkRow(day, i, { score: 60, net: 0, vol: 1 })); // 低ボラ
    for (let i = 10; i < 20; i++) rows.push(mkRow(day, i, { score: 60, net: 0, vol: 2 })); // 中ボラ
    for (let i = 20; i < 30; i++) rows.push(mkRow(day, i, { score: 75, net: 2, vol: 3 })); // 高ボラ(上位10件はこの層)
  }
  const summary = summarizeBacktest(rows, { topN: 10, simulations: 50, randomPicks: 200 });
  assert.ok(Math.abs(summary.topN.mean - (2 - 2 / 3)) < 1e-9); // 全件平均との差は +1.33
  assert.ok(Math.abs(summary.topN.matched.mean) < 1e-9); // 値動きの層をそろえると差は0
  assert.equal(summary.volCoverage, 1);
});

test("外れ値を丸めた差: 上位に1銘柄だけ極端な上昇があるとき、丸めると差が小さくなる", () => {
  const rows = [];
  for (let d = 1; d <= 2; d++) {
    const day = `2026-10-0${d}`;
    rows.push(mkRow(day, 0, { score: 75, net: 50 })); // 外れ値
    for (let i = 1; i < 10; i++) rows.push(mkRow(day, i, { score: 75, net: 1 }));
    for (let i = 10; i < 30; i++) rows.push(mkRow(day, i, { score: 60, net: 0 }));
  }
  const summary = summarizeBacktest(rows, { topN: 10, simulations: 20, randomPicks: 50, winsorPct: 5 });
  assert.ok(summary.topN.mean > 3.5); // (50 + 9) / 10 − 59 / 30
  assert.ok(summary.topN.winsorized.mean < 1); // 外れ値(50)を上側5%の値(1)に丸めると、上位の平均は1、全件の平均は10/30なので、差は 1 − 1/3
  assert.ok(Math.abs(summary.topN.winsorized.mean - 2 / 3) < 1e-9);
  assert.ok(summary.topN.median.mean < summary.topN.mean); // 中央値の差も小さい
});

test("スコアの水準別: 固定の区切りで分け、最上位の水準 − それ以外を日ごとの平均の差で出す(各3件以上の日のみ)", () => {
  const rows = [];
  for (let d = 1; d <= 3; d++) {
    const day = `2026-10-0${d}`;
    for (let i = 0; i < 4; i++) rows.push(mkRow(day, i, { score: 60, net: -1 }));
    for (let i = 4; i < 8; i++) rows.push(mkRow(day, i, { score: 66, net: 0 }));
    for (let i = 8; i < 12; i++) rows.push(mkRow(day, i, { score: 70, net: 0 }));
    for (let i = 12; i < 15; i++) rows.push(mkRow(day, i, { score: 75, net: 3 }));
  }
  const summary = summarizeBacktest(rows, { topN: 5, scoreCuts: [62, 68, 72], simulations: 10, randomPicks: 20 });
  assert.deepEqual(summary.byScoreLevel.map((g) => g.label), ["62未満", "62以上〜68未満", "68以上〜72未満", "72以上"]);
  assert.deepEqual(summary.byScoreLevel.map((g) => g.n), [12, 12, 12, 9]);
  // 最上位(72以上 = +3)−それ以外(平均 (−4 + 0 + 0) / 12 = −1/3)
  assert.equal(summary.topLevel.days, 3);
  assert.ok(Math.abs(summary.topLevel.mean - (3 + 1 / 3)) < 1e-9);
  // 区切りを空にすると、水準別は全体の1行だけ
  const none = summarizeBacktest(rows, { topN: 5, scoreCuts: [], simulations: 5, randomPicks: 5 });
  assert.equal(none.byScoreLevel.length, 1);
  assert.equal(none.topLevel, null);
});

test("指標別の順位相関: 上昇確率は成績と同じ向き(+1)、下落リスクは逆向き(−1)。値が全て同じ指標は相関を出さない", () => {
  const rows = [];
  for (let d = 1; d <= 3; d++) {
    const day = `2026-10-0${d}`;
    for (let i = 0; i < 12; i++) rows.push(mkRow(day, i, { score: 60 + (i % 3), net: i, up: 0.3 + i * 0.01, down: 30 - i, exp: i * 0.5, conf: 0.8 }));
  }
  const summary = summarizeBacktest(rows, { topN: 5, simulations: 5, randomPicks: 5 });
  const by = Object.fromEntries(summary.byMetric.map((m) => [m.key, m]));
  assert.ok(Math.abs(by.upsideProb.mean - 1) < 1e-12);
  assert.ok(Math.abs(by.expectedReturn.mean - 1) < 1e-12);
  assert.ok(Math.abs(by.downsideRisk.mean - -1) < 1e-12);
  assert.equal(by.confidence.days, 0); // 全て同じ値 → 順位相関なし
  assert.equal(by.confidence.mean, null);
  assert.equal(by.upsideProb.positiveDays, 3);
});

test("行の指標・ボラティリティ: 評価の上昇確率などと、基準日までの実現ボラティリティが行に入る", () => {
  const { pricesByCode, evaluations } = baseData();
  const withMetrics = evaluations.map((e) => ({ ...e, upside_probability: 0.6, downside_risk: 20, expected_return: 3, confidence: 0.7 }));
  const out = buildBacktestRows({ evaluations: withMetrics, pricesByCode, tradingDays: DAYS, horizons: [1] });
  const a = out[1].rows.find((r) => r.code === "A");
  assert.equal(a.upsideProb, 0.6);
  assert.equal(a.downsideRisk, 20);
  assert.equal(a.expectedReturn, 3);
  assert.equal(a.confidence, 0.7);
  assert.equal(a.vol20, null); // 基準日までの履歴が1日しか無く、ボラティリティは計算できない
  const none = buildBacktestRows({ evaluations, pricesByCode, tradingDays: DAYS, horizons: [1] });
  assert.equal(none[1].rows[0].upsideProb, null); // 指標が無い評価はnull
});

test("レポート(拡張): 固定のスコア帯・同点・外れ値・値動きの統制・指標別の相関の見出しが出る", () => {
  const rows = [];
  for (let d = 1; d <= 3; d++) {
    const day = `2026-10-0${d}`;
    for (let i = 0; i < 15; i++) rows.push(mkRow(day, i, { score: i < 12 ? 68 : 75, net: i * 0.1, vol: 1 + (i % 3), up: 0.5 + i * 0.01 }));
  }
  const summary = summarizeBacktest(rows, { topN: 5, simulations: 10, randomPicks: 50 });
  const report = formatBacktestReport({
    meta: { evaluationsUnique: 45, evaluationsRaw: 45, signalDateMin: "2026-10-01", signalDateMax: "2026-10-03", costPct: 0, topN: 5, bands: 3, scoreCuts: [62, 68, 72] },
    results: { 3: { summary, skipped: { noScore: 0, staleBasis: 0, noCalendar: 0, notElapsed: 0, noPrice: 0 }, delayedEntry: 0 } },
  });
  assert.match(report, /スコアの水準別/);
  assert.match(report, /同点は無作為/);
  assert.match(report, /外れ値\(上下1%\)を丸めた差/);
  assert.match(report, /値動きの大きさ.*をそろえた/);
  assert.match(report, /指標ごとの、成績との順位相関/);
  assert.match(report, /上昇確率\(upside_probability\)/);
  assert.match(report, /スコアの区切り\(固定\): 62, 68, 72/);
});

test("バックテストのスクリプトは、D1に対してSELECTしか実行しない(書き込みの呼び出しを持たない)", () => {
  const src = readFileSync(new URL("../scripts/backtest-d1.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /d1\.run\(|bulkUpsert|batchInsert|\bINSERT\b|\bDELETE\b|\bDROP\b|\bALTER\b/i);
  assert.match(src, /SELECT以外は実行しません/);
  const wf = readFileSync(new URL("../.github/workflows/backtest-d1.yml", import.meta.url), "utf8");
  assert.match(wf, /workflow_dispatch/);
  assert.doesNotMatch(wf, /^\s*schedule:/m); // 自動実行は追加しない
});
