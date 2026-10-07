// D1の「1日あたりの書き込み行数」(無料枠: アカウント全体で10万行/日。UTCの0時にリセット)を、
// ジョブをまたいで管理する。各ジョブは終了時に自分の書き込み行数を d1_write_ledger に加算し、
// 次のジョブは「今日の残り」を見て予算を決める(migrations/0005_d1_write_ledger.sql)。
// 台帳が読めない(migration未適用など)ときは、null を返し、呼び出し側は設定値だけで動く(動作は止めない)。
export { isQuotaExceededMessage } from "./d1.js";

/** UTCの日付(YYYY-MM-DD)。D1の上限がリセットされる単位。 */
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 株価蓄積(sync-prices)の、この実行の書き込み予算。
 * 1回あたりの上限(perRunCap)・今日の残り(dailyTotal - usedToday - reserve)の小さい方。usedTodayがnull(台帳なし)なら上限だけ。
 */
export function computeSyncBudget({ perRunCap, dailyTotal, usedToday, reserve }) {
  if (usedToday === null || usedToday === undefined) return Math.max(0, perRunCap);
  return Math.max(0, Math.min(perRunCap, dailyTotal - usedToday - reserve));
}

/** 今日の残りが少ないとき、パイプラインが必須ではない書き込みを省略すべきかどうか。台帳が読めないときは省略しない。 */
export function shouldSkipNonEssentialWrites({ usedToday, dailyTotal, minRemaining }) {
  if (usedToday === null || usedToday === undefined) return false;
  return dailyTotal - usedToday < minRemaining;
}

/** 今日(UTC)の、全ジョブの書き込み行数の合計。台帳を読めなければ null。 */
export async function readWrittenToday(d1, day) {
  try {
    const rows = await d1.query("SELECT COALESCE(SUM(rows_written), 0) AS used FROM d1_write_ledger WHERE day = ?", [day]);
    return Number(rows?.[0]?.used ?? 0);
  } catch {
    return null;
  }
}

/** ジョブの書き込み行数を台帳に加算する(失敗しても、ジョブ自体は止めない)。 */
export async function recordWrittenToday(d1, { day, job, rows, nowIso = () => new Date().toISOString() }) {
  const n = Math.max(0, Math.round(Number(rows) || 0));
  if (n === 0) return false;
  try {
    await d1.run(
      `INSERT INTO d1_write_ledger (day, job, rows_written, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, job) DO UPDATE SET rows_written = rows_written + excluded.rows_written, updated_at = excluded.updated_at`,
      [day, job, n, nowIso()]
    );
    return true;
  } catch {
    return false;
  }
}
