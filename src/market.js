import { isOnOrBeforeCutoff } from "./cutoff.js";

// TOPIXは専用の軽量エンドポイント(/v2/indices/bars/daily/topix)があり、
// from/toで期間指定した1回（〜数回のページング）のリクエストで取得できるため、
// 株価のような日付ループでの一括取得は不要（無料枠への影響はごく小さい）。

/**
 * TOPIXの日足データを取得する（cutoffDate以前のみ）。
 * @param {import("./jquants.js").JQuantsClient} client
 */
export async function fetchTopixForRange(client, fromDate, toDate, cutoffDate) {
  const rows = await client.fetchTopixRange(
    fromDate.replaceAll("-", ""),
    toDate.replaceAll("-", "")
  );
  return rows
    .map((r) => ({
      date: normalizeDate(r.Date ?? r.date),
      close: Number(r.C ?? r.Close ?? r.close),
    }))
    .filter((r) => r.date && isOnOrBeforeCutoff(r.date, cutoffDate))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

function pctChange(newValue, oldValue) {
  if (!oldValue) return null;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * TOPIXの騰落率（指定営業日数）を計算する。
 * @param {Array<{date, close}>} topixRowsSortedAsc
 * @param {number} tradingDays
 */
export function computeMarketFeatures(topixRowsSortedAsc, tradingDays = 20) {
  if (topixRowsSortedAsc.length < tradingDays + 1) {
    return { topixChangeNd: null, tradingDays };
  }
  const latest = topixRowsSortedAsc[topixRowsSortedAsc.length - 1];
  const past = topixRowsSortedAsc[topixRowsSortedAsc.length - 1 - tradingDays];
  return {
    topixChangeNd: pctChange(latest.close, past.close),
    tradingDays,
  };
}

/**
 * 個別銘柄の騰落率とTOPIXの騰落率を比較し、相対強度を計算する。
 * 正の値なら市場平均よりアウトパフォームしていることを示す。
 */
export function computeRelativeStrength(stockChangeNd, topixChangeNd) {
  if (stockChangeNd === null || stockChangeNd === undefined) return null;
  if (topixChangeNd === null || topixChangeNd === undefined) return null;
  return stockChangeNd - topixChangeNd;
}
