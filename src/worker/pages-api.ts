// ページの一覧、検索、バックリンクは D1 の索引から返す。ページの中身と表示名は DO から返す。
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { INDEX_EXCERPT_LENGTH, MAX_LIST_LIMIT } from '../shared/api';
import { isValidSlug } from '../shared/slug';
import type { AuthEnv } from './access';
import type { RevertFailure } from './page-do';
import { listPages, searchPages } from './page-queries';

const REVERT_STATUS = {
  'not-found': 404,
  conflict: 409,
  forbidden: 403,
  invalid: 400,
} as const satisfies Record<RevertFailure, number>;

/** パスの `:slug` が不正なら 400 を返す */
export const validSlug = createMiddleware<AuthEnv>(async (c, next) => {
  if (!isValidSlug(c.req.param('slug') ?? '')) return c.json({ error: 'invalid slug' }, 400);
  await next();
});

export const pagesApi = new Hono<AuthEnv>();

/** 認証が有効かを確かめるための、軽い問い合わせ先（切断中に認証が切れたかをブラウザが調べる） */
pagesApi.get('/session', (c) => c.json({ actor: c.get('actor') }));

/**
 * 一覧のボード用。新しい順のページと、そのページからのリンクをまとめて返す。
 * リンク先が存在しないページ（未作成）なら `missing` が 1 になる。
 */
pagesApi.get('/index', async (c) => {
  const db = c.env.DB;
  const [pages, links] = await db.batch([
    db
      .prepare(
        `SELECT name, title, note_count, updated_at, substr(plain_text, 1, ?) AS excerpt
         FROM pages ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(INDEX_EXCERPT_LENGTH, MAX_LIST_LIMIT),
    db
      .prepare(
        `SELECT l.from_page, l.to_page, p.name IS NULL AS missing
         FROM links l LEFT JOIN pages p ON p.name = l.to_page
         WHERE l.from_page IN (SELECT name FROM pages ORDER BY updated_at DESC LIMIT ?)`,
      )
      .bind(MAX_LIST_LIMIT),
  ]);
  return c.json({ pages: pages.results, links: links.results });
});

/** ページ一覧。`updated_after`（ミリ秒）より後に更新されたものに絞れる */
pagesApi.get('/pages', async (c) => {
  const pages = await listPages(c.env.DB, {
    updatedAfter: c.req.query('updated_after'),
    limit: c.req.query('limit'),
  });
  return c.json({ pages });
});

/** 全文検索。`names=1` なら、一致したページのスラッグだけを返す（一覧の絞り込み用） */
pagesApi.get('/search', async (c) => {
  const pages = await searchPages(c.env.DB, c.req.query('q') ?? '', c.req.query('names') === '1');
  return pages ? c.json({ pages }) : c.json({ error: 'invalid query' }, 400);
});

pagesApi.get('/pages/:slug', validSlug, async (c) => {
  const slug = c.req.param('slug');
  return c.json({ slug, ...(await c.env.PAGE.getByName(slug).getSnapshot()) });
});

/** ページの新規作成（本文は `{ "title": "..." }`。表示名は省略できる）。すでにあれば 409 */
pagesApi.post('/pages/:slug', validSlug, async (c) => {
  const body = await c.req.json<{ title?: unknown }>().catch(() => null);
  const result = await c.env.PAGE.getByName(c.req.param('slug')).createPage(body?.title);
  if (result.ok) return c.json(result, 201);
  return c.json({ error: result.reason }, result.reason === 'exists' ? 409 : 400);
});

/** ページの削除。取り消しはできない */
pagesApi.delete('/pages/:slug', validSlug, async (c) => {
  await c.env.PAGE.getByName(c.req.param('slug')).deletePage();
  return c.json({ ok: true });
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

/** 最近の操作。`agent=1` で agent（MCP 経由）の操作に絞る */
pagesApi.get('/pages/:slug/ops', validSlug, async (c) => {
  const ops = await c.env.PAGE.getByName(c.req.param('slug')).listOps({
    limit: Number(c.req.query('limit')),
    agentOnly: c.req.query('agent') === '1',
  });
  return c.json({ ops });
});

/**
 * 操作の取り消し。本文は `{ clientId, opId }`（同じ値で送り直しても二重に取り消さない）。
 * その後に変更されていて取り消さなかったものは `skipped` で返す。
 */
pagesApi.post('/pages/:slug/ops/:seq/revert', validSlug, async (c) => {
  const body = await c.req.json<{ clientId?: unknown; opId?: unknown }>().catch(() => null);
  const result = await c.env.PAGE.getByName(c.req.param('slug')).revert({
    seq: Number(c.req.param('seq')),
    actor: c.get('actor'),
    clientId: String(body?.clientId ?? ''),
    opId: String(body?.opId ?? ''),
  });
  if (result.ok) return c.json(result);
  return c.json({ error: result.reason }, REVERT_STATUS[result.code]);
});

/** 表示名の変更。まだ書き込みのないページに対して呼ぶと、ページが作られる */
pagesApi.put('/pages/:slug/title', validSlug, async (c) => {
  const body = await c.req.json<{ title?: unknown }>().catch(() => null);
  const result = await c.env.PAGE.getByName(c.req.param('slug')).setTitle(body?.title);
  return result.ok ? c.json(result) : c.json({ error: result.reason }, 400);
});
