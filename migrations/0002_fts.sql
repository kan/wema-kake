-- 仮想テーブルがあると D1 を export できない。export するときはこのテーブルを削除し、
-- 後から pages の内容で作り直す。そのため pages とは別のマイグレーションにしている。
--
-- rowid は pages.id と同じ値にする（name は索引されないので、行の特定には rowid を使う）。
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  plain_text,
  tokenize = 'trigram'
);
