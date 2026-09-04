// J-Quants V2 のレスポンスはカラム名が短縮形になっている場合がある
// （例: Close -> C, Volume -> Vo）。正式なキー名はダッシュボード/APIリファレンスで
// 確認できるが、確認前でも動作するよう複数の想定キー名から値を拾うようにしている。
//
// 【実装時に必ず確認すること】
// 実際のレスポンスを1件ダンプし、下記 CANDIDATE_KEYS を正確なキー名に合わせて調整すること。
// ここを raw -> normalized の変換点として一元化しているので、
// キー名の変更が必要な場合はこのファイルだけ直せばよい。

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
 * J-Quantsの生レコード1件を { code, date, close, volume } に正規化する。
 * 値が欠損している場合は null を返す（呼び出し側でフィルタすること）。
 */
export function normalizeRawRow(row) {
  const code = pick(row, CANDIDATE_KEYS.code);
  const date = normalizeDateString(pick(row, CANDIDATE_KEYS.date));
  const close = pick(row, CANDIDATE_KEYS.close);
  const volume = pick(row, CANDIDATE_KEYS.volume);

  if (!code || !date || close === undefined) {
    return null;
  }

  return {
    code: String(code),
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
