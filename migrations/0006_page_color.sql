-- ページの色。
--
-- color: ページに付けた色（src/shared/api.ts の PAGE_COLORS のどれか）。付けていなければ NULL。
--        正のデータは、ページの DO の meta にある。子ページの付箋と、一覧の付箋の色に使う
ALTER TABLE pages ADD COLUMN color TEXT;
