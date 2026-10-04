// 取引カレンダー(J-Quants /v2/markets/calendar)と営業日の計算(純粋関数)。
// 実測(2026-10-03)のレスポンス: [{ "Date": "2026-09-19", "HolDiv": "0" }, ...]
//   HolDiv: 0=非営業日 / 1=営業日 / 2=東証半日立会日(取引あり) / 3=非営業日(祝日取引あり)
// 取引日だけを対象にすることで、祝日・連休に株価APIを無駄に呼ばないようにする。
// カレンダーを取得できない場合は、土日だけを除く従来の方法(weekdayDates)にフォールバックする。

/** "20260601" / "2026-06-01" を "2026-06-01" に正規化する。形式が不正なら null。 */
export function normalizeCalendarDate(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** 株の取引が行われる日(営業日・半日立会日)かどうか。 */
export function isTradingHolDiv(holDiv) {
  const v = String(holDiv);
  return v === "1" || v === "2";
}

/**
 * カレンダーの生レコード配列から、取引日(YYYY-MM-DD)の昇順配列を作る。
 * 取得できなかった・空・形式不正のときは空配列を返す(呼び出し側で weekdayDates にフォールバックする)。
 */
export function parseTradingCalendar(rows) {
  const days = new Set();
  for (const row of rows ?? []) {
    const date = normalizeCalendarDate(row?.Date ?? row?.date);
    const holDiv = row?.HolDiv ?? row?.holDiv ?? row?.HolidayDivision;
    if (date && isTradingHolDiv(holDiv)) days.add(date);
  }
  return [...days].sort();
}

/** 土日を除く日付(YYYY-MM-DD)の配列(start, endともinclusive)。祝日は判定できない。 */
export function weekdayDates(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    const day = cur.getUTCDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** 取引日の配列(昇順)から、from〜toの範囲(inclusive)だけを返す。 */
export function tradingDaysBetween(tradingDays, fromDate, toDate) {
  return tradingDays.filter((d) => d >= fromDate && d <= toDate);
}

/** 指定した日付以前で最も新しい取引日。無ければ null。 */
export function latestTradingDayOnOrBefore(tradingDays, date) {
  let found = null;
  for (const d of tradingDays) {
    if (d <= date) found = d;
    else break;
  }
  return found;
}

/** 指定日付以前で最も新しい平日(土日を除く)。 */
export function weekdayOnOrBefore(date) {
  const cur = new Date(date + "T00:00:00Z");
  while ([0, 6].includes(cur.getUTCDay())) cur.setUTCDate(cur.getUTCDate() - 1);
  return cur.toISOString().slice(0, 10);
}

/** 日付文字列に日数を加える(負の値で過去)。 */
export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
