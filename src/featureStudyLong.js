// 長い期間(約5年)の日足を、J-Quantsから日付ごとに直接取って、値動き・出来高の数字そのものの順位づけの力を検証する(読み取り専用)。
// D1は使わない(読み取りも書き込みも無い)。計算の本体は src/featureStudy.js。ここは、取得と組み立ての流れだけを担う。
//
// 取得するのは、分割調整後の値(AdjO・AdjH・AdjL・AdjC・AdjVo)。同じ実行の中でまとめて取るので、調整が全期間でそろう。
// 日付ごとに取るので、その日に上場していた銘柄が全て入る(上場廃止の銘柄も含まれる = 生存者バイアスが小さい)。
import { parseTradingCalendar } from "./tradingCalendar.js";
import { toShortCode } from "./normalize.js";
import { fetchTopixForRange } from "./market.js";
import { DEFAULTS, addRows, computeRegimes, createPanel, deriveTradingDays, formatFeatureReport, runStudy, summarizeStudy } from "./featureStudy.js";

export const LONG_DEFAULTS = {
  ...DEFAULTS,
  horizons: [1, 3, 5, 10, 20],
  holdoutFrom: "2024-07-01", // 前半(2022〜2024年6月: 下落・上昇を含む)を探索、後半(2024年7月〜: 8月の急落・4月の関税ショックを含む)を確認にする
  aiFrom: null,
  aiTo: null,
  yearly: true,
  yearlyHorizons: [5, 20],
  quintileHorizon: 5,
};

const normDate = (raw) => {
  const s = String(raw ?? "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

/** J-Quantsの日足1件を、検証の表に入れる形にする。分割調整後の値を使う。 */
export function mapDailyRow(raw) {
  return {
    code: toShortCode(raw.Code ?? raw.code),
    date: normDate(raw.Date ?? raw.date),
    open: raw.AdjO,
    high: raw.AdjH,
    low: raw.AdjL,
    close: raw.AdjC,
    volume: raw.AdjVo,
  };
}

const ymd = (date) => date.replaceAll("-", "");

/**
 * 取引日ごとに、全銘柄の日足を取り、銘柄×営業日の表に入れる。
 *  - 最新日がまだ公表されていない(0件)場合は、その日を除く(最大3日)。
 *  - 取得に失敗した日は、最後にもう一度だけ取り直す。それでも失敗が maxFailedDays を超えたら中断する。
 *    残った失敗の日は、値が欠けたまま(その日を含む窓の特徴量・成績は作られず、推測しない)。
 */
export async function loadLongPanel({ client, from, to, log = () => {}, maxFailedDays = 20, now = () => Date.now() }) {
  const calendar = parseTradingCalendar(await client.fetchTradingCalendar(from, to));
  let tradingDays = calendar.filter((d) => d >= from && d <= to);
  if (tradingDays.length < 100) throw new Error(`取引日が少なすぎます(${tradingDays.length}日)。期間(${from}〜${to})を確認してください。`);

  // 最新日の確認
  const prefetched = new Map();
  for (let i = 0; i < 3; i++) {
    const last = tradingDays[tradingDays.length - 1];
    const rows = await client.fetchDailyQuotesForDate(ymd(last));
    if (rows.length > 0) {
      prefetched.set(last, rows);
      break;
    }
    log(`[features-long] ${last}: まだ公表されていない(0件)ため、除きます`);
    tradingDays = tradingDays.slice(0, -1);
  }

  const panel = createPanel(tradingDays);
  const counts = new Map();
  const failed = [];
  const startedAt = now();
  const put = (date, rows) => {
    addRows(panel, rows.map(mapDailyRow));
    counts.set(date, rows.length);
  };

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    try {
      put(date, prefetched.get(date) ?? (await client.fetchDailyQuotesForDate(ymd(date))));
    } catch (err) {
      failed.push({ date, error: err.message });
      log(`[features-long] ${date}: 取得に失敗(${err.message})。最後に取り直します`);
    }
    if ((i + 1) % 100 === 0) {
      const elapsed = (now() - startedAt) / 1000;
      const eta = (elapsed / (i + 1)) * (tradingDays.length - i - 1);
      log(`[features-long] 取得 ${i + 1}/${tradingDays.length}日 (${Math.round(elapsed)}秒経過 / 残り約${Math.round(eta)}秒)`);
    }
  }

  // 取り直し(1回)
  const stillFailed = [];
  for (const f of failed) {
    try {
      put(f.date, await client.fetchDailyQuotesForDate(ymd(f.date)));
    } catch (err) {
      stillFailed.push({ date: f.date, error: err.message });
    }
  }
  if (stillFailed.length > maxFailedDays) {
    throw new Error(`取得に失敗した日が多すぎます(${stillFailed.length}日 > ${maxFailedDays}日)。J-Quantsの状態とレート制限を確認してください。例: ${stillFailed[0].date} ${stillFailed[0].error}`);
  }
  return { panel, tradingDays, counts, failedDays: stillFailed };
}

/** 取得 → 検証 → レポートまでの流れ。clientは、fetchTradingCalendar・fetchDailyQuotesForDate・fetchTopixRange を持つもの。 */
export async function runLongStudy({ client, from, to, cfgOverrides = {}, log = () => {}, now = () => Date.now() }) {
  const { panel, tradingDays, counts, failedDays } = await loadLongPanel({ client, from, to, log, now });
  log(`[features-long] 読み込み完了: ${panel.codes.length}銘柄 × ${tradingDays.length}日`);

  // TOPIXの状態(25日移動平均の上・下)
  let regimeByDate = null;
  try {
    const topix = await fetchTopixForRange(client, from, to, to);
    regimeByDate = computeRegimes(topix);
    log(`[features-long] TOPIX: ${topix.length}日分(状態を付けた日 ${regimeByDate.size}日)`);
  } catch (err) {
    log(`[features-long] TOPIXの取得に失敗したため、TOPIXの状態別の表は出しません: ${err.message}`);
  }

  const cfg = { ...LONG_DEFAULTS, ...cfgOverrides, regimeByDate };
  const study = runStudy(panel, cfg);
  log(`[features-long] 検証: ${study.days.length}日分`);
  const summary = summarizeStudy(study, cfg);

  // 銘柄数が極端に少ない日・失敗した日(その日を含む窓は、特徴量・成績が作られない)
  const { dropped } = deriveTradingDays(counts);
  const lowDays = [...dropped, ...failedDays.map((f) => ({ date: f.date, count: 0 }))].sort((a, b) => (a.date < b.date ? -1 : 1));
  const meta = {
    firstDay: tradingDays[0],
    lastDay: tradingDays[tradingDays.length - 1],
    coverage: study.coverage,
    droppedDays: lowDays,
    minTurnoverYen: cfg.minTurnoverYen,
    costPct: cfg.costPct,
    quintileHorizon: cfg.quintileHorizon,
    upThresholds: cfg.upThresholds,
    flatPct: cfg.flatPct,
    showAi: false,
    yearly: cfg.yearly,
    yearlyHorizons: cfg.yearlyHorizons,
    minYearShare: cfg.minYearShare,
  };
  return { report: formatFeatureReport({ meta, summary }), meta, summary, cfg, failedDays };
}
