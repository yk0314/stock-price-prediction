// 長期検証(src/featureStudyLong.js と、src/featureStudy.js の年ごと・TOPIX状態別・厳しい判定)のテスト。
// J-Quantsには触れない。偽のクライアントで、取得の流れ(最新日の除外・失敗した日の取り直し)と、
// 作った(仕込んだ)効果を、年ごとに一貫したものとして見つけ、効果の無い数字を通過にしないことを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mulberry32 } from "../src/backtestD1.js";
import { weekdayDates } from "../src/tradingCalendar.js";
import { loadLongPanel, mapDailyRow, runLongStudy, LONG_DEFAULTS } from "../src/featureStudyLong.js";
import { computeRegimes, summarizeStudy, verdict, yearConsistency, yearlyMeans, DEFAULTS } from "../src/featureStudy.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------------------------
// 偽のJ-Quantsクライアント
// ---------------------------------------------------------------------------------------------
class FakeClient {
  constructor({ days, rowsByDate, failures = new Map(), topix = [], extraCalendar = [] }) {
    this.days = days;
    this.rowsByDate = rowsByDate;
    this.failures = failures; // 日付 → 失敗させる回数
    this.topix = topix;
    this.extraCalendar = extraCalendar;
    this.requests = [];
    this.stats = { requests: 0, retries: 0, failures: 0 };
  }

  async fetchTradingCalendar(from, to) {
    const rows = [...this.days, ...this.extraCalendar].map((d) => ({ Date: d, HolDiv: "1" }));
    // 土日も入れる(休日 HolDiv=0)
    return rows.filter((r) => r.Date >= from && r.Date <= to);
  }

  async fetchDailyQuotesForDate(dateYYYYMMDD) {
    const date = `${dateYYYYMMDD.slice(0, 4)}-${dateYYYYMMDD.slice(4, 6)}-${dateYYYYMMDD.slice(6, 8)}`;
    this.requests.push(date);
    this.stats.requests++;
    const left = this.failures.get(date) ?? 0;
    if (left > 0) {
      this.failures.set(date, left - 1);
      throw new Error(`HTTP 503 (${date})`);
    }
    return this.rowsByDate.get(date) ?? [];
  }

  async fetchTopixRange() {
    return this.topix;
  }
}

/** J-Quantsの形(5桁コード・生の値と調整後の値)の行を作る。調整後の値が使われることを確かめるため、生の値は、わざと違う値にする。 */
function jqRow(code5, date, { open, high, low, close, volume }) {
  return { Date: date, Code: code5, O: open * 999, H: high * 999, L: low * 999, C: close * 999, Vo: volume * 7, AdjO: open, AdjH: high, AdjL: low, AdjC: close, AdjVo: volume };
}

/**
 * 効果を仕込んだ合成データ(J-Quantsの形)。銘柄ごとに、一定の上がりやすさ(drift)と、動きの大きさ(sigma)を持たせる。
 *  - 過去に上がった銘柄は、その後も上がる(ret20 などに順位づけの力があり、年ごとにも同じ向き)
 *  - 動きの大きい銘柄は、その後も大きく動く
 *  - 出来高と寄り付きのギャップは、乱数
 */
function syntheticMarket({ N = 220, start = "2022-01-03", D = 480, seed = 5 } = {}) {
  const days = weekdayDates(start, new Date(Date.parse(start) + (D * 7 / 5 + 7) * 86400000).toISOString().slice(0, 10)).slice(0, D);
  const rand = mulberry32(seed);
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += rand();
    return s - 6;
  };
  const rowsByDate = new Map(days.map((d) => [d, []]));
  for (let n = 0; n < N; n++) {
    const code5 = `${1000 + n}0`;
    const drift = (rand() - 0.5) * 0.008;
    const sigma = 0.003 + rand() * 0.027;
    let close = 1000;
    for (const date of days) {
      const open = close * (1 + 0.002 * gauss());
      const next = open * (1 + drift + sigma * gauss());
      const high = Math.max(open, next) * (1 + 0.5 * sigma * Math.abs(gauss()));
      const low = Math.min(open, next) * (1 - 0.5 * sigma * Math.abs(gauss()));
      rowsByDate.get(date).push(jqRow(code5, date, { open, high, low, close: next, volume: 1_000_000 * Math.exp(0.3 * gauss()) }));
      close = next;
    }
  }
  // TOPIX: ゆるやかに上下する
  let level = 2000;
  const topix = days.map((date, i) => {
    level *= 1 + 0.0004 * Math.sin(i / 40) + 0.004 * gauss();
    return { Date: date, C: level };
  });
  return { days, rowsByDate, topix };
}

// ---------------------------------------------------------------------------------------------
test("日足の写し方: 5桁コードを4桁にし、分割調整後の値(AdjO・AdjH・AdjL・AdjC・AdjVo)を使う。日付は YYYY-MM-DD", () => {
  const r = mapDailyRow(jqRow("72030", "2026-11-20", { open: 100, high: 110, low: 95, close: 105, volume: 5000 }));
  assert.deepEqual({ ...r }, { code: "7203", date: "2026-11-20", open: 100, high: 110, low: 95, close: 105, volume: 5000 });
  assert.equal(mapDailyRow({ Date: "20261120", Code: "131A0", AdjC: 1 }).date, "2026-11-20");
  assert.equal(mapDailyRow({ Date: "2026-11-20", Code: "83010", AdjC: 1 }).code, "8301");
  assert.equal(mapDailyRow({ Date: "2026-11-20", Code: "ABCDE", AdjC: 1 }).code, "ABCDE"); // 5桁目が0でなければ、そのまま
});

test("TOPIXの状態: 終値が直近N日(その日を含む)の平均以上なら up、未満なら down。N日そろうまでは付けない。不正な行は除く", () => {
  const rows = [10, 11, 12, 11, 9, 8, 12].map((close, i) => ({ date: `2026-01-0${i + 1}`, close }));
  const m = computeRegimes(rows, { window: 3 });
  assert.equal(m.has("2026-01-01") || m.has("2026-01-02"), false); // 3日そろう前
  assert.equal(m.get("2026-01-03"), "up"); // 12 >= (10+11+12)/3
  assert.equal(m.get("2026-01-04"), "down"); // 11 < (11+12+11)/3? → 11 < 11.33
  assert.equal(m.get("2026-01-05"), "down"); // 9 < (12+11+9)/3
  assert.equal(m.get("2026-01-07"), "up"); // 12 >= (9+8+12)/3
  const bad = computeRegimes([{ date: "a", close: NaN }, ...rows], { window: 3 });
  assert.equal(bad.size, m.size); // 不正な行は、除かれる
  assert.equal(computeRegimes(null).size, 0);
});

test("年ごとの平均と一貫性: 日数が足りない年は除き、全期間の平均と同じ向きの年の割合を出す", () => {
  const mk = (year, n, v) => Array.from({ length: n }, (_, i) => ({ date: `${year}-01-${String(i + 1).padStart(2, "0")}`, v }));
  const days = [...mk(2022, 70, 0.04), ...mk(2023, 70, 0.02), ...mk(2024, 70, -0.01), ...mk(2025, 70, 0.03), ...mk(2026, 10, -0.5)];
  const years = yearlyMeans(days, (d) => d.v, 60);
  assert.deepEqual(years.map((y) => y.year), ["2022", "2023", "2024", "2025"]); // 2026年は10日で除かれる
  assert.ok(near(years[0].mean, 0.04));
  const c = yearConsistency(years, 0.02);
  assert.deepEqual({ ...c }, { years: 4, same: 3, share: 0.75 });
  assert.equal(yearConsistency([], 0.1).share, null);
  assert.equal(yearConsistency(years, 0).share, null);
});

test("判定: 前半・後半で有意でも、年ごとに向きがばらつけば「年ごとにばらつく」。そろっていれば通過。年ごとの条件を使わないときは、従来どおり", () => {
  const s = (mean, lo, hi, n = 100) => ({ n, mean, lo, hi });
  const ex = s(0.04, 0.01, 0.07);
  const ho = s(0.03, 0.005, 0.06);
  assert.equal(verdict(ex, ho), "通過"); // 従来どおり
  assert.equal(verdict(ex, ho, { consistency: { years: 5, same: 5, share: 1 }, minYearShare: 0.8 }), "通過");
  assert.equal(verdict(ex, ho, { consistency: { years: 5, same: 4, share: 0.8 }, minYearShare: 0.8 }), "通過");
  assert.equal(verdict(ex, ho, { consistency: { years: 5, same: 3, share: 0.6 }, minYearShare: 0.8 }), "年ごとにばらつく");
  assert.equal(verdict(ex, ho, { consistency: { years: 0, same: 0, share: null }, minYearShare: 0.8 }), "通過"); // 年が無いときは、判定に使わない
  assert.equal(verdict(s(0.04, 0.01, 0.07), s(-0.03, -0.06, -0.005), { consistency: { share: 1 }, minYearShare: 0.8 }), "逆転");
});

// ---------------------------------------------------------------------------------------------
test("取得の流れ: 最新日が0件なら除く。失敗した日は取り直す。取り直しても失敗した日は、欠けたまま記録する。コードは4桁、調整後の値を使う", async () => {
  const days = weekdayDates("2022-01-03", "2022-07-29"); // 平日のみ(祝日は無し)
  assert.ok(days.length > 100);
  const lastDay = days[days.length - 1];
  const rowsByDate = new Map(days.slice(0, -1).map((d) => [d, [jqRow("72030", d, { open: 100, high: 101, low: 99, close: 100, volume: 10 }), jqRow("67580", d, { open: 50, high: 51, low: 49, close: 50, volume: 10 })]]));
  // lastDay は、まだ公表されていない(0件)
  const retryDay = days[20];
  const brokenDay = days[40];
  const client = new FakeClient({
    days,
    rowsByDate,
    failures: new Map([[retryDay, 1], [brokenDay, 5]]), // retryDay は1回失敗、brokenDay はずっと失敗
    extraCalendar: ["2022-08-01"], // 範囲外の日付(to より後)は取らない
  });
  const logs = [];
  const { panel, tradingDays, counts, failedDays } = await loadLongPanel({ client, from: "2022-01-03", to: lastDay, log: (m) => logs.push(m), maxFailedDays: 5 });

  assert.equal(tradingDays[tradingDays.length - 1], days[days.length - 2]); // 最新日(0件)が除かれた
  assert.ok(logs.some((m) => m.includes("まだ公表されていない")));
  assert.deepEqual(failedDays.map((f) => f.date), [brokenDay]); // 取り直しても失敗した日
  assert.equal(counts.get(retryDay), 2); // 取り直しで成功した日
  assert.equal(counts.has(brokenDay), false);
  assert.deepEqual(panel.codes.sort(), ["6758", "7203"]); // 5桁 → 4桁
  const di = panel.dayIndex.get(days[10]);
  assert.equal(panel.close[panel.codeIndex.get("7203")][di], 100);
  assert.ok(Number.isNaN(panel.close[panel.codeIndex.get("7203")][panel.dayIndex.get(brokenDay)])); // 欠けたまま
  assert.equal(client.requests.filter((d) => d === retryDay).length, 2);
  assert.ok(client.requests.every((d) => d <= lastDay)); // 範囲外の日付にはリクエストしない

  // 失敗が多すぎれば、中断する
  const bad = new FakeClient({ days, rowsByDate, failures: new Map(days.slice(5, 15).map((d) => [d, 99])) });
  await assert.rejects(() => loadLongPanel({ client: bad, from: "2022-01-03", to: lastDay, maxFailedDays: 3 }), /失敗した日が多すぎます/);
  // 取引日が少なすぎれば、中断する
  await assert.rejects(() => loadLongPanel({ client, from: "2022-07-01", to: lastDay }), /取引日が少なすぎます/);
});

// ---------------------------------------------------------------------------------------------
test("通し: 仕込んだ効果(上がりやすさ)は、前半・後半・年ごとにそろい「通過」。出来高・ギャップは通過しない。年ごと・TOPIX状態別の表が出る", async () => {
  const { days, rowsByDate, topix } = syntheticMarket();
  const client = new FakeClient({ days, rowsByDate, topix });
  const logs = [];
  const { report, summary, meta } = await runLongStudy({
    client,
    from: days[0],
    to: days[days.length - 1],
    cfgOverrides: { holdoutFrom: days[300], minStocks: 100, iterations: 300, minDaysPerYear: 60, horizons: [1, 5, 20] },
    log: (m) => logs.push(m),
  });
  assert.ok(logs.some((m) => m.includes("読み込み完了")));
  assert.equal(meta.showAi, false);

  const row = (feature, h) => summary.rows.find((r) => r.feature === feature && r.h === h);
  for (const h of [5, 20]) {
    const r = row("ret20", h);
    assert.equal(r.verdict, "通過", `ret20(${h}日): ${r.verdict}`);
    assert.ok(r.consistency.years >= 2 && r.consistency.share === 1, "年ごとに同じ向き");
  }
  for (const key of ["volSurge", "gap"]) {
    for (const h of [1, 5, 20]) assert.notEqual(row(key, h).verdict, "通過", `${key}(${h}日)`);
  }

  // 年ごとの表・TOPIX状態別の表
  assert.match(report, /年ごとの順位相関\(コスト控除後の成績。保有5営業日/);
  assert.match(report, /年ごとの順位相関\(コスト控除後の成績。保有20営業日/);
  assert.match(report, /TOPIXの状態別の順位相関\(保有5営業日/);
  assert.match(report, /年ごとに同じ向き/);
  assert.ok(!/AI評価の期間のIC/.test(report)); // 長期の検証では、AI評価の列は出さない
  assert.match(report, /さらに、年ごとのICが、全期間の向きと同じ年の割合が 80% 以上/);
  assert.ok(summary.regime.length === 9 * 2 && summary.regime.every((r) => r.upDays > 0 && r.downDays > 0));
  assert.ok(summary.rows.every((r) => r.years && r.consistency));
});

test("TOPIXが取れなくても、検証は続く(状態別の表だけ出さない)", async () => {
  const { days, rowsByDate } = syntheticMarket({ N: 140, D: 200 });
  const client = new FakeClient({ days, rowsByDate });
  client.fetchTopixRange = async () => {
    throw new Error("HTTP 500");
  };
  const logs = [];
  const { report, summary } = await runLongStudy({
    client,
    from: days[0],
    to: days[days.length - 1],
    cfgOverrides: { holdoutFrom: days[120], minStocks: 60, iterations: 100, minDaysPerYear: 30, horizons: [1, 5] },
    log: (m) => logs.push(m),
  });
  assert.ok(logs.some((m) => m.includes("TOPIXの取得に失敗")));
  assert.equal(summary.regime, null);
  assert.ok(!/TOPIXの状態別/.test(report));
});

test("従来の実行(年ごと・TOPIX状態別を使わない)では、結果の形と判定が変わらない", () => {
  const study = { days: [], quintiles: {}, coverage: {} };
  const s = summarizeStudy(study, { ...DEFAULTS });
  assert.equal(s.regime, null);
  assert.ok(s.rows.every((r) => r.years === null && r.consistency === null));
  assert.equal(LONG_DEFAULTS.yearly, true);
  assert.equal(DEFAULTS.yearly, false);
  assert.deepEqual(LONG_DEFAULTS.horizons, [1, 3, 5, 10, 20]);
});

// ---------------------------------------------------------------------------------------------
test("読み取り専用: D1・KV・書き込みの処理を使わない。J-QuantsにはGETだけ。実行スクリプトに書き込みの文が無い", () => {
  const lib = readFileSync(new URL("../src/featureStudyLong.js", import.meta.url), "utf8");
  const script = readFileSync(new URL("../scripts/analyze-features-jquants.js", import.meta.url), "utf8");
  const strip = (s) => s.replace(/\/\/.*$/gm, "").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``");
  for (const [name, src] of [["featureStudyLong.js", lib], ["analyze-features-jquants.js", script]]) {
    const code = strip(src);
    assert.ok(!/\b(d1|D1Client|KV|kv)\b/.test(code), `${name} がD1・KVを使っています`);
    assert.ok(!/\b(POST|PUT|PATCH|DELETE|INSERT|UPDATE|REPLACE|DROP|ALTER)\b/.test(code), `${name} に書き込みの処理があります`);
  }
  assert.ok(!/from "\.\.\/src\/d1/.test(script) && !/from "\.\/d1/.test(lib));
  assert.match(script, /JQuantsClient/);
  // クライアントのHTTPメソッドは、GETだけ(既存の実装を確認)
  const client = readFileSync(new URL("../src/jquants.js", import.meta.url), "utf8");
  assert.match(client, /method: "GET"/);
  assert.ok(!/method: "(POST|PUT|PATCH|DELETE)"/.test(client));
});

test("ワークフロー: 手動実行のみ(schedule・push・pull_request なし)。J-QuantsのAPIキーだけを使い、D1・Cloudflareの認証情報を使わない", () => {
  const wf = readFileSync(new URL("../.github/workflows/feature-study-long.yml", import.meta.url), "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.ok(!/^\s*schedule:/m.test(wf) && !/^\s*push:/m.test(wf) && !/^\s*pull_request:/m.test(wf));
  assert.match(wf, /run: node scripts\/analyze-features-jquants\.js/);
  assert.match(wf, /JQUANTS_API_KEY: \$\{\{ secrets\.JQUANTS_API_KEY \}\}/);
  assert.ok(!/CF_API_TOKEN|CF_ACCOUNT_ID|CF_D1_DATABASE_ID|CLOUDFLARE_API_TOKEN|GITHUB_DISPATCH_TOKEN|wrangler/.test(wf), "D1・Cloudflareの認証情報や操作が含まれています");
  assert.match(wf, /timeout-minutes: 120/);
});
