// 依存パッケージなしの簡易テストランナー。node --test の代わりに素朴なassertで実装。
// GitHub Actionsでも `node test/unit.test.js` で実行できる。

import assert from "node:assert/strict";
import { resolveCutoffDate, isOnOrBeforeCutoff } from "../src/cutoff.js";
import { normalizeRawRow, normalizeRawRows, groupByCode } from "../src/normalize.js";
import { computeFeatures, computeFeaturesForAll } from "../src/features.js";
import { screenToPool, selectGeminiCandidates } from "../src/screening.js";
import { evaluatePrediction, summarizeHitRateByScoreBand } from "../src/backtest.js";
import { listCandidateDates } from "../src/jquants.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("[test] cutoff.js");
test("手動指定のcutoffDateがそのまま使われる", () => {
  const { cutoffDate, source } = resolveCutoffDate("2026-06-01", new Date("2026-09-03"));
  assert.equal(cutoffDate, "2026-06-01");
  assert.equal(source, "manual");
});
test("未指定時は自動計算(90日前)になる", () => {
  const { cutoffDate, source } = resolveCutoffDate(undefined, new Date("2026-09-03T00:00:00Z"));
  assert.equal(cutoffDate, "2026-06-05");
  assert.equal(source, "auto");
});
test("不正な形式はエラーになる", () => {
  assert.throws(() => resolveCutoffDate("not-a-date"));
});
test("isOnOrBeforeCutoff の境界値", () => {
  assert.equal(isOnOrBeforeCutoff("2026-06-01", "2026-06-01"), true);
  assert.equal(isOnOrBeforeCutoff("2026-06-02", "2026-06-01"), false);
  assert.equal(isOnOrBeforeCutoff("2026-05-31", "2026-06-01"), true);
});

console.log("[test] jquants.js (listCandidateDates)");
test("土日を除外した日付リストが生成される（2026-06-01は月曜）", () => {
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

console.log("[test] normalize.js");
test("正規化: 標準カラム名", () => {
  const row = normalizeRawRow({ Code: "7203", Date: "20260601", Close: 1234.5, Volume: 100000 });
  assert.deepEqual(row, { code: "7203", date: "2026-06-01", close: 1234.5, volume: 100000 });
});
test("正規化: 短縮カラム名(V2想定)", () => {
  const row = normalizeRawRow({ code: "7203", date: "2026-06-01", C: 1000, Vo: 500 });
  assert.deepEqual(row, { code: "7203", date: "2026-06-01", close: 1000, volume: 500 });
});
test("正規化: 必須項目欠損時はnull", () => {
  assert.equal(normalizeRawRow({ Code: "7203" }), null);
});
test("groupByCode: 銘柄ごとにグルーピングし日付昇順にソートする", () => {
  const rows = normalizeRawRows([
    { Code: "A", Date: "20260103", Close: 3, Volume: 10 },
    { Code: "A", Date: "20260101", Close: 1, Volume: 10 },
    { Code: "B", Date: "20260101", Close: 5, Volume: 10 },
    { Code: "A", Date: "20260102", Close: 2, Volume: 10 },
  ]);
  const grouped = groupByCode(rows);
  assert.deepEqual(
    grouped.get("A").map((r) => r.date),
    ["2026-01-01", "2026-01-02", "2026-01-03"]
  );
  assert.equal(grouped.get("B").length, 1);
});

console.log("[test] features.js");
test("computeFeatures: 20営業日未満はnull", () => {
  const rows = [
    { date: "2026-05-01", close: 100, volume: 1000 },
    { date: "2026-05-02", close: 101, volume: 1000 },
  ];
  assert.equal(computeFeatures("X", rows), null);
});
test("computeFeatures: 20営業日あれば計算される", () => {
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
  assert.equal(f.price, 1100);
  assert.ok(f.priceChange20d > 0);
});
test("computeFeaturesForAll: Mapを渡すと配列で返る", () => {
  const rows = [];
  for (let i = 0; i < 21; i++) {
    rows.push({ date: `d${i}`, close: 100 + i, volume: 1000 });
  }
  const grouped = new Map([["A", rows], ["B", [{ date: "d0", close: 1, volume: 1 }]]]);
  const features = computeFeaturesForAll(grouped);
  assert.equal(features.length, 1); // Bはデータ不足で除外される
  assert.equal(features[0].code, "A");
});

console.log("[test] screening.js");
test("screenToPool: 閾値未満は除外される", () => {
  const features = [
    { code: "A", priceChange5d: 0.1, volumeChange20d: 0 },
    { code: "B", priceChange5d: 5, volumeChange20d: 0 },
  ];
  const pool = screenToPool(features);
  assert.deepEqual(pool.map((f) => f.code), ["B"]);
});
test("selectGeminiCandidates: config.GEMINI.candidateCount件に絞る", () => {
  const pool = Array.from({ length: 50 }, (_, i) => ({ code: `C${i}`, priceChange5d: 10 - i }));
  const selected = selectGeminiCandidates(pool);
  assert.equal(selected.length, 10); // config.GEMINI.candidateCount のデフォルト値
});

console.log("[test] backtest.js");
test("evaluatePrediction: 30営業日分ない場合はnull", () => {
  const prediction = { code: "A", cutoffDate: "2026-06-01", price: 1000 };
  const future = [{ date: "2026-06-02", close: 1010 }];
  assert.equal(evaluatePrediction(prediction, future), null);
});
test("evaluatePrediction: +5%以上でhit=true", () => {
  const prediction = { code: "A", cutoffDate: "2026-06-01", price: 1000 };
  const future = [];
  for (let i = 1; i <= 30; i++) {
    future.push({ date: `2026-07-${String(i).padStart(2, "0")}`, close: i === 30 ? 1060 : 1000 });
  }
  const result = evaluatePrediction(prediction, future);
  assert.equal(result.hit, true);
  assert.ok(Math.abs(result.futureReturn30d - 6) < 1e-9);
});
test("evaluatePrediction: +5%未満でhit=false", () => {
  const prediction = { code: "A", cutoffDate: "2026-06-01", price: 1000 };
  const future = [];
  for (let i = 1; i <= 30; i++) {
    future.push({ date: `2026-07-${String(i).padStart(2, "0")}`, close: i === 30 ? 1020 : 1000 });
  }
  const result = evaluatePrediction(prediction, future);
  assert.equal(result.hit, false);
});
test("summarizeHitRateByScoreBand: スコア帯ごとの的中率を集計する", () => {
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
