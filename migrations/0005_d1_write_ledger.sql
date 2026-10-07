-- D1の「1日あたりの書き込み行数」を、ジョブ(パイプライン・株価蓄積など)をまたいで管理するための台帳。
-- Cloudflare D1の無料枠は、アカウント全体で「書き込み1日10万行」(UTCの0時=日本時間9時にリセット)。
-- パイプライン・sync-prices・手動実行がそれぞれ別々に書き込むため、各ジョブが終了時に自分の書き込み行数を
-- この表に加算し、次のジョブは「今日(UTC)の残り」を見て、自分の書き込み予算を決める。
CREATE TABLE IF NOT EXISTS d1_write_ledger (
  day TEXT NOT NULL,          -- UTCの日付(YYYY-MM-DD)
  job TEXT NOT NULL,          -- 'pipeline' / 'sync-prices' など
  rows_written INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, job)
);
