// J-Quants V2 /fins/summary のフィールド名は【2026-09、実データで検証済み】。
// EDINET XBRLの冗長ラベルではなく、独自の超短縮キー名が使われている。
// 実際のレスポンス例（信越化学工業 4063, 1Q決算）:
//   { DiscDate, DiscTime, Code, DocType, CurPerType, Sales, OP, OdP, NP,
//     EPS, DEPS, TA, Eq, EqAR, BPS, ROE, ... }
// Sales=売上高, OP=営業利益, OdP=経常利益, NP=純利益, EqAR=自己資本比率
// 空文字列("")は「その決算区分では算出されない項目」を意味し、0ではなくnullとして扱う
// （例: IFRS採用企業のOdPは常に空文字列）。

const CANDIDATE_KEYS = {
  code: ["Code", "code"],
  discDate: ["DiscDate", "DisclosedDate", "disclosedDate"],
  discTime: ["DiscTime", "DisclosedTime", "disclosedTime"],
  // 【2026-09実データ検証で判明】J-Quants V2 /fins/summary は独自の超短縮キー名を使用する
  // （V1の /fins/statements とは全く異なる）。実際のレスポンス例:
  // Sales, OP(営業利益), OdP(経常利益), NP(純利益), EPS, BPS, EqAR(自己資本比率) 等。
  // 一般的なV1形式のキー名も念のため候補に残しているが、実際にヒットするのは短縮形の方。
  netSales: ["Sales", "NetSales", "OperatingRevenue", "TotalNetRevenues"],
  operatingProfit: ["OP", "OperatingProfit", "OperatingIncome"],
  ordinaryProfit: ["OdP", "OrdinaryProfit", "OrdinaryIncome"],
  profit: ["NP", "Profit", "NetIncome", "ProfitAttributableToOwnersOfParent"],
  eps: ["EPS", "EarningsPerShare", "BasicEarningsPerShare"],
  bps: ["BPS", "BookValuePerShare"],
  equityToAssetRatio: ["EqAR", "EquityToAssetRatio", "EquityRatio"],
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
    bps: toNumberOrNull(pick(row, CANDIDATE_KEYS.bps)),
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
