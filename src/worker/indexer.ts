// ページ DO の内容を D1 の索引（pages / links / pages_fts）へ反映する。
// D1 は索引で、正のデータは DO にある。DO → D1 の一方向で、D1 から DO へは書き戻さない。
import type { WemaNote } from '../shared/delta';
import { extractContent, linkedSlug } from './plain-text';

/** pages.plain_text の上限（文字数）。D1 の 1 行の上限に収め、検索の対象としても十分な量にする */
const MAX_PLAIN_TEXT_LENGTH = 300_000;
const MAX_LINKS = 500;

export interface PageContent {
  plainText: string;
  /** このページからリンクしているページのスラッグ */
  links: string[];
}

/** 全付箋の text（サニタイズ済みの HTML）から、検索用のテキストとページ間リンクを作る */
export async function buildPageContent(
  slug: string,
  noteTexts: string[],
  siteOrigin: string | undefined,
): Promise<PageContent> {
  const texts: string[] = [];
  let length = 0;
  const links = new Set<string>();
  for (const html of noteTexts) {
    const { text, hrefs } = await extractContent(html);
    if (text && length < MAX_PLAIN_TEXT_LENGTH) {
      texts.push(text);
      length += text.length + 1;
    }
    for (const href of hrefs) {
      const to = linkedSlug(href, siteOrigin);
      if (to && to !== slug && links.size < MAX_LINKS) links.add(to);
    }
  }
  return {
    plainText: texts.join('\n').slice(0, MAX_PLAIN_TEXT_LENGTH),
    links: [...links].sort(),
  };
}

/** 検索とリンクに関わる内容が前回の反映から変わったかを比べるための値 */
export async function contentHash(title: string | null, content: PageContent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([title, content.plainText, content.links]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** 検索とリンクのほかに、ページの行へ書く値 */
export interface PageRow {
  title: string | null;
  /** 親ページのスラッグ。ルートのページなら null */
  parent: string | null;
  /** 付箋の配置（buildLayout の結果） */
  layout: string;
  noteCount: number;
  now: number;
}

/** 配置に入れる付箋の数の上限 */
const MAX_LAYOUT_NOTES = 200;

/**
 * 付箋の配置を、小さな JSON にする。親ページの画面が、子ページの付箋の上に、子ページの
 * 配置を簡易に再現するのに使う。1 枚は `[x, y, 幅, 高さ, 色]`。本文と接続線は入れない
 */
export function buildLayout(notes: Pick<WemaNote, 'x' | 'y' | 'width' | 'height' | 'color'>[]): string {
  return JSON.stringify(
    notes
      .slice(0, MAX_LAYOUT_NOTES)
      .map((n) => [Math.round(n.x), Math.round(n.y), Math.round(n.width), Math.round(n.height), n.color]),
  );
}

/**
 * 検索とリンク以外の値（付箋の数、更新日時、親、配置）だけを書く。付箋の移動や色の変更のように、
 * 検索とリンクに関わる内容が変わっていないときに使う。ページの行がなければ false を返す
 * （そのときは writePage で作る）。
 */
export async function touchPage(db: D1Database, slug: string, row: PageRow): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE pages SET note_count = ?, updated_at = ?, parent = ?, layout = ? WHERE name = ?`)
    .bind(row.noteCount, row.now, row.parent, row.layout, slug)
    .run();
  return result.meta.changes > 0;
}

/** 索引の上で `slug` を親としているページ */
export async function indexedChildren(db: D1Database, slug: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT name FROM pages WHERE parent = ?`).bind(slug).all<{ name: string }>();
  return results.map((row) => row.name);
}

/**
 * 1 ページ分の索引を消す。他のページからこのページへのリンクは残す
 * （リンク元の付箋にはリンクが残っていて、一覧では未作成のページとして出る）
 */
export async function removePage(db: D1Database, slug: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM pages_fts WHERE rowid = (SELECT id FROM pages WHERE name = ?)`).bind(slug),
    db.prepare(`DELETE FROM links WHERE from_page = ?`).bind(slug),
    db.prepare(`DELETE FROM pages WHERE name = ?`).bind(slug),
    db.prepare(`DELETE FROM bookmarks WHERE page = ?`).bind(slug),
  ]);
}

/** 1 ページ分の索引を入れ替える。1 つのトランザクションで実行する */
export async function writePage(
  db: D1Database,
  slug: string,
  content: PageContent,
  row: PageRow,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO pages (name, title, plain_text, note_count, updated_at, parent, layout)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET title = excluded.title, plain_text = excluded.plain_text,
           note_count = excluded.note_count, updated_at = excluded.updated_at,
           parent = excluded.parent, layout = excluded.layout`,
      )
      .bind(slug, row.title, content.plainText, row.noteCount, row.now, row.parent, row.layout),
    db.prepare(`DELETE FROM links WHERE from_page = ?`).bind(slug),
    db
      .prepare(`INSERT INTO links (from_page, to_page) SELECT ?, value FROM json_each(?)`)
      .bind(slug, JSON.stringify(content.links)),
    db.prepare(`DELETE FROM pages_fts WHERE rowid = (SELECT id FROM pages WHERE name = ?)`).bind(slug),
    db
      .prepare(
        `INSERT INTO pages_fts (rowid, title, plain_text)
         SELECT id, coalesce(title, ''), plain_text FROM pages WHERE name = ?`,
      )
      .bind(slug),
  ]);
}
