-- サイト全体で 1 つの値。今は、最初のページを作ったかどうか（first_page）だけ。
--
-- 最初のページ（使い方の付箋を置いたページ）は、ページが 1 つもないときに 1 回だけ作る。
-- 作ったことをここに記録するので、すべてのページを消しても、作り直さない
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- すでに使っている環境には作らない
INSERT INTO settings (key, value)
SELECT 'first_page', 'skipped' WHERE EXISTS (SELECT 1 FROM pages);
