// D1への書き込みロジックをまとめるモジュール。
// pipeline.js等の上位層は、SQLを直接書かずこの層の関数だけを呼ぶようにする。

/**
 * 銘柄コードごとの株価履歴(Map<code, rows>)をstock_pricesテーブルへ一括保存する。
 * PRIMARY KEY (code, date) のため、同じ日付を再実行しても安全に上書きされる。
 */
export async function saveStockPricesToD1(d1, pricesByCode, dataSource = "jquants") {
  const fetchedAt = new Date().toISOString();
  const columns = [
    "code", "date", "open", "high", "low", "close", "volume", "data_source", "fetched_at",
  ];
  const rows = [];

  for (const [code, series] of pricesByCode.entries()) {
    for (const row of series) {
      rows.push([
        code,
        row.date,
        // open は現状の正規化データに含まれていないためnull
        // （必要になれば normalize.js 側で AdjO を拾うよう拡張する）
        null,
        row.high ?? null,
        row.low ?? null,
        row.close,
        row.volume ?? null,
        dataSource,
        fetchedAt,
      ]);
    }
  }

  // ▼▼▼ 一時デバッグ（原因特定用。確認後に削除すること） ▼▼▼
  const keyCount = new Map();
  for (const [code, date] of rows.map((r) => [r[0], r[1]])) {
    const key = `${code}|${date}`;
    keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
  }
  const uniqueKeyCount = keyCount.size;
  const duplicateEntries = [...keyCount.entries()].filter(([, count]) => count > 1);
  const duplicateRowCount = duplicateEntries.reduce((sum, [, count]) => sum + (count - 1), 0);
  console.log(
    `[DEBUG-D1Repo] saveStockPricesToD1: 総行数=${rows.length}, (code,date)ユニーク数=${uniqueKeyCount}, 重複行数=${duplicateRowCount}`
  );
  if (duplicateEntries.length > 0) {
    console.log(
      `[DEBUG-D1Repo] 重複の具体例(先頭5件):`,
      duplicateEntries.slice(0, 5).map(([key, count]) => `${key} x${count}`)
    );
  }
  // ▲▲▲ 一時デバッグここまで ▲▲▲

  return d1.batchInsertOrReplace("stock_prices", columns, rows);
}

/**
 * 銘柄コードごとの財務情報をfinancialsテーブルへ保存する。
 * @param {Map<string, object>} financialsByCode - normalizeFinancialRow()相当のオブジェクト
 */
export async function saveFinancialsToD1(d1, financialsByCode) {
  const fetchedAt = new Date().toISOString();
  const columns = [
    "code", "disc_date", "disc_time", "net_sales", "operating_profit",
    "ordinary_profit", "profit", "eps", "bps", "equity_to_asset_ratio", "fetched_at",
  ];
  const rows = [];

  for (const [code, fin] of financialsByCode.entries()) {
    if (!fin) continue;
    rows.push([
      code,
      fin.discDate,
      fin.discTime ?? null,
      fin.netSales ?? null,
      fin.operatingProfit ?? null,
      fin.ordinaryProfit ?? null,
      fin.profit ?? null,
      fin.eps ?? null,
      fin.bps ?? null,
      fin.equityToAssetRatio ?? null,
      fetchedAt,
    ]);
  }

  return d1.batchInsertOrReplace("financials", columns, rows);
}

/**
 * 銘柄マスタ(stocks)を更新する。
 * @param {Array<{code, name?, market?}>} stocks
 */
export async function saveStocksToD1(d1, stocks) {
  const updatedAt = new Date().toISOString();
  const columns = ["code", "name", "market", "updated_at"];
  const rows = stocks.map((s) => [s.code, s.name ?? null, s.market ?? null, updatedAt]);
  return d1.batchInsertOrReplace("stocks", columns, rows);
}

/**
 * 1件のAI評価をai_evaluationsへ追記保存する（上書きしない。常にINSERT）。
 * evaluation_date / data_as_of_date / generated_at を明確に分離して保存する。
 * @returns {Promise<number>} 挿入されたレコードのid（Phase3で購入時評価を紐付ける際に使う）
 */
export async function saveAiEvaluationToD1(d1, evaluation) {
  const sql = `INSERT INTO ai_evaluations (
      code, evaluation_date, data_as_of_date, generated_at,
      score, rating, risk, upside_probability, downside_risk, expected_return,
      expected_holding_days, confidence,
      reasoning, summary, positive_factors, negative_factors, used_features,
      source, price_at_evaluation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    evaluation.code,
    evaluation.evaluationDate,
    evaluation.dataAsOfDate,
    evaluation.generatedAt,
    evaluation.score ?? null,
    evaluation.rating ?? null,
    evaluation.risk ?? null,
    evaluation.upsideProbability ?? null,
    evaluation.downsideRisk ?? null,
    evaluation.expectedReturn ?? null,
    evaluation.expectedHoldingDays ?? null,
    evaluation.confidence ?? null,
    evaluation.reasoning ?? null,
    evaluation.summary ?? null,
    JSON.stringify(evaluation.positiveFactors ?? []),
    JSON.stringify(evaluation.negativeFactors ?? []),
    JSON.stringify(evaluation.usedFeatures ?? {}),
    evaluation.source ?? "pipeline",
    evaluation.priceAtEvaluation ?? null,
  ];

  const { meta } = await d1.run(sql, params);
  return meta.last_row_id;
}

/**
 * 複数のAI評価をまとめて保存する。1件失敗しても残りは継続する
 * （D1エラーでパイプライン全体を止めないため。失敗は呼び出し側に返す）。
 * @returns {Promise<{savedIds: Array<number>, failures: Array<{code, error}>}>}
 */
export async function saveAiEvaluationsToD1(d1, evaluations) {
  const savedIds = [];
  const failures = [];
  for (const evaluation of evaluations) {
    try {
      savedIds.push(await saveAiEvaluationToD1(d1, evaluation));
    } catch (err) {
      failures.push({ code: evaluation.code, error: err.message });
    }
  }
  return { savedIds, failures };
}

/**
 * 現在保有中(数量>0)の銘柄コード一覧を取得する。
 * worker/src/index.jsのcomputePositionFromTrades()と同じ移動平均法のロジックを、
 * GitHub Actions側(REST APIクライアントのd1.js経由)向けに実装したもの
 * （env.DBネイティブバインディングが使えないGitHub Actions環境向けの複製。
 *  ロジック自体は完全に同一である必要があるため、変更する場合は両方を揃えること）。
 */
export async function fetchHeldCodes(d1) {
  const rows = await d1.query(
    `SELECT code, transaction_type, transaction_date, quantity, price, id FROM trades ORDER BY transaction_date ASC, id ASC`
  );

  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  const heldCodes = [];
  for (const [code, trades] of byCode.entries()) {
    let quantity = 0;
    let avgCost = 0;
    for (const t of trades) {
      if (t.transaction_type === "buy") {
        const totalCost = avgCost * quantity + t.price * t.quantity;
        quantity += t.quantity;
        avgCost = quantity > 0 ? totalCost / quantity : 0;
      } else if (t.transaction_type === "sell") {
        quantity -= t.quantity;
      }
    }
    if (quantity > 0) heldCodes.push(code);
  }

  return heldCodes;
}

/**
 * エラーログをD1へ記録する（Cron等の自動実行での障害追跡用）。
 * これ自体が失敗してもパイプラインを止めないよう、呼び出し側でtry/catchすること。
 */
export async function logErrorToD1(d1, { source, errorType, message, context }) {
  const sql = `INSERT INTO error_logs (occurred_at, source, error_type, message, context)
    VALUES (?, ?, ?, ?, ?)`;
  await d1.query(sql, [
    new Date().toISOString(),
    source,
    errorType ?? null,
    message ?? null,
    context ? JSON.stringify(context) : null,
  ]);
}
