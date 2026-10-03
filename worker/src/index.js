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

import {
  buildHoldings,
  buildPerformance,
  buildTradeHistory,
  computePositionFromTrades,
  listHoldingCodes,
  mapTradeRow,
  parseTradeEdit,
  purchaseEvaluationIdByCode,
  validateCancel,
  validateEdit,
} from "./tradeLogic.mjs";

const DEFAULT_RANKING_LIMIT = 20;
const MAX_RANKING_LIMIT = 100;

// ランキング日の切り替え境界: 日本時間の17:00(日次の自動実行の開始時刻と同じ)。
// generated_at(UTC)に (JSTとの時差9時間 - 境界17時間) = -8時間 を加えた日付が「ランキング日」になる。
// 例: 17:00 JST(=08:00 UTC)に始まった実行は、その日のランキング日に属する(08:00 - 8時間 = 当日00:00 UTC)。
const RANKING_DAY_BOUNDARY_HOUR_JST = 17;
const RANKING_DAY_OFFSET_HOURS = 9 - RANKING_DAY_BOUNDARY_HOUR_JST; // = -8
// SQLiteのdate()の修飾子(例: "-8 hours")。負の値でも "+-8" にならないよう符号を明示する
const RANKING_DAY_SQL_MODIFIER = `${RANKING_DAY_OFFSET_HOURS >= 0 ? "+" : "-"}${Math.abs(RANKING_DAY_OFFSET_HOURS)} hours`;

function currentRankingDay(now = new Date()) {
  return new Date(now.getTime() + RANKING_DAY_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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
    id: row.id,
    code: row.code,
    name: row.stock_name ?? null,
    source: row.source ?? null,
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
  ae.id,
  ae.code,
  ae.source,
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
 * ai_evaluations（D1）から、「今日のランキング日」における最新の1回の実行の評価だけを、
 * score降順で取得する。
 *
 * - ランキング日は日本時間の17:00で切り替わる（currentRankingDay参照）。
 *   前日以前の評価は表示しない。今日の実行が途中で終了しても、前日や前回完走分へのフォールバックはしない。
 * - 「1回の実行」は generated_at（実行開始時刻。同じ実行の全評価で同一）で識別する。
 *   今日のランキング日に複数回実行された場合は、generated_at が最大の実行だけが対象になり、
 *   古い実行の評価が混ざらない。
 * - 最新の実行の判定には source を問わず全行を使う。保有銘柄の追加分(source='holding')が
 *   先に保存されるため、通常候補がまだ0件でも新しい実行を検出できる。
 * - その実行のうち、source='pipeline'（通常のスクリーニング候補）の行だけを対象にする。
 * - 今日のランキング日の評価が0件なら、サブクエリがNULLになり結果は0件（空配列）になる。
 * - 1回の実行内で同じ銘柄の評価は1件のため、銘柄ごとの MAX(id) 集計は不要。
 *
 * stocksテーブルはname/marketが未取得の場合nullになりうる（LEFT JOINで欠損を許容する）。
 */
async function fetchRanking(db, limit, rankingDay) {
  const { results } = await db
    .prepare(
      `SELECT ${EVALUATION_COLUMNS}
       FROM ai_evaluations ae
       LEFT JOIN stocks s ON s.code = ae.code
       WHERE ae.source = 'pipeline'
         AND ae.generated_at = (
           SELECT MAX(generated_at) FROM ai_evaluations
           WHERE date(generated_at, '${RANKING_DAY_SQL_MODIFIER}') = ?
         )
       ORDER BY ae.score DESC
       LIMIT ?`
    )
    .bind(rankingDay, limit)
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
// 設計コメント通り）。計算ロジック(移動平均法・取消の検証・通算成績)は tradeLogic.mjs に集約している。
// 取消済み(canceled_atが入っている)取引は、includeCanceled=trueを指定しない限り常に除外して取得する。

/**
 * trades行を取得し、stocks.nameをLEFT JOINして返す（生のDB行、まだ加工しない）。
 */
async function fetchAllTradeRows(db, code, { includeCanceled = false } = {}) {
  const conditions = [];
  const binds = [];
  if (code) {
    conditions.push("t.code = ?");
    binds.push(code);
  }
  if (!includeCanceled) {
    conditions.push("t.canceled_at IS NULL");
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = db.prepare(
    `SELECT t.*, s.name AS stock_name
     FROM trades t
     LEFT JOIN stocks s ON s.code = t.code
     ${where}
     ORDER BY t.transaction_date ASC, t.id ASC`
  );
  const { results } = await (binds.length > 0 ? statement.bind(...binds) : statement).all();
  return results ?? [];
}

/**
 * 指定した1銘柄のai_evaluationsを新しい順(id降順)に最大limit件取得する。
 * 保有銘柄の「最新評価・前回評価」と、銘柄ごとのAI評価履歴の両方で使う。
 */
async function fetchRecentEvaluationsForCode(db, code, limit) {
  const { results } = await db
    .prepare(
      `SELECT ${EVALUATION_COLUMNS}
       FROM ai_evaluations ae
       LEFT JOIN stocks s ON s.code = ae.code
       WHERE ae.code = ?
       ORDER BY ae.id DESC
       LIMIT ?`
    )
    .bind(code, limit)
    .all();
  return (results ?? []).map(mapEvaluationRow);
}

/**
 * ai_evaluationsをid指定で1件取得する(無ければnull)。購入時AI評価の取得に使う。
 */
async function fetchEvaluationById(db, id) {
  const row = await db
    .prepare(
      `SELECT ${EVALUATION_COLUMNS}
       FROM ai_evaluations ae
       LEFT JOIN stocks s ON s.code = ae.code
       WHERE ae.id = ?`
    )
    .bind(id)
    .first();
  return row ? mapEvaluationRow(row) : null;
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
  const dataAsOfByCode = new Map(); // 株価のデータ基準日(リアルタイム価格ではないことを画面で示すために使う)
  for (const s of stocks) {
    priceByCode.set(s.code, s.price ?? null);
    nameByCode.set(s.code, s.name ?? null);
    dataAsOfByCode.set(s.code, s.dataAsOf ?? null);
  }
  return { priceByCode, nameByCode, dataAsOfByCode };
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
 * codeがKVのstocks一覧に存在しない場合は、実在しない銘柄コードとして登録を拒否する
 * （J-Quantsへの追加API呼び出しは行わず、既に取得済みのKVデータのみで確認する）。
 */
async function handleCreateTrade(db, kv, body) {
  const validationError = validateTradeInput(body);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const { code, transactionType, quantity, price, transactionDate, memo } = body;

  const { nameByCode } = await buildStockLookupMaps(kv);
  if (!nameByCode.has(code)) {
    return { status: 400, body: { error: "銘柄コードが存在しません。コードを確認してください。" } };
  }

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

/**
 * PUT /api/trades/:id を処理する(登録済みの取引の編集)。
 * 実際のSBI証券での約定結果に合わせて、数量・価格・取引日・メモを修正する用途。
 * - 取引は既存のid・既存のカラムのまま UPDATE する(物理DELETEして作り直さない。canceled_atの論理取消設計も維持)。
 * - 銘柄コード・取引種別(買い/売り)・購入時AI評価(purchase_evaluation_id)は変更しない。
 * - 存在しない取引は404、取消済みは409、不正な数量・価格・日付は400。
 * - 編集によって過去・後続の取引との整合性(保有数量)が崩れる場合は409で拒否する(既存の整合性チェックを使用)。
 * 保有数量・平均取得価格・損益・勝敗・通算成績は保存された値を持たず、常に取消されていない取引から
 * 計算するため、ここでは取引行を更新するだけで再計算は自動的に反映される。
 */
async function handleEditTrade(db, tradeId, body) {
  const target = await db.prepare(`SELECT * FROM trades WHERE id = ?`).bind(tradeId).first();
  if (!target) {
    return { status: 404, body: { error: "編集対象の取引が見つかりません。" } };
  }
  if (target.canceled_at) {
    return { status: 409, body: { error: "取消済みの取引は編集できません。" } };
  }

  const parsed = parseTradeEdit(body, target);
  if (!parsed.ok) {
    return { status: parsed.status, body: { error: parsed.error } };
  }
  const values = parsed.values;

  const rowsForCode = await fetchAllTradeRows(db, target.code, { includeCanceled: true });
  const verdict = validateEdit(rowsForCode, tradeId, values);
  if (!verdict.ok) {
    return { status: verdict.status, body: { error: verdict.error } };
  }

  const amount = values.quantity * values.price;
  const result = await db
    .prepare(
      `UPDATE trades SET quantity = ?, price = ?, amount = ?, transaction_date = ?, memo = ?
       WHERE id = ? AND canceled_at IS NULL`
    )
    .bind(values.quantity, values.price, amount, values.transactionDate, values.memo, tradeId)
    .run();
  if (result.meta && result.meta.changes === 0) {
    return { status: 409, body: { error: "取消済みの取引は編集できません。" } };
  }

  return {
    status: 200,
    body: mapTradeRow({
      ...target,
      quantity: values.quantity,
      price: values.price,
      amount,
      transaction_date: values.transactionDate,
      memo: values.memo,
    }),
  };
}

/**
 * POST /api/trades/:id/cancel を処理する(論理取消。物理DELETEはしない)。
 * - すでに取消済みの取引は409。
 * - SELLの取消は常に可能(保有数量・平均取得価格は、取消済みを除いた取引から再計算される)。
 * - BUYの取消は、そのBUYを除くと後続のSELLが保有数量を超える場合は409で拒否する。
 * 保有数量・平均取得価格・損益・通算成績は保存された値を持たず、常に取消されていない取引から
 * 計算するため、ここでは canceled_at を設定するだけで再計算は自動的に反映される。
 */
async function handleCancelTrade(db, tradeId) {
  const target = await db.prepare(`SELECT id, code FROM trades WHERE id = ?`).bind(tradeId).first();
  if (!target) {
    return { status: 404, body: { error: "取消対象の取引が見つかりません。" } };
  }

  const rowsForCode = await fetchAllTradeRows(db, target.code, { includeCanceled: true });
  const verdict = validateCancel(rowsForCode, tradeId);
  if (!verdict.ok) {
    return { status: verdict.status, body: { error: verdict.error } };
  }

  const canceledAt = new Date().toISOString();
  const result = await db
    .prepare(`UPDATE trades SET canceled_at = ? WHERE id = ? AND canceled_at IS NULL`)
    .bind(canceledAt, tradeId)
    .run();
  if (result.meta && result.meta.changes === 0) {
    return { status: 409, body: { error: "この取引はすでに取り消されています。" } };
  }

  return {
    status: 200,
    body: {
      id: tradeId,
      code: target.code,
      transactionType: verdict.target.transaction_type,
      canceledAt,
    },
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        // 204 No Content はレスポンス本文を持てないため、jsonResponse({}, 204) は使わない
        // （本文ありのまま204を返そうとするとレスポンス構築時に例外になり、結果としてPOST系
        //  エンドポイントへのCORSプリフライトが軒並み失敗する原因になっていた）。
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // GET /api/meta — 最終実行日時・cutoffDate等
      if (path === "/api/meta") {
        const meta = await getJson(env.STOCK_KV, "meta");
        return jsonResponse(meta ?? {});
      }

      // GET /api/ranking — AI評価ランキング（D1のai_evaluationsを参照）。
      // 今日のランキング日（日本時間の17:00で切り替わる）における最新の1回の実行の評価のみ、score降順。
      // 前日以前の評価・前回完走分へのフォールバックはしない（今日の評価が0件なら空配列）。
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
          const ranking = await fetchRanking(env.DB, limit, currentRankingDay());
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

      // GET /api/stocks/:code/evaluations — 銘柄ごとのAI評価履歴(ai_evaluationsは追記専用のため全履歴が残っている)。
      // 新しい順。?limit= で件数指定(既定50件、上限200件)。
      const evaluationsMatch = path.match(/^\/api\/stocks\/([^/]+)\/evaluations$/);
      if (evaluationsMatch) {
        if (!env.DB) return jsonResponse([]);
        const code = evaluationsMatch[1];
        const limitParam = Number.parseInt(url.searchParams.get("limit"), 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
        try {
          return jsonResponse(await fetchRecentEvaluationsForCode(env.DB, code, limit));
        } catch (err) {
          console.error(`[worker] /api/stocks/:code/evaluations D1クエリ失敗 code=${code}: ${err.message}`);
          return errorResponse(500);
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
          const { status, body: responseBody } = await handleCreateTrade(env.DB, env.STOCK_KV, body);
          return jsonResponse(responseBody, status);
        } catch (err) {
          console.error(`[worker] POST /api/trades 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // PUT /api/trades/:id — 登録済みの売買取引の編集(数量・価格・取引日・メモ)。
      // 実際のSBI証券での約定結果に合わせて修正する用途。銘柄・取引種別は変更不可。
      const editMatch = path.match(/^\/api\/trades\/(\d+)$/);
      if (editMatch && request.method === "PUT") {
        if (!env.DB) {
          return jsonResponse({ error: "D1が接続されていないため編集できません。" }, 500);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "リクエスト本文がJSONとして解釈できません。" }, 400);
        }
        try {
          const { status, body: responseBody } = await handleEditTrade(env.DB, Number(editMatch[1]), body);
          return jsonResponse(responseBody, status);
        } catch (err) {
          console.error(`[worker] PUT /api/trades/:id 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // POST /api/trades/:id/cancel — 売買取引の取消(論理取消)。BUY/SELLどちらも取り消せる。
      const cancelMatch = path.match(/^\/api\/trades\/(\d+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        if (!env.DB) {
          return jsonResponse({ error: "D1が接続されていないため取消できません。" }, 500);
        }
        try {
          const { status, body: responseBody } = await handleCancelTrade(env.DB, Number(cancelMatch[1]));
          return jsonResponse(responseBody, status);
        } catch (err) {
          console.error(`[worker] POST /api/trades/:id/cancel 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // GET /api/trades/summary — 通算成績(確定したSELLのみ。取消済みは除外)と累計確定損益の推移。
      if (path === "/api/trades/summary" && request.method === "GET") {
        if (!env.DB) return jsonResponse(buildPerformance([]));
        try {
          const allTradeRows = await fetchAllTradeRows(env.DB);
          return jsonResponse(buildPerformance(allTradeRows));
        } catch (err) {
          console.error(`[worker] GET /api/trades/summary 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // GET /api/trades — 売買履歴一覧（?code=で銘柄絞り込み可）。
      // BUY行には現在価格との含み損益、SELL行には移動平均法で計算した実現損益・勝敗・売却時平均取得価格を付与する。
      // 取消済みの取引は既定では含めない。?includeCanceled=1 で canceled:true として含める。
      if (path === "/api/trades" && request.method === "GET") {
        if (!env.DB) return jsonResponse([]);
        try {
          const codeFilter = url.searchParams.get("code") || undefined;
          const includeCanceled = url.searchParams.get("includeCanceled") === "1";
          const [allTradeRows, { priceByCode }] = await Promise.all([
            fetchAllTradeRows(env.DB, codeFilter, { includeCanceled }),
            buildStockLookupMaps(env.STOCK_KV),
          ]);
          // buildTradeHistoryは銘柄ごとの移動平均計算のために「その銘柄の全履歴」が必要なため、
          // ?codeで絞り込んでいてもfetchAllTradeRows自体はcode指定のWHERE句で完結しており問題ない
          // （他銘柄の履歴が無くても、その銘柄1つの計算は正しく行える）。
          return jsonResponse(buildTradeHistory(allTradeRows, priceByCode, { includeCanceled }));
        } catch (err) {
          console.error(`[worker] GET /api/trades 失敗: ${err.message}`);
          return errorResponse(500);
        }
      }

      // GET /api/holdings — 現在の保有銘柄一覧（保有数量>0の銘柄のみ。取消済みの取引は除外して計算）。
      // 保有数量・平均取得価格はtradesから移動平均法でその都度計算する（別テーブルは持たない）。
      // 各銘柄の最新AI評価(latestEvaluation)に加えて、その1つ前の評価(previousEvaluation)と
      // 購入時AI評価(purchaseEvaluation: 最新のBUYのpurchase_evaluation_id)も返す。
      if (path === "/api/holdings") {
        if (!env.DB) return jsonResponse([]);
        try {
          const [allTradeRows, { priceByCode, nameByCode, dataAsOfByCode }] = await Promise.all([
            fetchAllTradeRows(env.DB),
            buildStockLookupMaps(env.STOCK_KV),
          ]);
          const holdingCodes = listHoldingCodes(allTradeRows);
          const evaluationEntries = await Promise.all(
            holdingCodes.map(async (code) => {
              const recent = await fetchRecentEvaluationsForCode(env.DB, code, 2);
              return [code, { latest: recent[0] ?? null, previous: recent[1] ?? null }];
            })
          );
          const evaluationsByCode = new Map(evaluationEntries);

          const purchaseIds = [
            ...new Set(
              [...purchaseEvaluationIdByCode(allTradeRows).values()]
                .map((v) => v.purchaseEvaluationId)
                .filter((id) => id)
            ),
          ];
          const purchaseEntries = await Promise.all(
            purchaseIds.map(async (id) => [id, await fetchEvaluationById(env.DB, id)])
          );
          const purchaseEvaluationById = new Map(purchaseEntries);

          const holdings = buildHoldings(
            allTradeRows,
            priceByCode,
            nameByCode,
            evaluationsByCode,
            purchaseEvaluationById,
            dataAsOfByCode
          );
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
