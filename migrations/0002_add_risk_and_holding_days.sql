-- Phase 2: ランキングAPI実装に伴うai_evaluationsのカラム追加
--
-- 背景: Gemini(src/gemini.js)は risk(LOW/MEDIUM/HIGH) と expectedHoldingDays(想定保有日数)を
-- 生成しているが、0001_init.sqlのai_evaluationsにはこれらを受けるカラムが存在せず、
-- 生成されるたびに破棄されていた。ランキングAPIのレスポンスにこれらを含める必要があるため追加する。
--
-- 設計方針は0001_init.sqlを踏襲する:
-- - ai_evaluationsは追記専用（既存行はUPDATEしない）
-- - このマイグレーション適用前に保存された既存行では、新カラムはNULLのままになる
--   （過去分を遡って補完することはしない。今後の保存分から正しく記録される）

ALTER TABLE ai_evaluations ADD COLUMN risk TEXT;
ALTER TABLE ai_evaluations ADD COLUMN expected_holding_days INTEGER;
