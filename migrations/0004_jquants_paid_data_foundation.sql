-- J-Quants有料化後のデータ基盤(全銘柄の日足・TOPIX・同期状況をD1へ蓄積する)のためのスキーマ追加。
-- 既存データは変更しない(カラム追加・新規テーブル追加・冗長な索引の削除のみ)。

-- 1) 株価: 株式分割等の調整係数と売買代金。分割があると過去の調整後株価が変わるため、
--    adj_factor(その日の調整係数。1以外は分割等があった日)を保存して、再取得の判断に使う。
ALTER TABLE stock_prices ADD COLUMN adj_factor REAL;
ALTER TABLE stock_prices ADD COLUMN turnover REAL;

-- 2) 冗長な索引の削除: stock_pricesの主キー(code, date)が、同じ列の索引を自動で持つ。
--    idx_stock_prices_code_date は主キーと完全に同じ列のため不要で、1行の書き込みごとに
--    D1の「書き込み行数」(無料枠: 1日10万行)を余計に消費していた。
DROP INDEX IF EXISTS idx_stock_prices_code_date;

-- 3) 蓄積済みの日付(全銘柄分の書き込みが完了した日付)。差分取得(未蓄積の日付だけ取得)の判定に使う。
CREATE TABLE IF NOT EXISTS price_sync_dates (
  date TEXT PRIMARY KEY,
  row_count INTEGER NOT NULL,
  synced_at TEXT NOT NULL
);

-- 4) 指数(TOPIX等)の日足。バックテスト・将来の市場環境特徴量用。
CREATE TABLE IF NOT EXISTS index_prices (
  index_code TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (index_code, date)
);
