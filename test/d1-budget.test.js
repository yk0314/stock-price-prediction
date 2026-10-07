import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { D1Client, D1QuotaError, isQuotaExceededMessage } from "../src/d1.js";
import { computeSyncBudget, readWrittenToday, recordWrittenToday, shouldSkipNonEssentialWrites, utcDay } from "../src/d1Budget.js";

const QUOTA_BODY = '{"messages":[],"result":[],"success":false,"errors":[{"code":7500,"message":"Your account has exceeded D1\'s free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."}]}';

test("D1の書き込み上限エラーの判定(実際のエラーメッセージ)", () => {
  assert.equal(isQuotaExceededMessage(QUOTA_BODY), true);
  assert.equal(isQuotaExceededMessage('{"errors":[{"code":7500}]}'), true);
  assert.equal(isQuotaExceededMessage("D1クエリ失敗 (400): no such table: foo"), false);
  assert.equal(isQuotaExceededMessage(undefined), false);
});

test("UTCの日付(D1の上限がリセットされる単位): UTC 0時 = 日本時間9時で切り替わる", () => {
  assert.equal(utcDay(new Date("2026-10-05T23:59:59Z")), "2026-10-05");
  assert.equal(utcDay(new Date("2026-10-06T00:00:00Z")), "2026-10-06"); // JST 9:00
  assert.equal(utcDay(new Date("2026-10-05T22:25:18Z")), "2026-10-05"); // JST 10/6 7:25(上限は前日分のまま)
});

test("株価蓄積の予算: 1回の上限・今日の残り(合計 - 使用済み - パイプライン用の余裕)の小さい方。台帳が無ければ上限だけ", () => {
  const base = { perRunCap: 60000, dailyTotal: 85000, reserve: 10000 };
  assert.equal(computeSyncBudget({ ...base, usedToday: 0 }), 60000);
  assert.equal(computeSyncBudget({ ...base, usedToday: 20000 }), 55000); // 85000-20000-10000
  assert.equal(computeSyncBudget({ ...base, usedToday: 70000 }), 5000);
  assert.equal(computeSyncBudget({ ...base, usedToday: 80000 }), 0); // 余裕を割ったら0(マイナスにならない)
  assert.equal(computeSyncBudget({ ...base, usedToday: null }), 60000);
});

test("パイプライン: 今日の残りが少ないときだけ、必須ではない書き込み(銘柄マスタ・プール株価)を省略する", () => {
  const base = { dailyTotal: 85000, minRemaining: 15000 };
  assert.equal(shouldSkipNonEssentialWrites({ ...base, usedToday: 60000 }), false); // 残り25000
  assert.equal(shouldSkipNonEssentialWrites({ ...base, usedToday: 70000 }), false); // 残り15000(ちょうど)
  assert.equal(shouldSkipNonEssentialWrites({ ...base, usedToday: 70001 }), true);
  assert.equal(shouldSkipNonEssentialWrites({ ...base, usedToday: null }), false); // 台帳が読めなければ省略しない
});

test("書き込み上限(400・code 7500)が返ったら、以降の書き込みはネットワークに出さず即座に止め、読み取りは続けられる", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const sql = JSON.parse(init.body).sql;
    if (/^\s*select/i.test(sql)) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [{ n: 1 }], meta: { rows_read: 1 } }] }), text: async () => "" };
    }
    return { ok: false, status: 400, text: async () => QUOTA_BODY, json: async () => JSON.parse(QUOTA_BODY) };
  };
  try {
    const d1 = new D1Client({ accountId: "a", databaseId: "b", apiToken: "c" });
    await assert.rejects(() => d1.run("INSERT INTO t VALUES (1)"), (e) => e instanceof D1QuotaError && /書き込み上限/.test(e.message));
    assert.equal(d1.stats.quotaExceeded, true);
    assert.equal(calls, 1);

    await assert.rejects(() => d1.run("  insert or replace into t values (2)"), D1QuotaError);
    await assert.rejects(() => d1.bulkUpsertJson("t", ["a"], [[1]]), D1QuotaError);
    assert.equal(calls, 1, "上限後の書き込みはリクエストを送らない");

    assert.deepEqual(await d1.query("SELECT 1 AS n"), [{ n: 1 }]); // 読み取りは続けられる
    assert.equal(calls, 2);

    // 上限以外のエラーは、従来どおりのエラー(サーキットブレーカーは作動しない)
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => "no such table: foo" });
    const other = new D1Client({ accountId: "a", databaseId: "b", apiToken: "c" });
    await assert.rejects(() => other.run("INSERT INTO foo VALUES (1)"), (e) => !(e instanceof D1QuotaError) && /no such table/.test(e.message));
    assert.equal(other.stats.quotaExceeded, false);
  } finally {
    globalThis.fetch = original;
  }
});

// ---- 台帳(SQLite) ----
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* Node 22.5未満: スキップ */
}
const skip = DatabaseSync ? false : "node:sqlite が使えない環境(Node 22.5未満)";

class FakeD1 extends D1Client {
  constructor(sqlite) {
    super({ accountId: "a", databaseId: "b", apiToken: "c" });
    this.sqlite = sqlite;
  }
  async run(sql, params = []) {
    const stmt = this.sqlite.prepare(sql);
    if (/^\s*select/i.test(sql)) return { results: stmt.all(...params), meta: {} };
    const r = stmt.run(...params);
    this.stats.rowsWritten += Number(r.changes);
    return { results: [], meta: {} };
  }
}

test("台帳: ジョブごとの書き込み行数が日ごとに加算され、全ジョブの合計を読める。日が変われば別集計", { skip }, async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0005_d1_write_ledger.sql", import.meta.url), "utf8"));
  const d1 = new FakeD1(sqlite);
  assert.equal(await readWrittenToday(d1, "2026-10-05"), 0);

  assert.equal(await recordWrittenToday(d1, { day: "2026-10-05", job: "pipeline", rows: 15000 }), true);
  assert.equal(await recordWrittenToday(d1, { day: "2026-10-05", job: "sync-prices", rows: 50000 }), true);
  assert.equal(await recordWrittenToday(d1, { day: "2026-10-05", job: "pipeline", rows: 2000 }), true); // 同じジョブの2回目は加算
  assert.equal(await readWrittenToday(d1, "2026-10-05"), 67000);
  assert.equal(await readWrittenToday(d1, "2026-10-06"), 0);
  assert.equal(sqlite.prepare("SELECT rows_written FROM d1_write_ledger WHERE job='pipeline'").get().rows_written, 17000);

  // 書き込み0行は記録しない(台帳自体の書き込みを増やさない)
  assert.equal(await recordWrittenToday(d1, { day: "2026-10-05", job: "x", rows: 0 }), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM d1_write_ledger").get().n, 2);
});

test("台帳が無い(migration未適用)・書き込みに失敗しても、例外にならずジョブは続けられる", { skip }, async () => {
  const sqlite = new DatabaseSync(":memory:");
  const d1 = new FakeD1(sqlite);
  assert.equal(await readWrittenToday(d1, "2026-10-05"), null); // 読めない → null(呼び出し側は設定値だけで動く)
  assert.equal(await recordWrittenToday(d1, { day: "2026-10-05", job: "pipeline", rows: 100 }), false);
});

test("パイプライン・sync-prices が台帳と書き込み上限の扱いを組み込んでいる(配線の確認)", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const pipeline = read("../src/pipeline.js");
  const sync = read("../scripts/sync-prices.js");
  assert.match(pipeline, /readWrittenToday/);
  assert.match(pipeline, /recordWrittenToday\(d1, \{ day: ledgerDay, job: "pipeline"/);
  assert.match(pipeline, /!skipNonEssentialD1/);
  assert.match(sync, /computeSyncBudget/);
  assert.match(sync, /recordWrittenToday\(d1, \{ day: ledgerDay, job: "sync-prices"/);
  assert.match(sync, /D1QuotaError/);
});
