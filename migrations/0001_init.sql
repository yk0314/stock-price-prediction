-- Phase 1: データ基盤 D1スキーマ
--
-- 設計方針:
-- - J-Quants Free/有料どちらのプランでも同じスキーマで運用できるようにする
--   （「90日遅延」のようなプラン固有の制約はアプリケーション層(marketDataService.js)で吸収し、
--    スキーマ自体にはFree特有の制約を持ち込まない）
-- - AI評価・売買履歴は追記専用（上書きしない）。過去の評価・取引を後から消さない
-- - evaluation_date / data_as_of_date / generated_at を明確に分離して保存する
--   （「いつAIが評価したか」と「何日時点の市場データを使ったか」を区別するため）

-- 銘柄マスタ
CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT,
  market TEXT,
  updated_at TEXT NOT NULL
);

-- 株価履歴（日足）。data_sourceでFree/有料や将来の別データソースを区別できるようにしておく
CREATE TABLE IF NOT EXISTS stock_prices (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL NOT NULL,
  volume INTEGER,
  data_source TEXT NOT NULL DEFAULT 'jquants',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_stock_prices_code_date ON stock_prices (code, date);

-- 財務データ（開示日ベース。決算期ではなく実際に公開された日付で管理する）
CREATE TABLE IF NOT EXISTS financials (
  code TEXT NOT NULL,
  disc_date TEXT NOT NULL,
  disc_time TEXT,
  net_sales REAL,
  operating_profit REAL,
  ordinary_profit REAL,
  profit REAL,
  eps REAL,
  bps REAL,
  equity_to_asset_ratio REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (code, disc_date)
);
CREATE INDEX IF NOT EXISTS idx_financials_code_discdate ON financials (code, disc_date);

-- AI評価履歴（追記専用。通常のランキング生成と、保有銘柄の再評価の両方をここに記録する）
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  evaluation_date TEXT NOT NULL,   -- AIが評価を行った対象日（通常はgenerated_atの日付部分と同じ）
  data_as_of_date TEXT NOT NULL,   -- 評価に使用した市場データの基準日（cutoffDateに相当）
  generated_at TEXT NOT NULL,      -- 実際にAI評価を生成した日時（タイムスタンプ）
  score REAL,
  rating TEXT,                     -- BUY / HOLD / SELL
  upside_probability REAL,
  downside_risk REAL,
  expected_return REAL,
  confidence REAL,
  reasoning TEXT,
  summary TEXT,
  positive_factors TEXT,           -- JSON配列を文字列で保存
  negative_factors TEXT,           -- JSON配列を文字列で保存
  used_features TEXT,              -- Geminiに渡した入力データのスナップショット(JSON文字列)
  source TEXT NOT NULL DEFAULT 'pipeline', -- 'pipeline'(通常のスクリーニング由来) / 'holding_reeval'(保有銘柄の再評価由来)
  price_at_evaluation REAL         -- 評価時点の終値（バックテスト・含み損益比較の起点）
);
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_code_date ON ai_evaluations (code, evaluation_date);
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_source ON ai_evaluations (source);

-- 売買履歴（追記専用。売却しても削除しない）
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  transaction_type TEXT NOT NULL,  -- 'buy' / 'sell'
  transaction_date TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  amount REAL NOT NULL,            -- quantity * price（保存時に計算済みの値を入れる）
  memo TEXT,
  purchase_evaluation_id INTEGER,  -- 'buy'の場合、購入時点のai_evaluations.idを紐付ける（任意）
  created_at TEXT NOT NULL,
  FOREIGN KEY (purchase_evaluation_id) REFERENCES ai_evaluations (id)
);
CREATE INDEX IF NOT EXISTS idx_trades_code_date ON trades (code, transaction_date);

-- エラーログ（Cron等の自動実行で発生したエラーを記録する）
CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'pipeline' / 'holding_reeval' / 'cron' 等
  error_type TEXT,
  message TEXT,
  context TEXT                     -- 関連情報のJSON文字列（銘柄コード等）
);
CREATE INDEX IF NOT EXISTS idx_error_logs_occurred_at ON error_logs (occurred_at);

-- 【保有銘柄・含み損益について】
-- "holdings"(保有中銘柄・保有株数・平均取得価格)は独立したテーブルとして持たず、
-- tradesを時系列に集計して都度計算する設計にする(Phase 3で実装予定)。
-- 理由: 保有株数・平均取得価格はtradesの追加によって常に変わりうる派生データであり、
-- 別テーブルで二重管理すると更新漏れによる不整合のリスクがあるため。
