// Cloudflare Workers API層。
// 重い処理は一切行わず、GitHub Actionsが書き込んだKVの値をそのまま返すだけにすることで、
// Workers Free の CPU時間制限（10ms/リクエスト）にほぼ確実に収まるようにしている。
//
// 例外: /api/ranking はD1(ai_evaluations)を参照する。1クエリで完結する軽量な読み取りのみを
// 行い、KVエンドポイント群と同様にWorkers側では加工・集計処理を極力行わない設計を維持する。
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
      `SELECT
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

  return (results ?? []).map((row) => ({
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
  }));
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

      // GET /api/stocks/:code — 個別銘柄の基本情報（stocks一覧から検索）
      const stockMatch = path.match(/^\/api\/stocks\/([^/]+)$/);
      if (stockMatch) {
        const code = stockMatch[1];
        const stocks = await getJson(env.STOCK_KV, "stocks");
        const stock = (stocks ?? []).find((s) => s.code === code);
        if (!stock) {
          return jsonResponse({ error: "この銘柄コードは見つかりませんでした。" }, 404);
        }
        return jsonResponse(stock);
      }

      // GET /api/stocks/:code/prices — 直近の簡易株価データ
      const pricesMatch = path.match(/^\/api\/stocks\/([^/]+)\/prices$/);
      if (pricesMatch) {
        const code = pricesMatch[1];
        const prices = await getJson(env.STOCK_KV, `prices:${code}`);
        return jsonResponse(prices ?? []);
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

      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      return errorResponse(500);
    }
  },
};
