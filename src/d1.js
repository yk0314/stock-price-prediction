// Cloudflare D1への読み書きはREST API経由で行う（wrangler CLI不要 = GitHub Actionsで完結）。
// 参考: POST /accounts/{account_id}/d1/database/{database_id}/query
// KVのCloudflareKVクラスと同じ認証方式(Bearer Token)を使う。

const D1_API_BASE = "https://api.cloudflare.com/client/v4";

export class D1Client {
  constructor({ accountId, databaseId, apiToken }) {
    if (!accountId || !databaseId || !apiToken) {
      throw new Error(
        "CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_API_TOKEN が設定されていません"
      );
    }
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
  }

  async run(sql, params = []) {
    const url = `${D1_API_BASE}/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`D1クエリ失敗 (${res.status}): ${body}`);
    }

    const json = await res.json();
    if (!json.success) {
      throw new Error(`D1クエリ失敗: ${JSON.stringify(json.errors ?? json)}`);
    }
    const first = Array.isArray(json.result) ? json.result[0] : json.result;
    return { results: first?.results ?? [], meta: first?.meta ?? {} };
  }

  async query(sql, params = []) {
    const { results } = await this.run(sql, params);
    return results;
  }

  async executeBatch(sqlText) {
    const statements = sqlText
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));
    for (const stmt of statements) {
      await this.query(stmt);
    }
  }

  async batchInsertOrReplace(table, columns, rows, chunkSize) {
    if (rows.length === 0) return 0;

    const D1_MAX_BOUND_PARAMS = 100;
    const safeRowsPerChunk = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns.length));
    const effectiveChunkSize = chunkSize
      ? Math.min(chunkSize, safeRowsPerChunk)
      : safeRowsPerChunk;

    const columnList = columns.join(", ");
    let written = 0;

    // ▼▼▼ 一時デバッグ（原因特定用。確認後に削除すること） ▼▼▼
    let debugTotalRequested = 0;
    let debugTotalChanges = 0;
    let debugChunkIndex = 0;
    const debugTotalChunks = Math.ceil(rows.length / effectiveChunkSize);
    // ▲▲▲ 一時デバッグここまで ▲▲▲

    for (let i = 0; i < rows.length; i += effectiveChunkSize) {
      const chunk = rows.slice(i, i + effectiveChunkSize);
      const placeholders = chunk
        .map(() => `(${columns.map(() => "?").join(", ")})`)
        .join(", ");
      const params = chunk.flat();

      // ▼▼▼ 一時デバッグ（原因特定用。確認後に削除すること） ▼▼▼
      debugChunkIndex++;
      debugTotalRequested += chunk.length;
      try {
        const { meta } = await this.run(
          `INSERT OR REPLACE INTO ${table} (${columnList}) VALUES ${placeholders}`,
          params
        );
        const changes = meta?.changes ?? null;
        if (changes !== null) debugTotalChanges += changes;
        // 全チャンクを出すとログが膨大になるため、table=stock_pricesの時だけ・
        // 最初の3件と、requested!==changesの異常時だけ詳細ログを出す
        if (table === "stock_prices" && (debugChunkIndex <= 3 || changes !== chunk.length)) {
          console.log(
            `[DEBUG-D1] batchInsertOrReplace(${table}) chunk ${debugChunkIndex}/${debugTotalChunks}: ` +
              `requested=${chunk.length}, meta.changes=${changes}, success=true`
          );
        }
      } catch (err) {
        console.log(
          `[DEBUG-D1] batchInsertOrReplace(${table}) chunk ${debugChunkIndex}/${debugTotalChunks}: ` +
            `requested=${chunk.length}, success=false, error=${err.message}`
        );
        throw err;
      }
      // ▲▲▲ 一時デバッグここまで ▲▲▲

      written += chunk.length;
    }

    // ▼▼▼ 一時デバッグ（原因特定用。確認後に削除すること） ▼▼▼
    if (table === "stock_prices") {
      console.log(
        `[DEBUG-D1] batchInsertOrReplace(${table}) 合計: requested=${debugTotalRequested} / actualChanges=${debugTotalChanges}`
      );
    }
    // ▲▲▲ 一時デバッグここまで ▲▲▲

    return written;
  }
}
