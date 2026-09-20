// J-Quants /v2/equities/master（上場銘柄一覧）のレスポンスを正規化するモジュール。
//
// 【重要】financials.jsのケースと同様、J-Quants V2の実際のレスポンスの項目名は
// ドキュメントだけでは確定できず、実データで検証するまでは推測にならざるを得ない。
// そのため、想定される複数の候補キー名を順に試すフォールバック方式にしている。
// 初回の実行後、GitHub Actionsのログ・artifacts/listed-info.json（呼び出し側で保存する想定）で
// 実際のレスポンス形式を確認し、必要であれば候補キーを追加・修正すること
// （過去に財務データのフィールド名(Sales/OP/OdP/NP/EqAR等)で同様の検証が必要だった経緯がある）。

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
    "CompanyName",
    "CompanyNameJapanese",
    "CompanyNameJP",
    "Name",
    "name",
  ]);

  const market = pick(row, [
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
