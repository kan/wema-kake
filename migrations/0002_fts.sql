-- 仮想テーブルがあると D1 を export できない。export するときはこのテーブルを削除し、
-- 後から pages の内容で作り直す。そのため pages とは別のマイグレーションにしている。
CREATE VIRTUAL TABLE pages_fts USING fts5(
  name UNINDEXED,
  title,
  plain_text,
  tokenize = 'trigram'
);
