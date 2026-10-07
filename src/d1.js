// Cloudflare D1への読み書きはREST API経由で行う（wrangler CLI不要 = GitHub Actionsで完結）。
// 参考: POST /accounts/{account_id}/d1/database/{database_id}/query
// KVのCloudflareKVクラスと同じ認証方式(Bearer Token)を使う。

const D1_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * JSON配列を1つのバインド変数として渡し、SQLite組み込みの json_each で展開して upsert するSQLを作る。
 *   INSERT OR REPLACE INTO t (a, b) SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?) AS j
 * D1は「1つのSQL文のバインド変数は100個まで」という制約があり、通常のVALUES句では1リクエストあたり
 * 100÷列数(株価なら11列で9行)しか書き込めない。この方法なら1リクエストで数百行を書き込める
 * (JSON文字列は1つのバインド変数として数える)。
 * @param {string} table
 * @param {string[]} columns
 */
export function buildJsonUpsertSql(table, columns) {
  const selects = columns.map((_, i) => `json_extract(j.value, '$[${i}]')`).join(", ");
  return `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) SELECT ${selects} FROM json_each(?) AS j`;
}

/** D1の無料枠の「1日あたりの書き込み行数」の上限を超えたときのエラーメッセージかどうか。 */
export function isQuotaExceededMessage(text) {
  return /exceeded D1's free tier daily row write limit|"code"\s*:\s*7500/.test(String(text ?? ""));
}

/**
 * D1の書き込み上限(無料枠: 1日10万行)に達したことを表すエラー。
 * 一度これが発生したら、同じクライアントからの以降の書き込みは、ネットワークに出さず即座にこのエラーになる
 * (毎回失敗する書き込みを繰り返さない。上限はUTCの0時=日本時間9時にリセットされる)。読み取りは続けられる。
 */
export class D1QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "D1QuotaError";
  }
}

const WRITE_STATEMENT = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i;

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
    // 実行中のD1の使用量(リクエスト数・書き込み行数)。D1が返す meta.rows_written を積算する。
    // 無料枠(書き込み1日10万行)の予算管理に使う。
    this.stats = { requests: 0, rowsWritten: 0, rowsRead: 0, quotaExceeded: false };
  }

  async run(sql, params = []) {
    if (this.stats.quotaExceeded && WRITE_STATEMENT.test(sql)) {
      throw new D1QuotaError("D1の1日あたりの書き込み上限に達しているため、書き込みを行いません(UTCの0時にリセットされます)");
    }
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
      if (isQuotaExceededMessage(body)) {
        this.stats.quotaExceeded = true;
        throw new D1QuotaError(`D1の書き込み上限に達しました (${res.status}): ${body}`);
      }
      throw new Error(`D1クエリ失敗 (${res.status}): ${body}`);
    }

    const json = await res.json();
    if (!json.success) {
      if (isQuotaExceededMessage(JSON.stringify(json.errors ?? json))) {
        this.stats.quotaExceeded = true;
        throw new D1QuotaError(`D1の書き込み上限に達しました: ${JSON.stringify(json.errors ?? json)}`);
      }
      throw new Error(`D1クエリ失敗: ${JSON.stringify(json.errors ?? json)}`);
    }
    const first = Array.isArray(json.result) ? json.result[0] : json.result;
    const meta = first?.meta ?? {};
    this.stats.requests++;
    this.stats.rowsWritten += Number(meta.rows_written ?? meta.changes ?? 0) || 0;
    this.stats.rowsRead += Number(meta.rows_read ?? 0) || 0;
    return { results: first?.results ?? [], meta };
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

    for (let i = 0; i < rows.length; i += effectiveChunkSize) {
      const chunk = rows.slice(i, i + effectiveChunkSize);
      const placeholders = chunk
        .map(() => `(${columns.map(() => "?").join(", ")})`)
        .join(", ");
      const params = chunk.flat();

      await this.run(`INSERT OR REPLACE INTO ${table} (${columnList}) VALUES ${placeholders}`, params);
      written += chunk.length;
    }

    return written;
  }

  /**
   * 大量の行を、JSON一括(json_each)でupsert(INSERT OR REPLACE)する。
   * batchInsertOrReplace と同じ結果になるが、1リクエストで書き込める行数が桁違いに多い
   * (株価: 11列で 9行 → 200行)ため、全銘柄の日足(1日約4,400行)を数十リクエストで書き込める。
   * 主キーが同じ行は上書きされるため、同じ日付を再実行しても重複しない。
   * @returns {Promise<number>} 書き込もうとした行数
   */
  async bulkUpsertJson(table, columns, rows, { rowsPerRequest = 200 } = {}) {
    if (rows.length === 0) return 0;
    const sql = buildJsonUpsertSql(table, columns);
    let written = 0;
    for (let i = 0; i < rows.length; i += rowsPerRequest) {
      const chunk = rows.slice(i, i + rowsPerRequest);
      await this.run(sql, [JSON.stringify(chunk)]);
      written += chunk.length;
    }
    return written;
  }
}
