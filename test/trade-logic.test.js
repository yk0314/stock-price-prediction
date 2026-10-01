import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHoldings,
  buildPerformance,
  buildTradeHistory,
  computePositionFromTrades,
  groupTradesByCode,
  listHoldingCodes,
  purchaseEvaluationIdByCode,
  validateCancel,
} from "../worker/src/tradeLogic.mjs";
import { fetchHeldCodes } from "../src/d1Repository.js";

let nextId = 1;
function trade(code, type, date, quantity, price, extra = {}) {
  return {
    id: nextId++,
    code,
    transaction_type: type,
    transaction_date: date,
    quantity,
    price,
    amount: quantity * price,
    memo: null,
    purchase_evaluation_id: null,
    created_at: `${date}T00:00:00.000Z`,
    canceled_at: null,
    stock_name: `銘柄${code}`,
    ...extra,
  };
}

function activeOf(rows) {
  return rows.filter((r) => !r.canceled_at);
}

// ---- 既存の移動平均法 ----

test("移動平均法: 買い増しで平均取得価格が再計算され、売却では平均取得価格が変わらない", () => {
  const rows = [
    trade("1111", "buy", "2026-01-01", 100, 1000),
    trade("1111", "buy", "2026-01-02", 100, 1200),
    trade("1111", "sell", "2026-01-03", 50, 1500),
  ];
  const { quantity, avgCost, sellResults } = computePositionFromTrades(groupTradesByCode(rows).get("1111"));
  assert.equal(quantity, 150);
  assert.equal(avgCost, 1100);
  assert.equal(sellResults.length, 1);
  assert.equal(sellResults[0].avgCostAtSale, 1100);
  assert.equal(sellResults[0].realizedPnl, (1500 - 1100) * 50);
});

// ---- 取消の検証 ----

test("BUY取消: 後続のSELLの数量が足りなくなる場合は拒否される（先にSELLを取り消す案内）", () => {
  const rows = [trade("2222", "buy", "2026-02-01", 100, 500), trade("2222", "sell", "2026-02-05", 100, 600)];
  const result = validateCancel(rows, rows[0].id);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /先に該当するSELLを取り消してください/);
});

test("BUY取消: 他のBUYで数量が足りていれば取消できる", () => {
  const rows = [
    trade("2223", "buy", "2026-02-01", 100, 500),
    trade("2223", "buy", "2026-02-02", 100, 520),
    trade("2223", "sell", "2026-02-05", 100, 600),
  ];
  assert.equal(validateCancel(rows, rows[1].id).ok, true);
});

test("BUY取消: 時系列上、SELLより後のBUYなら取消できる（途中で保有数量がマイナスにならない）", () => {
  const rows = [
    trade("2224", "buy", "2026-02-01", 100, 500),
    trade("2224", "sell", "2026-02-05", 100, 600),
    trade("2224", "buy", "2026-02-10", 50, 550),
  ];
  assert.equal(validateCancel(rows, rows[2].id).ok, true);
  assert.equal(validateCancel(rows, rows[0].id).ok, false);
});

test("SELL取消は常に可能で、存在しない・取消済みの取引は取り消せない", () => {
  const rows = [
    trade("3333", "buy", "2026-03-01", 100, 100),
    trade("3333", "sell", "2026-03-02", 100, 120),
    trade("3333", "buy", "2026-03-03", 10, 100, { canceled_at: "2026-03-04T00:00:00.000Z" }),
  ];
  assert.equal(validateCancel(rows, rows[1].id).ok, true);
  assert.equal(validateCancel(rows, 999999).status, 404);
  const already = validateCancel(rows, rows[2].id);
  assert.equal(already.ok, false);
  assert.equal(already.status, 409);
});

test("取消済みのSELLが残した状態でも、BUYの整合性チェックは取消済みSELLを無視する", () => {
  const rows = [
    trade("3334", "buy", "2026-03-01", 100, 100),
    trade("3334", "sell", "2026-03-02", 100, 120, { canceled_at: "2026-03-03T00:00:00.000Z" }),
  ];
  assert.equal(validateCancel(rows, rows[0].id).ok, true);
});

// ---- 取消後の保有数量・平均取得価格 ----

test("BUY取消後: そのBUYが存在しなかった状態の保有数量・平均取得価格になる", () => {
  const rows = [
    trade("4444", "buy", "2026-04-01", 100, 1000),
    trade("4444", "buy", "2026-04-02", 100, 2000), // 誤登録
  ];
  rows[1].canceled_at = "2026-04-03T00:00:00.000Z";
  const holdings = buildHoldings(rows, new Map([["4444", 1500]]), new Map(), new Map());
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].quantity, 100);
  assert.equal(holdings[0].avgCost, 1000);
  assert.equal(holdings[0].unrealizedPnl, 50000);
});

test("SELL取消後: 保有数量が戻り、保有銘柄として復元され、平均取得価格は変わらない", () => {
  const rows = [trade("5555", "buy", "2026-05-01", 100, 1000), trade("5555", "sell", "2026-05-02", 100, 1100)];
  assert.deepEqual(listHoldingCodes(rows), []);
  rows[1].canceled_at = "2026-05-03T00:00:00.000Z";
  assert.deepEqual(listHoldingCodes(rows), ["5555"]);
  const [h] = buildHoldings(rows, new Map(), new Map(), new Map());
  assert.equal(h.quantity, 100);
  assert.equal(h.avgCost, 1000);
});

test("部分SELLの取消: 数量の一部だけが戻る", () => {
  const rows = [
    trade("5556", "buy", "2026-05-01", 100, 1000),
    trade("5556", "sell", "2026-05-02", 30, 1100),
    trade("5556", "sell", "2026-05-03", 20, 900),
  ];
  assert.equal(buildHoldings(rows, new Map(), new Map(), new Map())[0].quantity, 50);
  rows[2].canceled_at = "2026-05-04T00:00:00.000Z";
  assert.equal(buildHoldings(rows, new Map(), new Map(), new Map())[0].quantity, 70);
});

// ---- 取引履歴 ----

test("取引履歴: SELLに売却時平均取得価格・取得原価・損益・勝敗が付き、取消済みは既定で含まれない", () => {
  const rows = [
    trade("6666", "buy", "2026-06-01", 100, 1000),
    trade("6666", "sell", "2026-06-02", 40, 1250),
    trade("6666", "sell", "2026-06-03", 10, 900, { canceled_at: "2026-06-04T00:00:00.000Z" }),
  ];
  const history = buildTradeHistory(rows, new Map([["6666", 1100]]));
  assert.equal(history.length, 2);
  const sell = history.find((h) => h.transactionType === "sell");
  assert.equal(sell.avgCostAtSale, 1000);
  assert.equal(sell.costBasis, 40000);
  assert.equal(sell.pnl, 10000);
  assert.equal(sell.win, true);
  assert.equal(sell.outcome, "win");
  assert.equal(sell.canceled, false);
  const buy = history.find((h) => h.transactionType === "buy");
  assert.equal(buy.pnlType, "unrealized");
  assert.equal(buy.pnl, 10000);
});

test("取引履歴: includeCanceled=true なら取消済みが canceled として損益なしで含まれる", () => {
  const rows = [
    trade("6667", "buy", "2026-06-01", 100, 1000),
    trade("6667", "buy", "2026-06-02", 100, 2000, { canceled_at: "2026-06-03T00:00:00.000Z" }),
  ];
  const history = buildTradeHistory(rows, new Map(), { includeCanceled: true });
  assert.equal(history.length, 2);
  const canceled = history.find((h) => h.canceled);
  assert.equal(canceled.pnlType, "canceled");
  assert.equal(canceled.pnl, null);
  assert.ok(canceled.canceledAt);
});

// ---- 通算成績 ----

test("通算成績: 累計損益・勝率・平均利益/損失・最大利益/損失・累計リターン(部分売却の取得原価)", () => {
  const rows = [
    // 銘柄A: 100株を1000円で購入し、40株を1250円、60株を900円で売却
    trade("7001", "buy", "2026-07-01", 100, 1000),
    trade("7001", "sell", "2026-07-02", 40, 1250), // +10,000（取得原価 40,000）
    trade("7001", "sell", "2026-07-03", 60, 900), // -6,000（取得原価 60,000）
    // 銘柄B: 10株を500円で購入し、500円で売却（損益0）
    trade("7002", "buy", "2026-07-02", 10, 500),
    trade("7002", "sell", "2026-07-04", 10, 500),
    // 銘柄C: 保有中（含み損益は通算成績に含めない）
    trade("7003", "buy", "2026-07-05", 100, 100),
  ];
  const { summary, series } = buildPerformance(rows);
  assert.equal(summary.sellCount, 3);
  assert.equal(summary.totalTrades, 6);
  assert.equal(summary.buyCount, 3);
  assert.equal(summary.winCount, 1);
  assert.equal(summary.loseCount, 1);
  assert.equal(summary.evenCount, 1);
  assert.ok(Math.abs(summary.winRate - 33.3333333) < 1e-4);
  assert.equal(summary.totalRealizedPnl, 4000);
  assert.equal(summary.totalCostBasis, 40000 + 60000 + 5000);
  assert.ok(Math.abs(summary.totalReturnPct - (4000 / 105000) * 100) < 1e-9);
  assert.equal(summary.avgProfit, 10000);
  assert.equal(summary.avgLoss, -6000);
  assert.equal(summary.maxProfit, 10000);
  assert.equal(summary.maxLoss, -6000);

  // チャート用の系列: SELL確定順の累計確定損益
  assert.deepEqual(
    series.map((s) => [s.date, s.cumulativePnl]),
    [
      ["2026-07-02", 10000],
      ["2026-07-03", 4000],
      ["2026-07-04", 4000],
    ]
  );
});

test("通算成績: 取消済みのBUY/SELLは集計に含まれない", () => {
  const rows = [
    trade("7101", "buy", "2026-07-01", 100, 1000),
    trade("7101", "sell", "2026-07-02", 100, 2000, { canceled_at: "2026-07-03T00:00:00.000Z" }), // 取消済みの大きな利益
    trade("7101", "sell", "2026-07-04", 100, 1100),
  ];
  const { summary, series } = buildPerformance(rows);
  assert.equal(summary.sellCount, 1);
  assert.equal(summary.totalRealizedPnl, 10000);
  assert.equal(summary.maxProfit, 10000);
  assert.equal(series.length, 1);
});

test("通算成績: 取引0件・SELLが無い場合は値が null（画面では「—」）で、例外にならない", () => {
  for (const rows of [[], [trade("7201", "buy", "2026-07-01", 10, 100)]]) {
    const { summary, series } = buildPerformance(rows);
    assert.equal(summary.sellCount, 0);
    assert.equal(summary.winRate, null);
    assert.equal(summary.totalRealizedPnl, null);
    assert.equal(summary.totalReturnPct, null);
    assert.equal(summary.avgProfit, null);
    assert.equal(summary.avgLoss, null);
    assert.equal(summary.maxProfit, null);
    assert.equal(summary.maxLoss, null);
    assert.deepEqual(series, []);
  }
});

// ---- 保有銘柄のAI評価の変化 ----

test("保有銘柄: 購入時評価・前回評価・現在評価が付与される（購入時は最新のBUYのpurchase_evaluation_id）", () => {
  const rows = [
    trade("8001", "buy", "2026-08-01", 100, 1000, { purchase_evaluation_id: 11 }),
    trade("8001", "buy", "2026-08-05", 100, 1100, { purchase_evaluation_id: 12 }),
  ];
  const ev = (id, rating, score) => ({ id, code: "8001", rating, score });
  const holdings = buildHoldings(
    rows,
    new Map([["8001", 1200]]),
    new Map([["8001", "テスト銘柄"]]),
    new Map([["8001", { latest: ev(30, "HOLD", 70), previous: ev(20, "BUY", 80) }]]),
    new Map([[12, ev(12, "BUY", 85)]])
  );
  assert.equal(holdings[0].name, "テスト銘柄");
  assert.equal(holdings[0].purchaseEvaluation.rating, "BUY");
  assert.equal(holdings[0].previousEvaluation.score, 80);
  assert.equal(holdings[0].latestEvaluation.rating, "HOLD");
  assert.equal(holdings[0].lastBuyDate, "2026-08-05");
  assert.equal(purchaseEvaluationIdByCode(rows).get("8001").purchaseEvaluationId, 12);
});

test("保有銘柄: AI評価が0件でも例外にならず null が入る", () => {
  const rows = [trade("8002", "buy", "2026-08-01", 10, 100)];
  const [h] = buildHoldings(rows, new Map(), new Map(), new Map());
  assert.equal(h.latestEvaluation, null);
  assert.equal(h.previousEvaluation, null);
  assert.equal(h.purchaseEvaluation, null);
  assert.equal(h.currentPrice, null);
  assert.equal(h.unrealizedPnl, null);
});

test("保有銘柄0件・取引0件でも例外にならない", () => {
  assert.deepEqual(buildHoldings([], new Map(), new Map(), new Map()), []);
  assert.deepEqual(buildTradeHistory([], new Map()), []);
  assert.deepEqual(listHoldingCodes([]), []);
});

// ---- GitHub Actions側: 保有銘柄(再評価対象)の取得が取消済みを除外すること ----

test("fetchHeldCodes: SQLで取消済みの取引を除外し、残った取引の保有数量で判定する", async () => {
  let executedSql = "";
  const d1 = {
    async query(sql) {
      executedSql = sql;
      // canceled_at IS NULL の取引だけが返る想定（SQL側で絞り込まれている）
      return [
        { id: 1, code: "9001", transaction_type: "buy", transaction_date: "2026-09-01", quantity: 100, price: 100 },
        { id: 2, code: "9002", transaction_type: "buy", transaction_date: "2026-09-01", quantity: 50, price: 100 },
        { id: 3, code: "9002", transaction_type: "sell", transaction_date: "2026-09-02", quantity: 50, price: 110 },
      ];
    },
  };
  const held = await fetchHeldCodes(d1);
  assert.match(executedSql, /canceled_at IS NULL/);
  assert.deepEqual(held, ["9001"]);
});
