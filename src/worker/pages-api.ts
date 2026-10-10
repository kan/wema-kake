// ページの一覧、検索、バックリンクは D1 の索引から返す。ページの中身と表示名は DO から返す。
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { INDEX_EXCERPT_LENGTH, MAX_LIST_LIMIT, type PageSummary } from '../shared/api';
import { requestLang } from '../shared/i18n';
import { isValidSlug } from '../shared/slug';
import type { AuthEnv } from './access';
import { createFirstPage } from './first-page';
import { REASON_PAGE_NOT_FOUND, type RevertFailure } from './page-do';
import { listPages, searchPages, searchRoots } from './page-queries';

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
 * 一覧のボード用。ルートのページ（親のないページ）を新しい順に返す。子ページと孫ページは、
 * 親ページの中からたどるので、ここには出さない。`child_count` は、直接の子ページの数。
 *
 * リンクは、ルートのページから出ているもののうち、リンク先がルートのページか、存在しない
 * ページ（未作成。`missing` が 1）のものだけを返す。子孫のページが関わるリンクは、線にしない。
 */
pagesApi.get('/index', async (c) => {
  const db = c.env.DB;
  const roots = `SELECT name FROM pages WHERE parent IS NULL ORDER BY updated_at DESC LIMIT ?`;
  const read = () =>
    db.batch([
      db
        .prepare(
          `SELECT name, title, color, note_count, updated_at, substr(plain_text, 1, ?) AS excerpt,
                  (SELECT count(*) FROM pages c WHERE c.parent = pages.name) AS child_count
           FROM pages WHERE parent IS NULL ORDER BY updated_at DESC LIMIT ?`,
        )
        .bind(INDEX_EXCERPT_LENGTH, MAX_LIST_LIMIT),
      db
        .prepare(
          `SELECT l.from_page, l.to_page, p.name IS NULL AS missing
           FROM links l LEFT JOIN pages p ON p.name = l.to_page
           WHERE l.from_page IN (${roots}) AND p.parent IS NULL`,
        )
        .bind(MAX_LIST_LIMIT),
    ]);
  let [pages, links] = await read();
  // ページが 1 つもない環境では、使い方の付箋を置いた最初のページを作る（1 回だけ）
  if (pages.results.length === 0 && (await createFirstPage(c.env, requestLang(c.req.raw)))) {
    [pages, links] = await read();
  }
  return c.json({ pages: pages.results, links: links.results });
});

/** 一度に問い合わせられるページの数 */
const MAX_INFO_NAMES = 200;

/**
 * ページの概要をまとめて返す（本文は `{ "names": ["..."] }`）。子ページの付箋の表示に使う。
 * 索引にないページ（未作成、削除済み）は、結果に入らない。
 */
pagesApi.post('/pages-info', async (c) => {
  const body = await c.req.json<{ names?: unknown }>().catch(() => null);
  const names = Array.isArray(body?.names) ? body.names.filter((n): n is string => typeof n === 'string') : [];
  if (names.length === 0 || names.length > MAX_INFO_NAMES || !names.every(isValidSlug)) {
    return c.json({ error: 'invalid names' }, 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT name, title, color, note_count, parent, layout FROM pages WHERE name IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(names))
    .all<PageSummary>();
  // 索引への反映は、変更の数秒後。作ったばかりのページは、まだ索引にないので、DO から補う
  // （付箋の配置は、索引ができるまで出さない）
  const indexed = new Set(results.map((page) => page.name));
  for (const name of new Set(names)) {
    if (indexed.has(name)) continue;
    const ref = await c.env.PAGE.getByName(name).getPageRef();
    if (ref) {
      const { title, color, parent } = ref;
      results.push({ name, title, color, note_count: ref.noteCount, parent, layout: null });
    }
  }
  return c.json({ pages: results });
});

/** 先祖のページを、ルートから順に返す（パンくず用）。DO をたどるので、直前の変更も反映される */
pagesApi.get('/pages/:slug/ancestors', validSlug, async (c) => {
  // DO は、親に近い順で返す
  const ancestors = await c.env.PAGE.getByName(c.req.param('slug')).ancestors();
  return c.json({ ancestors: ancestors.reverse() });
});

/** ページ一覧。`updated_after`（ミリ秒）より後に更新されたものに絞れる */
pagesApi.get('/pages', async (c) => {
  const pages = await listPages(c.env.DB, {
    updatedAfter: c.req.query('updated_after'),
    limit: c.req.query('limit'),
  });
  return c.json({ pages });
});

/**
 * 全文検索。`roots=1` なら、一致したページのスラッグと、そのルートのスラッグだけを返す
 * （一覧の絞り込み用。一覧にはルートのページしか出ない）
 */
pagesApi.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const pages = c.req.query('roots') === '1' ? await searchRoots(c.env.DB, q) : await searchPages(c.env.DB, q);
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
  await c.env.PAGE.getByName(c.req.param('slug')).deletePage(c.get('actor'));
  return c.json({ ok: true });
});

/** 1 人が付けられるブックマークの数 */
const MAX_BOOKMARKS = 100;

/**
 * 自分のブックマーク（付けた順）。表示名は索引から取るので、作ったばかりのページ（索引への
 * 反映の前）は null になる
 */
pagesApi.get('/bookmarks', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT b.page AS name, p.title FROM bookmarks b LEFT JOIN pages p ON p.name = b.page
     WHERE b.actor = ? ORDER BY b.created_at, b.page`,
  )
    .bind(c.get('actor'))
    .all();
  return c.json({ pages: results });
});

/** ブックマークを付ける。すでに付いていれば、何もしない */
pagesApi.put('/bookmarks/:slug', validSlug, async (c) => {
  const slug = c.req.param('slug');
  const actor = c.get('actor');
  // 索引への反映を待たずに確かめる（作ったばかりのページにも付けられる）
  if ((await c.env.PAGE.getByName(slug).getPageRef()) === null) return c.json({ error: 'page not found' }, 404);
  // 上限は、付ける行の条件にする（数えてから付けると、同時に届いた分で超える）
  const added = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO bookmarks (actor, page, created_at)
     SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM bookmarks WHERE actor = ?1) < ?4`,
  )
    .bind(actor, slug, Date.now(), MAX_BOOKMARKS)
    .run();
  // 付かなかったのは、すでに付いているか、上限に達しているか
  if (added.meta.changes === 0) {
    const exists = await c.env.DB.prepare(`SELECT 1 FROM bookmarks WHERE actor = ? AND page = ?`)
      .bind(actor, slug)
      .first();
    if (!exists) return c.json({ error: `too many bookmarks (limit ${MAX_BOOKMARKS})` }, 400);
  }
  return c.json({ ok: true });
});

/** ブックマークを外す。付いていなくても、成功として返す */
pagesApi.delete('/bookmarks/:slug', validSlug, async (c) => {
  await c.env.DB.prepare(`DELETE FROM bookmarks WHERE actor = ? AND page = ?`)
    .bind(c.get('actor'), c.req.param('slug'))
    .run();
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

/**
 * 他のページから移す（写す）付箋を置く。本文は `{ clientId, opId, from, notes, edges }`
 * （`from` は、付箋が元あったページ。同じ `opId` で送り直しても、二重には置かない）。
 * 今ある付箋の下に置く。ページがなければ 404（作らない）
 */
pagesApi.post('/pages/:slug/notes', validSlug, async (c) => {
  const body = await c.req
    .json<{ clientId?: unknown; opId?: unknown; from?: unknown; notes?: unknown; edges?: unknown }>()
    .catch(() => null);
  const from = body?.from;
  if (typeof from !== 'string' || !isValidSlug(from)) return c.json({ error: 'invalid from' }, 400);
  const slug = c.req.param('slug');
  const stub = c.env.PAGE.getByName(slug);
  const result = await stub.receiveNotes({
    actor: c.get('actor'),
    clientId: String(body?.clientId ?? ''),
    opId: String(body?.opId ?? ''),
    from,
    notes: body?.notes,
    edges: body?.edges,
  });
  if (result.ok) {
    // 置いた後の概要も返す（送った側が、索引への反映を待たずに、子ページの付箋を描き直せる）
    const summary = await stub.getSummary();
    return c.json({ ok: true, seq: result.seq, page: summary && { name: slug, ...summary } });
  }
  return c.json({ error: result.reason }, result.reason === REASON_PAGE_NOT_FOUND ? 404 : 400);
});

/**
 * 表示名の変更。まだ書き込みのないページに対して呼ぶと、ページが作られる。
 * 本文に `"mustExist": true` があれば、作らずに 404 を返す
 */
pagesApi.put('/pages/:slug/title', validSlug, async (c) => {
  const body = await c.req.json<{ title?: unknown; mustExist?: unknown }>().catch(() => null);
  const result = await c.env.PAGE.getByName(c.req.param('slug')).setTitle(body?.title, {
    mustExist: body?.mustExist === true,
  });
  if (result.ok) return c.json(result);
  return c.json({ error: result.reason }, result.reason === REASON_PAGE_NOT_FOUND ? 404 : 400);
});

/**
 * ページの色の変更（本文は `{ "color": "#BBDEFB" }`。`PAGE_COLORS` のどれか。null で、付けていない
 * 状態に戻す）。ページがなければ 404（作らない）
 */
pagesApi.put('/pages/:slug/color', validSlug, async (c) => {
  const body = await c.req.json<{ color?: unknown }>().catch(() => null);
  // `color` のない本文を、「付けていない状態に戻す」として扱わない
  if (body?.color === undefined) return c.json({ error: 'invalid color' }, 400);
  const result = await c.env.PAGE.getByName(c.req.param('slug')).setColor(body.color, c.get('actor'));
  if (result.ok) return c.json(result);
  return c.json({ error: result.reason }, result.reason === REASON_PAGE_NOT_FOUND ? 404 : 400);
});
