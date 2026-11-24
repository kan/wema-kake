-- ページを作った人（issue #130）。
--
-- created_by: ページを作った人の主体（'user:<email>'）。記録が無いページ（管理者だけが消せる）は空文字。
--             NULL は、この列を足してから、まだ索引に反映していないページ（一覧では、消せるかどうかを
--             サーバーに任せる）。正のデータは、ページの DO の meta にある。一覧の削除のボタンに使う
ALTER TABLE pages ADD COLUMN created_by TEXT;
