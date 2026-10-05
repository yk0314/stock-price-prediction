// J-Quantsのデータを、Cloudflare D1へ「差分」で蓄積するための処理。
// (バックテスト用に、全銘柄の日足・TOPIX・銘柄マスタをD1へ貯める。日々のパイプライン(pipeline.js)は
//  特徴量計算のために直近約2か月分をJ-Quantsから直接取得するため、この蓄積はパイプラインの動作には必須ではない)
//
// 差分の考え方:
//   price_sync_dates(date, row_count, synced_at) に「全銘柄分の書き込みが完了した日付」を記録する。
//   取引カレンダーの取引日のうち、この表に無い日付だけを、新しい日付から順に取得してstock_pricesへupsertする。
//   → 2回目以降は新しい日付(通常1日分)だけを取得する。途中で止まっても、完了した日付は再取得しない(再開できる)。
//   → 書き込みが途中で失敗した日付は完了扱いにならず、次回やり直す(主キー(code,date)のupsertなので重複しない)。
//
// 書き込み予算:
//   D1の無料枠は「書き込み1日10万行」。stock_pricesは1行の書き込みで索引も更新されるため、1日分(約4,400行)で
//   約8,800行分になる。writeBudget(D1が返す実際の書き込み行数で集計)を超えない範囲で処理し、残りは次回に回す。
import { normalizeRawRow, toShortCode } from "./normalize.js";
import { addDays } from "./tradingCalendar.js";

export const PRICE_COLUMNS = [
  "code", "date", "open", "high", "low", "close", "volume", "data_source", "fetched_at", "adj_factor", "turnover",
];
export const INDEX_COLUMNS = ["index_code", "date", "open", "high", "low", "close", "fetched_at"];
export const STOCK_COLUMNS = ["code", "name", "market", "updated_at"];

// 1行のupsertで書き込まれる行数の見積もり(テーブル本体 + 主キーの索引)。実際の集計はD1のmeta.rows_writtenで行う
export const WRITES_PER_PRICE_ROW = 2;
// 1日あたりの株価行数の目安(実測: 約4,400)。予算の事前チェックに使う
export const TYPICAL_ROWS_PER_DAY = 4500;

function numberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * J-Quantsの株価1レコード(生)を、stock_pricesの1行(配列。PRICE_COLUMNSの順)にする。
 *   code    : 4桁化した銘柄コード(他テーブルと同じ形式。normalize.jsと同じルール)
 *   close/high/low/volume/open: 株式分割調整後の値(AdjC/AdjH/AdjL/AdjVo/AdjO)。normalize.jsと同じく調整後を使う
 *   adj_factor: その日の調整係数(AdjFactor。1以外の日は分割等があった日)
 *   turnover: 売買代金(Va)
 * 値が足りない行は null を返す(呼び出し側で除外する)。
 */
export function buildPriceRow(rawRow, fetchedAt, dataSource = "jquants") {
  const n = normalizeRawRow(rawRow);
  if (!n || !Number.isFinite(n.close)) return null;
  const open = numberOrNull(rawRow.AdjO ?? rawRow.O);
  return [
    n.code,
    n.date,
    open,
    n.high,
    n.low,
    n.close,
    n.volume,
    dataSource,
    fetchedAt,
    numberOrNull(rawRow.AdjFactor),
    numberOrNull(rawRow.Va),
  ];
}

/** 株式分割等(AdjFactor≠1)があった銘柄と日付。過去の調整後株価が変わるため、蓄積済みの履歴の再取得が必要になる。 */
export function findAdjustedCodes(rawRows) {
  const found = new Map(); // code -> 最新のex日
  for (const row of rawRows) {
    const factor = numberOrNull(row.AdjFactor);
    if (factor === null || factor === 1) continue;
    const n = normalizeRawRow(row);
    if (!n) continue;
    const prev = found.get(n.code);
    if (!prev || n.date > prev) found.set(n.code, n.date);
  }
  return found;
}

/**
 * まだ蓄積していない取引日を、新しい日付から順に返す。
 * @param {string[]} tradingDays 取引日(YYYY-MM-DD)
 * @param {Set<string>} syncedDates 蓄積済みの日付
 */
export function planMissingDates(tradingDays, syncedDates) {
  return tradingDays
    .filter((d) => !syncedDates.has(d))
    .slice()
    .sort()
    .reverse();
}

export async function loadSyncedDates(d1) {
  const rows = await d1.query("SELECT date FROM price_sync_dates");
  return new Set(rows.map((r) => r.date));
}

async function markDateSynced(d1, date, rowCount, nowIso) {
  await d1.run("INSERT OR REPLACE INTO price_sync_dates (date, row_count, synced_at) VALUES (?, ?, ?)", [date, rowCount, nowIso]);
}

/**
 * 株価行(PRICE_COLUMNSの順の配列)のうち、全銘柄の蓄積が完了している日付(price_sync_dates)の行を除く。
 * pipeline.jsがプール銘柄の株価を毎日書き込むとき、蓄積済みの日付を二重に書き込まない(D1の書き込み行数の節約)ために使う。
 */
export function filterUnsyncedPriceRows(rows, syncedDates) {
  return rows.filter((row) => !syncedDates.has(row[1]));
}

export async function upsertPriceRows(d1, rows, { rowsPerRequest = 200 } = {}) {
  return d1.bulkUpsertJson("stock_prices", PRICE_COLUMNS, rows, { rowsPerRequest });
}

/**
 * 全銘柄の日足を、未蓄積の取引日だけD1へ蓄積する(新しい日付から。書き込み予算の範囲で)。
 *
 * @param {object} params
 * @param {object} params.client J-Quantsクライアント(fetchDailyQuotesForDate)
 * @param {object} params.d1 D1Client(stats.rowsWrittenで書き込み行数を集計する)
 * @param {string[]} params.tradingDays 蓄積の対象にする取引日(最新のデータ基準日以前)
 * @param {Object<string, Array>} [params.prefetched] 取得済みの日付 -> 生レコード(再取得しない)
 * @param {number} params.writeBudget この実行で使ってよいD1の書き込み行数
 * @param {number} [params.rowsPerRequest]
 * @param {() => string} [params.nowIso]
 * @returns {Promise<{missingBefore:number, syncedDates:string[], skippedEmpty:string[], remaining:number, rowsWritten:number, stoppedBy:string|null, adjusted: Map<string,string>}>}
 */
export async function syncPrices({
  client,
  d1,
  tradingDays,
  prefetched = {},
  writeBudget,
  rowsPerRequest = 200,
  nowIso = () => new Date().toISOString(),
  log = (m) => console.log(m),
}) {
  const synced = await loadSyncedDates(d1);
  const missing = planMissingDates(tradingDays, synced);
  const startWrites = d1.stats.rowsWritten;
  const syncedDates = [];
  const skippedEmpty = [];
  const adjusted = new Map();
  let stoppedBy = null;

  for (const date of missing) {
    const used = d1.stats.rowsWritten - startWrites;
    if (used + TYPICAL_ROWS_PER_DAY * WRITES_PER_PRICE_ROW > writeBudget) {
      stoppedBy = "write-budget";
      break;
    }

    const rows = prefetched[date] ?? (await client.fetchDailyQuotesForDate(date.replaceAll("-", "")));
    if (rows.length === 0) {
      // 取引日なのにデータが無い日(更新前など)は、完了扱いにせず次回に回す
      skippedEmpty.push(date);
      continue;
    }
    const fetchedAt = nowIso();
    const priceRows = rows.map((r) => buildPriceRow(r, fetchedAt)).filter(Boolean);
    if (used + priceRows.length * WRITES_PER_PRICE_ROW > writeBudget) {
      stoppedBy = "write-budget";
      break;
    }

    await upsertPriceRows(d1, priceRows, { rowsPerRequest });
    // 全行の書き込みに成功してから「完了」を記録する(途中で失敗した日付は次回やり直す)
    await markDateSynced(d1, date, priceRows.length, nowIso());
    syncedDates.push(date);
    for (const [code, exDate] of findAdjustedCodes(rows)) {
      const prev = adjusted.get(code);
      if (!prev || exDate > prev) adjusted.set(code, exDate);
    }
    log(`[d1Sync] ${date}: ${priceRows.length}行を蓄積(累計書き込み ${d1.stats.rowsWritten - startWrites}行)`);
  }

  return {
    missingBefore: missing.length,
    syncedDates,
    skippedEmpty,
    remaining: missing.length - syncedDates.length - skippedEmpty.length,
    rowsWritten: d1.stats.rowsWritten - startWrites,
    stoppedBy,
    adjusted,
  };
}

// J-Quantsの株価は日本時間16:30頃に更新される。この時刻より前に取得した「分割日より前の日付」の行は、
// 分割の調整が反映されていない古い基準の値(=過去の調整後株価と食い違う)である。UTCでは 07:30。
export const PRICE_PUBLISH_UTC_TIME = "T07:30:00.000Z";

/**
 * 調整(AdjFactor≠1)があった銘柄のうち、「調整が反映される前に取得した古い行」がD1に残っている銘柄だけを返す。
 * そのような行が無い銘柄(例: 初回の蓄積で、調整後にすべて取得した場合)は、再取得しても値が変わらないため不要。
 * @param {object} d1
 * @param {Array<[string, string]>} entries [code, exDate]
 * @returns {Promise<Set<string>>} 再取得が必要な銘柄コード
 */
export async function findCodesWithStaleRows(d1, entries) {
  const byExDate = new Map();
  for (const [code, exDate] of entries) {
    if (!byExDate.has(exDate)) byExDate.set(exDate, []);
    byExDate.get(exDate).push(code);
  }
  const stale = new Set();
  for (const [exDate, codes] of byExDate) {
    for (let i = 0; i < codes.length; i += 80) {
      const chunk = codes.slice(i, i + 80);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await d1.query(
        `SELECT DISTINCT code FROM stock_prices WHERE code IN (${placeholders}) AND date < ? AND fetched_at < ?`,
        [...chunk, exDate, `${exDate}${PRICE_PUBLISH_UTC_TIME}`]
      );
      for (const r of rows) stale.add(r.code);
    }
  }
  return stale;
}

/**
 * 株式分割等で過去の調整後株価が変わった銘柄の履歴を、期間全体で再取得して上書きする。
 * J-Quantsの調整後株価(AdjC等)は、分割があると過去分もさかのぼって再計算されるため、
 * 以前に蓄積した古い行と新しい行で値の基準がずれるのを防ぐ。
 * 対象は、直近(recentDays日以内)に調整があり、かつ、調整の反映前に取得した古い行がD1に残っている銘柄だけ
 * (古い分割や、すべて調整後に取得した銘柄は、再取得しても値が変わらないため不要)。
 */
export async function repairAdjustedHistory({
  client,
  d1,
  adjusted,
  fromDate,
  toDate,
  latestDate,
  recentDays = 30,
  maxCodes,
  writeBudget,
  rowsPerRequest = 200,
  nowIso = () => new Date().toISOString(),
  log = (m) => console.log(m),
}) {
  const threshold = addDays(latestDate, -recentDays);
  const recent = [...adjusted.entries()].filter(([, exDate]) => exDate >= threshold);
  const stale = recent.length > 0 ? await findCodesWithStaleRows(d1, recent) : new Set();
  const targets = recent
    .filter(([code]) => stale.has(code))
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, maxCodes);
  const startWrites = d1.stats.rowsWritten;
  const repaired = [];
  let stoppedBy = null;

  for (const [code, exDate] of targets) {
    if (d1.stats.rowsWritten - startWrites >= writeBudget) {
      stoppedBy = "write-budget";
      break;
    }
    const raw = await client.fetchDailyQuotesForCodeRange(code, fromDate.replaceAll("-", ""), toDate.replaceAll("-", ""));
    const fetchedAt = nowIso();
    const priceRows = raw.map((r) => buildPriceRow(r, fetchedAt)).filter(Boolean);
    await upsertPriceRows(d1, priceRows, { rowsPerRequest });
    repaired.push({ code, exDate, rows: priceRows.length });
    log(`[d1Sync] 株式分割等の調整(${exDate})があった ${code} の履歴を再取得: ${priceRows.length}行`);
  }
  return { candidates: adjusted.size, recent: recent.length, stale: stale.size, repaired, stoppedBy };
}

/** 指数(TOPIX)の日足を、J-Quantsの生レコードからindex_pricesの行(配列)にする。 */
export function buildIndexRows(indexCode, rawRows, fetchedAt) {
  const rows = [];
  for (const r of rawRows) {
    const rawDate = String(r.Date ?? r.date ?? "");
    const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate;
    const close = numberOrNull(r.C ?? r.Close ?? r.close);
    if (!date || close === null) continue;
    rows.push([indexCode, date, numberOrNull(r.O ?? r.Open), numberOrNull(r.H ?? r.High), numberOrNull(r.L ?? r.Low), close, fetchedAt]);
  }
  return rows;
}

export async function upsertIndexRows(d1, rows) {
  return d1.bulkUpsertJson("index_prices", INDEX_COLUMNS, rows, { rowsPerRequest: 200 });
}

/**
 * TOPIX等の指数を、保存済みの最終日の少し前(再取得で補正するため5日)から最新まで取得してupsertする。
 * 初回は fromDate から。
 */
export async function syncIndexPrices({ client, d1, indexCode, fromDate, toDate, nowIso = () => new Date().toISOString() }) {
  const last = await d1.query("SELECT MAX(date) AS last_date FROM index_prices WHERE index_code = ?", [indexCode]);
  const lastDate = last?.[0]?.last_date ?? null;
  const from = lastDate ? addDays(lastDate, -5) : fromDate;
  const effectiveFrom = from < fromDate ? fromDate : from;
  const raw = await client.fetchTopixRange(effectiveFrom.replaceAll("-", ""), toDate.replaceAll("-", ""));
  const rows = buildIndexRows(indexCode, raw, nowIso());
  await upsertIndexRows(d1, rows);
  return { from: effectiveFrom, to: toDate, rows: rows.length };
}

/**
 * 銘柄マスタ(stocks)のうち、新規・変更(銘柄名・市場区分)のあった銘柄だけを返す。
 * @param {Array<{code,name,market}>} existingRows D1の現在の内容
 * @param {Map<string,{code,name,market}>} incomingByCode J-Quantsの上場銘柄一覧(listedInfo.jsで正規化済み)
 */
export function diffStocks(existingRows, incomingByCode) {
  const existing = new Map(existingRows.map((r) => [r.code, r]));
  const changed = [];
  for (const incoming of incomingByCode.values()) {
    const current = existing.get(incoming.code);
    if (!current || (current.name ?? null) !== (incoming.name ?? null) || (current.market ?? null) !== (incoming.market ?? null)) {
      changed.push(incoming);
    }
  }
  return changed;
}

/** 銘柄マスタ全体(約4,400銘柄)をD1へ同期する。変更があった銘柄だけ書き込む(日々の書き込みはほぼ0)。 */
export async function syncStocksMaster({ d1, listedInfoByCode, nowIso = () => new Date().toISOString() }) {
  if (!listedInfoByCode || listedInfoByCode.size === 0) return { total: 0, written: 0 };
  const existing = await d1.query("SELECT code, name, market FROM stocks");
  const changed = diffStocks(existing, listedInfoByCode);
  const updatedAt = nowIso();
  const rows = changed.map((s) => [s.code, s.name ?? null, s.market ?? null, updatedAt]);
  await d1.bulkUpsertJson("stocks", STOCK_COLUMNS, rows, { rowsPerRequest: 200 });
  return { total: listedInfoByCode.size, written: rows.length };
}

export { toShortCode };
