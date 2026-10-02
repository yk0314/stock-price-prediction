// SBI証券で「手動発注」するときの補助計算(純粋関数)。
// このアプリはSBI証券へログイン・注文送信・API接続を一切行わない。ここにあるのは、
// 「何株買うか」「売ったらいくらになるか」を計算し、注文内容を表示用に整形する関数だけである。
//
// <script src="orderAssist.js"> で読み込むと globalThis.OrderAssist として使える
// (ES Moduleではなく通常スクリプトとして読み込むため export は使わない)。
// Nodeのテストからは `await import("../public/orderAssist.js")` の後に globalThis.OrderAssist を参照する。
(function (root) {
  "use strict";

  // 注文内容の表示用ラベル。実際の注文方法・価格の選択はSBI証券の画面でユーザー自身が行う。
  const ORDER_METHOD = "S株";
  const ORDER_PRICE_LABEL = "成行";

  const MESSAGES = {
    noPrice: "現在株価を取得できないため、発注補助を利用できません。",
    badBudget: "投資予定金額は1円以上の数値で入力してください。",
    cannotBuyOne: "この金額では1株購入できません。",
    noHolding: "保有株数が0のため、売却補助を利用できません。",
    badQuantity: "売却株数は1株以上の整数で入力してください。",
    noSellPrice: "売却価格を入力してください。",
  };

  function isPositiveNumber(v) {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  }

  // 浮動小数点の誤差(例: 0.1+0.2)が表示に出ないよう、金額は小数2桁で丸める。
  function roundMoney(v) {
    return Math.round(v * 100) / 100;
  }

  /**
   * BUYの発注補助。購入株数 = floor(投資予定金額 / 株価)、実際の投資額 = 購入株数 × 株価。
   * 端数は切り捨て(S株は1株単位のため整数株)。実際の投資額は投資予定金額を超えない。
   * @returns {{ok:false, code:string, message:string}
   *         | {ok:true, shares:number, actualAmount:number, remainder:number, budget:number, price:number, message:string|null}}
   */
  function calcBuyPlan(budget, price) {
    if (!isPositiveNumber(price)) return { ok: false, code: "no-price", message: MESSAGES.noPrice };
    if (!isPositiveNumber(budget)) return { ok: false, code: "bad-budget", message: MESSAGES.badBudget };

    let shares = Math.floor(budget / price + 1e-9);
    // 浮動小数点の誤差で投資予定金額を超えてしまった場合は1株ずつ減らす
    while (shares > 0 && shares * price > budget + 1e-9) shares -= 1;

    const actualAmount = roundMoney(shares * price);
    const remainder = roundMoney(budget - actualAmount);
    return {
      ok: true,
      shares,
      actualAmount,
      remainder,
      budget,
      price,
      message: shares >= 1 ? null : MESSAGES.cannotBuyOne,
    };
  }

  /**
   * SELLの発注補助(想定損益)。平均取得単価を使って計算する。
   * 実際の損益(realized P&L)は、SELL登録時にWorker側で同じ平均取得単価から計算される。
   * @returns {{ok:false, code:string, message:string}
   *         | {ok:true, quantity:number, price:number, proceeds:number, costBasis:number,
   *            pnl:number, returnPct:number|null, remaining:number, isFullSale:boolean}}
   */
  function calcSellPlan({ quantity, price, holdingQuantity, avgCost }) {
    if (!isPositiveNumber(holdingQuantity)) return { ok: false, code: "no-holding", message: MESSAGES.noHolding };
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, code: "bad-quantity", message: MESSAGES.badQuantity };
    }
    if (quantity > holdingQuantity) {
      return {
        ok: false,
        code: "over-holding",
        message: `売却株数が保有株数（${holdingQuantity.toLocaleString()}株）を超えています。`,
      };
    }
    if (!isPositiveNumber(price)) return { ok: false, code: "no-price", message: MESSAGES.noSellPrice };

    const cost = Number.isFinite(avgCost) && avgCost >= 0 ? avgCost : 0;
    const proceeds = roundMoney(quantity * price);
    const costBasis = roundMoney(cost * quantity);
    const pnl = roundMoney(proceeds - costBasis);
    const remaining = holdingQuantity - quantity;
    return {
      ok: true,
      quantity,
      price,
      proceeds,
      costBasis,
      pnl,
      returnPct: costBasis > 0 ? (pnl / costBasis) * 100 : null,
      remaining,
      isFullSale: remaining === 0,
    };
  }

  /**
   * 「SBI証券で注文する場合」に表示する注文内容(ラベルと値の組)。画面表示とコピー用テキストの両方の元になる。
   * side: "buy" | "sell"
   */
  function buildOrderRows({ code, name, side, quantity, orderMethod = ORDER_METHOD, priceLabel = ORDER_PRICE_LABEL }) {
    return [
      ["銘柄コード", String(code)],
      ["銘柄名", name ? String(name) : "—"],
      ["注文", side === "buy" ? "買い" : "売り"],
      ["数量", `${Number(quantity).toLocaleString()}株`],
      ["注文方法", orderMethod],
      ["価格", priceLabel],
    ];
  }

  /** コピー用の注文情報(テキスト)。クリップボードにコピーしても、注文は一切実行されない。 */
  function buildOrderText(order) {
    return buildOrderRows(order)
      .map(([label, value]) => `${label}：${value}`)
      .join("\n");
  }

  root.OrderAssist = Object.freeze({
    ORDER_METHOD,
    ORDER_PRICE_LABEL,
    calcBuyPlan,
    calcSellPlan,
    buildOrderRows,
    buildOrderText,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
