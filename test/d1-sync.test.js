import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { D1Client, buildJsonUpsertSql } from "../src/d1.js";
import {
  buildIndexRows,
  buildPriceRow,
  diffStocks,
  findAdjustedCodes,
  planMissingDates,
  repairAdjustedHistory,
  syncIndexPrices,
  syncPrices,
  syncStocksMaster,
} from "../src/d1Sync.js";

// ---- 純粋関数 ----

const RAW = {
  Date: "2026-10-02",
  Code: "72030",
  O: 3000,
  H: 3050,
  L: 2990,
  C: 3040,
  Vo: 1000000,
  Va: 3040000000,
  AdjFactor: 1,
  AdjO: 3000,
  AdjH: 3050,
  AdjL: 2990,
  AdjC: 3040,
  AdjVo: 1000000,
};

test("株価1行のD1用の変換: 4桁コード・調整後の四本値・調整係数・売買代金", () => {
  assert.deepEqual(buildPriceRow(RAW, "T"), ["7203", "2026-10-02", 3000, 3050, 2990, 3040, 1000000, "jquants", "T", 1, 3040000000]);
  // 調整後(Adj*)を優先する(株式分割で生の値と異なる場合)
  const split = { ...RAW, Code: "99840", AdjFactor: 0.25, C: 4000, AdjC: 1000, O: 4000, AdjO: 1000 };
  const row = buildPriceRow(split, "T");
  assert.equal(row[5], 1000);
  assert.equal(row[2], 1000);
  assert.equal(row[9], 0.25);
  // 値が足りない行は除外される
  assert.equal(buildPriceRow({ Date: "2026-10-02", Code: "72030" }, "T"), null);
  assert.equal(buildPriceRow({ Date: "2026-10-02", Code: "72030", AdjC: "abc" }, "T"), null);
  // 任意項目が無くても保存できる(nullになる)
  const minimal = buildPriceRow({ Date: "20261002", Code: "13010", AdjC: 500 }, "T");
  assert.deepEqual([minimal[0], minimal[1], minimal[5], minimal[9], minimal[10]], ["1301", "2026-10-02", 500, null, null]);
});

test("株式分割等(AdjFactor≠1)があった銘柄と日付を検出する", () => {
  const found = findAdjustedCodes([
    { ...RAW, Code: "99840", AdjFactor: 0.25, Date: "2025-12-29" },
    { ...RAW, Code: "99840", AdjFactor: 0.5, Date: "2026-03-01" },
    { ...RAW, Code: "72030", AdjFactor: 1 },
    { ...RAW, Code: "67580", AdjFactor: undefined },
  ]);
  assert.deepEqual([...found.entries()], [["9984", "2026-03-01"]]);
});

test("差分: 未蓄積の取引日だけを、新しい日付から順に返す", () => {
  const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"];
  assert.deepEqual(planMissingDates(days, new Set(["2026-09-29"])), ["2026-10-01", "2026-09-30", "2026-09-28"]);
  assert.deepEqual(planMissingDates(days, new Set(days)), []);
});

test("銘柄マスタの差分: 新規・銘柄名や市場区分の変更だけが書き込み対象", () => {
  const existing = [
    { code: "7203", name: "トヨタ自動車", market: "プライム" },
    { code: "6758", name: "ソニーグループ", market: "プライム" },
  ];
  const incoming = new Map([
    ["7203", { code: "7203", name: "トヨタ自動車", market: "プライム" }],
    ["6758", { code: "6758", name: "ソニーG", market: "プライム" }], // 名称変更
    ["9999", { code: "9999", name: "新規上場", market: "グロース" }], // 新規
  ]);
  assert.deepEqual(diffStocks(existing, incoming).map((s) => s.code), ["6758", "9999"]);
});

test("指数(TOPIX)の行: 日付形式の正規化と欠損行の除外", () => {
  const rows = buildIndexRows("TOPIX", [{ Date: "2026-10-02", O: 1, H: 2, L: 0.5, C: 1.5 }, { Date: "20261001", C: 3 }, { Date: "2026-09-30" }], "T");
  assert.deepEqual(rows, [["TOPIX", "2026-10-02", 1, 2, 0.5, 1.5, "T"], ["TOPIX", "2026-10-01", null, null, null, 3, "T"]]);
});

test("JSON一括upsertのSQL: 列数が多くてもバインド変数は1つ", () => {
  const sql = buildJsonUpsertSql("t", ["a", "b"]);
  assert.equal(sql, "INSERT OR REPLACE INTO t (a, b) SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?) AS j");
  assert.equal((sql.match(/\?/g) ?? []).length, 1);
});

// ---- SQLiteを使ったD1の模擬(Node 22.5以上。無い環境ではスキップ) ----

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* Node 20等: SQLite組み込みが無いため、以降のテストはスキップ */
}
const sqliteTest = (name, fn) => test(name, { skip: DatabaseSync ? false : "node:sqlite が使えない環境(Node 22.5未満)" }, fn);

/** 本物の D1Client(bulkUpsertJsonのSQL生成を含む)を、REST APIの代わりにSQLiteへ接続したもの */
class FakeD1 extends D1Client {
  constructor(sqlite, { failAfterRuns = null } = {}) {
    super({ accountId: "a", databaseId: "b", apiToken: "c" });
    this.sqlite = sqlite;
    this.failAfterRuns = failAfterRuns;
    this.runs = 0;
  }
  async run(sql, params = []) {
    this.runs++;
    if (this.failAfterRuns !== null && this.runs > this.failAfterRuns) throw new Error("D1が一時的に失敗(テスト)");
    const stmt = this.sqlite.prepare(sql);
    const isSelect = /^\s*select/i.test(sql);
    if (isSelect) {
      const results = stmt.all(...params);
      this.stats.requests++;
      return { results, meta: {} };
    }
    const r = stmt.run(...params);
    this.stats.requests++;
    this.stats.rowsWritten += Number(r.changes) * 2; // テーブル本体 + 主キーの索引(D1の書き込み行数の数え方を模擬)
    return { results: [], meta: { rows_written: Number(r.changes) * 2 } };
  }
}

function newDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0004_jquants_paid_data_foundation.sql", import.meta.url), "utf8"));
  return sqlite;
}

function dayRows(date, count, extra = {}) {
  return Array.from({ length: count }, (_, i) => ({
    Date: date,
    Code: `${1000 + i}0`,
    O: 100,
    H: 110,
    L: 90,
    C: 105 + i,
    Vo: 1000,
    Va: 105000,
    AdjFactor: 1,
    AdjO: 100,
    AdjH: 110,
    AdjL: 90,
    AdjC: 105 + i,
    AdjVo: 1000,
    ...extra,
  }));
}

function fakeClient(byDate, perCode = {}) {
  const calls = { dates: [], codes: [], topix: [] };
  return {
    calls,
    async fetchDailyQuotesForDate(compact) {
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
      calls.dates.push(date);
      return byDate[date] ?? [];
    },
    async fetchDailyQuotesForCodeRange(code) {
      calls.codes.push(code);
      return perCode[code] ?? [];
    },
    async fetchTopixRange(from, to) {
      calls.topix.push([from, to]);
      return perCode.__topix ?? [];
    },
  };
}

const count = (sqlite, sql) => Number(Object.values(sqlite.prepare(sql).get())[0]);

sqliteTest("migration 0004: 列・テーブルが追加され、冗長な索引が無くなる", () => {
  const sqlite = newDb();
  const cols = sqlite.prepare("PRAGMA table_info(stock_prices)").all().map((c) => c.name);
  assert.ok(cols.includes("adj_factor") && cols.includes("turnover") && cols.includes("open"));
  const objects = sqlite.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name);
  for (const name of ["price_sync_dates", "index_prices"]) assert.ok(objects.includes(name), name);
  assert.ok(!objects.includes("idx_stock_prices_code_date"));
});

sqliteTest("差分蓄積: 2回目以降は未蓄積の日付だけを取得し、同じ日付を二重に書き込まない", async () => {
  const sqlite = newDb();
  const d1 = new FakeD1(sqlite);
  const days = ["2026-09-30", "2026-10-01", "2026-10-02"];
  const client = fakeClient(Object.fromEntries(days.map((d) => [d, dayRows(d, 5)])));

  const first = await syncPrices({ client, d1, tradingDays: days, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(first.syncedDates, ["2026-10-02", "2026-10-01", "2026-09-30"]); // 新しい日付から
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stock_prices"), 15);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM price_sync_dates"), 3);
  assert.equal(client.calls.dates.length, 3);

  // 2回目: 何も取得しない
  const second = await syncPrices({ client, d1, tradingDays: days, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(second.syncedDates, []);
  assert.equal(client.calls.dates.length, 3);

  // 新しい取引日が増えたら、その日だけ取得する
  client.calls.dates.length = 0;
  const withNew = [...days, "2026-10-05"];
  const clientNew = fakeClient({ "2026-10-05": dayRows("2026-10-05", 5) });
  const third = await syncPrices({ client: clientNew, d1, tradingDays: withNew, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(third.syncedDates, ["2026-10-05"]);
  assert.deepEqual(clientNew.calls.dates, ["2026-10-05"]);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stock_prices"), 20);

  // 同じ日付を、蓄積済みの記録を消して再実行しても、主キー(code, date)でupsertされ重複しない
  sqlite.exec("DELETE FROM price_sync_dates");
  await syncPrices({ client: fakeClient(Object.fromEntries(withNew.map((d) => [d, dayRows(d, 5)]))), d1, tradingDays: withNew, writeBudget: 1e6, log: () => {} });
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stock_prices"), 20);
  const row = sqlite.prepare("SELECT * FROM stock_prices WHERE code='1000' AND date='2026-10-02'").get();
  assert.deepEqual([row.code, row.open, row.close, row.adj_factor, row.turnover, row.data_source], ["1000", 100, 105, 1, 105000, "jquants"]);
});

sqliteTest("書き込み予算: 予算を超えない範囲で新しい日付から処理し、残りは次回に回す(再開できる)", async () => {
  const sqlite = newDb();
  const days = ["2026-09-30", "2026-10-01", "2026-10-02"];
  const data = Object.fromEntries(days.map((d) => [d, dayRows(d, 4000)]));
  const run = () => syncPrices({ client: fakeClient(data), d1: new FakeD1(sqlite), tradingDays: days, writeBudget: 20000, log: () => {} });

  const first = await run();
  assert.deepEqual(first.syncedDates, ["2026-10-02", "2026-10-01"]);
  assert.equal(first.stoppedBy, "write-budget");
  assert.equal(first.remaining, 1);
  assert.ok(first.rowsWritten <= 20000, `書き込み${first.rowsWritten}行が予算以内`);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM price_sync_dates"), 2);

  const second = await run();
  assert.deepEqual(second.syncedDates, ["2026-09-30"]);
  assert.equal(second.remaining, 0);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stock_prices"), 12000);
});

sqliteTest("データが無い取引日(更新前など)は完了扱いにせず、データが揃ってから蓄積する", async () => {
  const sqlite = newDb();
  const d1 = new FakeD1(sqlite);
  const days = ["2026-10-01", "2026-10-02"];
  const early = await syncPrices({ client: fakeClient({ "2026-10-01": dayRows("2026-10-01", 3) }), d1, tradingDays: days, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(early.skippedEmpty, ["2026-10-02"]);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM price_sync_dates WHERE date='2026-10-02'"), 0);
  const later = await syncPrices({ client: fakeClient({ "2026-10-02": dayRows("2026-10-02", 3) }), d1, tradingDays: days, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(later.syncedDates, ["2026-10-02"]);
});

sqliteTest("書き込みの途中でD1が失敗した日付は完了扱いにならず、次回やり直して欠損も重複も無い", async () => {
  const sqlite = newDb();
  const day = "2026-10-02";
  const data = { [day]: dayRows(day, 450) }; // 200行ずつ3リクエスト
  const flaky = new FakeD1(sqlite, { failAfterRuns: 2 }); // 1回目の読み取り + 1リクエスト目の書き込みだけ成功
  await assert.rejects(() => syncPrices({ client: fakeClient(data), d1: flaky, tradingDays: [day], writeBudget: 1e6, rowsPerRequest: 200, log: () => {} }), /一時的に失敗/);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM price_sync_dates"), 0);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stock_prices"), 200); // 途中まで書き込み済み

  const retry = await syncPrices({ client: fakeClient(data), d1: new FakeD1(sqlite), tradingDays: [day], writeBudget: 1e6, rowsPerRequest: 200, log: () => {} });
  assert.deepEqual(retry.syncedDates, [day]);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stock_prices"), 450);
  assert.equal(count(sqlite, "SELECT row_count FROM price_sync_dates"), 450);
});

sqliteTest("取得済み(prefetched)の日付はJ-Quantsに再問い合わせしない", async () => {
  const sqlite = newDb();
  const client = fakeClient({});
  const r = await syncPrices({ client, d1: new FakeD1(sqlite), tradingDays: ["2026-10-02"], prefetched: { "2026-10-02": dayRows("2026-10-02", 3) }, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(r.syncedDates, ["2026-10-02"]);
  assert.equal(client.calls.dates.length, 0);
});

sqliteTest("株式分割: 検出した銘柄の履歴を再取得して上書きする。古い調整や上限を超える銘柄は対象外", async () => {
  const sqlite = newDb();
  const d1 = new FakeD1(sqlite);
  // 以前に蓄積した(分割前の基準の)古い行
  const oldRows = ["2026-09-01", "2026-09-02"].flatMap((d) => dayRows(d, 1, { Code: "99840", AdjC: 4000, C: 4000 }));
  await d1.bulkUpsertJson("stock_prices", ["code", "date", "open", "high", "low", "close", "volume", "data_source", "fetched_at", "adj_factor", "turnover"], oldRows.map((r) => buildPriceRow(r, "old")));
  // 新しい日に分割(AdjFactor 0.25)が反映された
  const exDay = "2026-10-02";
  const day = dayRows(exDay, 3).concat([{ ...dayRows(exDay, 1)[0], Code: "99840", AdjFactor: 0.25, AdjC: 1000, C: 4000 }]);
  const sync = await syncPrices({ client: fakeClient({ [exDay]: day }), d1, tradingDays: [exDay], writeBudget: 1e6, log: () => {} });
  assert.deepEqual([...sync.adjusted.entries()], [["9984", exDay]]);

  const corrected = ["2026-09-01", "2026-09-02", exDay].map((d) => ({ ...dayRows(d, 1)[0], Code: "99840", AdjC: 1000, AdjO: 1000, AdjH: 1100, AdjL: 900 }));
  const client = fakeClient({}, { 9984: corrected });
  const repair = await repairAdjustedHistory({ client, d1, adjusted: sync.adjusted, fromDate: "2026-09-01", toDate: exDay, latestDate: exDay, maxCodes: 20, writeBudget: 1e6, log: () => {} });
  assert.deepEqual(repair.repaired.map((r) => r.code), ["9984"]);
  assert.deepEqual(client.calls.codes, ["9984"]);
  const closes = sqlite.prepare("SELECT close FROM stock_prices WHERE code='9984' ORDER BY date").all().map((r) => r.close);
  assert.deepEqual(closes, [1000, 1000, 1000]); // 古い行も分割後の基準に揃う

  // 古い調整(30日より前)・上限を超える銘柄は再取得しない
  const old = await repairAdjustedHistory({ client: fakeClient({}), d1, adjusted: new Map([["1111", "2026-01-05"]]), fromDate: "2026-01-01", toDate: exDay, latestDate: exDay, maxCodes: 20, writeBudget: 1e6, log: () => {} });
  assert.equal(old.repaired.length, 0);
  const limited = fakeClient({});
  const lim = await repairAdjustedHistory({ client: limited, d1, adjusted: new Map([["1111", "2026-10-01"], ["2222", "2026-10-02"], ["3333", "2026-09-30"]]), fromDate: "2026-09-01", toDate: exDay, latestDate: exDay, maxCodes: 2, writeBudget: 1e6, log: () => {} });
  assert.equal(lim.repaired.length, 2);
  assert.deepEqual(limited.calls.codes, ["2222", "1111"]); // 新しい調整から
});

sqliteTest("TOPIX: 初回は期間全体、2回目以降は保存済みの最終日の少し前から取得して上書きする", async () => {
  const sqlite = newDb();
  const d1 = new FakeD1(sqlite);
  const raw = (d, c) => ({ Date: d, O: c, H: c + 1, L: c - 1, C: c });
  const c1 = fakeClient({}, { __topix: [raw("2026-09-30", 4000), raw("2026-10-01", 4050)] });
  const first = await syncIndexPrices({ client: c1, d1, indexCode: "TOPIX", fromDate: "2024-10-03", toDate: "2026-10-01" });
  assert.equal(first.rows, 2);
  assert.deepEqual(c1.calls.topix[0], ["20241003", "20261001"]);

  const c2 = fakeClient({}, { __topix: [raw("2026-10-01", 4051), raw("2026-10-02", 4100)] });
  await syncIndexPrices({ client: c2, d1, indexCode: "TOPIX", fromDate: "2024-10-03", toDate: "2026-10-02" });
  assert.deepEqual(c2.calls.topix[0], ["20260926", "20261002"]); // 最終日(10-01)の5日前から
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM index_prices"), 3);
  assert.equal(count(sqlite, "SELECT close FROM index_prices WHERE date='2026-10-01'"), 4051);
});

sqliteTest("銘柄マスタ(全銘柄)の同期: 初回は全件、変更が無ければ0件、名称変更だけ1件", async () => {
  const sqlite = newDb();
  const d1 = new FakeD1(sqlite);
  const master = new Map([
    ["7203", { code: "7203", name: "トヨタ自動車", market: "プライム" }],
    ["1306", { code: "1306", name: "ETF", market: "その他" }],
  ]);
  assert.equal((await syncStocksMaster({ d1, listedInfoByCode: master })).written, 2);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM stocks"), 2);
  assert.equal((await syncStocksMaster({ d1, listedInfoByCode: master })).written, 0);
  master.set("7203", { code: "7203", name: "トヨタ", market: "プライム" });
  const changed = await syncStocksMaster({ d1, listedInfoByCode: master });
  assert.equal(changed.written, 1);
  assert.equal(sqlite.prepare("SELECT name FROM stocks WHERE code='7203'").get().name, "トヨタ");
  assert.deepEqual(await syncStocksMaster({ d1, listedInfoByCode: new Map() }), { total: 0, written: 0 });
});

sqliteTest("JSON一括upsert(bulkUpsertJson)は、通常のVALUES句でのupsertと同じ結果になり、日本語・NULLも壊れない", async () => {
  const sqlite = newDb();
  const d1 = new FakeD1(sqlite);
  const rows = [["A001", "グロース銘柄", null, "2026-10-02"], ["A002", "引用符'を含む\"名前", "その他", "2026-10-02"]];
  await d1.bulkUpsertJson("stocks", ["code", "name", "market", "updated_at"], rows, { rowsPerRequest: 1 });
  assert.deepEqual(sqlite.prepare("SELECT code, name, market FROM stocks ORDER BY code").all().map((r) => ({ ...r })), [
    { code: "A001", name: "グロース銘柄", market: null },
    { code: "A002", name: "引用符'を含む\"名前", market: "その他" },
  ]);
  assert.equal(d1.stats.requests, 2); // 2行 / 1行ずつ
  assert.equal(await d1.bulkUpsertJson("stocks", ["code"], []), 0);
});
