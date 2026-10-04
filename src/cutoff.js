import { config } from "./config.js";
import {
  addDays,
  latestTradingDayOnOrBefore,
  tradingDaysBetween,
  weekdayDates,
  weekdayOnOrBefore,
} from "./tradingCalendar.js";

/**
 * YYYY-MM-DD 形式の文字列に変換
 */
function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

/** 日本時間(JST)の今日の日付(YYYY-MM-DD)。J-Quantsの更新時刻(日本時間16:30頃)に合わせて日本時間で判定する。 */
export function jstDateString(now = new Date()) {
  return toDateString(new Date(now.getTime() + 9 * 60 * 60 * 1000));
}

/**
 * J-Quantsの契約期間外の日付を指定したときのエラーメッセージから、取得可能な期間を取り出す。
 * 例: "Your subscription covers the following dates: 2021-10-03 ~ . If you want more data, ..."
 *     "Your subscription covers the following dates: 2024-07-04 ~ 2026-07-04. ..."
 * @returns {{from: string|null, to: string|null} | null} メッセージが該当しなければ null。終端が空なら to は null(=現在まで)
 */
export function parseSubscriptionRange(message) {
  const m = /covers the following dates:\s*(\d{4}-\d{2}-\d{2})?\s*~\s*(\d{4}-\d{2}-\d{2})?/.exec(String(message ?? ""));
  if (!m) return null;
  return { from: m[1] ?? null, to: m[2] ?? null };
}

/**
 * 【新】データ基準日(cutoffDate)を、「J-Quantsから実際に取得できた最新の取引日」として動的に判定する。
 *
 * 無料プランの「実行日 - 84日」のような固定値は使わない。
 *   今日(日本時間)から過去に向かって、取引日(取引カレンダー。無ければ平日)に株価を問い合わせ、
 *   最初に「全銘柄分のデータが揃っている」日をデータ基準日にする。
 *   - 当日の株価は日本時間16:30頃に更新される。それより前に実行すると当日は0件(または更新途中)なので、
 *     自動的に前の取引日になる。
 *   - 休日・連休は取引カレンダーで飛ばす(カレンダーを取得できなければ平日のみ)。
 *   - 件数が config.LATEST_DATE.minRowsForCompleteDay 未満の日は、更新途中とみなして1つ前の取引日に戻る。
 *   - 契約期間のエラー("Your subscription covers the following dates: A ~ B")が返ったときは、
 *     B以前の最新の取引日に1回だけ移って探し直す(Freeプランでも固定値なしで最新日を判定できる)。
 *
 * 判定に使った最新日の株価は rows として返す(呼び出し側で再取得しないため。リクエスト数の節約)。
 *
 * @param {object} client fetchDailyQuotesForDate(dateYYYYMMDD) を持つJ-Quantsクライアント
 * @param {object} options
 * @param {string} [options.manualCutoffDate] 手動指定(YYYY-MM-DD)。指定時は問い合わせず、そのまま使う
 * @param {Date} [options.now] テスト用に注入可能な現在時刻
 * @param {string[]|null} [options.tradingDays] 取引カレンダー由来の取引日(昇順)。null/空なら平日のみで判定
 * @returns {Promise<{cutoffDate: string, source: "manual"|"auto-latest", rows: Array<object>|null, probes: Array<object>}>}
 */
export async function resolveLatestAvailableDate(client, options = {}) {
  const {
    manualCutoffDate,
    now = new Date(),
    tradingDays = null,
    maxLookbackDays = config.LATEST_DATE.maxLookbackDays,
    minRowsForCompleteDay = config.LATEST_DATE.minRowsForCompleteDay,
  } = options;

  if (manualCutoffDate) {
    // 手動指定は形式だけを検証する(従来どおり)
    resolveCutoffDate(manualCutoffDate, now);
    return { cutoffDate: manualCutoffDate, source: "manual", rows: null, probes: [] };
  }

  const today = jstDateString(now);
  const hasCalendar = Array.isArray(tradingDays) && tradingDays.length > 0;
  const listCandidates = (upTo) => {
    const lowerBound = addDays(upTo, -maxLookbackDays);
    const list = hasCalendar ? tradingDaysBetween(tradingDays, lowerBound, upTo) : weekdayDates(lowerBound, upTo);
    return list.slice().sort().reverse(); // 新しい日付から
  };

  let candidates = listCandidates(today);
  const probes = [];
  let jumped = false;

  for (let i = 0; i < candidates.length; i++) {
    const date = candidates[i];
    let rows;
    try {
      rows = await client.fetchDailyQuotesForDate(date.replaceAll("-", ""));
    } catch (err) {
      const range = parseSubscriptionRange(err?.message);
      if (range && err?.status === 400) {
        probes.push({ date, outcome: "outside-subscription", range });
        if (range.to && date > range.to && !jumped) {
          jumped = true;
          const jumpTo = hasCalendar ? latestTradingDayOnOrBefore(tradingDays, range.to) : weekdayOnOrBefore(range.to);
          if (jumpTo) {
            candidates = listCandidates(jumpTo);
            i = -1; // for文の i++ で0から再開
            continue;
          }
        }
        continue; // 契約期間外の日は飛ばす
      }
      throw err; // 認証エラー・5xx(リトライ済み)などは呼び出し側へ(握りつぶさない)
    }

    probes.push({ date, outcome: rows.length === 0 ? "empty" : rows.length < minRowsForCompleteDay ? "incomplete" : "ok", rows: rows.length });
    if (rows.length >= minRowsForCompleteDay) {
      return { cutoffDate: date, source: "auto-latest", rows, probes };
    }
  }

  throw new Error(
    `J-Quantsから取得可能な最新の取引日を判定できませんでした(今日=${today}から過去${maxLookbackDays}日を確認): ` +
      JSON.stringify(probes)
  );
}

/**
 * cutoffDate を決定する(手動指定の検証と、従来互換の自動計算)。
 *
 * - 環境変数 CUTOFF_DATE (または workflow_dispatch の入力) が指定されていればそれを使う（手動指定）。
 * - 指定がなければ「実行日 - JQUANTS_DELAY_DAYS」を計算する。
 *
 * 【注意】パイプライン本体(pipeline.js)は、自動のときは上の resolveLatestAvailableDate()
 * (J-Quantsから取得できた最新の取引日)を使う。この関数の自動計算は後方互換のために残しており、
 * JQUANTS_DELAY_DAYS の既定値は 0(=遅延を仮定しない)である。
 *
 * @param {string|undefined} manualCutoffDate - "YYYY-MM-DD" 形式。省略時は自動計算。
 * @param {Date} now - テスト用に注入可能な現在時刻。省略時は実行時刻。
 * @returns {{ cutoffDate: string, source: "manual" | "auto" }}
 */
export function resolveCutoffDate(manualCutoffDate, now = new Date()) {
  if (manualCutoffDate) {
    // 手動指定された日付が未来日でないか、簡易チェックのみ行う。
    // (J-Quants側の実際のデータ有無チェックは jquants.js 側のレスポンスで判断する)
    const parsed = new Date(manualCutoffDate + "T00:00:00Z");
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `cutoffDate の形式が不正です（YYYY-MM-DD形式で指定してください）: ${manualCutoffDate}`
      );
    }
    return { cutoffDate: manualCutoffDate, source: "manual" };
  }

  const autoDate = new Date(now.getTime());
  autoDate.setUTCDate(autoDate.getUTCDate() - config.JQUANTS_DELAY_DAYS);
  return { cutoffDate: toDateString(autoDate), source: "auto" };
}

/**
 * 指定した日付が cutoffDate 以前かどうかを判定する。
 * データ取得結果のフィルタリングに使う（データリーク防止の最終防波堤）。
 */
export function isOnOrBeforeCutoff(dateString, cutoffDate) {
  return dateString <= cutoffDate;
}
