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
   * SQLクエリを実行する。プレースホルダは "?" を使う（SQLインジェクション対策）。
   * @param {string} sql
   * @param {Array<any>} params
   * @returns {Promise<Array<object>>} 結果行の配列（SELECT以外は空配列）
   */
  async query(sql, params = []) {
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
    // 単一クエリの場合は先頭要素の results を返す。
    const first = Array.isArray(json.result) ? json.result[0] : json.result;
    return first?.results ?? [];
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
}
