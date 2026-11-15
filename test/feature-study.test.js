// 値動き・出来高の数字そのものの、順位づけの力の検証(src/featureStudy.js)のテスト。
// D1には触れない。手で作った値動きで、計算が手計算と一致すること・先読みをしないこと・欠けたデータを推測しないこと、
// 作った(仕込んだ)効果を見つけ、効果の無い数字を「通過」にしないことを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mulberry32 } from "../src/backtestD1.js";
import {
  DEFAULTS,
  FEATURE_KEYS,
  addRows,
  blockBootstrapMeanCI,
  createPanel,
  deriveTradingDays,
  featuresAt,
  formatFeatureReport,
  pearson,
  rankOrder,
  runStudy,
  studyDay,
  summarizeStudy,
  targetsAt,
  turnover20At,
  verdict,
} from "../src/featureStudy.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const dateOf = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const daysList = (D) => Array.from({ length: D }, (_, i) => dateOf(i));

/** 1銘柄の、手計算しやすい直線的な値動き: 終値=100+i、高値=終値+1、安値=終値-1、始値=終値-0.5、出来高=1000+i */
function linearPanel(D = 80) {
  const panel = createPanel(daysList(D));
  const rows = [];
  for (let i = 0; i < D; i++) {
    rows.push({ code: "1111", date: dateOf(i), open: 99.5 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 + i });
  }
  addRows(panel, rows);
  return panel;
}

test("特徴量が手計算と一致する(基準日 t=65 の直線的な値動き)", () => {
  const panel = linearPanel();
  const f = featuresAt(panel, 0, 65);
  assert.ok(near(f.ret5, (165 / 160 - 1) * 100));
  assert.ok(near(f.ret20, (165 / 145 - 1) * 100));
  assert.ok(near(f.range10, ((166 - 155) / 165) * 100)); // 過去10日(i=56..65): 高値の最大166、安値の最小155
  assert.ok(near(f.atr14, (2 / 165) * 100)); // 真の値幅は毎日2
  assert.ok(near(f.volSurge, (1063 / 1050.5))); // 直近5日(61..65)の平均1063 ÷ その前の20日(41..60)の平均1050.5
  assert.ok(near(f.ma25dev, (165 / 153 - 1) * 100)); // 25日(41..65)の終値の平均153
  assert.ok(near(f.distHigh60, (165 / 166 - 1) * 100));
  assert.ok(near(f.distLow60, (165 / 105 - 1) * 100)); // 60日(6..65)の安値の最小105
  assert.ok(near(f.gap, (164.5 / 164 - 1) * 100)); // 当日の始値164.5 ÷ 前日の終値164
  assert.equal(featuresAt(panel, 0, 58), null); // 60日分の履歴が無い
  assert.ok(near(turnover20At(panel, 0, 65), (() => { let s = 0; for (let i = 46; i <= 65; i++) s += (100 + i) * (1000 + i); return s / 20; })()));
});

test("成績の定義: 翌営業日の始値で買い、h営業日後の始値で売る。コストを引く。上昇余地・値幅は保有期間の高値・安値", () => {
  const panel = linearPanel();
  const t = 65;
  const tg = targetsAt(panel, 0, t, 3, 0.3);
  const entry = 99.5 + 66; // 始値(t+1)
  const exit = 99.5 + 69; // 始値(t+1+3)
  assert.ok(near(tg.ret, (exit / entry - 1) * 100 - 0.3));
  assert.ok(near(tg.up, ((101 + 68) / entry - 1) * 100)); // 保有中(t+1..t+3 = 66..68)の高値の最大
  assert.ok(near(tg.range, ((101 + 68 - (99 + 66)) / entry) * 100));
  assert.equal(targetsAt(panel, 0, 77, 3, 0.3), null); // 売る日がデータの外
});

test("先読みをしない: 基準日より後の値を変えても特徴量は同じ。基準日以前の値を変えても成績は同じ", () => {
  const a = linearPanel();
  const b = linearPanel();
  const t = 65;
  for (const f of ["open", "high", "low", "close", "volume"]) for (let i = t + 1; i < 80; i++) b[f][0][i] = 12345 + i;
  assert.deepEqual({ ...featuresAt(a, 0, t) }, { ...featuresAt(b, 0, t) });
  assert.equal(turnover20At(a, 0, t), turnover20At(b, 0, t));

  const c = linearPanel();
  for (const f of ["open", "high", "low", "close", "volume"]) for (let i = 0; i <= t; i++) c[f][0][i] = 777 + i;
  assert.deepEqual({ ...targetsAt(a, 0, t, 3) }, { ...targetsAt(c, 0, t, 3) });
});

test("欠けたデータは推測しない: 窓の中の高値・安値・終値・出来高が1つでも欠ければ、その日は作らない", () => {
  const t = 65;
  for (const [field, idx] of [["high", 60], ["low", 10], ["close", 50], ["volume", 45], ["open", 65]]) {
    const p = linearPanel();
    p[field][0][idx] = NaN;
    assert.equal(featuresAt(p, 0, t), null, `${field}[${idx}] が欠けているのに特徴量が作られました`);
  }
  const p = linearPanel();
  p.low[0][68] = NaN; // 保有中(t+1..t+3)の安値が欠ける
  assert.equal(targetsAt(p, 0, 65, 3), null);
  assert.ok(targetsAt(p, 0, 65, 1) !== null); // 保有1日(t+1=66)には影響しない
  const q = linearPanel();
  q.open[0][69] = NaN; // 売る日の始値が欠ける
  assert.equal(targetsAt(q, 0, 65, 3), null);

  // 営業日に無い日付の行は無視する。株価0以下はNaN
  const panel = createPanel(daysList(3));
  addRows(panel, [{ code: "A", date: "1999-01-01", open: 1, high: 1, low: 1, close: 1, volume: 1 }, { code: "B", date: dateOf(0), open: 0, high: -1, low: 1, close: 1, volume: 5 }]);
  assert.equal(panel.codes.length, 1);
  assert.ok(Number.isNaN(panel.open[0][0]) && Number.isNaN(panel.high[0][0]) && panel.low[0][0] === 1 && panel.volume[0][0] === 5);
});

test("順位・相関: 同じ値は平均順位。完全に同じ並びは1、逆は-1、片方が一定ならNaN", () => {
  assert.deepEqual(Array.from(rankOrder([10, 30, 20, 20]).ranks), [1, 4, 2.5, 2.5]);
  const r1 = rankOrder([1, 2, 3, 4, 5]).ranks;
  assert.ok(near(pearson(r1, rankOrder([10, 20, 30, 40, 50]).ranks), 1));
  assert.ok(near(pearson(r1, rankOrder([5, 4, 3, 2, 1]).ranks), -1));
  assert.ok(Number.isNaN(pearson(r1, rankOrder([7, 7, 7, 7, 7]).ranks)));
});

test("ブロック・ブートストラップ: 同じ種なら同じ結果。件数が増えると区間が狭まる。平均は区間に入る。1件以下は区間なし", () => {
  const rand = mulberry32(1);
  const small = Array.from({ length: 40 }, () => rand() - 0.5);
  const big = Array.from({ length: 400 }, () => rand() - 0.5);
  const a = blockBootstrapMeanCI(small, { seed: 5 });
  assert.deepEqual(a, blockBootstrapMeanCI(small, { seed: 5 }));
  const b = blockBootstrapMeanCI(big, { seed: 5 });
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  assert.ok(b.hi - b.lo < a.hi - a.lo);
  assert.deepEqual(blockBootstrapMeanCI([]), { n: 0, mean: null, lo: null, hi: null });
  assert.equal(blockBootstrapMeanCI([1.5]).lo, null);
  assert.equal(blockBootstrapMeanCI([1, NaN, 3]).n, 2); // 有限でない値は除く
});

test("判定: 探索と確認の両方で、同じ向きに、区間が0を含まなければ「通過」", () => {
  const s = (mean, lo, hi, n = 100) => ({ n, mean, lo, hi });
  assert.equal(verdict(s(0.05, 0.02, 0.08), s(0.04, 0.01, 0.07)), "通過");
  assert.equal(verdict(s(0.05, 0.02, 0.08), s(-0.04, -0.07, -0.01)), "逆転");
  assert.equal(verdict(s(0.05, 0.02, 0.08), s(0.01, -0.02, 0.04)), "探索のみ(確認で消えた)");
  assert.equal(verdict(s(0.01, -0.02, 0.04), s(0.04, 0.01, 0.07)), "確認のみ(探索では有意でない)");
  assert.equal(verdict(s(0.01, -0.02, 0.04), s(0.01, -0.02, 0.04)), "なし");
  assert.equal(verdict(s(0.05, 0.02, 0.08, 10), s(0.04, 0.01, 0.07)), "データ不足");
  assert.equal(verdict(null, s(0.04, 0.01, 0.07)), "データ不足");
});

test("営業日の決め方: 件数が中央値の半分に満たない日(蓄積が途中の日)は除き、昇順に並べる", () => {
  const counts = new Map([
    ["2025-01-06", 4000],
    ["2025-01-07", 4100],
    ["2025-01-08", 300], // 一部の銘柄だけ
    ["2025-01-09", 4050],
    ["2024-12-27", 3990], // 順不同で入れても、昇順になる
    ["2025-01-10", 0],
  ]);
  const r = deriveTradingDays(counts);
  assert.deepEqual(r.days, ["2024-12-27", "2025-01-06", "2025-01-07", "2025-01-09"]);
  assert.deepEqual(r.dropped, [{ date: "2025-01-08", count: 300 }]);
  assert.ok(r.medianCount > 3900);
  assert.deepEqual(deriveTradingDays(new Map()), { days: [], dropped: [], medianCount: 0 });
  assert.deepEqual(deriveTradingDays(counts, { minShare: 0.05 }).dropped, []); // 基準を緩めれば、除かれない
});

/**
 * 効果を仕込んだ合成データ: 銘柄ごとに、一定の上がりやすさ(drift)と、一定の動きの大きさ(sigma)を持たせる。
 *  - 過去に上がった銘柄は、その後も上がる(ret20 などに順位づけの力がある)
 *  - 動きの大きい銘柄は、その後も大きく動く(range10・atr14 が、その後の値幅を予測する)
 *  - 出来高と寄り付きのギャップは、乱数(順位づけの力が無い)
 * extra で、一部の銘柄の出来高を小さくして、流動性の足切りを確かめられる。
 */
function syntheticPanel({ N = 300, D = 330, seed = 11, lowVolumeCodes = 0 } = {}) {
  const rand = mulberry32(seed);
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += rand();
    return s - 6;
  };
  const panel = createPanel(daysList(D));
  const rows = [];
  for (let n = 0; n < N; n++) {
    const code = String(1000 + n);
    const drift = (rand() - 0.5) * 0.008;
    const sigma = 0.003 + rand() * 0.027;
    const lowVol = n < lowVolumeCodes;
    let close = 1000;
    for (let i = 0; i < D; i++) {
      const open = close * (1 + 0.002 * gauss());
      const next = open * (1 + drift + sigma * gauss());
      const high = Math.max(open, next) * (1 + 0.5 * sigma * Math.abs(gauss()));
      const low = Math.min(open, next) * (1 - 0.5 * sigma * Math.abs(gauss()));
      const volume = (lowVol ? 10 : 1_000_000) * Math.exp(0.3 * gauss());
      rows.push({ code, date: dateOf(i), open, high, low, close: next, volume });
      close = next;
    }
  }
  addRows(panel, rows);
  return panel;
}

const cfgFor = (extra = {}) => ({ ...DEFAULTS, holdoutFrom: dateOf(200), aiFrom: dateOf(250), aiTo: dateOf(280), iterations: 400, minStocks: 100, ...extra });

test("流動性の足切り: 売買代金が小さい銘柄は、比べる対象に入らない", () => {
  const panel = syntheticPanel({ N: 150, D: 100, lowVolumeCodes: 20 });
  const day = studyDay(panel, 70, cfgFor({ minStocks: 50 }));
  assert.equal(day.n[1], 130); // 150銘柄のうち、売買代金が小さい20銘柄を除く
  assert.equal(day.n[5], 130);
});

test("仕込んだ効果を見つける: ret20 は通過し、出来高の急増・ギャップは通過しない。動きの大きさは、その後の値幅を予測する", () => {
  const panel = syntheticPanel();
  const cfg = cfgFor();
  const study = runStudy(panel, cfg);
  assert.ok(study.days.length > 200);
  const summary = summarizeStudy(study, cfg);
  const row = (feature, h) => summary.rows.find((r) => r.feature === feature && r.h === h);

  for (const h of [1, 3, 5]) {
    const r = row("ret20", h);
    assert.ok(r.explore.mean > 0.02, `ret20 の探索期間のIC(${h}日): ${r.explore.mean}`);
    assert.ok(r.holdout.mean > 0.02);
    assert.equal(r.verdict, "通過", `ret20(${h}日)`);
    assert.ok(r.holdoutTop.mean > 0 && r.holdoutBottom.mean < 0, "上位グループが全体を上回り、下位グループが下回る");
    assert.ok(r.ai.n > 0 && r.ai.mean > 0); // AI評価の期間と同じ期間のICも出る
  }
  for (const key of ["volSurge", "gap"]) {
    for (const h of [1, 3, 5]) assert.notEqual(row(key, h).verdict, "通過", `${key}(${h}日)は効果が無いのに通過しました`);
  }

  // 動きの大きさ → その後の値幅(どれだけ動いたか)
  const mv = (key) => summary.movement.find((m) => m.feature === key);
  assert.ok(mv("range10").rangeExplore.mean > 0.3 && mv("range10").rangeHoldout.mean > 0.3);
  assert.ok(mv("atr14").rangeExplore.mean > 0.3);

  // 「動きが小さい銘柄は、その後も動かない」
  const q = summary.quintiles.range10;
  assert.equal(q.length, 5);
  assert.ok(q[0].medianRange < q[4].medianRange);
  assert.ok(q[0].shareFlat > q[4].shareFlat);
  assert.ok(q[0].medianUp < q[4].medianUp);
  assert.equal(q.reduce((s, b) => s + b.n, 0) > 0, true);
});

test("期間の分け方: 探索期間は固定日より前、確認期間は固定日以降。日数が合う", () => {
  const panel = syntheticPanel({ N: 120, D: 140 });
  const cfg = cfgFor({ holdoutFrom: dateOf(100), minStocks: 50, aiFrom: dateOf(120), aiTo: dateOf(130) });
  const study = runStudy(panel, cfg);
  const s = summarizeStudy(study, cfg);
  assert.equal(s.periods.exploreDays + s.periods.holdoutDays, study.days.length);
  assert.ok(s.periods.exploreTo < cfg.holdoutFrom && s.periods.holdoutFrom >= cfg.holdoutFrom);
  assert.ok(s.periods.aiDays > 0 && s.periods.aiDays <= 11);
});

test("レポート: 見出しと表が出て、データが少なくても例外にならない。生存者バイアスの注意が出る", () => {
  const panel = syntheticPanel({ N: 120, D: 140 });
  const cfg = cfgFor({ holdoutFrom: dateOf(100), minStocks: 50 });
  const study = runStudy(panel, cfg);
  const summary = summarizeStudy(study, cfg);
  const meta = { firstDay: dateOf(0), lastDay: dateOf(139), coverage: study.coverage, minTurnoverYen: cfg.minTurnoverYen, costPct: cfg.costPct, quintileHorizon: cfg.quintileHorizon, upThresholds: cfg.upThresholds, flatPct: cfg.flatPct };
  const text = formatFeatureReport({ meta, summary });
  assert.match(text, /順位づけの力の検証/);
  assert.match(text, /成績\(コスト控除後の騰落率\)との順位相関/);
  assert.match(text, /どれだけ動いたか/);
  assert.match(text, /が小さい銘柄は、その後も動かないか/);
  assert.match(text, /生存者バイアス/); // 途中で終わる銘柄が無い合成データなので、注意が出る
  const text2 = formatFeatureReport({ meta: { ...meta, masterCodes: 4500, droppedDays: [{ date: "2025-03-03", count: 120 }] }, summary });
  assert.match(text2, /銘柄数が少ない日を除外: 1日\(2025-03-03:120件\)/);
  assert.match(text2, /stocks マスタ\(4500件\)/);
  for (const [, label] of FEATURE_KEYS.map((k) => [k, k])) assert.ok(text.length > 0 && label);

  const tiny = createPanel(daysList(30)); // 履歴が足りない
  const empty = runStudy(tiny, cfg);
  assert.deepEqual(empty.days, []);
  assert.doesNotThrow(() => summarizeStudy(empty, cfg));
  assert.doesNotThrow(() => formatFeatureReport({ meta: { ...meta, coverage: empty.coverage }, summary: summarizeStudy(empty, cfg) }));
});

test("読み取り専用: 実行スクリプトは SELECT しか実行せず、書き込みの文を含まない。計算のモジュールに通信・保存が無い", () => {
  const script = readFileSync(new URL("../scripts/analyze-features.js", import.meta.url), "utf8");
  assert.match(script, /読み取り専用のため、SELECT以外は実行しません/);
  assert.equal((script.match(/d1\.query\(/g) ?? []).length, 1); // 問い合わせの入口は、SELECTだけを通す select() の1か所
  const strip = (s) => s.replace(/\/\/.*$/gm, "").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/.test(strip(script)));
  // SQL文の中身も確認する(文字列を伏せる前)。"..." と `...` の両方
  const sqls = [...script.matchAll(/select\(\s*d1,\s*(?:"([^"]+)"|`([^`]+)`)/g)].map((m) => m[1] ?? m[2]);
  assert.ok(sqls.length >= 2 && sqls.every((q) => /^\s*SELECT\b/i.test(q)));
  // 全表走査を防ぐ: stock_prices は、必ず「code IN (...)」で絞って読む(日付だけの絞り込みは、1回ごとに全表を走査し、D1の読み取り上限を使い切る)
  const priceQueries = sqls.filter((q) => /FROM\s+stock_prices/i.test(q));
  assert.ok(priceQueries.length >= 1);
  assert.ok(priceQueries.every((q) => /WHERE\s+code\s+IN\s*\(/i.test(q)), "stock_prices を code で絞らずに読んでいます(全表走査になります)");
  assert.ok(!/date\s*<=\s*\?/i.test(priceQueries.join(" ")), "stock_prices を日付の範囲で読んでいます");
  assert.ok(!/price_sync_dates/.test(script), "営業日は、読んだ日足から決める(price_sync_dates の範囲に縛られない)");
  assert.match(script, /--max-rows|maxRows/); // 読み取り行数の上限がある
  const lib = readFileSync(new URL("../src/featureStudy.js", import.meta.url), "utf8");
  assert.ok(!/\b(fetch|writeFile|appendFile|readFile|process\.env)\b/.test(strip(lib)), "計算のモジュールに通信・保存・環境変数の処理があります");
});

test("ワークフロー: 手動実行のみ(schedule・push・pull_request なし)で、検証スクリプトだけを実行する。書き込み・本番の操作が無い", () => {
  const wf = readFileSync(new URL("../.github/workflows/feature-study.yml", import.meta.url), "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.ok(!/^\s*schedule:/m.test(wf) && !/^\s*push:/m.test(wf) && !/^\s*pull_request:/m.test(wf));
  assert.match(wf, /run: node scripts\/analyze-features\.js/);
  assert.ok(!/wrangler|d1 execute|migrations|CLOUDFLARE_API_TOKEN|GITHUB_DISPATCH_TOKEN/.test(wf), "書き込みや本番の操作につながる記述があります");
});
