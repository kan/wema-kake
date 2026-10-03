CREATE TABLE pages (
  name       TEXT PRIMARY KEY,   -- スラッグ
  title      TEXT,               -- 表示名。未設定ならスラッグを表示する
  plain_text TEXT,               -- 全付箋のテキストをタグ除去して連結したもの
  note_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE links (
  from_page TEXT NOT NULL,
  to_page   TEXT NOT NULL,
  PRIMARY KEY (from_page, to_page)
);

CREATE INDEX links_to_page ON links (to_page);
