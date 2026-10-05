-- ブックマーク。利用者（Access の主体。'user:<email>'）ごとの、よく行くページ。
-- 他の利用者のブックマークは見えない。ページを削除すると、そのページのブックマークも消す
CREATE TABLE bookmarks (
  actor      TEXT NOT NULL,
  page       TEXT NOT NULL,    -- スラッグ
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor, page)
);
