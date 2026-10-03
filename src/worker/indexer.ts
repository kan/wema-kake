// ページ DO の内容を D1 の索引（pages / links / pages_fts）へ反映する。
// D1 は索引で、正のデータは DO にある。DO → D1 の一方向で、D1 から DO へは書き戻さない。
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

/**
 * 付箋の数と更新日時だけを書く。付箋の移動や色の変更のように、検索とリンクに関わる内容が
 * 変わっていないときに使う。ページの行がなければ false を返す（そのときは writePage で作る）。
 */
export async function touchPage(
  db: D1Database,
  slug: string,
  noteCount: number,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE pages SET note_count = ?, updated_at = ? WHERE name = ?`)
    .bind(noteCount, now, slug)
    .run();
  return result.meta.changes > 0;
}

/** 1 ページ分の索引を入れ替える。1 つのトランザクションで実行する */
export async function writePage(
  db: D1Database,
  slug: string,
  title: string | null,
  content: PageContent,
  noteCount: number,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO pages (name, title, plain_text, note_count, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET title = excluded.title, plain_text = excluded.plain_text,
           note_count = excluded.note_count, updated_at = excluded.updated_at`,
      )
      .bind(slug, title, content.plainText, noteCount, now),
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
