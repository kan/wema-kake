-- 利用者。設定の `approval` が有効なときに、Access を通って初めて来た人を承認待ちとして入れる。
-- 管理者（設定の `admins`）は、この表にかかわらず承認済みとして扱う。
-- 表示名とアイコン（issue #121）も、この表に足す
CREATE TABLE users (
  email      TEXT PRIMARY KEY,                     -- 小文字にした email
  status     TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,                     -- 初めて来た時刻（UNIX ミリ秒）
  decided_by TEXT,                                 -- 最後に承認か拒否をした管理者の主体（'user:<email>'）
  decided_at INTEGER                               -- その時刻（UNIX ミリ秒）
);

CREATE INDEX users_status ON users (status, created_at);
