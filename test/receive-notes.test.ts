// 他のページから移す（写す）付箋を受け取る（POST /api/pages/<slug>/notes）。
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createNote, edge, note } from './helpers';

let count = 0;
const unique = (prefix: string) => `${prefix}-${++count}`;
const page = (slug: string) => env.PAGE.getByName(slug);

async function create(): Promise<string> {
  const slug = unique('receive');
  expect(await page(slug).createPage(slug)).toEqual({ ok: true });
  return slug;
}

const send = (slug: string, body: Record<string, unknown>) =>
  api(`/api/pages/${slug}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', opId: unique('op'), from: 'source', edges: [], ...body }),
  });

const board = async (slug: string) => (await page(slug).getSnapshot()).data;

describe('POST /api/pages/:slug/notes', () => {
  it('互いの位置関係を保って、今ある付箋の下に置く。接続線も置く', async () => {
    const slug = await create();
    await page(slug).applyOps({
      actor: 'user:a',
      clientId: 'c0',
      opId: unique('op'),
      deltas: [createNote('old', { x: 100, y: 50, width: 200, height: 150 })],
    });

    const res = await send(slug, {
      notes: [note('a', { x: 900, y: 700 }), note('b', { x: 1200, y: 760 })],
      edges: [edge('e1', 'a', 'b')],
    });
    expect(res.status).toBe(200);
    // 置いた後の概要が、索引への反映を待たずに返る
    expect(await res.json()).toMatchObject({
      page: { name: slug, title: slug, note_count: 3, parent: null, layout: expect.stringContaining('[100,240,') },
    });

    const { notes, edges } = await board(slug);
    const at = (id: string) => notes.find((n) => n.id === id)!;
    // 左端は今ある付箋にそろえ、上端は今ある付箋の下端から 40 空ける
    expect(at('a')).toMatchObject({ x: 100, y: 240 });
    expect(at('b')).toMatchObject({ x: 400, y: 300 });
    expect(edges).toMatchObject([{ id: 'e1', from: 'a', to: 'b' }]);

    // 履歴には、元のページが分かる要約で残る
    const [op] = await page(slug).listOps({ limit: 1 });
    expect(op).toMatchObject({ actor: 'user:dev@example.com', summary: 'system:notes-received:source' });
  });

  it('同じ opId で送り直しても、二重には置かない', async () => {
    const slug = await create();
    const body = { opId: unique('op'), notes: [note('a')] };
    expect((await send(slug, body)).status).toBe(200);
    expect((await send(slug, body)).status).toBe(200);
    expect((await board(slug)).notes).toHaveLength(1);
  });

  it('ページがなければ 404 で、ページを作らない', async () => {
    const slug = unique('receive-missing');
    expect((await send(slug, { notes: [note('a')] })).status).toBe(404);
    expect(await page(slug).getPageRef()).toBeNull();
  });

  it('形のおかしい本文は 400', async () => {
    const slug = await create();
    expect((await send(slug, { notes: 'x' })).status).toBe(400);
    expect((await send(slug, { notes: [{ id: 'a' }] })).status).toBe(400);
    expect((await send(slug, { notes: [note('a')], from: 'Bad Slug' })).status).toBe(400);
    // 送る付箋の外につながる接続線は、置けない
    expect((await send(slug, { notes: [note('a')], edges: [edge('e1', 'a', 'gone')] })).status).toBe(400);
    expect((await board(slug)).notes).toHaveLength(0);
  });
});
