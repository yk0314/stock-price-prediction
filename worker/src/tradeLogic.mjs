// 売買(trades)まわりの純粋関数。DBやKVに依存しないため、worker/src/index.js から利用しつつ
// 単体テスト(test/trade-logic.test.js)もできるように分離している。
//
// 計算方式は従来どおり移動平均法:
//   買うたびに平均取得価格を再計算し、売っても平均取得価格自体は変えず数量だけ減らす。
// 取消(論理取消)された取引は canceled_at が入っており、通常の計算からは常に除外する。

export function isActiveTrade(row) {
  return !row.canceled_at;
}

function compareTradesAsc(a, b) {
  if (a.transaction_date !== b.transaction_date) {
    return a.transaction_date < b.transaction_date ? -1 : 1;
  }
  return a.id - b.id;
}

export function mapTradeRow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.stock_name ?? null,
    transactionType: row.transaction_type, // "buy" | "sell"
    transactionDate: row.transaction_date,
    quantity: row.quantity,
    price: row.price,
    amount: row.amount,
    memo: row.memo ?? null,
    purchaseEvaluationId: row.purchase_evaluation_id ?? null,
    createdAt: row.created_at,
    canceled: Boolean(row.canceled_at),
    canceledAt: row.canceled_at ?? null,
  };
}

/**
 * 全trades(どの銘柄のものも混在可)を銘柄ごとにグルーピングし、時系列昇順にソートする。
 * transaction_dateが同じ場合はid(登録順)で安定ソートする。
 */
export function groupTradesByCode(trades) {
  const byCode = new Map();
  for (const t of trades) {
    if (!byCode.has(t.code)) byCode.set(t.code, []);
    byCode.get(t.code).push(t);
  }
  for (const list of byCode.values()) {
    list.sort(compareTradesAsc);
  }
  return byCode;
}

/**
 * ある銘柄のtrades配列(時系列昇順・取消済みは含めないこと)を移動平均法で順に処理し、
 * 最終的な保有数量・平均取得価格と、各SELLの実現損益を返す。
 */
export function computePositionFromTrades(tradesForCodeAsc) {
  let quantity = 0;
  let avgCost = 0;
  const sellResults = [];

  for (const t of tradesForCodeAsc) {
    if (t.transaction_type === "buy") {
      const totalCost = avgCost * quantity + t.price * t.quantity;
      quantity += t.quantity;
      avgCost = quantity > 0 ? totalCost / quantity : 0;
    } else if (t.transaction_type === "sell") {
      const avgCostAtSale = avgCost;
      const realizedPnl = (t.price - avgCostAtSale) * t.quantity;
      const realizedPnlPct = avgCostAtSale > 0 ? (realizedPnl / (avgCostAtSale * t.quantity)) * 100 : null;
      sellResults.push({ tradeId: t.id, realizedPnl, realizedPnlPct, avgCostAtSale });
      quantity -= t.quantity;
      // 移動平均法: 売却時に平均取得価格自体は変更しない
    }
  }

  return { quantity, avgCost, sellResults };
}

/**
 * 取引の取消が可能かを検証する。
 * @param {Array} tradesForCode 対象銘柄のtrades行(取消済みを含んでよい)
 * @param {number} targetId 取り消したい取引のid
 * @returns {{ok:true, target:object} | {ok:false, status:number, error:string}}
 *
 * - すでに取消済みの取引は取り消せない(409)。
 * - SELLの取消は常に可能(保有数量が戻るだけ)。
 * - BUYの取消は、そのBUYを除いた状態で時系列に数量を追ったとき、
 *   途中で保有数量がマイナスになる(=後続のSELLの数量が足りなくなる)場合は拒否する。
 */
export function validateCancel(tradesForCode, targetId) {
  const target = tradesForCode.find((t) => t.id === targetId);
  if (!target) {
    return { ok: false, status: 404, error: "取消対象の取引が見つかりません。" };
  }
  if (target.canceled_at) {
    return { ok: false, status: 409, error: "この取引はすでに取り消されています。" };
  }
  if (target.transaction_type === "sell") {
    return { ok: true, target };
  }

  const active = tradesForCode.filter(isActiveTrade).sort(compareTradesAsc);
  let quantity = 0;
  for (const t of active) {
    if (t.id === targetId) continue;
    quantity += t.transaction_type === "buy" ? t.quantity : -t.quantity;
    if (quantity < 0) {
      return {
        ok: false,
        status: 409,
        error:
          "このBUYを取り消すと、後続のSELLの数量が保有数量を超えてしまいます。先に該当するSELLを取り消してください。",
      };
    }
  }
  return { ok: true, target };
}

/**
 * GET /api/trades のレスポンスを組み立てる。
 * BUY行には「このロットを今も持っていたら」の含み損益(現在価格との差、1ロット単位)を、
 * SELL行には移動平均法で計算した実現損益・勝敗・売却時平均取得価格を付与する。
 * 取消済みの取引は includeCanceled=true のときだけ、損益なし・canceled=true で含める。
 */
export function buildTradeHistory(allTradeRows, currentPriceByCode, { includeCanceled = false } = {}) {
  const active = allTradeRows.filter(isActiveTrade);
  const byCode = groupTradesByCode(active);
  const resultsByTradeId = new Map();

  for (const [code, tradesAsc] of byCode.entries()) {
    const { sellResults } = computePositionFromTrades(tradesAsc);
    const sellResultByTradeId = new Map(sellResults.map((r) => [r.tradeId, r]));
    const currentPrice = currentPriceByCode.get(code) ?? null;

    for (const t of tradesAsc) {
      const base = mapTradeRow(t);
      if (t.transaction_type === "buy") {
        const pnl = currentPrice !== null ? (currentPrice - t.price) * t.quantity : null;
        const pnlPct = currentPrice !== null && t.price > 0 ? ((currentPrice - t.price) / t.price) * 100 : null;
        resultsByTradeId.set(t.id, {
          ...base,
          pnl,
          pnlPct,
          pnlType: "unrealized", // このロットを今も保有していたと仮定した含み損益(実際の保有数とは独立)
          win: null,
          outcome: null,
          avgCostAtSale: null,
          costBasis: null,
        });
      } else {
        const sellResult = sellResultByTradeId.get(t.id);
        const pnl = sellResult?.realizedPnl ?? null;
        resultsByTradeId.set(t.id, {
          ...base,
          pnl,
          pnlPct: sellResult?.realizedPnlPct ?? null,
          pnlType: "realized",
          win: sellResult ? sellResult.realizedPnl > 0 : null,
          outcome: pnl === null ? null : pnl > 0 ? "win" : pnl < 0 ? "lose" : "even",
          avgCostAtSale: sellResult?.avgCostAtSale ?? null,
          costBasis: sellResult ? sellResult.avgCostAtSale * t.quantity : null,
        });
      }
    }
  }

  const rows = [];
  for (const t of allTradeRows) {
    if (isActiveTrade(t)) {
      const r = resultsByTradeId.get(t.id);
      if (r) rows.push(r);
    } else if (includeCanceled) {
      rows.push({
        ...mapTradeRow(t),
        pnl: null,
        pnlPct: null,
        pnlType: "canceled",
        win: null,
        outcome: null,
        avgCostAtSale: null,
        costBasis: null,
      });
    }
  }

  // 新しい取引から見たいことが多いので transaction_date 降順で返す
  return rows.sort((a, b) => {
    if (a.transactionDate !== b.transactionDate) return a.transactionDate < b.transactionDate ? 1 : -1;
    return b.id - a.id;
  });
}

/**
 * 現在保有中(数量>0)の銘柄コード一覧(取消済みは除外して計算)。
 */
export function listHoldingCodes(allTradeRows) {
  const byCode = groupTradesByCode(allTradeRows.filter(isActiveTrade));
  const codes = [];
  for (const [code, tradesAsc] of byCode.entries()) {
    if (computePositionFromTrades(tradesAsc).quantity > 0) codes.push(code);
  }
  return codes;
}

/**
 * 保有中の各銘柄について、購入時AI評価として参照するai_evaluations.idの一覧を返す。
 * 銘柄ごとに「purchase_evaluation_idが入っている最新の(取消されていない)BUY」の値を使う。
 */
export function purchaseEvaluationIdByCode(allTradeRows) {
  const byCode = groupTradesByCode(allTradeRows.filter(isActiveTrade));
  const result = new Map();
  for (const [code, tradesAsc] of byCode.entries()) {
    if (computePositionFromTrades(tradesAsc).quantity <= 0) continue;
    let id = null;
    let lastBuyDate = null;
    for (const t of tradesAsc) {
      if (t.transaction_type !== "buy") continue;
      lastBuyDate = t.transaction_date;
      if (t.purchase_evaluation_id) id = t.purchase_evaluation_id;
    }
    result.set(code, { purchaseEvaluationId: id, lastBuyDate });
  }
  return result;
}

/**
 * GET /api/holdings のレスポンスを組み立てる。保有数量が0より大きい銘柄のみ返す。
 * @param evaluationsByCode Map<code, {latest, previous}>  latest=最新のAI評価, previous=その1つ前
 * @param purchaseEvaluationById Map<id, evaluation>       購入時AI評価(purchase_evaluation_idで引く)
 * @param priceAsOfByCode Map<code, string>                 currentPriceのデータ基準日(KVのstocks.dataAsOf)
 */
export function buildHoldings(
  allTradeRows,
  currentPriceByCode,
  nameByCode,
  evaluationsByCode,
  purchaseEvaluationById = new Map(),
  priceAsOfByCode = new Map()
) {
  const active = allTradeRows.filter(isActiveTrade);
  const byCode = groupTradesByCode(active);
  const purchaseInfoByCode = purchaseEvaluationIdByCode(allTradeRows);
  const holdings = [];

  for (const [code, tradesAsc] of byCode.entries()) {
    const { quantity, avgCost } = computePositionFromTrades(tradesAsc);
    if (quantity <= 0) continue;

    const currentPrice = currentPriceByCode.get(code) ?? null;
    const unrealizedPnl = currentPrice !== null ? (currentPrice - avgCost) * quantity : null;
    const unrealizedPnlPct = currentPrice !== null && avgCost > 0 ? ((currentPrice - avgCost) / avgCost) * 100 : null;
    const evaluations = evaluationsByCode.get(code) ?? { latest: null, previous: null };
    const purchaseInfo = purchaseInfoByCode.get(code) ?? { purchaseEvaluationId: null, lastBuyDate: null };

    holdings.push({
      code,
      name: nameByCode.get(code) ?? null,
      quantity,
      avgCost,
      currentPrice,
      priceAsOf: priceAsOfByCode.get(code) ?? null, // currentPriceのデータ基準日
      unrealizedPnl,
      unrealizedPnlPct,
      latestEvaluation: evaluations.latest ?? null,
      previousEvaluation: evaluations.previous ?? null,
      purchaseEvaluation: purchaseInfo.purchaseEvaluationId
        ? purchaseEvaluationById.get(purchaseInfo.purchaseEvaluationId) ?? null
        : null,
      lastBuyDate: purchaseInfo.lastBuyDate,
    });
  }

  return holdings.sort((a, b) => (b.unrealizedPnl ?? -Infinity) - (a.unrealizedPnl ?? -Infinity));
}

/**
 * 通算成績(確定したSELLのみが対象。含み損益は含めない。取消済みは除外)。
 *
 * 累計リターン = 確定損益の合計 ÷ 売却分の取得原価の合計
 *   各SELLの取得原価 = 売却時平均取得価格 × 売却数量
 * 勝率 = 勝ち(損益>0)の件数 ÷ 確定したSELLの件数
 * 平均損失・最大損失は負の値(損失額)で返す。該当する取引が無い指標は null。
 *
 * @returns {{summary: object, series: Array}}
 *   series: SELL確定順(transaction_date, id)の累計確定損益の推移
 */
export function buildPerformance(allTradeRows) {
  const active = allTradeRows.filter(isActiveTrade);
  const byCode = groupTradesByCode(active);
  const sells = [];

  for (const [code, tradesAsc] of byCode.entries()) {
    const { sellResults } = computePositionFromTrades(tradesAsc);
    const tradeById = new Map(tradesAsc.map((t) => [t.id, t]));
    for (const r of sellResults) {
      const t = tradeById.get(r.tradeId);
      sells.push({
        tradeId: r.tradeId,
        code,
        name: t.stock_name ?? null,
        date: t.transaction_date,
        quantity: t.quantity,
        sellPrice: t.price,
        avgCostAtSale: r.avgCostAtSale,
        costBasis: r.avgCostAtSale * t.quantity,
        pnl: r.realizedPnl,
        pnlPct: r.realizedPnlPct,
      });
    }
  }

  sells.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.tradeId - b.tradeId;
  });

  let cumulativePnl = 0;
  let cumulativeCost = 0;
  const series = sells.map((s) => {
    cumulativePnl += s.pnl;
    cumulativeCost += s.costBasis;
    return {
      ...s,
      cumulativePnl,
      cumulativeReturnPct: cumulativeCost > 0 ? (cumulativePnl / cumulativeCost) * 100 : null,
    };
  });

  const wins = sells.filter((s) => s.pnl > 0);
  const losses = sells.filter((s) => s.pnl < 0);
  const evens = sells.filter((s) => s.pnl === 0);
  const sum = (list, pick) => list.reduce((acc, item) => acc + pick(item), 0);
  const hasSells = sells.length > 0;
  const totalCostBasis = sum(sells, (s) => s.costBasis);
  const totalRealizedPnl = sum(sells, (s) => s.pnl);

  const summary = {
    totalTrades: active.length, // 取消されていないBUY+SELLの合計件数
    buyCount: active.filter((t) => t.transaction_type === "buy").length,
    sellCount: sells.length, // 確定した売却取引の件数
    winCount: wins.length,
    loseCount: losses.length,
    evenCount: evens.length,
    winRate: hasSells ? (wins.length / sells.length) * 100 : null,
    totalRealizedPnl: hasSells ? totalRealizedPnl : null,
    totalCostBasis: hasSells ? totalCostBasis : null,
    totalReturnPct: hasSells && totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : null,
    avgProfit: wins.length > 0 ? sum(wins, (s) => s.pnl) / wins.length : null,
    avgLoss: losses.length > 0 ? sum(losses, (s) => s.pnl) / losses.length : null,
    maxProfit: wins.length > 0 ? Math.max(...wins.map((s) => s.pnl)) : null,
    maxLoss: losses.length > 0 ? Math.min(...losses.map((s) => s.pnl)) : null,
  };

  return { summary, series };
}
