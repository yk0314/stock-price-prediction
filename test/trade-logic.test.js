import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHoldings,
  buildPerformance,
  buildTradeHistory,
  computePositionFromTrades,
  findHoldingShortfall,
  groupTradesByCode,
  isValidDateString,
  listHoldingCodes,
  parseTradeEdit,
  purchaseEvaluationIdByCode,
  validateCancel,
  validateEdit,
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

// ---- SBI発注補助: 保有銘柄の株価のデータ基準日 ----

test("保有銘柄: 株価のデータ基準日(priceAsOf)が付与され、無ければ null", () => {
  const rows = [trade("8101", "buy", "2026-08-01", 10, 100), trade("8102", "buy", "2026-08-01", 10, 100)];
  const holdings = buildHoldings(
    rows,
    new Map([["8101", 120]]),
    new Map(),
    new Map(),
    new Map(),
    new Map([["8101", "2026-07-02"]])
  );
  assert.equal(holdings.find((h) => h.code === "8101").priceAsOf, "2026-07-02");
  assert.equal(holdings.find((h) => h.code === "8102").priceAsOf, null);
});


// ---- 取引の編集 ----

/** DBのUPDATEを模した、編集後の取引行(取引IDは維持したまま値だけ更新)。 */
function applyEdit(rows, id, v) {
  return rows.map((r) =>
    r.id === id
      ? { ...r, quantity: v.quantity, price: v.price, amount: v.quantity * v.price, transaction_date: v.transactionDate, memo: v.memo }
      : r
  );
}

function editValues(row, patch = {}) {
  return { quantity: row.quantity, price: row.price, transactionDate: row.transaction_date, memo: row.memo, ...patch };
}

test("編集: 取引日は YYYY-MM-DD の実在する日付だけが有効", () => {
  for (const ok of ["2026-10-02", "2024-02-29"]) assert.equal(isValidDateString(ok), true, ok);
  for (const ng of ["2026-02-30", "2026-13-01", "2026/10/02", "20261002", "", null, undefined, 20261002, "2026-10-2"]) {
    assert.equal(isValidDateString(ng), false, String(ng));
  }
});

test("編集の入力検証: 数量・価格・日付・メモ・変更不可の項目", () => {
  const target = trade("A001", "buy", "2026-09-01", 100, 1000, { memo: "元のメモ" });
  const base = { quantity: 100, price: 1010, transactionDate: "2026-09-02" };

  for (const quantity of [0, -1, 2.5, "100", NaN, Infinity, null, undefined]) {
    const r = parseTradeEdit({ ...base, quantity }, target);
    assert.equal(r.ok, false, `quantity=${String(quantity)}`);
    assert.equal(r.status, 400);
    assert.match(r.error, /数量/);
  }
  for (const price of [0, -5, "1000", NaN, Infinity, null, undefined]) {
    const r = parseTradeEdit({ ...base, price }, target);
    assert.equal(r.ok, false, `price=${String(price)}`);
    assert.match(r.error, /価格/);
  }
  for (const transactionDate of ["2026-02-30", "2026/09/02", "", null, undefined, 20260902]) {
    const r = parseTradeEdit({ ...base, transactionDate }, target);
    assert.equal(r.ok, false, `date=${String(transactionDate)}`);
    assert.match(r.error, /取引日/);
  }
  assert.equal(parseTradeEdit(null, target).ok, false);
  assert.equal(parseTradeEdit([], target).ok, false);

  // 銘柄・取引種別は変更不可(同じ値を送るのは許可)
  assert.equal(parseTradeEdit({ ...base, code: "ZZZZ" }, target).ok, false);
  assert.equal(parseTradeEdit({ ...base, transactionType: "sell" }, target).ok, false);
  assert.match(parseTradeEdit({ ...base, transactionType: "sell" }, target).error, /変更できません/);
  assert.equal(parseTradeEdit({ ...base, code: "A001", transactionType: "buy" }, target).ok, true);

  // メモ: 省略=現在の値を維持 / null・空白=クリア / 文字列=前後の空白を除去 / 長すぎ・文字列以外は拒否
  assert.equal(parseTradeEdit(base, target).values.memo, "元のメモ");
  assert.equal(parseTradeEdit({ ...base, memo: null }, target).values.memo, null);
  assert.equal(parseTradeEdit({ ...base, memo: "   " }, target).values.memo, null);
  assert.equal(parseTradeEdit({ ...base, memo: "  約定価格に修正  " }, target).values.memo, "約定価格に修正");
  assert.equal(parseTradeEdit({ ...base, memo: "a".repeat(501) }, target).ok, false);
  assert.equal(parseTradeEdit({ ...base, memo: 123 }, target).ok, false);
});

test("編集の整合性: 存在しない取引は404、取消済みの取引は409", () => {
  const rows = [
    trade("A002", "buy", "2026-09-01", 100, 1000),
    trade("A002", "buy", "2026-09-02", 10, 1000, { canceled_at: "2026-09-03T00:00:00.000Z" }),
  ];
  const missing = validateEdit(rows, 999999, editValues(rows[0]));
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  const canceled = validateEdit(rows, rows[1].id, editValues(rows[1], { price: 1 }));
  assert.equal(canceled.ok, false);
  assert.equal(canceled.status, 409);
  assert.match(canceled.error, /取消済みの取引は編集できません/);
});

test("編集の整合性: BUYの数量を減らして後続のSELLが保有数量を超える場合は拒否（後続のSELLを先に修正する案内）", () => {
  const rows = [trade("A003", "buy", "2026-09-01", 100, 1000), trade("A003", "sell", "2026-09-05", 80, 1100)];
  const ng = validateEdit(rows, rows[0].id, editValues(rows[0], { quantity: 50 }));
  assert.equal(ng.ok, false);
  assert.equal(ng.status, 409);
  assert.match(ng.error, /先に後続のSELLを修正/);
  // 80株までなら可、価格だけの変更は常に可
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { quantity: 80 })).ok, true);
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { price: 1234.5 })).ok, true);
});

test("編集の整合性: BUYの取引日をSELLより後ろに動かして保有数量が足りなくなる場合は拒否", () => {
  const rows = [trade("A004", "buy", "2026-09-01", 100, 1000), trade("A004", "sell", "2026-09-05", 100, 1100)];
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { transactionDate: "2026-09-10" })).ok, false);
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { transactionDate: "2026-09-04" })).ok, true);
});

test("編集の整合性: SELLの数量が売却時点の保有数量を超える・取引日が買いより前になる場合は拒否", () => {
  const rows = [trade("A005", "buy", "2026-09-01", 100, 1000), trade("A005", "sell", "2026-09-05", 40, 1100)];
  const over = validateEdit(rows, rows[1].id, editValues(rows[1], { quantity: 101 }));
  assert.equal(over.ok, false);
  assert.match(over.error, /保有数量（100株）を超えて/);
  assert.equal(validateEdit(rows, rows[1].id, editValues(rows[1], { quantity: 100 })).ok, true);
  assert.equal(validateEdit(rows, rows[1].id, editValues(rows[1], { transactionDate: "2026-08-31" })).ok, false);
});

test("編集の整合性: SELLの数量を増やすと別のSELLが足りなくなる場合も拒否される", () => {
  const rows = [
    trade("A006", "buy", "2026-09-01", 100, 1000),
    trade("A006", "sell", "2026-09-03", 30, 1100),
    trade("A006", "sell", "2026-09-05", 60, 1100),
  ];
  const ng = validateEdit(rows, rows[1].id, editValues(rows[1], { quantity: 50 })); // 50 + 60 > 100
  assert.equal(ng.ok, false);
  assert.match(ng.error, /別のSELL/);
  assert.equal(validateEdit(rows, rows[1].id, editValues(rows[1], { quantity: 40 })).ok, true); // 40 + 60 = 100
});

test("取消済みの取引は、編集の整合性チェックの対象にも含まれない", () => {
  const rows = [
    trade("A007", "buy", "2026-09-01", 100, 1000),
    trade("A007", "sell", "2026-09-05", 100, 1100, { canceled_at: "2026-09-06T00:00:00.000Z" }),
  ];
  // 取消済みのSELLは無いものとして扱うので、BUYの数量を減らしても拒否されない
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { quantity: 10 })).ok, true);
  assert.equal(findHoldingShortfall([]), null);
});

test("BUY価格の編集: 平均取得価格・含み損益・実現損益・勝敗・通算成績が編集後の履歴から再計算される", () => {
  const rows = [trade("B001", "buy", "2026-09-01", 100, 1000), trade("B001", "sell", "2026-09-05", 40, 1250)];
  const prices = new Map([["B001", 1300]]);
  let history = buildTradeHistory(rows, prices);
  assert.equal(history.find((h) => h.transactionType === "sell").pnl, 10000);

  const edited = applyEdit(rows, rows[0].id, editValues(rows[0], { price: 1100 })); // 予定価格1000 → 約定価格1100
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { price: 1100 })).ok, true);

  const [holding] = buildHoldings(edited, prices, new Map(), new Map());
  assert.equal(holding.quantity, 60);
  assert.equal(holding.avgCost, 1100);
  assert.equal(holding.unrealizedPnl, (1300 - 1100) * 60);

  history = buildTradeHistory(edited, prices);
  const sell = history.find((h) => h.transactionType === "sell");
  assert.equal(sell.avgCostAtSale, 1100);
  assert.equal(sell.pnl, 6000);
  assert.ok(Math.abs(sell.pnlPct - (6000 / 44000) * 100) < 1e-9);
  assert.equal(sell.win, true);
  const buy = history.find((h) => h.transactionType === "buy");
  assert.equal(buy.price, 1100);
  assert.equal(buy.amount, 110000);

  const { summary, series } = buildPerformance(edited);
  assert.equal(summary.totalRealizedPnl, 6000);
  assert.ok(Math.abs(summary.totalReturnPct - (6000 / 44000) * 100) < 1e-9);
  assert.equal(summary.maxProfit, 6000);
  assert.deepEqual(series.map((x) => x.cumulativePnl), [6000]);
});

test("SELL価格の編集: 実現損益・リターン率・勝敗が反転し、通算成績・累計損益チャートも更新される", () => {
  const rows = [
    trade("B002", "buy", "2026-09-01", 100, 1000),
    trade("B002", "sell", "2026-09-03", 50, 1200), // +10,000(勝ち)
    trade("B002", "sell", "2026-09-05", 50, 1100), // +5,000(勝ち)
  ];
  let perf = buildPerformance(rows);
  assert.equal(perf.summary.winCount, 2);
  assert.equal(perf.summary.totalRealizedPnl, 15000);

  const edited = applyEdit(rows, rows[1].id, editValues(rows[1], { price: 900 })); // 約定価格が900円だった → 負け
  const history = buildTradeHistory(edited, new Map());
  const sell = history.find((h) => h.id === rows[1].id);
  assert.equal(sell.pnl, -5000);
  assert.ok(Math.abs(sell.pnlPct - -10) < 1e-9);
  assert.equal(sell.win, false);
  assert.equal(sell.outcome, "lose");

  perf = buildPerformance(edited);
  assert.equal(perf.summary.winCount, 1);
  assert.equal(perf.summary.loseCount, 1);
  assert.equal(perf.summary.winRate, 50);
  assert.equal(perf.summary.totalRealizedPnl, 0);
  assert.equal(perf.summary.avgProfit, 5000);
  assert.equal(perf.summary.avgLoss, -5000);
  assert.equal(perf.summary.maxProfit, 5000);
  assert.equal(perf.summary.maxLoss, -5000);
  assert.equal(perf.summary.totalReturnPct, 0);
  assert.deepEqual(perf.series.map((x) => x.cumulativePnl), [-5000, 0]);
});

test("BUY数量の編集: 保有数量・平均取得価格が再計算される(売却に影響しない範囲)", () => {
  const rows = [trade("B003", "buy", "2026-09-01", 100, 1000), trade("B003", "sell", "2026-09-05", 40, 1250)];
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { quantity: 60 })).ok, true);
  const edited = applyEdit(rows, rows[0].id, editValues(rows[0], { quantity: 60 }));
  const [h] = buildHoldings(edited, new Map(), new Map(), new Map());
  assert.equal(h.quantity, 20);
  assert.equal(h.avgCost, 1000);
  assert.equal(buildPerformance(edited).summary.totalRealizedPnl, 10000);
  // 30株への変更は、後続のSELL(40株)が足りなくなるので拒否
  assert.equal(validateEdit(rows, rows[0].id, editValues(rows[0], { quantity: 30 })).ok, false);
});

test("SELL数量の編集: 保有数量・実現損益・取得原価が再計算される", () => {
  const rows = [trade("B004", "buy", "2026-09-01", 100, 1000), trade("B004", "sell", "2026-09-05", 40, 1250)];
  const edited = applyEdit(rows, rows[1].id, editValues(rows[1], { quantity: 60 }));
  const [h] = buildHoldings(edited, new Map(), new Map(), new Map());
  assert.equal(h.quantity, 40);
  const perf = buildPerformance(edited);
  assert.equal(perf.summary.totalRealizedPnl, 15000);
  assert.equal(perf.summary.totalCostBasis, 60000);
  assert.ok(Math.abs(perf.summary.totalReturnPct - 25) < 1e-9);
});

test("取引日の編集: 約定順が変わると、売却時の平均取得価格(移動平均法)・損益が変わる", () => {
  const rows = [
    trade("B005", "buy", "2026-09-01", 100, 1000),
    trade("B005", "buy", "2026-09-02", 100, 2000),
    trade("B005", "sell", "2026-09-03", 50, 1200),
  ];
  let perf = buildPerformance(rows);
  assert.equal(perf.series[0].avgCostAtSale, 1500);
  assert.equal(perf.summary.totalRealizedPnl, -15000);

  // 2回目のBUYの約定日が実際は売却より後だった
  const values = editValues(rows[1], { transactionDate: "2026-09-04" });
  assert.equal(validateEdit(rows, rows[1].id, values).ok, true);
  const edited = applyEdit(rows, rows[1].id, values);
  perf = buildPerformance(edited);
  assert.equal(perf.series[0].avgCostAtSale, 1000);
  assert.equal(perf.summary.totalRealizedPnl, 10000);
  const [h] = buildHoldings(edited, new Map(), new Map(), new Map());
  assert.equal(h.quantity, 150);
  assert.ok(Math.abs(h.avgCost - 250000 / 150) < 1e-9);
});

test("メモの編集は、数量・損益・通算成績に影響しない / 取消済みの取引は編集後も計算に混ざらない", () => {
  const rows = [
    trade("B006", "buy", "2026-09-01", 100, 1000),
    trade("B006", "sell", "2026-09-05", 100, 1100),
    trade("B006", "sell", "2026-09-06", 10, 5000, { canceled_at: "2026-09-07T00:00:00.000Z" }),
  ];
  const before = buildPerformance(rows);
  const edited = applyEdit(rows, rows[0].id, editValues(rows[0], { memo: "約定価格に修正" }));
  assert.equal(edited[0].memo, "約定価格に修正");
  assert.deepEqual(buildPerformance(edited), before);
  assert.equal(before.summary.sellCount, 1);
  assert.equal(before.summary.totalRealizedPnl, 10000);
  assert.deepEqual(listHoldingCodes(edited), []);
});
