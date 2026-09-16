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

  /**
   * SQLクエリを実行し、rowsだけでなくmeta情報（last_row_id等）も含めた
   * 結果オブジェクト全体を返す。INSERT後にIDを取得したい場合に使う。
   * @returns {Promise<{results: Array<object>, meta: object}>}
   */
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
    // D1のqueryエンドポイントは result が配列（複数ステートメント対応）で返る。
    const first = Array.isArray(json.result) ? json.result[0] : json.result;
    return { results: first?.results ?? [], meta: first?.meta ?? {} };
  }

  /**
   * SQLクエリを実行する。プレースホルダは "?" を使う（SQLインジェクション対策）。
   * @param {string} sql
   * @param {Array<any>} params
   * @returns {Promise<Array<object>>} 結果行の配列（SELECT以外は空配列）
   */
  async query(sql, params = []) {
    const { results } = await this.run(sql, params);
    return results;
  }

  /**
   * 複数のSQL文をまとめて実行する（マイグレーション適用等に使う）。
   * D1のqueryエンドポイントは1リクエストに1ステートメントが基本のため、
   * ここではセミコロン区切りで分割して順番に実行する。
   */
  async executeBatch(sqlText) {
    const statements = sqlText
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));
    for (const stmt of statements) {
      await this.query(stmt);
    }
  }

  /**
   * 大量の行を「INSERT OR REPLACE」でまとめて書き込む。
   * 全銘柄対応で1回のパイプライン実行につき数千行を書き込むケースを想定し、
   * 1行ずつAPIを呼ぶ非効率を避けるため、複数行を1つのSQL文にまとめる。
   * PRIMARY KEYが重複した場合は上書きする（同じ日付のデータを再実行しても安全）。
   *
   * @param {string} table
   * @param {Array<string>} columns
   * @param {Array<Array<any>>} rows - 各行の値の配列（columnsと同じ順序）
   * @param {number} chunkSize - 1リクエストあたりの最大行数
   * @returns {Promise<number>} 書き込んだ総行数
   */
  async batchInsertOrReplace(table, columns, rows, chunkSize = 200) {
    if (rows.length === 0) return 0;

    const columnList = columns.join(", ");
    let written = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk
        .map(() => `(${columns.map(() => "?").join(", ")})`)
        .join(", ");
      const params = chunk.flat();
      await this.query(
        `INSERT OR REPLACE INTO ${table} (${columnList}) VALUES ${placeholders}`,
        params
      );
      written += chunk.length;
    }

    return written;
  }
}
