// J-Quants /v2/fins/summary のレスポンスは、EDINET XBRLタクソノミの
// 「冗長ラベル（英語）」をキーとするため、正式なキー名は実際のレスポンスで
// 確認・調整が必要（現時点では公式ドキュメントで全項目が確認できていない）。
// 【要検証】実際に取得したレスポンスの生データをdata/financials.jsonで
// 確認し、下記 CANDIDATE_KEYS を実際のキー名に合わせて調整すること。
//
// 開示日(DiscDate)・開示時刻(DiscTime)は/v2/fins/detailsで確認できた項目名を
// 採用している（/fins/summaryも同様の命名規則と推測されるが、これも要検証）。

const CANDIDATE_KEYS = {
  code: ["Code", "code"],
  discDate: ["DiscDate", "DisclosedDate", "disclosedDate"],
  discTime: ["DiscTime", "DisclosedTime", "disclosedTime"],
  netSales: ["NetSales", "Sales", "OperatingRevenue", "TotalNetRevenues"],
  operatingProfit: ["OperatingProfit", "OperatingIncome"],
  ordinaryProfit: ["OrdinaryProfit", "OrdinaryIncome"],
  profit: ["Profit", "NetIncome", "ProfitAttributableToOwnersOfParent"],
  eps: ["EarningsPerShare", "EPS", "BasicEarningsPerShare"],
  equityToAssetRatio: ["EquityToAssetRatio", "EquityRatio"],
};

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return undefined;
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeDateString(raw) {
  const s = String(raw);
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

/**
 * 財務情報の生レコード1件を正規化する。
 */
export function normalizeFinancialRow(row) {
  const code = pick(row, CANDIDATE_KEYS.code);
  const discDate = pick(row, CANDIDATE_KEYS.discDate);
  if (!code || !discDate) return null;

  return {
    code: String(code),
    discDate: normalizeDateString(discDate),
    discTime: pick(row, CANDIDATE_KEYS.discTime) ?? null,
    netSales: toNumberOrNull(pick(row, CANDIDATE_KEYS.netSales)),
    operatingProfit: toNumberOrNull(pick(row, CANDIDATE_KEYS.operatingProfit)),
    ordinaryProfit: toNumberOrNull(pick(row, CANDIDATE_KEYS.ordinaryProfit)),
    profit: toNumberOrNull(pick(row, CANDIDATE_KEYS.profit)),
    eps: toNumberOrNull(pick(row, CANDIDATE_KEYS.eps)),
    equityToAssetRatio: toNumberOrNull(pick(row, CANDIDATE_KEYS.equityToAssetRatio)),
  };
}

/**
 * 銘柄コードごとの財務情報配列（複数期分含みうる）から、
 * 「cutoffDate時点で公開済みだった、最新の財務情報」だけを選び出す。
 *
 * 【未来情報リーク防止の核心部分】
 * 決算期（会計上の対象期間）ではなく、実際に市場に公開された日付(discDate)で判定する。
 * cutoffDateは時刻を持たない日付単位のため、同日開示分は前後関係が曖昧になり、
 * 安全側に倒して「discDate < cutoffDate（厳密に前日以前）」の場合のみ利用可能とみなす。
 *
 * @param {Array<object>} normalizedFinancials
 * @param {string} cutoffDate - "YYYY-MM-DD"
 * @returns {object|null} 利用可能な最新の財務情報。存在しなければ null
 */
export function selectLatestAvailableFinancials(normalizedFinancials, cutoffDate) {
  const available = normalizedFinancials.filter((f) => f.discDate < cutoffDate);
  if (available.length === 0) return null;
  available.sort((a, b) => (a.discDate < b.discDate ? -1 : 1));
  return available[available.length - 1];
}

/**
 * 銘柄コード -> 生の財務レコード配列 の Map から、
 * 銘柄コード -> cutoffDate時点で利用可能な最新財務情報 の Map を作る。
 */
export function buildAvailableFinancialsByCode(rawFinancialsByCode, cutoffDate) {
  const result = new Map();
  for (const [code, rawRows] of rawFinancialsByCode.entries()) {
    const normalized = rawRows.map(normalizeFinancialRow).filter((r) => r !== null);
    const latest = selectLatestAvailableFinancials(normalized, cutoffDate);
    if (latest) result.set(code, latest);
  }
  return result;
}
