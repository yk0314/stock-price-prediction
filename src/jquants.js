import { config } from "./config.js";
import { isOnOrBeforeCutoff, parseSubscriptionRange } from "./cutoff.js";
import { weekdayDates } from "./tradingCalendar.js";

const BASE_URL = "https://api.jquants.com/v2";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * J-Quants APIそのものが失敗したことを表すエラー（レートリミット・認証エラー・5xx等）。
 * 「その日にたまたま取引がなくデータが0件だった」という正常系とは明確に区別する。
 * このエラーが発生した場合、呼び出し側は握りつぶさずパイプライン全体を失敗させること
 * (TOPIXなど補助的なデータを除く。呼び出し側で明示的にcatchして続行する)。
 *
 * kind: "rate-limit"(429) / "server"(5xx) / "network"(通信・タイムアウト) / "auth"(401) /
 *       "forbidden"(403: 契約プランで使えないAPI等) / "bad-request"(400) / "parse"(JSON解析失敗) / "client"(その他の4xx)
 * subscriptionRange: 契約期間外の日付を指定した400エラーのとき、取得可能な期間 {from, to}
 */
export class JQuantsApiError extends Error {
  constructor(message, { status, path, kind, subscriptionRange } = {}) {
    super(message);
    this.name = "JQuantsApiError";
    this.status = status;
    this.path = path;
    this.kind = kind;
    this.subscriptionRange = subscriptionRange ?? null;
  }
}

/**
 * "YYYY-MM-DD" の配列を生成する（start, end とも inclusive）。
 * 土日は除外する。祝日はここでは判定できないため、祝日の日付もリストには含まれるが、
 * その日のAPI応答が「正常な0件（HTTP 200・data: []）」であることは呼び出し側で
 * JQuantsApiErrorと明確に区別して扱う。
 * (祝日も除くには、取引カレンダー: tradingCalendar.js + fetchTradingCalendar() を使う)
 */
export function listCandidateDates(startDate, endDate) {
  return weekdayDates(startDate, endDate);
}

/**
 * J-Quants API V2 クライアント。
 * - 認証は x-api-key ヘッダー
 * - 契約プランのレート制限を守るため、リクエスト間に固定間隔を空ける(config.JQUANTS_REQUEST_INTERVAL_MS。
 *   財務情報(/fins/summary)だけは config.JQUANTS_FINS_INTERVAL_MS)
 * - 一時的な失敗は「待機してから、上限回数まで」だけ再試行する(無限リトライはしない):
 *     429(レートリミット): Retry-Afterがあればそれに従い、無ければ段階的に待機
 *     5xx・ネットワークエラー・タイムアウト・JSON解析失敗: 指数バックオフ
 *   上限に達したら JQuantsApiError として呼び出し側へ伝える。
 *   401/403/400などの再試行しても直らないエラーは、即座に JQuantsApiError として投げる。
 * - 再試行・失敗は onEvent コールバックに通知する(pipelineがerror_logsへ記録するために使う)
 * - pagination_key によるページングに対応（全ページ取得するまで繰り返す）
 * - 銘柄ごとにループしてAPIを叩くことは行わない。date指定の一括取得を基本とする。
 *   「その日は取引がなくdata:[]だった」という正常系はエラーにしない。
 */
export class JQuantsClient {
  /**
   * @param {string} apiKey
   * @param {object} [options] テスト・運用で差し替えるための設定(省略時は config の値)
   * @param {Function} [options.fetchImpl] fetchの代わり
   * @param {Function} [options.sleepImpl] 待機の代わり
   * @param {Function} [options.nowImpl] 現在時刻(ms)の代わり
   * @param {Function} [options.onEvent] 再試行・失敗の通知 ({type:"retry"|"failure", ...})
   * @param {number} [options.intervalMs] 通常APIのリクエスト間隔
   * @param {number} [options.finsIntervalMs] 財務情報APIのリクエスト間隔
   * @param {object} [options.retry] config.JQUANTS_RETRY の上書き
   */
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error("JQUANTS_API_KEY が設定されていません");
    }
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleepImpl ?? defaultSleep;
    this.now = options.nowImpl ?? (() => Date.now());
    this.onEvent = options.onEvent ?? null;
    this.intervalMs = options.intervalMs ?? config.JQUANTS_REQUEST_INTERVAL_MS;
    this.finsIntervalMs = options.finsIntervalMs ?? config.JQUANTS_FINS_INTERVAL_MS;
    this.retry = { ...config.JQUANTS_RETRY, ...(options.retry ?? {}) };
    this._lastRequestAt = 0;
    // 実行中の集計(meta・ログ用)
    this.stats = { requests: 0, retries: 0, failures: 0 };
  }

  _emit(event) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // 通知の失敗でAPI取得を止めない
    }
  }

  async _throttle(minIntervalMs) {
    const elapsed = this.now() - this._lastRequestAt;
    const waitMs = minIntervalMs - elapsed;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    this._lastRequestAt = this.now();
  }

  /** タイムアウトつきで1回リクエストし、レスポンス本文まで読む。 */
  async _requestOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.retry.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { "x-api-key": this.apiKey },
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, headers: res.headers, text };
    } finally {
      clearTimeout(timer);
    }
  }

  _fail(error) {
    this.stats.failures++;
    this._emit({ type: "failure", path: error.path, status: error.status, kind: error.kind, message: error.message });
    return error;
  }

  async _get(path, params, { intervalMs } = {}) {
    const { maxRetriesOn429, retryBackoffMs, maxRetriesOnTransient, transientBackoffMs, maxBackoffMs } = this.retry;
    let attempts429 = 0;
    let attemptsTransient = 0;

    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    // 上限回数つきのループ(429と一時的エラーは、それぞれの上限に達したら必ず例外で終わる)
    for (;;) {
      await this._throttle(intervalMs ?? this.intervalMs);
      this.stats.requests++;

      let response;
      try {
        response = await this._requestOnce(url.toString());
      } catch (networkErr) {
        const reason = networkErr?.name === "AbortError" ? "タイムアウト" : networkErr.message;
        if (attemptsTransient < maxRetriesOnTransient) {
          const waitMs = Math.min(transientBackoffMs * 2 ** attemptsTransient, maxBackoffMs);
          attemptsTransient++;
          this.stats.retries++;
          console.warn(`[jquants] ネットワークエラー(${reason}): ${path} — ${waitMs}ms待機して再試行します (${attemptsTransient}/${maxRetriesOnTransient})`);
          this._emit({ type: "retry", kind: "network", path, attempt: attemptsTransient, waitMs, message: reason });
          await this.sleep(waitMs);
          continue;
        }
        throw this._fail(
          new JQuantsApiError(`J-Quants ネットワークエラー: ${path} — ${reason}(${maxRetriesOnTransient}回リトライしても解消せず)`, {
            path,
            kind: "network",
          })
        );
      }

      const { status } = response;

      if (status === 429) {
        if (attempts429 < maxRetriesOn429) {
          const retryAfterSec = Number(response.headers?.get?.("retry-after"));
          const waitMs =
            Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.min(retryAfterSec * 1000, 120000)
              : retryBackoffMs * (attempts429 + 1);
          attempts429++;
          this.stats.retries++;
          console.warn(`[jquants] レートリミット(429): ${path} — ${waitMs}ms待機して再試行します (${attempts429}/${maxRetriesOn429})`);
          this._emit({ type: "retry", kind: "rate-limit", path, status, attempt: attempts429, waitMs, message: "429" });
          await this.sleep(waitMs);
          continue;
        }
        throw this._fail(
          new JQuantsApiError(`J-Quants レートリミット超過 (429): ${path} — ${maxRetriesOn429}回リトライしましたが解消しませんでした`, {
            status: 429,
            path,
            kind: "rate-limit",
          })
        );
      }

      if (status >= 500) {
        if (attemptsTransient < maxRetriesOnTransient) {
          const waitMs = Math.min(transientBackoffMs * 2 ** attemptsTransient, maxBackoffMs);
          attemptsTransient++;
          this.stats.retries++;
          console.warn(`[jquants] サーバーエラー(${status}): ${path} — ${waitMs}ms待機して再試行します (${attemptsTransient}/${maxRetriesOnTransient})`);
          this._emit({ type: "retry", kind: "server", path, status, attempt: attemptsTransient, waitMs, message: String(status) });
          await this.sleep(waitMs);
          continue;
        }
        throw this._fail(
          new JQuantsApiError(`J-Quants サーバーエラー ${status}: ${path} ${response.text.slice(0, 200)}(${maxRetriesOnTransient}回リトライしても解消せず)`, {
            status,
            path,
            kind: "server",
          })
        );
      }

      if (!response.ok) {
        // 400/401/403/404など: 再試行しても直らないため、即座に呼び出し側へ(認証エラー・契約外のAPIを見落とさない)
        const kind = status === 401 ? "auth" : status === 403 ? "forbidden" : status === 400 ? "bad-request" : "client";
        const subscriptionRange = status === 400 ? parseSubscriptionRange(response.text) : null;
        throw this._fail(
          new JQuantsApiError(`J-Quants APIエラー ${status}: ${path} ${response.text.slice(0, 300)}`, {
            status,
            path,
            kind,
            subscriptionRange,
          })
        );
      }

      try {
        return JSON.parse(response.text);
      } catch (parseErr) {
        if (attemptsTransient < maxRetriesOnTransient) {
          const waitMs = Math.min(transientBackoffMs * 2 ** attemptsTransient, maxBackoffMs);
          attemptsTransient++;
          this.stats.retries++;
          this._emit({ type: "retry", kind: "parse", path, status, attempt: attemptsTransient, waitMs, message: parseErr.message });
          await this.sleep(waitMs);
          continue;
        }
        throw this._fail(
          new JQuantsApiError(`J-Quants レスポンスのJSON解析に失敗: ${path} — ${parseErr.message}`, { path, kind: "parse" })
        );
      }
    }
  }

  /**
   * ページングに対応した一括GET。
   * pagination_key が返る限り繰り返し取得し、data配列を結合して返す。
   * data配列が空のページはAPI側の正常な応答（例: 休日でデータなし）であり、
   * エラーではない。エラーは _get() が JQuantsApiError として投げる。
   */
  async _getAllPages(path, params, requestOptions) {
    let allData = [];
    let paginationKey;
    do {
      const page = await this._get(path, { ...params, pagination_key: paginationKey }, requestOptions);
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
   * 指定した日付(YYYY-MM-DDの配列)ごとに、全銘柄分の株価データをまとめて取得する。
   * 取引カレンダーで求めた取引日を渡せば、祝日にリクエストを無駄遣いしない。
   * prefetched に { "YYYY-MM-DD": rows } を渡すと、その日付は再取得せず使う
   * (最新日の判定で取得済みのデータを使い回すため)。
   * いずれかの日付でAPIエラー(JQuantsApiError)が発生した場合は、握りつぶさずそのまま再送出する。
   *
   * @returns {Promise<Array<object>>} 生レスポンスのレコードを結合した配列（全銘柄・複数日分）
   */
  async fetchDailyQuotesForDates(dates, cutoffDate, { prefetched = {} } = {}) {
    let allRows = [];
    let emptyDayCount = 0;
    let reusedCount = 0;
    for (const date of dates) {
      let rows;
      if (prefetched[date]) {
        rows = cutoffDate ? prefetched[date].filter((row) => isOnOrBeforeCutoff(normalizeDash(row.Date ?? row.date ?? date), cutoffDate)) : prefetched[date];
        reusedCount++;
      } else {
        rows = await this.fetchDailyQuotesForDate(date.replaceAll("-", ""), cutoffDate);
      }
      if (rows.length === 0) {
        emptyDayCount++;
        console.log(`[jquants] ${date}: 0件（休日等の正常な0件と判断）`);
      }
      allRows = allRows.concat(rows);
    }
    console.log(
      `[jquants] 取得完了: 対象${dates.length}日(取得済みの再利用${reusedCount}日)中 ${emptyDayCount}日が0件 / 合計${allRows.length}件`
    );
    return allRows;
  }

  /**
   * cutoffDateを終端とする期間について、日付ベースで全銘柄分の株価データをまとめて取得する(平日のみを対象)。
   * 後方互換のために残している。取引カレンダーを使う場合は fetchDailyQuotesForDates() を使う。
   *
   * @param {string} startDate "YYYY-MM-DD"
   * @param {string} cutoffDate "YYYY-MM-DD"（この日を含めて、これより後の日付は取得しない）
   */
  async fetchDailyQuotesBulkForDateRange(startDate, cutoffDate) {
    return this.fetchDailyQuotesForDates(listCandidateDates(startDate, cutoffDate), cutoffDate);
  }

  /**
   * 取引カレンダーを取得する(/v2/markets/calendar)。[{ Date, HolDiv }, ...]
   * 取引日の判定は tradingCalendar.js の parseTradingCalendar() を使う。
   */
  async fetchTradingCalendar(fromDate, toDate) {
    return this._getAllPages("/markets/calendar", { from: fromDate, to: toDate });
  }

  /**
   * TOPIXの日足データを期間指定(from/to)でまとめて取得する。
   * 専用の軽量エンドポイントであり、株価のような日付ループは不要。
   */
  async fetchTopixRange(fromYYYYMMDD, toYYYYMMDD) {
    return this._getAllPages("/indices/bars/daily/topix", {
      from: fromYYYYMMDD,
      to: toYYYYMMDD,
    });
  }

  /**
   * 指定した銘柄コードの財務情報を全期間分取得する（/v2/fins/summary, code指定）。
   * 財務情報は銘柄コード指定でしか取得できないため、Gemini分析対象に選ばれた候補銘柄にのみ呼び出す
   * （全銘柄に毎回呼ぶ設計にはしない）。リクエスト間隔は財務情報用(config.JQUANTS_FINS_INTERVAL_MS)。
   */
  async fetchFinancialsForCode(code) {
    return this._getAllPages("/fins/summary", { code }, { intervalMs: this.finsIntervalMs });
  }

  /**
   * 指定した銘柄コードの株価四本値を、期間指定(from/to)で取得する。
   *
   * 【用途】バックテスト評価スクリプトと、株式分割で過去の調整後株価が変わった銘柄の再取得
   * (priceSync.js)専用。通常の予測パイプライン（pipeline.js）では使用しないこと。
   */
  async fetchDailyQuotesForCodeRange(code, fromYYYYMMDD, toYYYYMMDD) {
    return this._getAllPages("/equities/bars/daily", {
      code,
      from: fromYYYYMMDD,
      to: toYYYYMMDD,
    });
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
