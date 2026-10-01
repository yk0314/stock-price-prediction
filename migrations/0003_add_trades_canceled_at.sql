-- 売買の誤登録を取り消せるようにするための論理取消カラム。
-- - NULL許容。既存の行はすべてNULLのまま（既存データは変更されない）。
-- - 取消した取引は物理削除せず canceled_at に取消日時(ISO文字列)を入れる。
-- - 通常の保有数量・平均取得価格・損益・通算成績の計算は canceled_at IS NULL の取引だけを対象にする。
ALTER TABLE trades ADD COLUMN canceled_at TEXT;
