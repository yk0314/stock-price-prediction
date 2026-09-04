// 依存パッケージなしの簡易テストランナー。node --test の代わりに素朴なassertで実装。
// GitHub Actionsでも `node test/unit.test.js` で実行できる。

import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { resolveCutoffDate, isOnOrBeforeCutoff } from "../src/cutoff.js";
import { normalizeRawRow, normalizeRawRows, groupByCode } from "../src/normalize.js";
import { computeFeatures, computeFeaturesForAll } from "../src/features.js";
import { screenToPool, selectGeminiCandidates } from "../src/screening.js";
import { evaluatePrediction, summarizeHitRateByScoreBand } from "../src/backtest.js";
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
  assert.deepEqual(row, { code: "7203", date: "2026-06-01", close: 1234.5, volume: 100000 });
});
await test("正規化: 5桁目が0以外のコードはそのまま維持される", () => {
  const row = normalizeRawRow({ Code: "72035", Date: "20260601", Close: 100, Volume: 10 });
  assert.equal(row.code, "72035");
});
await test("正規化: 短縮カラム名(V2想定)", () => {
  const row = normalizeRawRow({ code: "72030", date: "2026-06-01", C: 1000, Vo: 500 });
  assert.deepEqual(row, { code: "7203", date: "2026-06-01", close: 1000, volume: 500 });
});
await test("正規化: 必須項目欠損時はnull", () => {
  assert.equal(normalizeRawRow({ Code: "72030" }), null);
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
await test("computeFeatures: 21営業日未満(20点)はnull", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      close: 1000 + i * 5,
      volume: 100000 + i * 100,
    });
  }
  assert.equal(computeFeatures("X", rows), null);
});
await test("computeFeatures: 21営業日(20営業日前+最新)あれば正しく計算される", () => {
  const rows = [];
  for (let i = 0; i < 21; i++) {
    rows.push({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      close: 1000 + i * 5,
      volume: 100000 + i * 100,
    });
  }
  const f = computeFeatures("X", rows);
  assert.equal(f.code, "X");
  assert.equal(f.dataAsOf, "2026-05-21");
  assert.equal(f.price, 1100); // i=20 -> 1000+20*5
  // priceChange20d は「20営業日前(i=0, close=1000)」との比較であるべき（オフバイワン修正の検証）
  assert.equal(f.priceChange20d, 10); // (1100-1000)/1000*100 = 10%
  // priceChange5d は「5営業日前(i=15, close=1075)」との比較
  assert.ok(Math.abs(f.priceChange5d - ((1100 - 1075) / 1075) * 100) < 1e-9);
  // priceChange1d は「1営業日前(i=19, close=1095)」との比較
  assert.ok(Math.abs(f.priceChange1d - ((1100 - 1095) / 1095) * 100) < 1e-9);
});
await test("computeFeaturesForAll: Mapを渡すと配列で返る", () => {
  const rows = [];
  for (let i = 0; i < 21; i++) {
    rows.push({ date: `2026-05-${String(i + 1).padStart(2, "0")}`, close: 100 + i, volume: 1000 });
  }
  const grouped = new Map([["A", rows], ["B", [{ date: "2026-05-01", close: 1, volume: 1 }]]]);
  const features = computeFeaturesForAll(grouped);
  assert.equal(features.length, 1); // Bはデータ不足で除外される
  assert.equal(features[0].code, "A");
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

console.log(`\n[test] ${passed}件成功`);
if (process.exitCode) {
  console.error("[test] 失敗したテストがあります");
} else {
  console.log("[test] 全テスト成功");
}
