import { config } from "./config.js";
import { isOnOrBeforeCutoff } from "./cutoff.js";

const BASE_URL = "https://api.jquants.com/v2";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "YYYY-MM-DD" の配列を生成する（start, end とも inclusive）。
 * 土日は除外する（祝日は除外できないため、対象日にデータが無いレスポンスが返るだけで
 * エラーにはならない設計にしている）。
 */
export function listCandidateDates(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    const day = cur.getUTCDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) {
      dates.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * J-Quants API V2 クライアント。
 * - 認証は x-api-key ヘッダー
 * - Freeプランのレート制限（5req/分）を守るため、リクエスト間に固定間隔を空ける
 * - pagination_key によるページングに対応（全ページ取得するまで繰り返す）
 * - 銘柄ごとにループしてAPIを叩くことは行わない。date指定の一括取得を基本とする。
 */
export class JQuantsClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error("JQUANTS_API_KEY が設定されていません");
    }
    this.apiKey = apiKey;
    this._lastRequestAt = 0;
  }

  async _throttle() {
    const elapsed = Date.now() - this._lastRequestAt;
    const waitMs = config.JQUANTS_REQUEST_INTERVAL_MS - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this._lastRequestAt = Date.now();
  }

  async _get(path, params) {
    await this._throttle();

    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": this.apiKey },
    });

    if (res.status === 429) {
      throw new Error(
        `J-Quants レートリミット超過 (429): ${path} — 呼び出し間隔を見直してください`
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`J-Quants APIエラー ${res.status}: ${path} ${body}`);
    }
    return res.json();
  }

  /**
   * ページングに対応した一括GET。
   * pagination_key が返る限り繰り返し取得し、data配列を結合して返す。
   */
  async _getAllPages(path, params) {
    let allData = [];
    let paginationKey;
    do {
      const page = await this._get(path, {
        ...params,
        pagination_key: paginationKey,
      });
      allData = allData.concat(page.data || []);
      paginationKey = page.pagination_key;
    } while (paginationKey);
    return allData;
  }

  /**
   * 指定した1日分の株価四本値を全銘柄分まとめて取得する（date指定・codeは省略）。
   * cutoffDateより新しいレコードは念のためここでも除外する（多重防御）。
   */
  async fetchDailyQuotesForDate(dateYYYYMMDD, cutoffDate) {
    const data = await this._getAllPages("/equities/bars/daily", {
      date: dateYYYYMMDD,
    });
    if (!cutoffDate) return data;
    return data.filter((row) => {
      const d = row.Date ?? row.date;
      return d && isOnOrBeforeCutoff(normalizeDash(d), cutoffDate);
    });
  }

  /**
   * cutoffDateを終端とする期間について、日付ベースで全銘柄分の株価データをまとめて取得する。
   * これがPhase 1以降の唯一のデータ取得経路であり、銘柄コードでループする方式は使わない。
   *
   * @param {string} startDate "YYYY-MM-DD"
   * @param {string} cutoffDate "YYYY-MM-DD"（この日を含めて、これより後の日付は取得しない）
   * @returns {Promise<Array<object>>} 生レスポンスのレコードを結合した配列（全銘柄・複数日分）
   */
  async fetchDailyQuotesBulkForDateRange(startDate, cutoffDate) {
    const dates = listCandidateDates(startDate, cutoffDate);
    let allRows = [];
    for (const date of dates) {
      const dateCompact = date.replaceAll("-", "");
      try {
        const rows = await this.fetchDailyQuotesForDate(dateCompact, cutoffDate);
        allRows = allRows.concat(rows);
        console.log(`[jquants] ${date}: ${rows.length}件取得`);
      } catch (err) {
        // 祝日等でデータが無い日はエラーにならずrows=0で返る想定だが、
        // 万一のAPIエラーはログに残しつつ、その日をスキップして続行する
        // （1日分の失敗でパイプライン全体を止めない）。
        console.warn(`[jquants] ${date} の取得に失敗: ${err.message}`);
      }
    }
    return allRows;
  }

  /**
   * 上場銘柄一覧を取得する（全銘柄運用時、UNIVERSE_MODE="all" で使用する）。
   */
  async fetchListedInfo() {
    return this._getAllPages("/equities/master", {});
  }
}

function normalizeDash(raw) {
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}
