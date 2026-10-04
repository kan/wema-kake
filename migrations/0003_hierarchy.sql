-- ページの階層（docs/plan.md のフェーズ 6.6）。
--
-- parent: 親ページのスラッグ。ルートのページなら NULL。正のデータは、子ページの DO の meta にある
-- layout: 付箋の配置（[[x, y, 幅, 高さ, 色], ...] の JSON）。親ページの画面が、子ページの付箋の上に、
--         子ページの配置を簡易に再現するのに使う
ALTER TABLE pages ADD COLUMN parent TEXT;
ALTER TABLE pages ADD COLUMN layout TEXT;

CREATE INDEX pages_parent ON pages (parent);
