import { config } from "./config.js";
import { JQuantsApiError } from "./jquants.js";
import { normalizeRawRows, groupByCode } from "./normalize.js";
import { buildAvailableFinancialsByCode } from "./financials.js";

// 【設計方針】
// このモジュールは、J-Quantsの「Freeプランは約90日遅延する」という制約を
// アプリケーション全体のロジックに埋め込まないための抽象化レイヤーである。
// 呼び出し側(pipeline.js等の上位層)は getLatestAvailableDate() / getHistoricalPrices() /
// getFinancialData() だけを使い、「今どのプランで、何日まで見えるか」を意識しない。
//
// Freeプランでは、利用可能な最新日を超えた範囲を要求すると
// J-Quants側が400エラーでメッセージに実際の提供期間
// （例: "Your subscription covers the following dates: 2024-06-20 ~ 2026-06-20"）
// を返してくる。このメッセージを解析することで、
// 「今日から何日遅延するか」をハードコードせず、実際の契約プランから動的に検出する。
// 有料プランに移行してこの制約が無くなった場合も、コードを変更する必要はない
// （probeで「今日」を直接取得でき、そのまま境界として扱われる）。

const SUBSCRIPTION_RANGE_REGEX = /covers the following dates:\s*([\d-]+)\s*~\s*([\d-]+)/i;

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseSubscriptionBoundary(message) {
  const match = message.match(SUBSCRIPTION_RANGE_REGEX);
  if (!match) return null;
  return { from: match[1], to: match[2] };
}

// プロセス内キャッシュ（同一実行内で何度もprobeしないように）。
// テストや複数回の実行で汚染しないよう、明示的にリセットできる関数も用意する。
let cachedBoundary = null;

export function resetSubscriptionBoundaryCache() {
  cachedBoundary = null;
}

/**
 * 現在の契約プランで実際に取得可能な日付範囲を動的に検出する。
 * - 「今日」を直接取得できればそれが上限（遅延なし = 有料プラン等）
 * - 400エラーで提供期間が返れば、そのメッセージから上限日を抽出する（Freeプラン等）
 * - どちらの方法でも判定できない場合のみ、config.JQUANTS_DELAY_DAYSを
 *   「最後の保険」としてのフォールバックに使う（プラン固有の値をアプリ仕様として
 *   固定するものではなく、あくまで検出失敗時の安全側デフォルト）。
 *
 * @param {import("./jquants.js").JQuantsClient} client
 * @returns {Promise<{to: string, from?: string, discoveredVia: string}>}
 */
export async function discoverSubscriptionBoundary(client, { forceRefresh = false } = {}) {
  if (cachedBoundary && !forceRefresh) return cachedBoundary;

  const todayStr = new Date().toISOString().slice(0, 10);
  try {
    await client.fetchDailyQuotesForDate(todayStr.replaceAll("-", ""));
    cachedBoundary = { to: todayStr, discoveredVia: "direct-success" };
    return cachedBoundary;
  } catch (err) {
    if (err instanceof JQuantsApiError && err.status === 400) {
      const parsed = parseSubscriptionBoundary(err.message);
      if (parsed) {
        cachedBoundary = { from: parsed.from, to: parsed.to, discoveredVia: "error-message" };
        return cachedBoundary;
      }
    }
    console.warn(
      `[marketDataService] 契約プランの提供期間を自動検出できなかったため、設定値(JQUANTS_DELAY_DAYS=${config.JQUANTS_DELAY_DAYS})にフォールバックします: ${err.message}`
    );
    cachedBoundary = {
      to: addDaysUTC(todayStr, -config.JQUANTS_DELAY_DAYS),
      discoveredVia: "fallback-config",
    };
    return cachedBoundary;
  }
}

/**
 * 現在利用可能な最新のデータ日付を返す（プランを問わない）。
 */
export async function getLatestAvailableDate(client) {
  const boundary = await discoverSubscriptionBoundary(client);
  return boundary.to;
}

/**
 * cutoffDateを解決する。手動指定があればそれを使い、無ければ
 * 「現在利用可能な最新日」を動的に使う（固定の遅延日数をハードコードしない）。
 *
 * @param {import("./jquants.js").JQuantsClient} client
 * @param {string|undefined} manualCutoffDate - "YYYY-MM-DD"。省略時は自動検出した最新日を使う
 */
export async function resolveEffectiveCutoffDate(client, manualCutoffDate) {
  if (manualCutoffDate) {
    return { cutoffDate: manualCutoffDate, source: "manual" };
  }
  const latest = await getLatestAvailableDate(client);
  return { cutoffDate: latest, source: "auto-detected" };
}

/**
 * 指定銘柄の株価履歴を取得する（正規化済み・分割調整後の値を使用）。
 * Free/有料どちらのプランでも同じ呼び出し方で使える。
 *
 * @param {import("./jquants.js").JQuantsClient} client
 * @param {string} code - 4桁銘柄コード
 * @param {string} fromDate - "YYYY-MM-DD"
 * @param {string} toDate - "YYYY-MM-DD"
 * @returns {Promise<Array<{date, close, high, low, volume}>>} 日付昇順
 */
export async function getHistoricalPrices(client, code, fromDate, toDate) {
  const rawRows = await client.fetchDailyQuotesForCodeRange(
    code,
    fromDate.replaceAll("-", ""),
    toDate.replaceAll("-", "")
  );
  const normalized = normalizeRawRows(rawRows).filter((r) => r.code === code);
  return groupByCode(normalized).get(code) || [];
}

/**
 * 指定した期間について、全銘柄分の株価データを日付ベースで一括取得し、
 * 銘柄コードごとにグルーピングして返す（分割調整後の値を使用）。
 * 全銘柄対応(UNIVERSE_MODE="all")時のデータ取得はこの関数を経由すること。
 * 内部的には日付ループでの一括取得を使う（1銘柄ずつのループではない）。
 *
 * @returns {Promise<Map<string, Array<{date, close, high, low, volume}>>>}
 */
export async function getBulkHistoricalPrices(client, fromDate, cutoffDate) {
  const rawRows = await client.fetchDailyQuotesBulkForDateRange(fromDate, cutoffDate);
  return groupByCode(normalizeRawRows(rawRows));
}

/**
 * 指定銘柄の、asOfDate時点で利用可能だった最新の財務情報を取得する。
 * （開示日ベースのフィルタは financials.js の既存ロジックをそのまま再利用する）
 *
 * @param {import("./jquants.js").JQuantsClient} client
 * @param {string} code
 * @param {string} asOfDate - "YYYY-MM-DD"（この日より厳密に前の開示のみ対象）
 */
export async function getFinancialData(client, code, asOfDate) {
  const rawRows = await client.fetchFinancialsForCode(code);
  const rawByCode = new Map([[code, rawRows]]);
  const available = buildAvailableFinancialsByCode(rawByCode, asOfDate);
  return available.get(code) ?? null;
}
