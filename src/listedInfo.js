// J-Quants /v2/equities/master（上場銘柄一覧）のレスポンスを正規化するモジュール。
//
// 実データで確認した本物のキー名（2026-09、13010=極洋のレスポンスで確認）:
//   Code, CoName(日本語社名), CoNameEn(英語社名), Mkt(市場区分コード), MktNm(市場区分名) 等
// これらを最優先の候補キーとして採用している。それ以外の候補キーは、
// 万一将来レスポンス形式が変わった場合のフォールバックとして残してある
// （financials.jsで実際にV1形式のフォールバックが使われた前例に倣った設計）。

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

/**
 * 5桁コード(末尾0)を4桁化する。normalize.jsの正規化ルールと合わせるため、
 * stock_prices/financials等、他のテーブルのcodeと同じ形式にする。
 */
function normalizeCode(rawCode) {
  if (rawCode === null || rawCode === undefined) return null;
  const code = String(rawCode);
  if (/^\d{4}0$/.test(code)) return code.slice(0, 4);
  return code;
}

/**
 * 銘柄マスタの1行を {code, name, market} に正規化する。
 * codeが取得できない行はnull（呼び出し側で除外すること）。
 */
export function normalizeListedInfoRow(row) {
  const code = normalizeCode(pick(row, ["Code", "code", "LocalCode"]));
  if (!code) return null;

  const name = pick(row, [
    "CoName", // 実データで確認した本物のキー名（2026-09、13010=極洋で確認）
    "CompanyName",
    "CompanyNameJapanese",
    "CompanyNameJP",
    "Name",
    "name",
  ]);

  const market = pick(row, [
    "MktNm", // 実データで確認した本物のキー名
    "MarketCodeName",
    "MarketCode",
    "Market",
    "market",
  ]);

  return { code, name, market };
}

/**
 * 銘柄マスタの生レスポンス配列を Map<code, {code, name, market}> に変換する。
 * 同一codeが複数回出現した場合は後勝ちとする（通常は発生しない想定）。
 */
export function buildListedInfoByCode(rawRows) {
  const byCode = new Map();
  for (const row of rawRows ?? []) {
    const normalized = normalizeListedInfoRow(row);
    if (!normalized) continue;
    byCode.set(normalized.code, normalized);
  }
  return byCode;
}
