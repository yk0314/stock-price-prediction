// J-Quants V2 のレスポンスはカラム名が短縮形になっている場合がある
// （例: Close -> C, Volume -> Vo）。正式なキー名はダッシュボード/APIリファレンスで
// 確認できるが、確認前でも動作するよう複数の想定キー名から値を拾うようにしている。
//
// 【重要】J-Quantsの銘柄コード(Code)は5桁で返る（例: トヨタ自動車 "72030"）。
// 一般的に知られる4桁コード("7203")ではないため、そのままでは
// config.STOCK_UNIVERSE 等の4桁コードと一致しない。
// 5桁目が"0"の場合は普通株式を表すため、末尾の"0"を取り除いて4桁化する。
// 5桁目が"0"以外（優先株式・新株予約権等、英字を含む場合もある）の場合は、
// 別銘柄を表すため4桁化せずそのまま保持する。

const CANDIDATE_KEYS = {
  date: ["Date", "date", "D"],
  code: ["Code", "code", "LocalCode"],
  close: ["Close", "close", "C", "AdjustmentClose", "AdjClose"],
  volume: ["Volume", "volume", "Vo", "AdjustmentVolume", "AdjVolume"],
};

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

function normalizeDateString(raw) {
  if (!raw) return null;
  // "20260601" 形式 と "2026-06-01" 形式の両方に対応
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}

/**
 * J-Quantsの5桁銘柄コードを、一般的に使われる4桁コードに変換する。
 * 5桁目が"0"の場合（普通株式）のみ変換し、それ以外はそのまま返す。
 * 例: "72030" -> "7203" / "83010"（日本銀行、特殊ケース） -> "8301"
 */
export function toShortCode(rawCode) {
  const s = String(rawCode);
  if (s.length === 5 && s.endsWith("0")) {
    return s.slice(0, 4);
  }
  return s;
}

/**
 * J-Quantsの生レコード1件を { code, date, close, volume } に正規化する。
 * code は toShortCode() で4桁化したものを使用する（設定ファイルの銘柄コードと一致させるため）。
 * 値が欠損している場合は null を返す（呼び出し側でフィルタすること）。
 */
export function normalizeRawRow(row) {
  const rawCode = pick(row, CANDIDATE_KEYS.code);
  const date = normalizeDateString(pick(row, CANDIDATE_KEYS.date));
  const close = pick(row, CANDIDATE_KEYS.close);
  const volume = pick(row, CANDIDATE_KEYS.volume);

  if (!rawCode || !date || close === undefined) {
    return null;
  }

  return {
    code: toShortCode(rawCode),
    date,
    close: Number(close),
    volume: volume !== undefined ? Number(volume) : null,
  };
}

/**
 * 生レコードの配列を正規化し、不正なレコードを除外する。
 */
export function normalizeRawRows(rawRows) {
  const normalized = [];
  for (const row of rawRows) {
    const n = normalizeRawRow(row);
    if (n) normalized.push(n);
  }
  return normalized;
}

/**
 * 正規化済みレコードの配列を銘柄コードごとにグルーピングし、日付昇順にソートする。
 * @returns {Map<string, Array<{date, close, volume}>>}
 */
export function groupByCode(normalizedRows) {
  const map = new Map();
  for (const row of normalizedRows) {
    if (!map.has(row.code)) map.set(row.code, []);
    map.get(row.code).push({ date: row.date, close: row.close, volume: row.volume });
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return map;
}
