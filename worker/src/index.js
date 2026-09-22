// Cloudflare Workers API層。
// 重い処理は一切行わず、GitHub Actionsが書き込んだKVの値をそのまま返すだけにすることで、
// Workers Free の CPU時間制限（10ms/リクエスト）にほぼ確実に収まるようにしている。
//
// 例外: /api/ranking, /api/stocks/:code, /api/stocks/:code/prices, /api/trades(GET/POST),
// /api/holdings はD1を参照する。いずれも1クエリ〜数クエリで完結する軽量な読み取り・書き込みのみを
// 行い、KVエンドポイント群と同様にWorkers側では大掛かりな加工・集計処理は行わない設計を維持する
// （trades→holdings/損益の計算のみ例外的にWorkers側で行う。個人の取引記録程度の件数を前提とした
//  軽量な計算であり、CPU時間制限に抵触する規模ではない）。
//
// バインディング: wrangler.toml で STOCK_KV という名前のKV Namespace、
// DBという名前のD1 Databaseをバインドしている前提。

const DEFAULT_RANKING_LIMIT = 20;
const MAX_RANKING_LIMIT = 100;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function errorResponse(status = 500) {
  // ユーザーには技術的な詳細を出さず、シンプルなメッセージのみ返す
  return jsonResponse(
    { error: "現在データを取得できませんでした。しばらくしてから再度お試しください。" },
    status
  );
}

async function getJson(kv, key) {
  const value = await kv.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeParseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * ai_evaluationsの1行(+LEFT JOINしたstocks.name)を、APIレスポンス用の形に変換する。
 * fetchRanking()と/api/stocks/:codeの両方から共通で使う。
 */
function mapEvaluationRow(row) {
  return {
    code: row.code,
    name: row.stock_name ?? null,
    score: row.score,
    rating: row.rating, // "BUY" | "HOLD" | "SELL"
    risk: row.risk, // "LOW" | "MEDIUM" | "HIGH"
    expectedReturn: row.expected_return,
    expectedHoldingDays: row.expected_holding_days,
    upsideProbability: row.upside_probability,
    downsideRisk: row.downside_risk,
    confidence: row.confidence,
    reasoning: row.reasoning,
    summary: row.summary,
    positiveFactors: safeParseJsonArray(row.positive_factors),
    negativeFactors: safeParseJsonArray(row.negative_factors),
    evaluationDate: row.evaluation_date,
    dataAsOfDate: row.data_as_of_date,
    generatedAt: row.generated_at,
    priceAtEvaluation: row.price_at_evaluation,
  };
}

const EVALUATION_COLUMNS = `
  ae.code,
  s.name AS stock_name,
  ae.score,
  ae.rating,
  ae.risk,
  ae.expected_return,
  ae.expected_holding_days,
  ae.upside_probability,
  ae.downside_risk,
  ae.confidence,
  ae.reasoning,
  ae.summary,
  ae.positive_factors,
  ae.negative_factors,
  ae.evaluation_date,
  ae.data_as_of_date,
  ae.generated_at,
  ae.price_at_evaluation
`;

/**
 * ai_evaluations（D1）から、銘柄ごとに最新の1件だけをscore降順で取得する。
 *
 * 「最新」の判定は evaluation_date/generated_at ではなく id（AUTOINCREMENT）の最大値を使う。
 * ai_evaluationsは追記専用でINSERTのみが行われるため、idの大小＝挿入順（＝新しさ）が
 * 常に保証されており、タイムスタンプの精度や同一実行内での複数レコード発生などの
 * エッジケースを気にする必要がない、最もシンプルで安全な「最新」の定義になる。
 *
 * Gemini分析が存在しない銘柄はそもそもai_evaluationsに行が無いため、
 * 追加のフィルタなしで自然にランキング対象から除外される。
 *
 * stocksテーブルはname/marketが未取得の場合nullになりうる（LEFT JOINで欠損を許容する）。
 */
async function fetchRanking(db, limit) {
  const { results } = await db
    .prepare(
      `SELECT ${EVALUATION_COLUMNS}
       FROM ai_evaluations ae
       INNER JOIN (
         SELECT code, MAX(id) AS max_id
         FROM ai_evaluations
         GROUP BY code
       ) latest ON ae.id = latest.max_id
       LEFT JOIN stocks s ON s.code = ae.code
       ORDER BY ae.score DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  return (results ?? []).map(mapEvaluationRow);
}

/**
 * 指定した1銘柄について、ai_evaluationsの最新1件を取得する（無ければnull）。
 * fetchRanking()と違い対象がcode1件だけなので、MAX(id)のGROUP BYではなく
 * ORDER BY id DESC LIMIT 1で十分（結果は同じだがシンプルで軽量）。
 */
async function fetchLatestEvaluationForCode(db, code) {
  const row = await db
    .prepare(
      `SELECT ${EVALUATION_COLUMNS}
       FROM ai_evaluations ae
       LEFT JOIN stocks s ON s.code = ae.code
       WHERE ae.code = ?
       ORDER BY ae.id DESC
       LIMIT 1`
    )
    .bind(code)
    .first();

  return row ? mapEvaluationRow(row) : null;
}

/**
 * 指定した1銘柄の株価履歴をD1(stock_prices)から日付昇順で取得する。
 * stock_pricesはスクリーニングプールに残った銘柄のみ・直近
 * config.FEATURE_LOOKBACK_TRADING_DAYS+1営業日分しか保存されていない
 * （pipeline.js側の設計上の制約。ここでは変更しない）。
 */
async function fetchStockPricesFromD1(db, code) {
  const { results } = await db
    .prepare(
      `SELECT date, open, high, low, close, volume
       FROM stock_prices
       WHERE code = ?
       ORDER BY date ASC`
    )
    .bind(code)
    .all();

  return (results ?? []).map((row) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

// ---- 売買履歴(trades)・保有状況(holdings) ----
// holdingsは別テーブルを持たず、tradesを時系列に集計して都度計算する（migrations/0001_init.sqlの
// 設計コメント通り）。計算方式は移動平均法: 買うたびに平均取得価格を再計算し、
// 売っても平均取得価格自体は変えず数量だけ減らす（証券会社の実務でも一般的な方式）。

function mapTradeRow(row) {
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
  };
}

/**
 * ある銘柄のtrades配列(時系列昇順)を移動平均法で順に処理し、各時点の状態を返す。
 * @returns {{
 *   quantity: number, avgCost: number,
 *   sellResults: Array<{tradeId:number, realizedPnl:number, realizedPnlPct:number, avgCostAtSale:number}>
 * }}
 */
function computePositionFromTrades(tradesForCodeAsc) {
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
 * 全trades(どの銘柄のものも混在可)を銘柄ごとにグルーピングし、時系列昇順にソートする。
 * transaction_dateが同じ場合はid(登録順)で安定ソートする。
 */
function groupTradesByCode(trades) {
  const byCode = new Map();
  for (const t of trades) {
    if (!byCode.has(t.code)) byCode.set(t.code, []);
    byCode.get(t.code).push(t);
  }
  for (const list of byCode.values()) {
    list.sort((a, b) => {
      if (a.transaction_date !== b.transaction_date) {
        return a.transaction_date < b.transaction_date ? -1 : 1;
      }
      return a.id - b.id;
    });
  }
  return byCode;
}

/**
 * 全trades行を取得し、stocks.nameをLEFT JOINして返す（生のDB行、まだ加工しない）。
 */
async function fetchAllTradeRows(db, code) {
  const query = code
    ? db
        .prepare(
          `SELECT t.*, s.name AS stock_name
           FROM trades t
           LEFT JOIN stocks s ON s.code = t.code
           WHERE t.code = ?
           ORDER BY t.transaction_date ASC, t.id ASC`
        )
        .bind(code)
    : db.prepare(
        `SELECT t.*, s.name AS stock_name
         FROM trades t
         LEFT JOIN stocks s ON s.code = t.code
         ORDER BY t.transaction_date ASC, t.id ASC`
      );
  const { results } = await query.all();
  return results ?? [];
}

/**
 * GET /api/trades のレスポンスを組み立てる。
 * BUY行には「このロットを今も持っていたら」の含み損益（現在価格との差、1ロット単位）を、
 * SELL行には移動平均法で計算した実現損益・勝敗フラグを付与する。
 * currentPriceByCode が無い銘柄（KVのstocks一覧に無い等）は損益をnullのまま返す。
 */
function buildTradeHistory(allTradeRows, currentPriceByCode) {
  const byCode = groupTradesByCode(allTradeRows);
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
          pnlType: "unrealized", // このロットを今も保有していたと仮定した含み損益（実際の保有数とは独立）
          win: null,
        });
      } else {
        const sellResult = sellResultByTradeId.get(t.id);
        resultsByTradeId.set(t.id, {
          ...base,
          pnl: sellResult?.realizedPnl ?? null,
          pnlPct: sellResult?.realizedPnlPct ?? null,
          pnlType: "realized",
          win: sellResult ? sellResult.realizedPnl > 0 : null,
        });
      }
    }
  }

  // 元の(全銘柄混在の)時系列順ではなく、新しい取引から見たいことが多いのでtransaction_date降順で返す
  return allTradeRows
    .map((t) => resultsByTradeId.get(t.id))
    .sort((a, b) => {
      if (a.transactionDate !== b.transactionDate) return a.transactionDate < b.transactionDate ? 1 : -1;
      return b.id - a.id;
    });
}

/**
 * GET /api/holdings のレスポンスを組み立てる。保有数量が0より大きい銘柄のみ返す。
 */
function buildHoldings(allTradeRows, currentPriceByCode, nameByCode, latestEvaluationByCode) {
  const byCode = groupTradesByCode(allTradeRows);
  const holdings = [];

  for (const [code, tradesAsc] of byCode.entries()) {
    const { quantity, avgCost } = computePositionFromTrades(tradesAsc);
    if (quantity <= 0) continue;

    const currentPrice = currentPriceByCode.get(code) ?? null;
    const unrealizedPnl = currentPrice !== null ? (currentPrice - avgCost) * quantity : null;
    const unrealizedPnlPct = currentPrice !== null && avgCost > 0 ? ((currentPrice - avgCost) / avgCost) * 100 : null;

    holdings.push({
      code,
      name: nameByCode.get(code) ?? null,
      quantity,
      avgCost,
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPct,
      latestEvaluation: latestEvaluationByCode.get(code) ?? null,
    });
  }

  return holdings.sort((a, b) => (b.unrealizedPnl ?? -Infinity) - (a.unrealizedPnl ?? -Infinity));
}

/**
 * KVのstocks一覧から code -> price, code -> name の対応表を作る。
 * ランキング等と違い、trades/holdingsは全銘柄横断で参照する可能性があるため
 * 一覧ごと読み込んでMap化するのが一番シンプル。
 */
async function buildStockLookupMaps(kv) {
  const stocks = (await getJson(kv, "stocks")) ?? [];
  const priceByCode = new Map();
  const nameByCode = new Map();
  for (const s of stocks) {
    priceByCode.set(s.code, s.price ?? null);
    nameByCode.set(s.code, s.name ?? null);
  }
  return { priceByCode, nameByCode };
}

const VALID_TRANSACTION_TYPES = new Set(["buy", "sell"]);

/**
 * POST /api/tradesの入力を検証する。問題があればエラーメッセージの文字列を返し、無ければnullを返す。
 */
function validateTradeInput(body) {
  if (!body || typeof body !== "object") return "リクエスト本文が不正です。";
  if (!body.code || typeof body.code !== "string") return "銘柄コード(code)は必須です。";
  if (!VALID_TRANSACTION_TYPES.has(body.transactionType)) return "transactionTypeは buy または sell を指定してください。";
  if (!Number.isFinite(body.quantity) || body.quantity <= 0) return "数量(quantity)は正の数で指定してください。";
  if (!Number.isFinite(body.price) || body.price <= 0) return "約定価格(price)は正の数で指定してください。";
  if (!body.transactionDate || typeof body.transactionDate !== "string") return "約定日時(transactionDate)は必須です。";
  return null;
}

/**
 * POST /api/trades を処理する。
 * buyの場合、登録時点でその銘柄の最新AI評価(ai_evaluations)を検索しpurchase_evaluation_idに紐付ける。
 * sellの場合、現在の保有数量を超える売却をエラーで弾く（誤登録の簡易チェック）。
 */
async function handleCreateTrade(db, body) {
  const validationError = validateTradeInput(body);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const { code, transactionType, quantity, price, transactionDate, memo } = body;

  if (transactionType === "sell") {
    const existingRows = await fetchAllTradeRows(db, code);
    const { quantity: currentQuantity } = computePositionFromTrades(existingRows);
    if (quantity > currentQuantity) {
      return {
        status: 400,
        body: { error: `保有数量(${currentQuantity})を超える売却数量(${quantity})は登録できません。` },
      };
    }
  }

  let purchaseEvaluationId = null;
  if (transactionType === "buy") {
    try {
      const latestEvaluation = await db
        .prepare(`SELECT id FROM ai_evaluations WHERE code = ? ORDER BY id DESC LIMIT 1`)
        .bind(code)
        .first();
      purchaseEvaluationId = latestEvaluation?.id ?? null;
    } catch (err) {
      // AI評価の紐付けに失敗しても取引記録自体は登録できるようにする(紐付けはnullのまま)
      console.error(`[worker] POST /api/trades: 最新AI評価の検索に失敗 code=${code}: ${err.message}`);
    }
  }

  const amount = quantity * price;
  const createdAt = new Date().toISOString();

  const insertResult = await db
    .prepare(
      `INSERT INTO trades (code, transaction_type, transaction_date, quantity, price, amount, memo, purchase_evaluation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(code, transactionType, transactionDate, quantity, price, amount, memo ?? null, purchaseEvaluationId, createdAt)
    .run();

  return {
    status: 201,
    body: {
      id: insertResult.meta.last_row_id,
      code,
      transactionType,
      transactionDate,
      quantity,
      price,
      amount,
      memo: memo ?? null,
      purchaseEvaluationId,
      createdAt,
    },
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return jsonResponse({}, 204);
      }

      // GET /api/meta — 最終実行日時・cutoffDate等
      if (path === "/api/meta") {
        const meta = await getJson(env.STOCK_KV, "meta");
        return jsonResponse(meta ?? {});
      }

      // GET /api/ranking — AI評価ランキング（D1のai_evaluationsを参照。銘柄ごとに最新評価のみ、score降順）
      // クエリパラメータ: limit（省略時20件、上限100件）
      if (path === "/api/ranking") {
        if (!env.DB) {
          // D1が未接続の環境では空配列を返す（KV系エンドポイントの「データなし時は[]」という
          // 既存の振る舞いに合わせ、フロントエンド側の分岐を増やさないようにする）。
          return jsonResponse([]);
        }
        const limitParam = Number.parseInt(url.searchParams.get("limit"), 10);
        const limit =
          Number.isFinite(limitParam) && limitParam > 0
            ? Math.min(limitParam, MAX_RANKING_LIMIT)
            : DEFAULT_RANKING_LIMIT;
        try {
          const ranking = await fetchRanking(env.DB, limit);
          return jsonResponse(ranking);
        } catch (err) {
          console.error(`[worker] /api/ranking D1クエリ失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // GET /api/stocks — 特徴量計算に成功した銘柄の一覧（コード・価格・データ基準日）
      if (path === "/api/stocks") {
        const stocks = await getJson(env.STOCK_KV, "stocks");
        return jsonResponse(stocks ?? []);
      }

      // GET /api/backtest — バックテスト評価サマリー（backtest-run.jsが生成、未実行ならnull相当）
      if (path === "/api/backtest") {
        const summary = await getJson(env.STOCK_KV, "backtest-summary");
        return jsonResponse(summary ?? {});
      }

      // GET /api/diagnostics/d1 — D1疎通確認用エンドポイント（Phase1データ基盤の動作確認専用）。
      // Workers内からのD1アクセスは、GitHub Actions側(src/d1.js, REST API経由)とは異なり、
      // ネイティブのバインディング(env.DB.prepare(...))を使う。これがCloudflare公式の推奨方式で、
      // REST API経由より高速・低レイテンシ。
      // 書き込みテストは error_logs テーブルに1行挿入 → 読み取り確認 → 同一リクエスト内で即削除する
      // 自己完結型のため、本番データを汚さない。D1未接続やクエリ失敗時もクラッシュせず、
      // d1Connected:false として結果を返す。
      if (path === "/api/diagnostics/d1") {
        if (!env.DB) {
          return jsonResponse({ d1Connected: false, error: "env.DB バインディングが見つかりません" }, 500);
        }
        try {
          const tablesResult = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          ).all();
          const tables = (tablesResult.results ?? []).map((t) => t.name);

          const testMessage = `diagnostic-${Date.now()}`;
          const insertResult = await env.DB.prepare(
            "INSERT INTO error_logs (occurred_at, source, error_type, message, context) VALUES (?, ?, ?, ?, ?)"
          )
            .bind(new Date().toISOString(), "diagnostic_test", "connectivity_check", testMessage, null)
            .run();
          const insertedId = insertResult.meta.last_row_id;

          const readBack = await env.DB.prepare("SELECT * FROM error_logs WHERE id = ?")
            .bind(insertedId)
            .first();

          await env.DB.prepare("DELETE FROM error_logs WHERE id = ?").bind(insertedId).run();

          const afterDelete = await env.DB.prepare("SELECT * FROM error_logs WHERE id = ?")
            .bind(insertedId)
            .first();

          return jsonResponse({
            d1Connected: true,
            tables,
            writeReadTest: {
              inserted: readBack !== null,
              readBackMessageMatches: readBack?.message === testMessage,
            },
            cleanupTest: { deletedSuccessfully: afterDelete === null },
          });
        } catch (err) {
          return jsonResponse({ d1Connected: false, error: err.message }, 500);
        }
      }

      // GET /api/stocks/:code — 個別銘柄の詳細（KVの基本情報 + D1の最新AI評価をまとめて返す）
      // 基本情報(code/name/market/price/dataAsOf)は従来通りKVのstocks一覧から取得する
      // （全銘柄分を含む一覧なので、Gemini未分析の銘柄でもここは取れる）。
      // latestEvaluationはD1のai_evaluationsから取得し、Gemini分析済みの銘柄のみ値が入る
      // （分析が無ければnull。/api/stocks/:code/analysis はKVの直近1回実行分をそのまま返す
      //  従来のエンドポイントとして残してあるが、D1を参照するこちらの方が
      //  「銘柄ごとに最新の評価」という意味では一貫性がある）。
      const stockMatch = path.match(/^\/api\/stocks\/([^/]+)$/);
      if (stockMatch) {
        const code = stockMatch[1];
        const stocks = await getJson(env.STOCK_KV, "stocks");
        const stock = (stocks ?? []).find((s) => s.code === code);
        if (!stock) {
          return jsonResponse({ error: "この銘柄コードは見つかりませんでした。" }, 404);
        }

        let latestEvaluation = null;
        if (env.DB) {
          try {
            latestEvaluation = await fetchLatestEvaluationForCode(env.DB, code);
          } catch (err) {
            // AI評価が取れなくても、基本情報だけは返せた方がフロントにとって有用なため、
            // ここでは500にせずlatestEvaluation:nullのまま返す（エラーはログにのみ残す）。
            console.error(`[worker] /api/stocks/:code D1クエリ失敗 code=${code}: ${err.message}`);
          }
        }

        return jsonResponse({
          code: stock.code,
          name: stock.name ?? null,
          market: stock.market ?? null,
          price: stock.price,
          dataAsOf: stock.dataAsOf,
          latestEvaluation,
        });
      }

      // GET /api/stocks/:code/prices — 株価履歴。D1のstock_pricesを正とする。
      // stock_pricesはスクリーニングプール銘柄のみ・直近約41営業日分しか保存されていない
      // （pipeline.js Stage8の設計上の制約。ここでは変更しない）。
      // D1未接続、または該当銘柄がプール外でD1に無い場合は、
      // 従来通りKVのprices:{code}（同じくプール限定・キャッシュ用途）にフォールバックする。
      const pricesMatch = path.match(/^\/api\/stocks\/([^/]+)\/prices$/);
      if (pricesMatch) {
        const code = pricesMatch[1];

        if (env.DB) {
          try {
            const pricesFromD1 = await fetchStockPricesFromD1(env.DB, code);
            if (pricesFromD1.length > 0) {
              return jsonResponse(pricesFromD1);
            }
          } catch (err) {
            console.error(`[worker] /api/stocks/:code/prices D1クエリ失敗 code=${code}: ${err.message}`);
            // D1がエラーでも即500にはせず、KVへのフォールバックを試みる
          }
        }

        const pricesFromKv = await getJson(env.STOCK_KV, `prices:${code}`);
        return jsonResponse(pricesFromKv ?? []);
      }

      // GET /api/stocks/:code/analysis — Gemini分析結果（あれば）
      const analysisMatch = path.match(/^\/api\/stocks\/([^/]+)\/analysis$/);
      if (analysisMatch) {
        const code = analysisMatch[1];
        const analysis = await getJson(env.STOCK_KV, `analysis:${code}`);
        if (!analysis) {
          return jsonResponse({ error: "この銘柄のAI分析結果はまだありません。" }, 404);
        }
        return jsonResponse(analysis);
      }

      // POST /api/trades — 売買取引の登録（買い/売り）。buyの場合は最新AI評価を自動で紐付ける。
      if (path === "/api/trades" && request.method === "POST") {
        if (!env.DB) {
          return jsonResponse({ error: "D1が接続されていないため取引を登録できません。" }, 500);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "リクエスト本文がJSONとして解釈できません。" }, 400);
        }
        try {
          const { status, body: responseBody } = await handleCreateTrade(env.DB, body);
          return jsonResponse(responseBody, status);
        } catch (err) {
          console.error(`[worker] POST /api/trades 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // GET /api/trades — 売買履歴一覧（?code=で銘柄絞り込み可）。
      // BUY行には現在価格との含み損益、SELL行には移動平均法で計算した実現損益・勝敗を付与する。
      if (path === "/api/trades" && request.method === "GET") {
        if (!env.DB) return jsonResponse([]);
        try {
          const codeFilter = url.searchParams.get("code") || undefined;
          const [allTradeRows, { priceByCode, nameByCode }] = await Promise.all([
            fetchAllTradeRows(env.DB, codeFilter),
            buildStockLookupMaps(env.STOCK_KV),
          ]);
          // buildTradeHistoryは銘柄ごとの移動平均計算のために「その銘柄の全履歴」が必要なため、
          // ?codeで絞り込んでいてもfetchAllTradeRows自体はcode指定のWHERE句で完結しており問題ない
          // （他銘柄の履歴が無くても、その銘柄1つの計算は正しく行える）。
          const history = buildTradeHistory(allTradeRows, priceByCode);
          void nameByCode; // buildTradeHistoryはstocks.nameをSQL側のJOINで既に取得済みのため未使用
          return jsonResponse(history);
        } catch (err) {
          console.error(`[worker] GET /api/trades 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // GET /api/holdings — 現在の保有銘柄一覧（保有数量>0の銘柄のみ）。
      // 保有数量・平均取得価格はtradesから移動平均法でその都度計算する（別テーブルは持たない）。
      // 各銘柄の最新AI評価も併せて返す（保有判断の参考用。fetchRanking同様、銘柄ごとにid最大値=最新1件）。
      if (path === "/api/holdings") {
        if (!env.DB) return jsonResponse([]);
        try {
          const [allTradeRows, { priceByCode, nameByCode }] = await Promise.all([
            fetchAllTradeRows(env.DB),
            buildStockLookupMaps(env.STOCK_KV),
          ]);
          const holdingCodes = [...groupTradesByCode(allTradeRows).entries()]
            .filter(([, trades]) => computePositionFromTrades(trades).quantity > 0)
            .map(([code]) => code);
          const evaluationEntries = await Promise.all(
            holdingCodes.map(async (code) => [code, await fetchLatestEvaluationForCode(env.DB, code)])
          );
          const latestEvaluationByCode = new Map(evaluationEntries);
          const holdings = buildHoldings(allTradeRows, priceByCode, nameByCode, latestEvaluationByCode);
          return jsonResponse(holdings);
        } catch (err) {
          console.error(`[worker] GET /api/holdings 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      return errorResponse(500);
    }
  },
};
