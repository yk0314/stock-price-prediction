// J-Quantsの全銘柄の日足・TOPIX・銘柄マスタを、Cloudflare D1へ「差分」で蓄積するスクリプト。
// (GitHub Actionsの sync-prices.yml から毎日実行する。手動実行も可能)
//
// 実行するたびに次を行う:
//   1. 取引カレンダーとJ-Quantsの最新の取引日(データ基準日)を判定する(固定の遅延日数は使わない)
//   2. 銘柄マスタ(全銘柄)をD1のstocksへ同期する(新規・変更があった銘柄だけ書き込む)
//   3. 未蓄積の取引日だけを、新しい日付から順にstock_pricesへupsertする(D1の1日の書き込み予算の範囲で)
//        → 初回の過去分(既定730日)は、予算の範囲で数日〜数十日かけて自動的に埋まる(再開可能)
//   4. 直近に株式分割等(AdjFactor≠1)があった銘柄は、履歴を再取得して調整後株価の基準を揃える
//   5. TOPIXをindex_pricesへ蓄積する
//
// 事前に migrations/0004_jquants_paid_data_foundation.sql をD1へ適用しておくこと。
// 必要な環境変数: JQUANTS_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN, CF_D1_DATABASE_ID
// 任意: JQUANTS_PLAN, PRICE_SYNC_LOOKBACK_DAYS, D1_DAILY_WRITE_BUDGET, D1_ROWS_PER_REQUEST
import { config } from "../src/config.js";
import { JQuantsClient } from "../src/jquants.js";
import { D1Client } from "../src/d1.js";
import { jstDateString, resolveLatestAvailableDate } from "../src/cutoff.js";
import { addDays, parseTradingCalendar, tradingDaysBetween, weekdayDates } from "../src/tradingCalendar.js";
import { buildListedInfoByCode } from "../src/listedInfo.js";
import { repairAdjustedHistory, syncIndexPrices, syncPrices, syncStocksMaster } from "../src/d1Sync.js";
import { logErrorToD1 } from "../src/d1Repository.js";
import { computeSyncBudget, readWrittenToday, recordWrittenToday, utcDay } from "../src/d1Budget.js";

async function main() {
  const startedAt = new Date();
  for (const name of ["JQUANTS_API_KEY", "CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_D1_DATABASE_ID"]) {
    if (!process.env[name]) {
      console.error(`[sync-prices] 環境変数 ${name} が設定されていません。`);
      process.exitCode = 1;
      return;
    }
  }

  const d1 = new D1Client({
    accountId: process.env.CF_ACCOUNT_ID,
    databaseId: process.env.CF_D1_DATABASE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });
  // 今日(UTC)の、全ジョブ(パイプライン・手動実行を含む)の書き込み量。無料枠(1日10万行)の残りの範囲で予算を決める。
  const ledgerDay = utcDay(startedAt);
  const usedToday = await readWrittenToday(d1, ledgerDay);
  try {
    const events = [];
    const client = new JQuantsClient(process.env.JQUANTS_API_KEY, { onEvent: (ev) => events.push(ev) });
    const { lookbackDays, dailyWriteBudget, rowsPerRequest, maxSplitRepairCodes } = config.PRICE_SYNC;
    // この実行で使ってよい書き込み行数 = 1回の上限・「今日の残り - パイプライン用の余裕」の小さい方
    const runBudget = computeSyncBudget({
      perRunCap: dailyWriteBudget,
      dailyTotal: config.D1_WRITE.dailyTotalBudget,
      usedToday,
      reserve: config.D1_WRITE.reserveForPipeline,
    });
    console.log(
      `[sync-prices] D1の今日(UTC ${ledgerDay})の書き込み: 実行前の合計 ${usedToday ?? "不明(台帳なし)"}行 → この実行の予算 ${runBudget}行`
    );

    const today = jstDateString(startedAt);
    const startDate = addDays(today, -lookbackDays);
    console.log(`[sync-prices] 開始: 今日(JST)=${today} / 蓄積の対象期間=${startDate}〜 / 書き込み予算=${dailyWriteBudget}行 / プラン=${config.JQUANTS_PLAN}`);

    // 1) 取引カレンダー(取得できなければ平日のみ)と、取得可能な最新の取引日
    let tradingDays = [];
    try {
      tradingDays = parseTradingCalendar(await client.fetchTradingCalendar(startDate, today));
    } catch (err) {
      console.warn(`[sync-prices] 取引カレンダーの取得に失敗したため、平日のみで判定します: ${err.message}`);
    }
    const resolved = await resolveLatestAvailableDate(client, { now: startedAt, tradingDays });
    const latestDate = resolved.cutoffDate;
    const targetDays = tradingDays.length > 0 ? tradingDaysBetween(tradingDays, startDate, latestDate) : weekdayDates(startDate, latestDate);
    console.log(`[sync-prices] 最新の取引日(データ基準日)=${latestDate} / 蓄積対象の取引日=${targetDays.length}日`);

    // 2) 銘柄マスタ(全銘柄)
    let masterResult = null;
    try {
      const listedInfoByCode = buildListedInfoByCode(await client.fetchListedInfo());
      masterResult = await syncStocksMaster({ d1, listedInfoByCode });
      console.log(`[sync-prices] 銘柄マスタ: 全${masterResult.total}銘柄中、新規・変更${masterResult.written}件を書き込み`);
    } catch (err) {
      console.warn(`[sync-prices] 銘柄マスタの同期に失敗(続行): ${err.message}`);
    }

    // 3) 株価の差分蓄積
    // 書き込み予算は、この実行全体(銘柄マスタ・TOPIX・株式分割の再取得を含む)の上限として数える。
    // 銘柄マスタ等で既に使った分と、後続(TOPIX・再取得)のための余裕(RESERVED_WRITES)を引いた残りを株価に使う。
    const RESERVED_WRITES = 3000;
    const priceBudget = Math.max(0, runBudget - d1.stats.rowsWritten - RESERVED_WRITES);
    let priceResult;
    try {
      priceResult = await syncPrices({
        client,
        d1,
        tradingDays: targetDays,
        prefetched: resolved.rows ? { [latestDate]: resolved.rows } : {},
        writeBudget: priceBudget,
        rowsPerRequest,
      });
    } catch (err) {
      if (/no such table/i.test(err.message)) {
        console.error("[sync-prices] D1に price_sync_dates がありません。migrations/0004_jquants_paid_data_foundation.sql を先に適用してください。");
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    console.log(
      `[sync-prices] 株価: 未蓄積${priceResult.missingBefore}日のうち${priceResult.syncedDates.length}日を蓄積 / 残り${priceResult.remaining}日 / 書き込み${priceResult.rowsWritten}行` +
        (priceResult.stoppedBy ? ` / 停止理由=${priceResult.stoppedBy}(残りは次回以降)` : "") +
        (priceResult.skippedEmpty.length ? ` / データ無しのため見送り: ${priceResult.skippedEmpty.join(",")}` : "")
    );

    // 4) 株式分割等で過去の調整後株価が変わった銘柄の履歴を揃える
    let repairResult = null;
    if (priceResult.adjusted.size > 0) {
      repairResult = await repairAdjustedHistory({
        client,
        d1,
        adjusted: priceResult.adjusted,
        fromDate: startDate,
        toDate: latestDate,
        latestDate,
        maxCodes: maxSplitRepairCodes,
        writeBudget: Math.max(0, runBudget - d1.stats.rowsWritten),
        rowsPerRequest,
      });
    }

    // 5) TOPIX
    let indexResult = null;
    try {
      indexResult = await syncIndexPrices({ client, d1, indexCode: config.MARKET.indexCode, fromDate: startDate, toDate: latestDate });
      console.log(`[sync-prices] ${config.MARKET.indexCode}: ${indexResult.from}〜${indexResult.to} の${indexResult.rows}行を保存`);
    } catch (err) {
      console.warn(`[sync-prices] ${config.MARKET.indexCode}の同期に失敗(続行。契約プランで使えない場合は403): ${err.message}`);
    }

    // J-Quantsの再試行・失敗をerror_logsへ記録(最大50件)
    for (const ev of events.slice(0, 50)) {
      try {
        await logErrorToD1(d1, {
          source: "jquants",
          errorType: `${ev.type}_${ev.kind ?? "unknown"}`,
          message: ev.message ?? "",
          context: { path: ev.path, status: ev.status, attempt: ev.attempt, waitMs: ev.waitMs, job: "sync-prices" },
        });
      } catch {
        // 記録の失敗は無視
      }
    }

    console.log(
      JSON.stringify(
        {
          latestDate,
          stocksMaster: masterResult,
          prices: { ...priceResult, adjusted: [...priceResult.adjusted.entries()].slice(0, 20) },
          repair: repairResult,
          index: indexResult,
          jquants: client.stats,
          d1: d1.stats,
          elapsedSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
        },
        null,
        2
      )
    );
  } finally {
    // この実行の書き込み行数を台帳に加算する(失敗しても無視)
    await recordWrittenToday(d1, { day: ledgerDay, job: "sync-prices", rows: d1.stats.rowsWritten });
  }
}

main().catch((err) => {
  if (err?.name === "D1QuotaError") {
    // D1の無料枠(1日の書き込み上限)に達した。異常ではないため、ジョブは失敗にしない(残りは翌日以降に回る)
    console.warn(`[sync-prices] D1の書き込み上限に達したため、ここで終了します(蓄積済みの分は保存されています。残りは次回): ${err.message}`);
    return;
  }
  console.error(`[sync-prices] 致命的エラー: ${err.stack || err.message}`);
  process.exitCode = 1;
});
