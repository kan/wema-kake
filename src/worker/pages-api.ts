// ページの一覧、検索、バックリンクは D1 の索引から返す。ページの中身と表示名は DO から返す。
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { isValidSlug } from '../shared/slug';
import type { AuthEnv } from './access';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const SEARCH_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
/** trigram の FTS が一致を返せる最短の検索語（文字数） */
const MIN_FTS_QUERY_LENGTH = 3;

/** パスの `:slug` が不正なら 400 を返す */
export const validSlug = createMiddleware<AuthEnv>(async (c, next) => {
  if (!isValidSlug(c.req.param('slug') ?? '')) return c.json({ error: 'invalid slug' }, 400);
  await next();
});

export const pagesApi = new Hono<AuthEnv>();

/** ページ一覧。`updated_after`（ミリ秒）より後に更新されたものに絞れる */
pagesApi.get('/pages', async (c) => {
  const limit = Math.min(
    Math.max(Math.trunc(Number(c.req.query('limit'))) || DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT,
  );
  const updatedAfter = Number(c.req.query('updated_after')) || 0;
  const { results } = await c.env.DB.prepare(
    `SELECT name, title, note_count, updated_at FROM pages
     WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(updatedAfter, limit)
    .all();
  return c.json({ pages: results });
});

/** 全文検索。3 文字未満の検索語は trigram に一致しないので LIKE で探す */
pagesApi.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q === '' || q.length > MAX_QUERY_LENGTH) return c.json({ error: 'invalid query' }, 400);

  if ([...q].length >= MIN_FTS_QUERY_LENGTH) {
    // 検索語全体を 1 つの語句として扱う（FTS5 の演算子として解釈させない）
    const phrase = `"${q.replaceAll('"', '""')}"`;
    const { results } = await c.env.DB.prepare(
      `SELECT p.name, p.title, p.updated_at, snippet(pages_fts, 1, '', '', '…', 24) AS snippet
       FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
       WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
      .bind(phrase, SEARCH_LIMIT)
      .all();
    return c.json({ pages: results });
  }

  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT name, title, updated_at FROM pages
     WHERE title LIKE ?1 ESCAPE '\\' OR plain_text LIKE ?1 ESCAPE '\\'
     ORDER BY updated_at DESC LIMIT ?2`,
  )
    .bind(pattern, SEARCH_LIMIT)
    .all();
  return c.json({ pages: results });
});

pagesApi.get('/pages/:slug', validSlug, async (c) => {
  const slug = c.req.param('slug');
  return c.json({ slug, ...(await c.env.PAGE.getByName(slug).getSnapshot()) });
});

/** このページへリンクしているページ */
pagesApi.get('/pages/:slug/backlinks', validSlug, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.name, p.title FROM links l JOIN pages p ON p.name = l.from_page
     WHERE l.to_page = ? ORDER BY p.updated_at DESC`,
  )
    .bind(c.req.param('slug'))
    .all();
  return c.json({ pages: results });
});

/** 表示名の変更。まだ書き込みのないページに対して呼ぶと、ページが作られる */
pagesApi.put('/pages/:slug/title', validSlug, async (c) => {
  const body = await c.req.json<{ title?: unknown }>().catch(() => null);
  const result = await c.env.PAGE.getByName(c.req.param('slug')).setTitle(body?.title);
  return result.ok ? c.json(result) : c.json({ error: result.reason }, 400);
});
