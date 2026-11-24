-- 自分が作ったページに、ほかの人が付箋を足したときのメール（issue #131）。
--
-- notify_notes: 受け取るなら 1。既定は受け取らない（0）
-- notify_lang:  メールの言語（'ja' か 'en'）。受け取ると決めたときの画面の言語
ALTER TABLE profiles ADD COLUMN notify_notes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN notify_lang TEXT;
