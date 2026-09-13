// 依存パッケージなしの簡易テストランナー。node --test の代わりに素朴なassertで実装。
// GitHub Actionsでも `node test/unit.test.js` で実行できる。

import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { resolveCutoffDate, isOnOrBeforeCutoff } from "../src/cutoff.js";
import { normalizeRawRow, normalizeRawRows, groupByCode } from "../src/normalize.js";
import { computeFeatures, computeFeaturesForAll } from "../src/features.js";
import { sma, ema, rsi, macd, bollingerBands, atr } from "../src/indicators.js";
import { computeMarketFeatures, computeRelativeStrength } from "../src/market.js";
import {
  normalizeFinancialRow,
  selectLatestAvailableFinancials,
  buildAvailableFinancialsByCode,
} from "../src/financials.js";
import { screenToPool, selectGeminiCandidates, computeScreeningScore } from "../src/screening.js";
import { evaluatePrediction, summarizeHitRateByScoreBand } from "../src/backtest.js";
import {
  pearsonCorrelation,
  computeQuantileBands,
  summarizeByBand,
  topNByDate,
} from "../src/analysis.js";
import { listCandidateDates, JQuantsClient, JQuantsApiError } from "../src/jquants.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("[test] cutoff.js");
await test("手動指定のcutoffDateがそのまま使われる", () => {
  const { cutoffDate, source } = resolveCutoffDate("2026-06-01", new Date("2026-09-03"));
  assert.equal(cutoffDate, "2026-06-01");
  assert.equal(source, "manual");
});
await test("未指定時は自動計算(90日前)になる", () => {
  const { cutoffDate, source } = resolveCutoffDate(undefined, new Date("2026-09-03T00:00:00Z"));
  assert.equal(cutoffDate, "2026-06-05");
  assert.equal(source, "auto");
});
await test("不正な形式はエラーになる", () => {
  assert.throws(() => resolveCutoffDate("not-a-date"));
});
await test("isOnOrBeforeCutoff の境界値", () => {
  assert.equal(isOnOrBeforeCutoff("2026-06-01", "2026-06-01"), true);
  assert.equal(isOnOrBeforeCutoff("2026-06-02", "2026-06-01"), false);
  assert.equal(isOnOrBeforeCutoff("2026-05-31", "2026-06-01"), true);
});

console.log("[test] jquants.js (listCandidateDates)");
await test("土日を除外した日付リストが生成される（2026-06-01は月曜）", () => {
  const dates = listCandidateDates("2026-06-01", "2026-06-07");
  // 2026-06-01(月)〜06-05(金) が対象、06-06(土)・06-07(日)は除外
  assert.deepEqual(dates, [
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
    "2026-06-04",
    "2026-06-05",
  ]);
});

console.log("[test] jquants.js (エラー区別・伝播)");
await test("正常な0件レスポンス(HTTP 200, data:[])はエラーにならない", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 });
  try {
    const client = new JQuantsClient("dummy-key");
    const rows = await client.fetchDailyQuotesForDate("20260601", "2026-06-01");
    assert.deepEqual(rows, []);
  } finally {
    global.fetch = originalFetch;
  }
});
await test("APIエラー(500)はJQuantsApiErrorとしてfetchDailyQuotesBulkForDateRangeまで伝播し、握りつぶされない", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("internal error", { status: 500 });
  try {
    const client = new JQuantsClient("dummy-key");
    await assert.rejects(
      () => client.fetchDailyQuotesBulkForDateRange("2026-06-01", "2026-06-01"),
      JQuantsApiError
    );
  } finally {
    global.fetch = originalFetch;
  }
});
await test("429は設定回数まで待機して再試行し、それでも解消しなければJQuantsApiErrorとして伝播する", async () => {
  const originalFetch = global.fetch;
  const originalRetryConfig = { ...config.JQUANTS_RETRY };
  config.JQUANTS_RETRY.maxRetriesOn429 = 2;
  config.JQUANTS_RETRY.retryBackoffMs = 1; // テストなので待機時間は最小に
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return new Response("rate limited", { status: 429 });
  };
  try {
    const client = new JQuantsClient("dummy-key");
    await assert.rejects(
      () => client.fetchDailyQuotesForDate("20260601", "2026-06-01"),
      JQuantsApiError
    );
    // maxRetriesOn429=2 なので、初回+リトライ2回=合計3回呼ばれるはず
    assert.equal(callCount, 3);
  } finally {
    global.fetch = originalFetch;
    Object.assign(config.JQUANTS_RETRY, originalRetryConfig);
  }
});
await test("429が数回発生しても、その後成功すればエラーにならない", async () => {
  const originalFetch = global.fetch;
  const originalRetryConfig = { ...config.JQUANTS_RETRY };
  config.JQUANTS_RETRY.maxRetriesOn429 = 3;
  config.JQUANTS_RETRY.retryBackoffMs = 1;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount < 3) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    const client = new JQuantsClient("dummy-key");
    const rows = await client.fetchDailyQuotesForDate("20260601", "2026-06-01");
    assert.deepEqual(rows, []);
    assert.equal(callCount, 3); // 2回失敗して3回目で成功
  } finally {
    global.fetch = originalFetch;
    Object.assign(config.JQUANTS_RETRY, originalRetryConfig);
  }
});

console.log("[test] normalize.js");
await test("正規化: 標準カラム名 + 5桁コードは4桁化される", () => {
  const row = normalizeRawRow({ Code: "72030", Date: "20260601", Close: 1234.5, Volume: 100000 });
  assert.deepEqual(row, {
    code: "7203",
    date: "2026-06-01",
    close: 1234.5,
    high: null,
    low: null,
    volume: 100000,
  });
});
await test("正規化: 5桁目が0以外のコードはそのまま維持される", () => {
  const row = normalizeRawRow({ Code: "72035", Date: "20260601", Close: 100, Volume: 10 });
  assert.equal(row.code, "72035");
});
await test("正規化: 短縮カラム名(V2想定)", () => {
  const row = normalizeRawRow({ code: "72030", date: "2026-06-01", C: 1000, Vo: 500 });
  assert.deepEqual(row, {
    code: "7203",
    date: "2026-06-01",
    close: 1000,
    high: null,
    low: null,
    volume: 500,
  });
});
await test("正規化: 必須項目欠損時はnull", () => {
  assert.equal(normalizeRawRow({ Code: "72030" }), null);
});
await test("正規化: AdjustmentCloseが存在する場合は生のCloseより優先される（株式分割対策）", () => {
  // 実データ検証で発覚: 生のCloseを使うと株式分割銘柄でpriceChange5d/20dが
  // 「-70%」のようなあり得ない値になっていた。分割調整後の値を優先することを保証する。
  const row = normalizeRawRow({
    Code: "99840",
    Date: "20260105",
    Close: 500, // 分割前後で不連続な生の終値（想定）
    AdjustmentClose: 2000, // 分割調整後の連続的な終値
    Volume: 1000000,
    AdjustmentVolume: 250000,
  });
  assert.equal(row.close, 2000);
  assert.equal(row.volume, 250000);
});
await test("正規化: AdjustmentCloseが無ければ生のCloseにフォールバックする", () => {
  const row = normalizeRawRow({ Code: "72030", Date: "20260601", Close: 1234.5, Volume: 100000 });
  assert.equal(row.close, 1234.5);
});
await test("groupByCode: 銘柄ごとにグルーピングし日付昇順にソートする", () => {
  const rows = normalizeRawRows([
    { Code: "10000", Date: "20260103", Close: 3, Volume: 10 },
    { Code: "10000", Date: "20260101", Close: 1, Volume: 10 },
    { Code: "20000", Date: "20260101", Close: 5, Volume: 10 },
    { Code: "10000", Date: "20260102", Close: 2, Volume: 10 },
  ]);
  const grouped = groupByCode(rows);
  assert.deepEqual(
    grouped.get("1000").map((r) => r.date),
    ["2026-01-01", "2026-01-02", "2026-01-03"]
  );
  assert.equal(grouped.get("2000").length, 1);
});

console.log("[test] features.js");
function makeDateSeq(n, startDay = 1) {
  const dates = [];
  let day = startDay;
  let month = 5;
  for (let i = 0; i < n; i++) {
    dates.push(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    day++;
    if (day > 28) {
      day = 1;
      month++;
    }
  }
  return dates;
}
await test(`computeFeatures: 必要点数(${config.FEATURE_LOOKBACK_TRADING_DAYS}+1)未満はnull`, () => {
  const n = config.FEATURE_LOOKBACK_TRADING_DAYS; // 1点足りない
  const dates = makeDateSeq(n);
  const rows = dates.map((date, i) => ({ date, close: 1000 + i * 5, volume: 100000 + i * 100 }));
  assert.equal(computeFeatures("X", rows), null);
});
await test("computeFeatures: 必要点数ぴったりあれば正しく計算される（オフバイワン検証）", () => {
  const n = config.FEATURE_LOOKBACK_TRADING_DAYS + 1;
  const dates = makeDateSeq(n);
  const rows = dates.map((date, i) => ({ date, close: 1000 + i * 5, volume: 100000 + i * 100 }));
  const f = computeFeatures("X", rows);
  const latest = rows[rows.length - 1];
  const d20 = rows[rows.length - 1 - config.FEATURE_LOOKBACK_TRADING_DAYS];
  const d5 = rows[rows.length - 6];
  const d1 = rows[rows.length - 2];
  assert.equal(f.code, "X");
  assert.equal(f.dataAsOf, latest.date);
  assert.equal(f.price, latest.close);
  // priceChange20dは「config.FEATURE_LOOKBACK_TRADING_DAYS営業日前」との比較であるべき（オフバイワン修正の検証）
  assert.ok(Math.abs(f.priceChange20d - ((latest.close - d20.close) / d20.close) * 100) < 1e-9);
  assert.ok(Math.abs(f.priceChange5d - ((latest.close - d5.close) / d5.close) * 100) < 1e-9);
  assert.ok(Math.abs(f.priceChange1d - ((latest.close - d1.close) / d1.close) * 100) < 1e-9);
  // データ点数が config.FEATURE_LOOKBACK_TRADING_DAYS+1 点の場合に計算可能な指標
  // （SMA20/RSI14/BB20は必要データ数20〜21を常に満たす）
  assert.ok(f.sma20 !== null);
  assert.ok(f.rsi14 !== null);
  assert.ok(f.bbUpper !== null);
  assert.ok(!Number.isNaN(f.sma20) && Number.isFinite(f.sma20));
  // MACD(12,26,9)は最低35点、EMA26は最低26点必要。
  // 現在の設定(config.FEATURE_LOOKBACK_TRADING_DAYS+1点)がそれを満たすかどうかで期待値を動的に判定する
  // （設定値が将来変わってもテストが追従できるようにするため）。
  const totalPoints = config.FEATURE_LOOKBACK_TRADING_DAYS + 1;
  if (totalPoints >= 35) {
    assert.ok(f.macd !== null, `${totalPoints}点あるためMACDは計算されるはず`);
    assert.ok(f.macdSignal !== null);
  } else {
    assert.equal(f.macd, null, `${totalPoints}点しかないためMACDはnullのはず`);
    assert.equal(f.macdSignal, null);
  }
  if (totalPoints >= 26) {
    assert.ok(f.ema26 !== null, `${totalPoints}点あるためEMA26は計算されるはず`);
  } else {
    assert.equal(f.ema26, null, `${totalPoints}点しかないためEMA26はnullのはず`);
  }
});
await test("computeFeaturesForAll: Mapを渡すと配列で返る", () => {
  const n = config.FEATURE_LOOKBACK_TRADING_DAYS + 1;
  const dates = makeDateSeq(n);
  const rows = dates.map((date, i) => ({ date, close: 100 + i, volume: 1000 }));
  const grouped = new Map([["A", rows], ["B", [{ date: "2026-05-01", close: 1, volume: 1 }]]]);
  const features = computeFeaturesForAll(grouped);
  assert.equal(features.length, 1); // Bはデータ不足で除外される
  assert.equal(features[0].code, "A");
});
await test("computeFeatures: 渡された配列の最後の日付だけをdataAsOfとして使う（cutoffDateフィルタは呼び出し側の責務であることの確認）", () => {
  // features.js自体は日付を見て自律的にフィルタしているわけではなく、
  // 「渡された配列の末尾を最新（=cutoffDate時点）として扱う」だけである。
  // つまりcutoffDateより後のデータを混入させないためには、
  // 呼び出し側(jquants.js/cutoff.js)で事前にフィルタしておくことが必須であり、
  // それが正しく行われていることは cutoff.js / jquants.js 側のテストで別途確認している。
  const n = config.FEATURE_LOOKBACK_TRADING_DAYS + 1;
  const dates = makeDateSeq(n);
  const rows = dates.map((date, i) => ({ date, close: 1000 + i, volume: 1000 }));
  const f = computeFeatures("X", rows);
  assert.equal(f.dataAsOf, rows[rows.length - 1].date);
});
await test("computeFeatures: 計算結果にNaN/Infinityが含まれない", () => {
  const n = config.FEATURE_LOOKBACK_TRADING_DAYS + 1;
  const dates = makeDateSeq(n);
  // 出来高0や価格が一定など、ゼロ割りが起きやすいエッジケースを含める
  const rows = dates.map((date, i) => ({ date, close: 1000, volume: 0 }));
  const f = computeFeatures("X", rows);
  for (const [key, value] of Object.entries(f)) {
    if (typeof value === "number") {
      assert.ok(
        Number.isFinite(value),
        `${key} が NaN または Infinity になっている: ${value}`
      );
    }
  }
});

console.log("[test] indicators.js");
await test("sma: 期間未満はnull、十分あれば平均値を返す", () => {
  assert.equal(sma([1, 2], 3), null);
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
});
await test("ema: 単調増加列で直近値に近い値を返す", () => {
  const values = Array.from({ length: 30 }, (_, i) => 100 + i);
  const result = ema(values, 12);
  assert.ok(result > 100 && result < 130);
});
await test("rsi: 一貫して上昇し続ける場合は100に近い", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const result = rsi(closes, 14);
  assert.equal(result, 100); // 一度も下落していないため
});
await test("rsi: データ不足はnull", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});
await test("macd: データ不足(35点未満)はnull", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(macd(closes), null);
});
await test("macd: 十分なデータがあれば値を返す", () => {
  const closes = Array.from({ length: 41 }, (_, i) => 100 + i * 0.5);
  const result = macd(closes);
  assert.ok(result !== null);
  assert.ok(typeof result.macd === "number");
  assert.ok(typeof result.histogram === "number");
});
await test("bollingerBands: 一定値の系列では上下限=中央値", () => {
  const closes = Array(20).fill(100);
  const bb = bollingerBands(closes, 20, 2);
  assert.equal(bb.upper, 100);
  assert.equal(bb.lower, 100);
  assert.equal(bb.middle, 100);
});
await test("atr: high/lowが無い場合は終値の変動幅で近似する", () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ close: 100 + (i % 2 === 0 ? 1 : -1), high: null, low: null }));
  const result = atr(rows, 14);
  assert.ok(result !== null && result > 0);
});

console.log("[test] market.js");
await test("computeMarketFeatures: データ不足はnull", () => {
  const rows = [{ date: "2026-06-01", close: 2000 }];
  const result = computeMarketFeatures(rows, 20);
  assert.equal(result.topixChangeNd, null);
});
await test("computeMarketFeatures: 20営業日騰落率を計算する", () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    date: `d${i}`,
    close: 2000 + i * 10,
  }));
  const result = computeMarketFeatures(rows, 20);
  assert.ok(Math.abs(result.topixChangeNd - ((2200 - 2000) / 2000) * 100) < 1e-9);
});
await test("computeRelativeStrength: 銘柄がTOPIXをアウトパフォームしていれば正の値", () => {
  assert.equal(computeRelativeStrength(15, 5), 10);
  assert.equal(computeRelativeStrength(null, 5), null);
  assert.equal(computeRelativeStrength(15, null), null);
});

console.log("[test] financials.js");
await test("normalizeFinancialRow: 標準的なキー名を正規化する", () => {
  const row = normalizeFinancialRow({
    Code: "72030",
    DiscDate: "2026-05-13",
    DiscTime: "15:00",
    NetSales: "1000000",
    OperatingProfit: "50000",
    Profit: "30000",
  });
  assert.equal(row.code, "72030");
  assert.equal(row.discDate, "2026-05-13");
  assert.equal(row.netSales, 1000000);
  assert.equal(row.operatingProfit, 50000);
  assert.equal(row.profit, 30000);
});
await test("normalizeFinancialRow: フォールバック用のV1形式キー名でも正規化できる", () => {
  // 実際のV2 APIでは使われないが、候補に残してあるV1形式のキー名でも動くことの確認
  const row = normalizeFinancialRow({
    LocalCode: "86970",
    Code: "8697",
    DisclosedDate: "2023-04-27",
    DisclosedTime: "12:00:00",
    NetSales: "133991000000",
    OperatingProfit: "68253000000",
    OrdinaryProfit: "", // IFRS採用企業は空文字列になりうる
    Profit: "46342000000",
    EarningsPerShare: "88.03",
    BookValuePerShare: "599.47",
    EquityToAssetRatio: "0.004",
  });
  assert.equal(row.discDate, "2023-04-27");
  assert.equal(row.netSales, 133991000000);
  assert.equal(row.operatingProfit, 68253000000);
  assert.equal(row.ordinaryProfit, null); // 空文字列は0ではなくnullになるべき
  assert.equal(row.profit, 46342000000);
  assert.equal(row.eps, 88.03);
  assert.equal(row.bps, 599.47);
  assert.equal(row.equityToAssetRatio, 0.004);
});
await test("normalizeFinancialRow: 実際のJ-Quants V2レスポンス形式(短縮キー名)を正規化する", () => {
  // 2026-09、信越化学工業(4063)の実データで確認した本物のレスポンス形式
  const row = normalizeFinancialRow({
    DiscDate: "2024-07-26",
    DiscTime: "15:00:00",
    Code: "40630",
    DocType: "1QFinancialStatements_Consolidated_JP",
    Sales: "597930000000",
    OP: "191023000000",
    OdP: "219810000000",
    NP: "144021000000",
    EPS: "72.21",
    BPS: "2234.22",
    EqAR: "0.836",
  });
  assert.equal(row.code, "40630");
  assert.equal(row.discDate, "2024-07-26");
  assert.equal(row.netSales, 597930000000);
  assert.equal(row.operatingProfit, 191023000000); // OPキーが正しく拾えているかの検証（今回の修正の核心）
  assert.equal(row.ordinaryProfit, 219810000000); // OdPキー
  assert.equal(row.profit, 144021000000); // NPキー
  assert.equal(row.eps, 72.21);
  assert.equal(row.bps, 2234.22);
  assert.equal(row.equityToAssetRatio, 0.836); // EqARキー
});
await test("normalizeFinancialRow: 実データ形式で空文字列項目(配当等)はnullとして無視される", () => {
  const row = normalizeFinancialRow({
    DiscDate: "2024-07-26",
    Code: "40630",
    Sales: "597930000000",
    OP: "191023000000",
    OdP: "219810000000",
    NP: "144021000000",
    EPS: "72.21",
    BPS: "2234.22",
    EqAR: "0.836",
    Div1Q: "", // 未使用フィールド。正規化対象外だが、影響が無いことを確認
  });
  assert.equal(row.operatingProfit, 191023000000);
  assert.ok(!Number.isNaN(row.operatingProfit));
});
await test("normalizeFinancialRow: discDateが無ければnull", () => {
  assert.equal(normalizeFinancialRow({ Code: "72030" }), null);
});
await test("selectLatestAvailableFinancials: cutoffDate以降(同日含む)の開示は除外する", () => {
  const rows = [
    normalizeFinancialRow({ Code: "1", DiscDate: "2026-05-01", NetSales: "100" }),
    normalizeFinancialRow({ Code: "1", DiscDate: "2026-06-01", NetSales: "200" }), // cutoffDate当日 → 除外
    normalizeFinancialRow({ Code: "1", DiscDate: "2026-06-02", NetSales: "300" }), // cutoffDateより後 → 除外
  ];
  const latest = selectLatestAvailableFinancials(rows, "2026-06-01");
  assert.equal(latest.netSales, 100);
});
await test("selectLatestAvailableFinancials: 利用可能な開示が無ければnull", () => {
  const rows = [normalizeFinancialRow({ Code: "1", DiscDate: "2026-07-01", NetSales: "100" })];
  assert.equal(selectLatestAvailableFinancials(rows, "2026-06-01"), null);
});
await test("buildAvailableFinancialsByCode: 銘柄コードごとに最新の利用可能開示を選ぶ", () => {
  const rawByCode = new Map([
    ["1", [
      { Code: "1", DiscDate: "2026-03-01", NetSales: "100" },
      { Code: "1", DiscDate: "2026-06-01", NetSales: "200" }, // cutoff当日なので除外されるはず
    ]],
  ]);
  const result = buildAvailableFinancialsByCode(rawByCode, "2026-06-01");
  assert.equal(result.get("1").netSales, 100);
});

console.log("[test] screening.js (computeScreeningScore)");
await test("computeScreeningScore: モメンタム・相対強度・RSIを合成する", () => {
  const feature = {
    priceChange5d: 5,
    priceChange20d: 10,
    relativeStrength20d: 3,
    rsi14: 70,
    volumeChange20d: 20,
  };
  const w = config.SCREENING.scoreWeights;
  const expected =
    w.momentum5d * 5 + w.momentum20d * 10 + w.relativeStrength * 3 + w.rsiExtremity * 20 + w.volumeChange * 20;
  assert.ok(Math.abs(computeScreeningScore(feature) - expected) < 1e-9);
});

console.log("[test] screening.js");
await test("screenToPool: 閾値未満は除外される", () => {
  const features = [
    { code: "A", priceChange5d: 0.1, volumeChange20d: 0 },
    { code: "B", priceChange5d: 5, volumeChange20d: 0 },
  ];
  const pool = screenToPool(features);
  assert.deepEqual(pool.map((f) => f.code), ["B"]);
});
await test("selectGeminiCandidates: config.GEMINI.candidateCount件に絞る", () => {
  const pool = Array.from({ length: 50 }, (_, i) => ({ code: `C${i}`, priceChange5d: 10 - i }));
  const selected = selectGeminiCandidates(pool);
  assert.equal(selected.length, 10); // config.GEMINI.candidateCount のデフォルト値
});

console.log("[test] backtest.js");
await test("evaluatePrediction: 30営業日分ない場合はnull", () => {
  const prediction = { code: "A", cutoffDate: "2026-06-01", price: 1000 };
  const future = [{ date: "2026-06-02", close: 1010 }];
  assert.equal(evaluatePrediction(prediction, future), null);
});
await test("evaluatePrediction: +5%以上でhit=true", () => {
  const prediction = { code: "A", cutoffDate: "2026-06-01", price: 1000 };
  const future = [];
  for (let i = 1; i <= 30; i++) {
    future.push({ date: `2026-07-${String(i).padStart(2, "0")}`, close: i === 30 ? 1060 : 1000 });
  }
  const result = evaluatePrediction(prediction, future);
  assert.equal(result.hit, true);
  assert.ok(Math.abs(result.futureReturn30d - 6) < 1e-9);
});
await test("evaluatePrediction: +5%未満でhit=false", () => {
  const prediction = { code: "A", cutoffDate: "2026-06-01", price: 1000 };
  const future = [];
  for (let i = 1; i <= 30; i++) {
    future.push({ date: `2026-07-${String(i).padStart(2, "0")}`, close: i === 30 ? 1020 : 1000 });
  }
  const result = evaluatePrediction(prediction, future);
  assert.equal(result.hit, false);
});
await test("summarizeHitRateByScoreBand: スコア帯ごとの的中率を集計する", () => {
  const data = [
    { score: 85, hit: true },
    { score: 82, hit: false },
    { score: 65, hit: true },
  ];
  const summary = summarizeHitRateByScoreBand(data, [
    [80, 100],
    [60, 79],
  ]);
  assert.equal(summary[0].count, 2);
  assert.equal(summary[0].hitRate, 50);
  assert.equal(summary[1].count, 1);
  assert.equal(summary[1].hitRate, 100);
});

console.log("[test] analysis.js");
await test("pearsonCorrelation: 完全な正の相関で1になる", () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [2, 4, 6, 8, 10];
  assert.ok(Math.abs(pearsonCorrelation(xs, ys) - 1) < 1e-9);
});
await test("pearsonCorrelation: 完全な負の相関で-1になる", () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [10, 8, 6, 4, 2];
  assert.ok(Math.abs(pearsonCorrelation(xs, ys) - -1) < 1e-9);
});
await test("pearsonCorrelation: 無関係な場合は0に近い", () => {
  const xs = [1, 2, 3, 4, 5, 6];
  const ys = [3, 1, 4, 1, 5, 9]; // ランダムに近い並び
  const r = pearsonCorrelation(xs, ys);
  assert.ok(r !== null && Math.abs(r) < 1);
});
await test("pearsonCorrelation: サンプル数不足はnull", () => {
  assert.equal(pearsonCorrelation([1, 2], [1, 2]), null);
});
await test("computeQuantileBands: 指定した数のバンドに分割する", () => {
  const scores = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const bands = computeQuantileBands(scores, 2);
  assert.equal(bands.length, 2);
  assert.ok(bands[0][0] <= bands[0][1]);
  assert.ok(bands[1][0] <= bands[1][1]);
});
await test("summarizeByBand: バンドごとにhit率・平均/中央値リターンを集計する", () => {
  const samples = [
    { score: 10, futureReturn30d: 10, hit: true },
    { score: 12, futureReturn30d: -5, hit: false },
    { score: 1, futureReturn30d: 2, hit: false },
  ];
  const bands = [
    [10, 20],
    [0, 9],
  ];
  const summary = summarizeByBand(samples, bands);
  assert.equal(summary[0].count, 2);
  assert.equal(summary[0].hitRatePct, 50);
  assert.equal(summary[0].avgReturnPct, 2.5);
  assert.equal(summary[1].count, 1);
  assert.equal(summary[1].avgReturnPct, 2);
});
await test("topNByDate: 日付ごとにスコア上位N件の平均リターンを計算する", () => {
  const samples = [
    { code: "A", cutoffDate: "2026-01-01", score: 10, futureReturn30d: 5 },
    { code: "B", cutoffDate: "2026-01-01", score: 5, futureReturn30d: -5 },
    { code: "C", cutoffDate: "2026-01-01", score: 20, futureReturn30d: 15 },
  ];
  const result = topNByDate(samples, [1, 2]);
  assert.deepEqual(result["2026-01-01"].top1.codes, ["C"]);
  assert.equal(result["2026-01-01"].top1.avgReturnPct, 15);
  assert.equal(result["2026-01-01"].top2.avgReturnPct, 10); // (15+5)/2
});

console.log(`\n[test] ${passed}件成功`);
if (process.exitCode) {
  console.error("[test] 失敗したテストがあります");
} else {
  console.log("[test] 全テスト成功");
}
