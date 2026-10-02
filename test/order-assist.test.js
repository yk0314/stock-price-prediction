import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// OrderAssist(計算の純粋関数)は public/app.js の「ORDER-ASSIST:BEGIN 〜 ORDER-ASSIST:END」の間にある。
// 画面(ブラウザ)で実際に動くコードそのものを取り出してテストする(別ファイルのコピーはテストしない)。
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = appSource.indexOf("/* ORDER-ASSIST:BEGIN");
const end = appSource.indexOf("/* ORDER-ASSIST:END */");
assert.ok(begin >= 0 && end > begin, "app.js に ORDER-ASSIST のブロックがありません");
const OrderAssist = vm.runInNewContext(`${appSource.slice(begin, end)}\n;OrderAssist`);
const { calcBuyPlan, calcSellPlan, buildOrderRows, buildOrderText } = OrderAssist;

// ---- BUY ----

test("BUY: 50,000円 ÷ 1,250円 = 40株、実際の投資額50,000円、余り0円", () => {
  const plan = calcBuyPlan(50000, 1250);
  assert.equal(plan.ok, true);
  assert.equal(plan.shares, 40);
  assert.equal(plan.actualAmount, 50000);
  assert.equal(plan.remainder, 0);
});

test("BUY: 依頼文の例（1,087.5円・50,000円）は45株・48,937.5円・余り1,062.5円", () => {
  const plan = calcBuyPlan(50000, 1087.5);
  assert.equal(plan.shares, 45);
  assert.equal(plan.actualAmount, 48937.5);
  assert.equal(plan.remainder, 1062.5);
});

test("BUY: 端数は切り捨て（小数株にならない）で、実際の投資額は投資予定金額を超えない", () => {
  for (const [budget, price] of [
    [50000, 333],
    [50000, 1087.5],
    [12345, 97.3],
    [99999, 0.7 * 100],
    [1000, 0.1],
    [30000, 1234.5],
    [50000, 7.77],
  ]) {
    const plan = calcBuyPlan(budget, price);
    assert.equal(plan.ok, true);
    assert.ok(Number.isInteger(plan.shares), `${budget}/${price}: 整数株`);
    assert.ok(plan.actualAmount <= budget + 1e-9, `${budget}/${price}: 投資額が予算以内`);
    assert.ok((plan.shares + 1) * price > budget - 1e-9, `${budget}/${price}: もう1株買うと予算超過（切り捨ての最大値）`);
    assert.ok(Math.abs(plan.remainder - (budget - plan.actualAmount)) < 0.01, `${budget}/${price}: 余り`);
    assert.ok(plan.remainder >= -1e-9);
  }
});

test("BUY: 浮動小数点の誤差で1株少なくならない（0.1円×10株 = 1円）", () => {
  const plan = calcBuyPlan(1, 0.1);
  assert.equal(plan.shares, 10);
});

test("BUY: 株価が0・null・undefined・NaN・負数のときは計算せず、取得できない旨のメッセージ", () => {
  for (const price of [0, null, undefined, NaN, -5, "abc"]) {
    const plan = calcBuyPlan(50000, price);
    assert.equal(plan.ok, false, String(price));
    assert.equal(plan.code, "no-price");
    assert.match(plan.message, /現在株価を取得できないため、発注補助を利用できません/);
  }
});

test("BUY: 投資予定金額が0以下・NaNはエラー", () => {
  for (const budget of [0, -1, NaN, null, undefined]) {
    const plan = calcBuyPlan(budget, 1000);
    assert.equal(plan.ok, false, String(budget));
    assert.equal(plan.code, "bad-budget");
  }
});

test("BUY: 株価が投資予定金額より高い場合は購入可能株数0で、「1株購入できません」を返す", () => {
  const plan = calcBuyPlan(500, 1250);
  assert.equal(plan.ok, true);
  assert.equal(plan.shares, 0);
  assert.equal(plan.actualAmount, 0);
  assert.equal(plan.remainder, 500);
  assert.match(plan.message, /この金額では1株購入できません/);
});

// ---- SELL ----

test("SELL: 依頼文の例（保有45株・平均取得単価1,000円・売却価格1,100円・20株）", () => {
  const plan = calcSellPlan({ quantity: 20, price: 1100, holdingQuantity: 45, avgCost: 1000 });
  assert.equal(plan.ok, true);
  assert.equal(plan.proceeds, 22000);
  assert.equal(plan.costBasis, 20000);
  assert.equal(plan.pnl, 2000);
  assert.ok(Math.abs(plan.returnPct - 10) < 1e-9);
  assert.equal(plan.remaining, 25);
  assert.equal(plan.isFullSale, false);
});

test("SELL: 全株売却（1株〜保有株数の上限）", () => {
  const plan = calcSellPlan({ quantity: 45, price: 900, holdingQuantity: 45, avgCost: 1000 });
  assert.equal(plan.ok, true);
  assert.equal(plan.isFullSale, true);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.pnl, -4500);
  assert.ok(Math.abs(plan.returnPct - -10) < 1e-9);
  assert.equal(calcSellPlan({ quantity: 1, price: 900, holdingQuantity: 45, avgCost: 1000 }).ok, true);
});

test("SELL: 平均取得単価が使われる（取得原価 = 平均取得単価 × 売却株数）", () => {
  const plan = calcSellPlan({ quantity: 7, price: 1500, holdingQuantity: 10, avgCost: 1133.3333 });
  assert.equal(plan.costBasis, Math.round(1133.3333 * 7 * 100) / 100);
  assert.equal(plan.pnl, Math.round((7 * 1500 - 1133.3333 * 7) * 100) / 100);
});

test("SELL: 0株・負数・小数・NaNは拒否", () => {
  for (const quantity of [0, -3, 2.5, NaN, undefined]) {
    const plan = calcSellPlan({ quantity, price: 1000, holdingQuantity: 45, avgCost: 1000 });
    assert.equal(plan.ok, false, String(quantity));
    assert.equal(plan.code, "bad-quantity");
  }
});

test("SELL: 保有株数を超える数量は拒否（保有株数がメッセージに入る）", () => {
  const plan = calcSellPlan({ quantity: 46, price: 1000, holdingQuantity: 45, avgCost: 1000 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "over-holding");
  assert.match(plan.message, /45株/);
});

test("SELL: 保有株数が0なら補助を使えない / 売却価格が未入力・0以下は拒否", () => {
  assert.equal(calcSellPlan({ quantity: 1, price: 1000, holdingQuantity: 0, avgCost: 1000 }).code, "no-holding");
  for (const price of [0, -1, NaN, undefined]) {
    assert.equal(calcSellPlan({ quantity: 1, price, holdingQuantity: 5, avgCost: 1000 }).code, "no-price");
  }
});

// ---- 注文内容(表示・コピー) ----

test("注文内容: 銘柄コード・銘柄名・注文・数量・注文方法(S株)・価格(成行)の順で、コピー用テキストになる", () => {
  const text = buildOrderText({ code: "8136", name: "サンリオ", side: "buy", quantity: 45 });
  assert.equal(text, ["銘柄コード：8136", "銘柄名：サンリオ", "注文：買い", "数量：45株", "注文方法：S株", "価格：成行"].join("\n"));
  assert.equal(buildOrderRows({ code: "8136", name: "サンリオ", side: "sell", quantity: 1200 })[2][1], "売り");
  assert.equal(buildOrderRows({ code: "8136", name: "サンリオ", side: "sell", quantity: 1200 })[3][1], "1,200株");
});

test("注文内容: 銘柄名が無いときは「—」", () => {
  assert.equal(buildOrderRows({ code: "1234", name: null, side: "buy", quantity: 1 })[1][1], "—");
});
