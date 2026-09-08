// Cloudflare KV への書き込みは REST API 経由で行う（wrangler CLI 不要 = GitHub Actions で完結）。
// 参考: PUT /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key}

function kvBaseUrl(accountId, namespaceId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
}

export class CloudflareKV {
  constructor({ accountId, namespaceId, apiToken }) {
    if (!accountId || !namespaceId || !apiToken) {
      throw new Error(
        "CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN が設定されていません"
      );
    }
    this.accountId = accountId;
    this.namespaceId = namespaceId;
    this.apiToken = apiToken;
  }

  async put(key, value) {
    const url = `${kvBaseUrl(this.accountId, this.namespaceId)}/values/${encodeURIComponent(
      key
    )}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "text/plain",
      },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cloudflare KV書き込み失敗 (${res.status}): ${key} ${body}`);
    }
  }

  /**
   * 1件のキーの値を取得する（JSONとしてパースして返す。存在しなければnull）。
   * バックテスト評価スクリプト等、GitHub Actions側からKVを読み出す用途で使う
   * （Workers APIとは独立した経路）。
   */
  async get(key) {
    const url = `${kvBaseUrl(this.accountId, this.namespaceId)}/values/${encodeURIComponent(
      key
    )}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cloudflare KV読み込み失敗 (${res.status}): ${key} ${body}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * 指定したprefixに一致するキー名の一覧を取得する（値は含まない）。
   * カーソルによるページングに対応する。
   */
  async listKeys(prefix) {
    let allKeys = [];
    let cursor;
    do {
      const url = new URL(`${kvBaseUrl(this.accountId, this.namespaceId)}/keys`);
      if (prefix) url.searchParams.set("prefix", prefix);
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Cloudflare KVキー一覧取得失敗 (${res.status}): ${body}`);
      }
      const json = await res.json();
      allKeys = allKeys.concat((json.result || []).map((r) => r.name));
      cursor = json.result_info?.cursor || undefined;
    } while (cursor);
    return allKeys;
  }
}

/**
 * パイプラインの結果を KV に保存する。
 * サイト表示に必要な最小限のデータのみを保存し、4,400銘柄分の生データなどは保存しない。
 *
 * 保存するキー:
 * - meta                  最終実行日時・cutoffDate等のメタ情報
 * - ranking                上位銘柄ランキング（AI評価込み）
 * - stocks                 特徴量が計算できた全銘柄の一覧（コード・価格・dataAsOf）
 * - analysis:{code}        銘柄ごとのAI評価（詳細ページ表示用）
 * - prices:{code}          銘柄ごとの直近の正規化済み株価（簡易チャート表示用）
 * - history:{cutoffDate}:{code}
 *                          将来のバックテスト用に、予測時点の状態を追記保存する。
 *                          cutoffDateとcodeの組み合わせをキーにしているため、
 *                          既存の予測を上書きすることは原理的に発生しない（追記専用）。
 * - backtest-summary       backtest-run.jsが生成する評価サマリー
 *
 * 【将来の投資管理機能（売買履歴）との名前空間設計】
 * 今後追加予定の「自分の売買履歴・収支管理」機能は、上記のいずれとも重複しない
 * 別プレフィックス（例: "trade:{code}:{tradeId}"）を使うことを想定している。
 */
export async function saveResultsToKV(
  kv,
  { meta, ranking, analysisByCode, stocks, pricesByCode }
) {
  await kv.put("meta", meta);
  await kv.put("ranking", ranking);
  if (stocks) await kv.put("stocks", stocks);

  for (const [code, analysis] of Object.entries(analysisByCode)) {
    await kv.put(`analysis:${code}`, analysis);
    // 追記専用の履歴レコード（バックテスト用）。同じcutoffDate+codeでの再実行は上書きになるが、
    // 異なるcutoffDateであれば別キーとして蓄積される。
    await kv.put(`history:${meta.cutoffDate}:${code}`, analysis);
  }

  if (pricesByCode) {
    for (const [code, prices] of Object.entries(pricesByCode)) {
      await kv.put(`prices:${code}`, prices);
    }
  }
}
