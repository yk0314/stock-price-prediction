import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// KVのstocks一覧が「直近の実行の対象銘柄だけ」(phase1_subsetの手動実行など)でも、
// D1の銘柄マスタ・株価で、BUY登録と保有銘柄の現在価格が壊れないことを確認する。
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* Node 22.5未満: スキップ */
}
const skip = DatabaseSync ? false : "node:sqlite が使えない環境(Node 22.5未満)";

async function setup(kvStocks) {
  const { default: worker } = await import("../worker/src/index.js");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec("ALTER TABLE ai_evaluations ADD COLUMN risk TEXT; ALTER TABLE ai_evaluations ADD COLUMN expected_holding_days INTEGER;");
  sqlite.exec(readFileSync(new URL("../migrations/0003_add_trades_canceled_at.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0004_jquants_paid_data_foundation.sql", import.meta.url), "utf8"));
  const DB = {
    prepare(sql) {
      let params = [];
      const st = {
        bind(...a) { params = a; return st; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async run() { const r = sqlite.prepare(sql).run(...params); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
      };
      return st;
    },
  };
  const kv = new Map([["stocks", kvStocks]]);
  const env = { DB, STOCK_KV: { async get(k) { return kv.has(k) ? JSON.stringify(kv.get(k)) : null; } } };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request("https://x.test" + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, body: await res.json() };
  };
  return { sqlite, call };
}

const buy = (code) => ({ code, transactionType: "buy", quantity: 10, price: 1000, transactionDate: "2026-10-05" });

test("KVのstocksに無い銘柄でも、D1の銘柄マスタにあればBUY登録できる。どちらにも無ければ従来どおり拒否", { skip }, async () => {
  const { sqlite, call } = await setup([{ code: "7203", name: "トヨタ自動車", price: 3000, dataAsOf: "2026-10-05" }]);
  sqlite.exec("INSERT INTO stocks (code, name, market, updated_at) VALUES ('6327','北川精機','スタンダード','2026-10-05')");

  assert.equal((await call("POST", "/api/trades", buy("7203"))).status, 201); // KVにある
  assert.equal((await call("POST", "/api/trades", buy("6327"))).status, 201); // KVに無いが、D1の銘柄マスタにある
  const ng = await call("POST", "/api/trades", buy("0000"));
  assert.equal(ng.status, 400);
  assert.match(ng.body.error, /銘柄コードが存在しません/);
});

test("保有銘柄: KVに価格が無い銘柄は、D1の最新の終値・データ基準日・銘柄名で補う。KVにある銘柄はKVを優先", { skip }, async () => {
  const { sqlite, call } = await setup([{ code: "7203", name: "トヨタ自動車", price: 3100, dataAsOf: "2026-10-05" }]);
  sqlite.exec(`INSERT INTO stocks (code, name, market, updated_at) VALUES ('6327','北川精機','スタンダード','2026-10-05'), ('7203','古い名前','プライム','2026-10-05');
    INSERT INTO stock_prices (code, date, close, data_source, fetched_at) VALUES
      ('6327','2026-10-02',1900,'jquants','t'), ('6327','2026-10-05',2000,'jquants','t'), ('7203','2026-10-05',9999,'jquants','t')`);
  await call("POST", "/api/trades", buy("6327"));
  await call("POST", "/api/trades", buy("7203"));

  const holdings = (await call("GET", "/api/holdings")).body;
  const kitagawa = holdings.find((h) => h.code === "6327");
  assert.deepEqual([kitagawa.currentPrice, kitagawa.priceAsOf, kitagawa.name, kitagawa.unrealizedPnl], [2000, "2026-10-05", "北川精機", 10000]);
  const toyota = holdings.find((h) => h.code === "7203");
  assert.deepEqual([toyota.currentPrice, toyota.name], [3100, "トヨタ自動車"]); // KVを優先(D1の9999は使わない)

  const history = (await call("GET", "/api/trades")).body;
  assert.equal(history.find((t) => t.code === "6327").pnl, 10000); // 売買履歴の含み損益にも反映
});

test("KVにもD1にも価格が無い銘柄は、現在価格がnullのまま(エラーにならない)", { skip }, async () => {
  const { sqlite, call } = await setup([]);
  sqlite.exec("INSERT INTO stocks (code, name, market, updated_at) VALUES ('5216','倉元製作所','スタンダード','2026-10-05')");
  assert.equal((await call("POST", "/api/trades", buy("5216"))).status, 201);
  const [h] = (await call("GET", "/api/holdings")).body;
  assert.deepEqual([h.currentPrice, h.priceAsOf, h.unrealizedPnl, h.name], [null, null, null, "倉元製作所"]);
});
