import { config } from "./config.js";
import { isOnOrBeforeCutoff } from "./cutoff.js";

const BASE_URL = "https://api.jquants.com/v2";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * J-Quants APIそのものが失敗したことを表すエラー（レートリミット・認証エラー・5xx等）。
 * 「その日にたまたま取引がなくデータが0件だった」という正常系とは明確に区別する。
 * このエラーが発生した場合、呼び出し側は握りつぶさずパイプライン全体を失敗させること。
 */
export class JQuantsApiError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = "JQuantsApiError";
    this.status = status;
    this.path = path;
  }
}

/**
 * "YYYY-MM-DD" の配列を生成する（start, end とも inclusive）。
 * 土日は除外する。祝日はここでは判定できないため、祝日の日付もリストには含まれるが、
 * その日のAPI応答が「正常な0件（HTTP 200・data: []）」であることは呼び出し側で
 * JQuantsApiErrorと明確に区別して扱う。
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
 * - Freeプランのレート制限を守るため、リクエスト間に固定間隔を空ける
 * - 429（レートリミット）発生時は、無制限のリトライではなく、
 *   「待機してから最大N回まで再試行し、それでも失敗すればJQuantsApiErrorとして
 *   呼び出し側に伝播させる」という節度ある挙動にする。
 *   これは課金にはつながらない（同一の無料APIへの再試行のみ）ため、
 *   Geminiに関する「429時はリトライ禁止」という制約とは別に扱う。
 * - pagination_key によるページングに対応（全ページ取得するまで繰り返す）
 * - 銘柄ごとにループしてAPIを叩くことは行わない。date指定の一括取得を基本とする。
 * - 429以外のAPIエラー（認証エラー・5xx等）は即座に JQuantsApiError として投げ、
 *   呼び出し側で握りつぶさない（＝パイプラインを明確に失敗させる）。
 *   「その日は取引がなくdata:[]だった」という正常系はエラーにしない。
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
    const { maxRetriesOn429, retryBackoffMs } = config.JQUANTS_RETRY;

    for (let attempt = 0; attempt <= maxRetriesOn429; attempt++) {
      await this._throttle();

      const url = new URL(BASE_URL + path);
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      }

      let res;
      try {
        res = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-api-key": this.apiKey },
        });
      } catch (networkErr) {
        // ネットワークエラー自体もAPIエラーとして扱い、正常系(0件)とは区別する。
        // リトライ対象は429のみとし、ネットワークエラーは即座に失敗させる。
        throw new JQuantsApiError(
          `J-Quants ネットワークエラー: ${path} — ${networkErr.message}`,
          { path }
        );
      }

      if (res.status === 429) {
        if (attempt < maxRetriesOn429) {
          const waitMs = retryBackoffMs * (attempt + 1);
          console.warn(
            `[jquants] レートリミット(429): ${path} — ${waitMs}ms待機して再試行します (${attempt + 1}/${maxRetriesOn429})`
          );
          await sleep(waitMs);
          continue;
        }
        throw new JQuantsApiError(
          `J-Quants レートリミット超過 (429): ${path} — ${maxRetriesOn429}回リトライしましたが解消しませんでした`,
          { status: 429, path }
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new JQuantsApiError(`J-Quants APIエラー ${res.status}: ${path} ${body}`, {
          status: res.status,
          path,
        });
      }

      try {
        return await res.json();
      } catch (parseErr) {
        throw new JQuantsApiError(
          `J-Quants レスポンスのJSON解析に失敗: ${path} — ${parseErr.message}`,
          { path }
        );
      }
    }
    // ここには到達しない（ループ内で必ず return かエラー送出される）
    throw new JQuantsApiError(`J-Quants 予期しないリトライループ終了: ${path}`, { path });
  }

  /**
   * ページングに対応した一括GET。
   * pagination_key が返る限り繰り返し取得し、data配列を結合して返す。
   * data配列が空のページはAPI側の正常な応答（例: 休日でデータなし）であり、
   * エラーではない。エラーは _get() が JQuantsApiError として投げる。
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
   * data: [] が返る（=その日は取引がなかった等）のは正常系であり、例外にはならない。
   * APIエラーは JQuantsApiError として呼び出し側に伝播する（ここでは握りつぶさない）。
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
   * 重要: いずれかの日付でAPIエラー(JQuantsApiError)が発生した場合、ここでは握りつぶさず
   * そのままエラーを再送出し、パイプライン全体を明確に失敗させる。
   * 「休日等でその日のdataが0件だった」という正常系は問題なくスキップ（＝rows.length===0のまま続行）される。
   * 429は _get() 内で既に節度あるリトライが行われた後の結果であり、
   * ここまでエラーが伝播してきた場合はリトライ済みでも解消しなかったことを意味する。
   *
   * @param {string} startDate "YYYY-MM-DD"
   * @param {string} cutoffDate "YYYY-MM-DD"（この日を含めて、これより後の日付は取得しない）
   * @returns {Promise<Array<object>>} 生レスポンスのレコードを結合した配列（全銘柄・複数日分）
   */
  async fetchDailyQuotesBulkForDateRange(startDate, cutoffDate) {
    const dates = listCandidateDates(startDate, cutoffDate);
    let allRows = [];
    let emptyDayCount = 0;
    for (const date of dates) {
      const dateCompact = date.replaceAll("-", "");
      const rows = await this.fetchDailyQuotesForDate(dateCompact, cutoffDate);
      if (rows.length === 0) {
        emptyDayCount++;
        console.log(`[jquants] ${date}: 0件（休日等の正常な0件と判断）`);
      } else {
        console.log(`[jquants] ${date}: ${rows.length}件取得`);
      }
      allRows = allRows.concat(rows);
    }
    console.log(
      `[jquants] 取得完了: 対象${dates.length}日中 ${emptyDayCount}日が0件（休日等） / 合計${allRows.length}件`
    );
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
