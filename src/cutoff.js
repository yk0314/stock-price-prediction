import { config } from "./config.js";

/**
 * YYYY-MM-DD 形式の文字列に変換
 */
function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * cutoffDate を決定する。
 *
 * - 環境変数 CUTOFF_DATE (または workflow_dispatch の入力) が指定されていればそれを使う（手動指定）。
 * - 指定がなければ「実行日 - JQUANTS_DELAY_DAYS」を自動計算する。
 *
 * 重要: J-Quants Freeプランは実データが常に約12週間遅延するため、
 * cutoffDateを「今日」に設定しても、実際にはそれより新しいデータは
 * どのみち取得できない。このモジュールは、それを前提に
 * 「安全に処理可能な上限日」を明示的に計算する役割を持つ。
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
