-- 利用者の表示名とアイコン（issue #121）。管理者と、承認（設定の `approval`）が無効なときの利用者も
-- 持てるように、承認の `users` とは別の表にする（`users` には、承認を求められた人しか入らない）
CREATE TABLE profiles (
  email      TEXT PRIMARY KEY,   -- 小文字にした email
  name       TEXT,               -- 表示名。未設定なら NULL（画面は email の `@` より前を出す）
  icon       TEXT,               -- アイコンの画像の R2 のキー（'<uuid>.webp'）。未設定なら NULL
  updated_at INTEGER NOT NULL    -- 最後に変えた時刻（UNIX ミリ秒）
);
