// Cloudflare Workers API層。
// 重い処理は一切行わず、GitHub Actionsが書き込んだKVの値をそのまま返すだけにすることで、
// Workers Free の CPU時間制限（10ms/リクエスト）にほぼ確実に収まるようにしている。
//
// バインディング: wrangler.toml で STOCK_KV という名前のKV Namespaceをバインドしている前提。

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

      // GET /api/ranking — AI評価ランキング
      if (path === "/api/ranking") {
        const ranking = await getJson(env.STOCK_KV, "ranking");
        return jsonResponse(ranking ?? []);
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
